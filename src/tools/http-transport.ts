import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpStdioServer, type McpDiagnosticSink, type McpToolHost } from './mcp-server.ts'

/**
 * Per-session HTTP transport for the Pluton tool bridge (Phase 6).
 * One PlutonToolBridge is registered per engine session behind a random bearer
 * token; the HTTP layer is dumb multiplexing — every authorization decision
 * still happens inside the bridge on every call.
 *
 * Deliberate surface: POST-only single JSON-RPC messages (MCP "Streamable
 * HTTP" minimal subset), `application/json` responses, no server-initiated
 * SSE stream. The TCP listener is loopback-only (`127.0.0.1`); restricted
 * native sessions never reach it directly. They use the AF_UNIX listener
 * through the helper's in-namespace loopback proxy. Tokens are compared
 * timing-safe and are never logged.
 */

export interface ToolHttpSessionSpec {
  shipId?: string
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string
  taskId: string | null
  runId: string | null
  /** Human label for diagnostics only (never a secret). */
  label?: string
}

export interface ToolHttpServerOptions {
  /** Bind address. Default `127.0.0.1` (loopback only). */
  host?: string
  /** Port; 0 = ephemeral (default). */
  port?: number
  /**
   * Optional AF_UNIX socket path. Restricted native sessions reach the bridge
   * through the helper's loopback proxy, which connects to this socket instead
   * of a host TCP port. Linux only.
   */
  unixPath?: string
  /**
   * Linux only: allocate a per-server socket in a private 0700 temp directory
   * and serve the same bridge on it. Ignored when `unixPath` is set. The
   * directory and socket are removed by `stop()`.
   */
  unixSocket?: boolean
  serverName?: string
  serverVersion?: string
  /** Hard cap on a single request body, bytes. */
  maxRequestBytes?: number
  /** Diagnostics sink. Defaults to process.stderr.write (never stdout). */
  diagnosticSink?: McpDiagnosticSink
  /** Global maximum concurrent requests being processed. Default 64. */
  maxConcurrentRequests?: number
  /** Maximum concurrent requests being processed per session. Default 8. */
  maxConcurrentRequestsPerSession?: number
  /** Maximum queued requests waiting for a concurrency slot. Default 16. */
  maxQueueDepth?: number
}

export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 64
export const DEFAULT_MAX_CONCURRENT_REQUESTS_PER_SESSION = 8
export const DEFAULT_MAX_QUEUE_DEPTH = 16

/**
 * The bridge endpoint pair a `restricted` native session needs: the AF_UNIX
 * socket the in-namespace proxy forwards to, plus the host loopback port the
 * engine keeps in its MCP URL. Undefined when no socket was allocated.
 */
export function bridgeEndpointOf(started: {
  port: number
  unixPath?: string
}): { unixPath: string; port: number } | undefined {
  return started.unixPath === undefined ? undefined : { unixPath: started.unixPath, port: started.port }
}

/**
 * Upper bound for draining in-flight tool handlers after shutdown. Handlers
 * observe the aborted signal (task.wait returns an `aborted: true` report
 * immediately), so the drain normally completes in a tick; the bound exists so
 * a wedged handler can never hold the store open forever.
 */
export const DRAIN_GRACE_MS = 5_000

interface RegisteredSession {
  server: McpStdioServer
  spec: ToolHttpSessionSpec
  activeRequests: number
}

interface QueuedRequest {
  token: string
  session: RegisteredSession
  signal: AbortSignal
  onAbort: () => void
  run: () => void
}

export class ToolHttpServer {
  private readonly http: Server
  private readonly sessions = new Map<string, RegisteredSession>()
  private readonly host: string
  private readonly port: number
  private readonly maxRequestBytes: number
  private readonly diagnosticSink: McpDiagnosticSink
  private readonly serverName: string | undefined
  private readonly serverVersion: string | undefined
  private readonly requestedUnixPath: string | null
  private readonly wantUnixSocket: boolean
  private readonly maxConcurrentRequests: number
  private readonly maxConcurrentRequestsPerSession: number
  private readonly maxQueueDepth: number
  private activeGlobalCount = 0
  private readonly queue: QueuedRequest[] = []
  private unixHttp: Server | null = null
  private boundPort: number | null = null
  private boundUnixPath: string | null = null
  /** Private directory owned by this server when it allocated the socket. */
  private ownedUnixDir: string | null = null
  /** Aborted by stop(): every in-flight handler's signal fires at once. */
  private readonly shutdown = new AbortController()
  /** Handlers currently running — drained (bounded) before stop() resolves. */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(opts: ToolHttpServerOptions = {}) {
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port ?? 0
    this.maxRequestBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
    this.diagnosticSink = opts.diagnosticSink ?? ((line) => process.stderr.write(`${line}\n`))
    this.serverName = opts.serverName
    this.serverVersion = opts.serverVersion
    this.requestedUnixPath = opts.unixPath ?? null
    this.wantUnixSocket = opts.unixSocket ?? false
    this.maxConcurrentRequests = opts.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS
    this.maxConcurrentRequestsPerSession = opts.maxConcurrentRequestsPerSession ?? DEFAULT_MAX_CONCURRENT_REQUESTS_PER_SESSION
    this.maxQueueDepth = opts.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH
    this.http = this.createHttpServer()
  }

  private createHttpServer(): Server {
    return createServer((req, res) => {
      const task = this.handleRequest(req, res)
      this.inFlight.add(task)
      const done = (): void => {
        this.inFlight.delete(task)
      }
      void task.then(done, done)
    })
  }

  /**
   * Register one engine session's bridge. Returns the bearer token the engine
   * config must carry; the token is the whole secret, so callers must write it
   * only into the session's own engine home (never into events/logs).
   */
  register(host: McpToolHost, spec: ToolHttpSessionSpec): { token: string } {
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, {
      server: new McpStdioServer({
        host,
        ...(this.serverName !== undefined ? { serverName: this.serverName } : {}),
        ...(this.serverVersion !== undefined ? { serverVersion: this.serverVersion } : {}),
        diagnosticSink: this.diagnosticSink,
      }),
      spec,
      activeRequests: 0,
    })
    return { token }
  }

  /** Drop a session's token (e.g. when its task finishes). Returns false when unknown. */
  unregister(token: string): boolean {
    const removed = this.sessions.delete(token)
    this.cancelQueuedForToken(token)
    return removed
  }

  /** Unregister all sessions matching a predicate (e.g. by taskId or runId). */
  unregisterMatching(predicate: (spec: ToolHttpSessionSpec) => boolean): number {
    let count = 0
    for (const [token, session] of this.sessions) {
      if (predicate(session.spec)) {
        this.sessions.delete(token)
        this.cancelQueuedForToken(token)
        count++
      }
    }
    return count
  }

  private cancelQueuedForToken(token: string): void {
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i]!
      if (item.token === token) {
        this.queue.splice(i, 1)
        item.signal.removeEventListener('abort', item.onAbort)
        item.onAbort()
        i--
      }
    }
  }

  sessionCount(): number {
    return this.sessions.size
  }

  /** Bound URL, or null before start(). */
  get url(): string | null {
    return this.boundPort === null ? null : `http://${this.host}:${String(this.boundPort)}/`
  }

  /**
   * Everything a `restricted` native session needs to reach this bridge:
   * the host loopback port it keeps in the MCP URL and the AF_UNIX path the
   * helper's in-namespace proxy connects to. Null before start().
   */
  get endpoint(): { host: string; port: number; url: string; unixPath?: string } | null {
    if (this.boundPort === null) return null
    return {
      host: this.host,
      port: this.boundPort,
      url: this.url as string,
      ...(this.boundUnixPath !== null ? { unixPath: this.boundUnixPath } : {}),
    }
  }

  async start(): Promise<{ host: string; port: number; url: string; unixPath?: string }> {
    if (this.boundPort !== null) throw new Error('tool http server is already started')
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(this.port, this.host, () => {
        this.http.off('error', reject)
        resolve()
      })
    })
    const address = this.http.address()
    if (address === null || typeof address === 'string') {
      throw new Error('tool http server has no bound TCP address')
    }
    this.boundPort = address.port

    if (this.requestedUnixPath !== null || this.wantUnixSocket) {
      if (process.platform !== 'linux') {
        await this.closeTcp()
        throw new Error(`AF_UNIX tool bridge is only supported on Linux (got ${process.platform})`)
      }
      let path = this.requestedUnixPath
      if (path === null) {
        const dir = mkdtempSync(join(tmpdir(), 'pluton-bridge-'))
        chmodSync(dir, 0o700)
        this.ownedUnixDir = dir
        path = join(dir, 'bridge.sock')
      }
      rmSync(path, { force: true })
      const unix = this.createHttpServer()
      try {
        await new Promise<void>((resolve, reject) => {
          unix.once('error', reject)
          unix.listen(path, () => {
            unix.off('error', reject)
            resolve()
          })
        })
        chmodSync(path, 0o600)
      } catch (error) {
        unix.close()
        rmSync(path, { force: true })
        this.removeOwnedUnixDir()
        await this.closeTcp()
        throw error
      }
      this.unixHttp = unix
      this.boundUnixPath = path
    }

    return { ...(this.endpoint as { host: string; port: number; url: string; unixPath?: string }) }
  }

  async stop(): Promise<void> {
    if (this.boundPort === null && this.unixHttp === null) return
    // 1. Signal shutdown first: long polls (task.wait) return immediately
    //    instead of outliving the store (host-mode smoke: a pending task.wait
    //    touched the closed database at process shutdown).
    this.shutdown.abort()
    for (const item of this.queue.splice(0)) {
      item.signal.removeEventListener('abort', item.onAbort)
      item.onAbort()
    }
    const unix = this.unixHttp
    this.unixHttp = null
    const unixPath = this.boundUnixPath
    this.boundUnixPath = null
    if (unix !== null) {
      await new Promise<void>((resolve, reject) => {
        unix.close((err) => (err ? reject(err) : resolve()))
        unix.closeAllConnections()
      })
      if (unixPath !== null) rmSync(unixPath, { force: true })
    }
    this.removeOwnedUnixDir()
    await this.closeTcp()
    this.boundPort = null
    // 2. Drain in-flight handlers (bounded) so store.close() is safe.
    if (this.inFlight.size > 0) {
      let graceTimer: ReturnType<typeof setTimeout> | null = null
      try {
        await Promise.race([
          Promise.allSettled([...this.inFlight]),
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, DRAIN_GRACE_MS)
          }),
        ])
      } finally {
        // The race resolves early when the handlers finish first; the pending
        // grace timer must not hold the event loop (or a test worker) alive.
        if (graceTimer !== null) clearTimeout(graceTimer)
      }
    }
  }

  private removeOwnedUnixDir(): void {
    const dir = this.ownedUnixDir
    if (dir === null) return
    this.ownedUnixDir = null
    try {
      rmdirSync(dir)
    } catch {
      // Best effort: a leftover empty temp directory is harmless.
    }
  }

  private async closeTcp(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.close((err) => (err ? reject(err) : resolve()))
      this.http.closeAllConnections() // keep-alive sockets must not hold the listener alive
    })
  }

  // -- private plumbing (kept dumb on purpose: authn lookup + body cap only) --

  /**
   * Signal handed to one request's tool call: fires when that client goes away
   * or when the server shuts down, whichever happens first.
   */
  private requestSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
    const closed = new AbortController()
    const onAbort = (): void => {
      closed.abort()
    }
    req.once('close', onAbort)
    res.once('close', onAbort)
    req.socket?.once('close', onAbort)
    return AbortSignal.any([this.shutdown.signal, closed.signal])
  }

  private bearerToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization
    if (typeof header !== 'string') return null
    const match = /^Bearer (.+)$/i.exec(header.trim())
    return match?.[1] ?? null
  }

  /** Timing-safe token lookup so equality checks never short-circuit per byte. */
  private sessionForToken(token: string): RegisteredSession | null {
    const candidate = Buffer.from(token, 'utf8')
    for (const [stored, session] of this.sessions) {
      const known = Buffer.from(stored, 'utf8')
      if (known.length === candidate.length && timingSafeEqual(known, candidate)) return session
    }
    return null
  }

  private async readBody(req: IncomingMessage): Promise<string | null> {
    const chunks: Buffer[] = []
    let total = 0
    let tooLarge = false
    for await (const chunk of req) {
      const buf = chunk as Buffer
      total += buf.length
      if (total > this.maxRequestBytes) {
        tooLarge = true
        if (total > this.maxRequestBytes * 2) {
          req.resume()
          break
        }
        continue // keep draining so the 413 can actually be delivered
      }
      chunks.push(buf)
    }
    return tooLarge ? null : Buffer.concat(chunks).toString('utf8')
  }

  private acquireSlot(token: string, session: RegisteredSession, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(new Error('aborted'))
    }
    if (
      this.activeGlobalCount < this.maxConcurrentRequests &&
      session.activeRequests < this.maxConcurrentRequestsPerSession
    ) {
      this.activeGlobalCount++
      session.activeRequests++
      return Promise.resolve(() => {
        session.activeRequests--
        this.activeGlobalCount--
        this.drainQueue()
      })
    }

    if (this.queue.length >= this.maxQueueDepth) {
      const err = new Error('capacity_exhausted')
      ;(err as { code?: string }).code = 'CAPACITY_EXHAUSTED'
      return Promise.reject(err)
    }

    return new Promise<() => void>((resolve, reject) => {
      const item: QueuedRequest = {
        token,
        session,
        signal,
        onAbort: () => {
          this.removeFromQueue(item)
          reject(new Error('aborted'))
        },
        run: () => {
          this.activeGlobalCount++
          session.activeRequests++
          signal.removeEventListener('abort', item.onAbort)
          resolve(() => {
            session.activeRequests--
            this.activeGlobalCount--
            this.drainQueue()
          })
        },
      }
      signal.addEventListener('abort', item.onAbort, { once: true })
      this.queue.push(item)
    })
  }

  private removeFromQueue(item: QueuedRequest): void {
    const idx = this.queue.indexOf(item)
    if (idx !== -1) {
      this.queue.splice(idx, 1)
    }
  }

  private drainQueue(): void {
    if (this.queue.length === 0) return
    if (this.activeGlobalCount >= this.maxConcurrentRequests) return

    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i]!
      if (item.signal.aborted) {
        this.queue.splice(i, 1)
        item.signal.removeEventListener('abort', item.onAbort)
        item.onAbort()
        i--
        continue
      }
      if (item.session.activeRequests < this.maxConcurrentRequestsPerSession) {
        this.queue.splice(i, 1)
        item.run()
        if (this.activeGlobalCount >= this.maxConcurrentRequests) break
        i--
      }
    }
  }

  private reply(res: ServerResponse, status: number, payload: unknown): void {
    if (res.destroyed || res.writableEnded) return // client is gone; nothing to answer
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The client may vanish at any moment (engine cancelled, run stopping):
    // a destroyed socket must surface as an aborted tool call, never as an
    // unhandled 'error' or a write-after-destroy crash.
    res.on('error', () => {
      // Swallowed by design: the response is best-effort once the socket is gone.
    })
    try {
      if (req.method !== 'POST') {
        this.reply(res, 405, { error: 'method_not_allowed', message: 'the MCP endpoint accepts POST JSON-RPC messages only' })
        return
      }
      const token = this.bearerToken(req)
      const session = token === null ? null : this.sessionForToken(token)
      if (session === null || token === null) {
        this.reply(res, 401, { error: 'unauthorized', message: 'missing or unknown bearer token' })
        return
      }
      const body = await this.readBody(req)
      if (body === null) {
        this.reply(res, 413, { error: 'payload_too_large', message: `request exceeds ${String(this.maxRequestBytes)} bytes` })
        return
      }
      const signal = this.requestSignal(req, res)
      let releaseSlot: () => void
      try {
        releaseSlot = await this.acquireSlot(token, session, signal)
      } catch (e) {
        if ((e as { code?: string })?.code === 'CAPACITY_EXHAUSTED' || (e instanceof Error && e.message === 'capacity_exhausted')) {
          this.reply(res, 429, { error: 'capacity_exhausted', message: 'tool bridge concurrency capacity exceeded' })
          return
        }
        return
      }
      if (signal.aborted) {
        releaseSlot()
        return
      }
      try {
        const response = await session.server.handleLine(body, { signal })
        if (response === null) {
          if (!res.destroyed && !res.writableEnded) res.writeHead(202).end() // notification accepted, no answer by design
          return
        }
        if (res.destroyed || res.writableEnded) return // handler outlived its client (shutdown/disconnect)
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(response) })
        res.end(response)
      } finally {
        releaseSlot()
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.diagnosticSink(`tool-http: request failed: ${message}`)
      if (res.destroyed || res.writableEnded) return
      if (!res.headersSent) this.reply(res, 500, { error: 'internal_error', message: 'request handling failed' })
      else res.end()
    }
  }
}
