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
  runId: string
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

  constructor(opts: ToolHttpServerOptions = {}) {
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port ?? 0
    this.maxRequestBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
    this.diagnosticSink = opts.diagnosticSink ?? ((line) => process.stderr.write(`${line}\n`))
    this.serverName = opts.serverName
    this.serverVersion = opts.serverVersion
    this.http = createServer((req, res) => {
      void this.handleRequest(req, res)
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
    await new Promise<void>((resolve, reject) => {
      this.http.close((err) => (err ? reject(err) : resolve()))
      this.http.closeAllConnections() // keep-alive sockets must not hold the listener alive
    })
    this.boundPort = null
  }

  // -- private plumbing (kept dumb on purpose: authn lookup + body cap only) --

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
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      const response = await session.server.handleLine(body)
      if (response === null) {
        res.writeHead(202).end() // notification accepted, no answer by design
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(response) })
      res.end(response)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.diagnosticSink(`tool-http: request failed: ${message}`)
      if (!res.headersSent) this.reply(res, 500, { error: 'internal_error', message: 'request handling failed' })
      else res.end()
    }
  }
}
