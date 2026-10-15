import { PassThrough } from 'node:stream'
import type { AcpChild, AcpSpawnFn } from '../../src/engines/acp/client.ts'

/**
 * In-process fake ACP agent for offline tests: behaves like a spawned child
 * process (stdin/stdout/stderr streams, spawn/error/exit events, kill) so the
 * real AcpClient transport code runs unmodified. Tests script agent behavior
 * by overriding `onMessage` / `onNotification`.
 */

export interface FakeAgentMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class FakeAcpAgent {
  readonly received: FakeAgentMessage[] = []
  readonly receivedNotifications: FakeAgentMessage[] = []
  readonly receivedResponses: FakeAgentMessage[] = []
  killed = false
  exitCode: number | null = null
  /** When true, ending stdin does not terminate the fake (tests kill path). */
  ignoreStdinEnd = false
  /** Spawn arguments/options captured for assertions. */
  spawnArgs: string[] = []
  spawnCwd = ''
  spawnEnv: Record<string, string> = {}

  /** Tests override: handle a request. If it returns false, the request is answered with -32601. */
  onMessage: (msg: FakeAgentMessage, agent: FakeAcpAgent) => boolean = () => false
  /** Tests override: observe notifications (session/cancel etc.). */
  onNotification: (msg: FakeAgentMessage, agent: FakeAcpAgent) => void = () => {}

  private readonly stdinPass = new PassThrough()
  private readonly stdoutPass = new PassThrough()
  private readonly stderrPass = new PassThrough()
  private readonly spawnHandlers = new Set<() => void>()
  private readonly errorHandlers = new Set<(err: Error) => void>()
  private readonly exitHandlers = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>()
  private lineBuffer = ''
  private exited = false

  readonly child: AcpChild

  constructor() {
    const self = this
    this.stdinPass.on('data', (chunk: Buffer) => this.feed(chunk.toString('utf8')))
    this.stdinPass.on('end', () => {
      if (!this.ignoreStdinEnd) this.emitExit(0, null)
    })
    this.child = {
      pid: 4242,
      stdin: this.stdinPass,
      stdout: this.stdoutPass,
      stderr: this.stderrPass,
      kill: () => {
        this.killed = true
        // Real processes exit asynchronously; keep the fake faithful so
        // error-then-exit ordering matches node:child_process behavior.
        setImmediate(() => this.emitExit(null, 'SIGTERM'))
        return true
      },
      on: ((event: string, listener: (...args: never[]) => void) => {
        if (event === 'spawn') self.spawnHandlers.add(listener as () => void)
        else if (event === 'error') self.errorHandlers.add(listener as (err: Error) => void)
        else if (event === 'exit') {
          self.exitHandlers.add(listener as (code: number | null, signal: NodeJS.Signals | null) => void)
        }
        return self.child
      }) as unknown as AcpChild['on'],
    }
  }

  private feed(chunk: string): void {
    this.lineBuffer += chunk
    for (;;) {
      const idx = this.lineBuffer.indexOf('\n')
      if (idx < 0) break
      const line = this.lineBuffer.slice(0, idx).replace(/\r$/, '')
      this.lineBuffer = this.lineBuffer.slice(idx + 1)
      if (line.trim() === '') continue
      let msg: FakeAgentMessage
      try {
        msg = JSON.parse(line) as FakeAgentMessage
      } catch {
        continue
      }
      this.received.push(msg)
      if (msg.id !== undefined && msg.method === undefined) {
        this.receivedResponses.push(msg)
        continue
      }
      if (msg.method !== undefined && msg.id === undefined) {
        this.receivedNotifications.push(msg)
        this.onNotification(msg, this)
        continue
      }
      if (msg.method !== undefined) {
        const handled = this.onMessage(msg, this)
        if (!handled) {
          this.respondError(msg.id as number, -32601, `fake agent: no handler for ${msg.method}`)
        }
      }
    }
  }

  // ---- agent -> client traffic

  send(message: FakeAgentMessage): void {
    this.stdoutPass.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  sendRawLine(line: string): void {
    this.stdoutPass.write(`${line}\n`)
  }

  /** Write bytes without a trailing newline (framing-violation tests). */
  sendPartial(text: string): void {
    this.stdoutPass.write(text)
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result })
  }

  respondError(id: number | string, code: number, message: string, data?: unknown): void {
    this.send({ id, error: data === undefined ? { code, message } : { code, message, data } })
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params })
  }

  stderrText(text: string): void {
    this.stderrPass.write(text)
  }

  // ---- lifecycle

  emitSpawn(): void {
    if (this.exited) return
    for (const handler of [...this.spawnHandlers]) handler()
  }

  emitError(err: Error): void {
    for (const handler of [...this.errorHandlers]) handler(err)
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    for (const handler of [...this.exitHandlers]) handler(code, signal)
  }

  get isExited(): boolean {
    return this.exited
  }
}

export interface FakeSpawn {
  spawnFn: AcpSpawnFn
  agents: FakeAcpAgent[]
  lastAgent(): FakeAcpAgent
}

export function fakeSpawn(factory?: () => FakeAcpAgent): FakeSpawn {
  const agents: FakeAcpAgent[] = []
  const spawnFn: AcpSpawnFn = (command, args, options) => {
    const agent = factory ? factory() : new FakeAcpAgent()
    agent.spawnArgs = [command, ...args]
    agent.spawnCwd = options.cwd
    agent.spawnEnv = options.env
    agents.push(agent)
    setImmediate(() => agent.emitSpawn())
    return agent.child
  }
  return {
    spawnFn,
    agents,
    lastAgent: () => {
      const agent = agents.at(-1)
      if (!agent) throw new Error('fakeSpawn: no agent was spawned')
      return agent
    },
  }
}
