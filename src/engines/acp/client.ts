import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { EngineProtocolError } from '../../domain/errors.ts'
import { withRetry, type RetryOptions } from './retry.ts'

/**
 * Minimal Agent Client Protocol (ACP) transport: newline-delimited JSON-RPC
 * 2.0 over a child process's stdio. This is the managed channel — TUI text is
 * never parsed. Facts verified against `opencode acp` v2.0.29 (2026-10-16,
 * `.pluton-tmp/acp-probe.log` + `acp-probe2.log`):
 *
 * - one JSON object per line, no Content-Length framing
 * - server -> client requests (e.g. `session/request_permission`) MUST be
 *   answered, otherwise the agent hangs; unsupported methods get -32601
 * - `session/cancel` is a client -> server notification (no id, no reply)
 *
 * Failure policy: malformed transport frames are fatal and fail all in-flight
 * requests (no silent resynchronisation). Request timeouts reject that request
 * only and leave the connection alive; late responses are ignored and counted.
 */

export interface AcpChild {
  readonly pid?: number | undefined
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'spawn', listener: () => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export interface AcpSpawnOptions {
  cwd: string
  env: Record<string, string>
  windowsHide: boolean
}

export type AcpSpawnFn = (command: string, args: string[], options: AcpSpawnOptions) => AcpChild

/** Default child-process spawn; exported so transports can wrap it (e.g. `docker exec`). */
export const defaultSpawn: AcpSpawnFn = (command, args, options) =>
  spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: options.windowsHide,
  })

export interface AcpServerRequestResponse {
  result?: unknown
  error?: { code: number; message: string }
}

export interface AcpClientOptions {
  command: string
  args?: string[]
  cwd: string
  env: Record<string, string>
  spawnFn?: AcpSpawnFn
  /** Retry options for process spawn (exponential backoff + jitter). */
  spawnRetry?: RetryOptions
  /** Default timeout for control requests (initialize/session/new/load/close). */
  requestTimeoutMs?: number
  /** A single stdout frame longer than this is a protocol violation. */
  maxLineBytes?: number
  /** Bounded stderr tail kept for diagnostics (lines × chars per line). */
  maxStderrLines?: number
  onNotification?: (method: string, params: unknown) => void
  /**
   * Handle a server -> client request: return a response, `null` for
   * "unsupported" (the client answers -32601), or a promise that settles when
   * the decision is known (e.g. an operator approval wait — the engine's
   * request stays unanswered while it is pending). A rejection answers -32603.
   */
  onServerRequest?: (
    method: string,
    params: unknown,
  ) => AcpServerRequestResponse | null | Promise<AcpServerRequestResponse | null>
  onStderrLine?: (line: string) => void
}

export interface AcpRequestOptions {
  timeoutMs?: number
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_PENDING = 64
const DEFAULT_MAX_STDERR_LINES = 50
const STDERR_LINE_MAX_CHARS = 500

function boundedSnippet(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

export class AcpClient {
  private readonly opts: AcpClientOptions
  private readonly maxLineBytes: number
  private child: AcpChild | null = null
  private state: 'idle' | 'starting' | 'running' | 'dead' = 'idle'
  private failure: EngineProtocolError | null = null
  private nextId = 1
  private lineBuffer = ''
  private readonly pending = new Map<number, PendingRequest>()
  private readonly stderrTail: string[] = []
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private exitResolve: (() => void) | null = null
  private readonly exitPromise: Promise<void>
  /** True from the start of graceful close(): no more frames may be written. */
  private closing = false

  /** Diagnostics (exposed for tests and error details). */
  orphanResponses = 0
  handlerErrors = 0

  constructor(opts: AcpClientOptions) {
    this.opts = opts
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve
    })
  }

  get isRunning(): boolean {
    return this.state === 'running'
  }

  /** True once the transport died or a protocol violation was recorded. */
  get isDead(): boolean {
    return this.state === 'dead'
  }

  stderrDiagnostics(): string {
    return this.stderrTail.join('\n')
  }

  private cleanupChild(): void {
    if (this.child) {
      if (this.exitInfo === null) {
        try {
          this.child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
      this.child = null
    }
    this.lineBuffer = ''
  }

  private async spawnOnce(): Promise<void> {
    const child = (this.opts.spawnFn ?? defaultSpawn)(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      windowsHide: true,
    })
    this.child = child

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string | Buffer) => {
      this.onStdout(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: string | Buffer) => {
      this.onStderr(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    // write() reports EPIPE and other I/O failures asynchronously via the
    // stream's 'error' event, not by throwing. Without this listener Node
    // treats a child that exits mid-write as an uncaught process crash.
    child.stdin?.on('error', (err: Error) => {
      if (this.closing) {
        // close() ended stdin deliberately and owns the shutdown path; the
        // exit/grace/kill sequence below still runs.
        return
      }
      this.die(
        new EngineProtocolError(`acp write failed: ${err.message}`, { cause: err }),
      )
    })
    child.on('error', (err) => {
      if (this.state === 'running') {
        this.die(new EngineProtocolError(`acp transport error: ${err.message}`, { cause: err }))
      }
    })
    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal }
      this.exitResolve?.()
      if (this.state === 'running') {
        this.dieNow(
          new EngineProtocolError(
            `acp agent exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
            { details: { code, signal, stderr: this.stderrDiagnostics() } },
          ),
        )
      }
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      child.on('spawn', () => {
        if (settled) return
        settled = true
        resolve()
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        reject(err)
      })
      child.on('exit', (code, signal) => {
        if (settled) return
        settled = true
        reject(
          new EngineProtocolError(
            `acp agent exited before start (code=${String(code)}, signal=${String(signal)})`,
            { details: { code, signal, stderr: this.stderrDiagnostics() } },
          ),
        )
      })
    })
  }

  /** Spawns the agent and resolves once the OS confirms the process started. */
  async start(): Promise<void> {
    if (this.state !== 'idle') throw new EngineProtocolError('acp client already started')
    this.state = 'starting'

    const retryOpts = this.opts.spawnRetry
    const maxRetries = retryOpts?.maxRetries ?? 0

    try {
      if (maxRetries > 0) {
        await withRetry(
          async () => {
            await this.spawnOnce()
          },
          retryOpts,
          () => {
            this.cleanupChild()
          },
        )
      } else {
        await this.spawnOnce()
      }
      // A stdin error during startup may already have recorded a fatal
      // transport failure; never resurrect that client by overwriting it.
      if (!this.isDead) this.state = 'running'
    } catch (err) {
      this.state = 'dead'
      this.cleanupChild()
      throw err
    }
  }

  async request<T>(method: string, params: unknown, opts: AcpRequestOptions = {}): Promise<T> {
    if (this.state !== 'running') throw this.notRunningError(method)
    if (this.pending.size >= DEFAULT_MAX_PENDING) {
      throw new EngineProtocolError(
        `acp client has ${this.pending.size} in-flight requests; refusing '${method}'`,
      )
    }
    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new EngineProtocolError(`acp request '${method}' timed out after ${timeoutMs}ms`, {
            details: { method, timeoutMs, stderr: this.stderrDiagnostics() },
          }),
        )
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (this.state !== 'running') throw this.notRunningError(method)
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** Graceful shutdown: close stdin, wait, then kill. Idempotent. */
  async close(graceMs = 1_000): Promise<void> {
    const child = this.child
    if (!child) return
    this.closing = true
    const wasRunning = this.state !== 'dead'
    if (wasRunning) {
      try {
        child.stdin?.end()
      } catch {
        // stdin may already be destroyed; killing below is the fallback
      }
      await this.raceExit(graceMs)
    }
    if (this.state !== 'dead') {
      try {
        child.kill()
      } catch {
        // process may already be gone
      }
      await this.raceExit(graceMs)
    }
    if (this.state !== 'dead') this.dieNow(new EngineProtocolError('acp client closed'))
    this.cleanupChild()
  }

  private async raceExit(graceMs: number): Promise<void> {
    if (this.state === 'dead') return
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, graceMs)
        t.unref?.()
      }),
    ])
  }

  private write(message: unknown): void {
    const child = this.child
    if (!child?.stdin) {
      this.die(new EngineProtocolError('acp transport has no stdin'))
      return
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch (err) {
      this.die(
        new EngineProtocolError(`acp write failed: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        }),
      )
    }
  }

  private onStdout(chunk: string): void {
    if (this.isDead) return
    this.lineBuffer += chunk
    for (;;) {
      const idx = this.lineBuffer.indexOf('\n')
      if (idx < 0) break
      const line = this.lineBuffer.slice(0, idx).replace(/\r$/, '')
      this.lineBuffer = this.lineBuffer.slice(idx + 1)
      if (line.trim() !== '') this.handleLine(line)
      if (this.isDead) return
    }
    if (this.lineBuffer.length > this.maxLineBytes) {
      this.die(
        new EngineProtocolError(
          `acp frame exceeded ${this.maxLineBytes} bytes without a newline; treating as protocol violation`,
        ),
      )
    }
  }

  private handleLine(line: string): void {
    if (line.length > this.maxLineBytes) {
      this.die(
        new EngineProtocolError(
          `acp frame of ${line.length} bytes exceeds the ${this.maxLineBytes}-byte limit`,
        ),
      )
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.die(
        new EngineProtocolError(`acp stdout frame is not JSON: ${boundedSnippet(line)}`, {
          details: { stderr: this.stderrDiagnostics() },
        }),
      )
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.die(new EngineProtocolError(`acp frame is not a JSON object: ${boundedSnippet(line)}`))
      return
    }
    const msg = parsed as Record<string, unknown>
    if (msg['jsonrpc'] !== '2.0') {
      this.die(new EngineProtocolError(`acp frame is not JSON-RPC 2.0: ${boundedSnippet(line)}`))
      return
    }
    const hasId = typeof msg['id'] === 'number' || typeof msg['id'] === 'string'
    const isResponse = hasId && ('result' in msg || 'error' in msg)
    const isServerRequest = hasId && typeof msg['method'] === 'string'
    const isNotification = !hasId && typeof msg['method'] === 'string'

    if (isResponse) this.handleResponse(msg)
    else if (isServerRequest) this.handleServerRequest(msg)
    else if (isNotification) this.handleNotification(msg)
    else this.die(new EngineProtocolError(`acp frame has no id/method shape: ${boundedSnippet(line)}`))
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg['id']
    if (typeof id !== 'number') {
      // We only ever send numeric ids; anything else is orphaned noise.
      this.orphanResponses += 1
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      this.orphanResponses += 1
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if ('error' in msg) {
      const err = (msg['error'] ?? {}) as Record<string, unknown>
      pending.reject(
        new EngineProtocolError(
          `acp '${pending.method}' failed: ${String(err['message'] ?? 'unknown error')} (code ${String(err['code'] ?? '?')})`,
          { details: { method: pending.method, jsonrpcCode: err['code'], data: err['data'] } },
        ),
      )
      return
    }
    pending.resolve(msg['result'])
  }

  private handleServerRequest(msg: Record<string, unknown>): void {
    const id = msg['id']
    const method = String(msg['method'])
    const params = msg['params']
    const unsupported: AcpServerRequestResponse = {
      error: { code: -32601, message: `client does not support ${method}` },
    }
    const handler = this.opts.onServerRequest
    if (!handler) {
      this.respondToServerRequest(id, unsupported)
      return
    }
    let handled: AcpServerRequestResponse | null | Promise<AcpServerRequestResponse | null>
    try {
      handled = handler(method, params)
    } catch (err) {
      this.handlerErrors += 1
      this.respondToServerRequest(id, {
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    if (handled !== null && typeof (handled as Promise<unknown>).then === 'function') {
      // Async handler (e.g. waiting for an operator decision): the response is
      // written only once it settles; the engine keeps waiting meanwhile.
      void (handled as Promise<AcpServerRequestResponse | null>).then(
        (response) => this.respondToServerRequest(id, response ?? unsupported),
        (err: unknown) => {
          this.handlerErrors += 1
          this.respondToServerRequest(id, {
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          })
        },
      )
      return
    }
    this.respondToServerRequest(id, (handled as AcpServerRequestResponse | null) ?? unsupported)
  }

  /** Answer a server request; dropped once the transport is closing or dead. */
  private respondToServerRequest(id: unknown, response: AcpServerRequestResponse): void {
    if (this.isDead || this.closing) return
    this.write({ jsonrpc: '2.0', id, ...response })
  }

  private handleNotification(msg: Record<string, unknown>): void {
    try {
      this.opts.onNotification?.(String(msg['method']), msg['params'])
    } catch {
      this.handlerErrors += 1
    }
  }

  private onStderr(chunk: string): void {
    const maxLines = this.opts.maxStderrLines ?? DEFAULT_MAX_STDERR_LINES
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.trimEnd()
      if (line === '') continue
      const bounded = line.slice(0, STDERR_LINE_MAX_CHARS)
      this.stderrTail.push(bounded)
      if (this.stderrTail.length > maxLines) this.stderrTail.shift()
      try {
        this.opts.onStderrLine?.(bounded)
      } catch {
        this.handlerErrors += 1
      }
    }
  }

  private notRunningError(method: string): EngineProtocolError {
    if (this.failure) return this.failure
    return new EngineProtocolError(
      `acp client is not running (state=${this.state}); cannot send '${method}'`,
    )
  }

  /** Record a fatal failure (if first), reject everything in flight, kill child. */
  private die(error: EngineProtocolError): void {
    if (this.state === 'dead') return
    this.dieNow(error)
    try {
      this.child?.kill()
    } catch {
      // best effort; state is already dead
    }
  }

  private dieNow(error: EngineProtocolError): void {
    if (this.state === 'dead') return
    this.state = 'dead'
    this.failure = this.failure ?? error
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(this.failure)
    }
  }
}
