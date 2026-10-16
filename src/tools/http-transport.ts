import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { McpStdioServer, type McpDiagnosticSink, type McpToolHost } from './mcp-server.ts'

/**
 * Per-session HTTP transport for the restricted Pluton tool bridge (Phase 6).
 * One PlutonToolBridge is registered per engine session behind a random bearer
 * token; the HTTP layer is dumb multiplexing — every authorization decision
 * still happens inside the bridge on every call.
 *
 * Deliberate surface: POST-only single JSON-RPC messages (MCP "Streamable
 * HTTP" minimal subset), `application/json` responses, no server-initiated
 * SSE stream. Bound to loopback by default; Docker Desktop reaches it from
 * containers via host.docker.internal. Tokens are compared timing-safe and are
 * never logged.
 */

export interface ToolHttpSessionSpec {
  museId: string
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
  serverName?: string
  serverVersion?: string
  /** Hard cap on a single request body, bytes. */
  maxRequestBytes?: number
  /** Diagnostics sink. Defaults to process.stderr.write (never stdout). */
  diagnosticSink?: McpDiagnosticSink
}

export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024

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
  private boundPort: number | null = null
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
    this.http = createServer((req, res) => {
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
    })
    return { token }
  }

  /** Drop a session's token (e.g. when its task finishes). Returns false when unknown. */
  unregister(token: string): boolean {
    return this.sessions.delete(token)
  }

  sessionCount(): number {
    return this.sessions.size
  }

  /** Bound URL, or null before start(). */
  get url(): string | null {
    return this.boundPort === null ? null : `http://${this.host}:${String(this.boundPort)}/`
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
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
    return { host: this.host, port: address.port, url: this.url as string }
  }

  async stop(): Promise<void> {
    if (this.boundPort === null) return
    // 1. Signal shutdown first: long polls (task.wait) return immediately
    //    instead of outliving the store (host-mode smoke: a pending task.wait
    //    touched the closed database at process shutdown).
    this.shutdown.abort()
    await new Promise<void>((resolve, reject) => {
      this.http.close((err) => (err ? reject(err) : resolve()))
      this.http.closeAllConnections() // keep-alive sockets must not hold the listener alive
    })
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

  // -- private plumbing (kept dumb on purpose: authn lookup + body cap only) --

  /**
   * Signal handed to one request's tool call: fires when that client goes away
   * or when the server shuts down, whichever happens first.
   */
  private requestSignal(res: ServerResponse): AbortSignal {
    const closed = new AbortController()
    res.once('close', () => {
      closed.abort()
    })
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
        continue // keep draining so the 413 can actually be delivered
      }
      chunks.push(buf)
    }
    return tooLarge ? null : Buffer.concat(chunks).toString('utf8')
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
      if (session === null) {
        this.reply(res, 401, { error: 'unauthorized', message: 'missing or unknown bearer token' })
        return
      }
      const body = await this.readBody(req)
      if (body === null) {
        this.reply(res, 413, { error: 'payload_too_large', message: `request exceeds ${String(this.maxRequestBytes)} bytes` })
        return
      }
      const response = await session.server.handleLine(body, { signal: this.requestSignal(res) })
      if (response === null) {
        if (!res.destroyed && !res.writableEnded) res.writeHead(202).end() // notification accepted, no answer by design
        return
      }
      if (res.destroyed || res.writableEnded) return // handler outlived its client (shutdown/disconnect)
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(response) })
      res.end(response)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.diagnosticSink(`tool-http: request failed: ${message}`)
      if (res.destroyed || res.writableEnded) return
      if (!res.headersSent) this.reply(res, 500, { error: 'internal_error', message: 'request handling failed' })
      else res.end()
    }
  }
}
