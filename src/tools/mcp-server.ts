import { PLUTON_VERSION } from '../version.ts'

/**
 * MCP stdio protocol layer (transport + JSON-RPC 2.0 + initialize handshake)
 * for Pluton's restricted tool bridge. Authorization and tool behavior live
 * behind `McpToolHost`; this file is pure protocol code with no I/O beyond the
 * injected streams.
 *
 * Rules encoded here:
 * - One JSON object per line, no Content-Length framing (MCP stdio transport).
 *   JSON.stringify escapes control characters, so a serialized message can
 *   never contain a raw newline.
 * - stdout is the protocol channel ONLY: every diagnostic goes to the
 *   injectable sink (process.stderr.write by default).
 * - tools/list and tools/call before initialize fail with -32002 (MCP:
 *   "server not initialized"). A tool failure decided by the host is a TOOL
 *   error: a successful JSON-RPC response with `isError: true`. Only protocol
 *   trouble uses an `error` response.
 * - Notifications (a message without an `id` member) never get a response,
 *   even when their payload is malformed schema-wise. A line that is not valid
 *   JSON cannot be identified as a notification, so it is answered with -32700
 *   and id null (per JSON-RPC 2.0).
 * - Requests are answered in arrival order.
 */

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpToolCallResult {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

export interface McpToolHost {
  listTools(): McpToolInfo[]
  call(name: string, args: unknown): Promise<McpToolCallResult>
}

/** Every diagnostic line the server emits. Never stdout. */
export type McpDiagnosticSink = (line: string) => void

export interface McpStdioServerOptions {
  host: McpToolHost
  /** serverInfo.name reported by initialize. Defaults to 'pluton'. */
  serverName?: string
  /** serverInfo.version reported by initialize. Defaults to PLUTON_VERSION. */
  serverVersion?: string
  /** A single line heavier than this many UTF-8 bytes is rejected with -32700. */
  maxMessageBytes?: number
  /** Diagnostics destination. Defaults to process.stderr.write. */
  diagnosticSink?: McpDiagnosticSink
}

export const MCP_PROTOCOL_VERSION = '2024-11-05'

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_INTERNAL_ERROR = -32603
const JSONRPC_NOT_INITIALIZED = -32002

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024
const NEWLINE_BYTE = 0x0a
const DIAGNOSTIC_SNIPPET_MAX = 500

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Collapse to one line and bound the length (diagnostics must stay bounded). */
function boundedOneLine(text: string, max = DIAGNOSTIC_SNIPPET_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

export class McpStdioServer {
  private readonly host: McpToolHost
  private readonly serverName: string
  private readonly serverVersion: string
  private readonly maxMessageBytes: number
  private readonly diagnosticSink: McpDiagnosticSink
  private initialized = false

  constructor(options: McpStdioServerOptions) {
    this.host = options.host
    this.serverName = options.serverName ?? 'pluton'
    this.serverVersion = options.serverVersion ?? PLUTON_VERSION
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    this.diagnosticSink =
      options.diagnosticSink ??
      ((line) => {
        process.stderr.write(`${line}\n`)
      })
  }

  /**
   * Handles one raw input line. Returns the response line to write, or null
   * when the message must not be answered (notifications, blank lines). Never
   * rejects for malformed input; a line heavier than the byte bound is
   * rejected without being parsed.
   */
  async handleLine(line: string): Promise<string | null> {
    if (line.trim() === '') return null
    if (Buffer.byteLength(line, 'utf8') > this.maxMessageBytes) {
      return this.errorJson(null, JSONRPC_PARSE_ERROR, this.oversizeMessage())
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return this.errorJson(null, JSONRPC_PARSE_ERROR, 'parse error: message is not valid JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return this.errorJson(null, JSONRPC_PARSE_ERROR, 'parse error: message must be a JSON object')
    }
    const msg = parsed as Record<string, unknown>
    // JSON-RPC 2.0: a message without an `id` member is a notification.
    if (!Object.prototype.hasOwnProperty.call(msg, 'id')) return null
    const rawId = msg['id']
    const id: string | number | null = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null
    return await this.dispatch(msg, id)
  }

  /**
   * Reads newline-delimited messages until EOF, answering requests in order
   * and resolving cleanly. `write` receives one complete response line per
   * call (never with an embedded newline); it may be sync or async.
   */
  async serve(
    input: AsyncIterable<string | Buffer>,
    write: (line: string) => void | Promise<void>,
  ): Promise<void> {
    let pending: Buffer[] = []
    let pendingBytes = 0
    let discardingOversize = false

    const emit = async (line: Buffer): Promise<void> => {
      if (line.length > this.maxMessageBytes) {
        await write(this.errorJson(null, JSONRPC_PARSE_ERROR, this.oversizeMessage()))
        return
      }
      const text = line.toString('utf8')
      const trimmed = text.endsWith('\r') ? text.slice(0, -1) : text
      if (trimmed.trim() === '') return
      const response = await this.handleLine(trimmed)
      if (response !== null) await write(response)
    }

    for await (const raw of input) {
      let chunk: Buffer = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
      if (discardingOversize) {
        const nl = chunk.indexOf(NEWLINE_BYTE)
        if (nl < 0) continue
        discardingOversize = false
        chunk = chunk.subarray(nl + 1)
      }
      for (;;) {
        const nl = chunk.indexOf(NEWLINE_BYTE)
        if (nl < 0) {
          if (pendingBytes + chunk.length > this.maxMessageBytes) {
            // Over the bound mid-line: reject once and stop buffering until
            // the next newline instead of growing the line.
            pending = []
            pendingBytes = 0
            discardingOversize = true
            await write(this.errorJson(null, JSONRPC_PARSE_ERROR, this.oversizeMessage()))
            break
          }
          if (chunk.length > 0) {
            pending.push(chunk)
            pendingBytes += chunk.length
          }
          break
        }
        const segment = chunk.subarray(0, nl)
        chunk = chunk.subarray(nl + 1)
        const line = pending.length === 0 ? segment : Buffer.concat([...pending, segment])
        pending = []
        pendingBytes = 0
        await emit(line)
      }
    }
    // A final line without a trailing newline is still a line.
    if (!discardingOversize && pending.length > 0) {
      await emit(Buffer.concat(pending))
    }
  }

  /** Binds process.stdin/process.stdout. The only production entry point. */
  async runStdio(): Promise<void> {
    await this.serve(process.stdin, (line) => {
      process.stdout.write(`${line}\n`)
    })
  }

  private async dispatch(msg: Record<string, unknown>, id: string | number | null): Promise<string | null> {
    const method = msg['method']
    if (typeof method !== 'string' || method === '') {
      return this.errorJson(id, JSONRPC_INVALID_REQUEST, 'invalid request: missing method')
    }
    switch (method) {
      case 'initialize':
        // The gate opens on the initialize request (not the initialized
        // notification), matching the MCP SDKs. A repeated initialize is
        // answered idempotently instead of failing.
        this.initialized = true
        return this.resultJson(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.serverName, version: this.serverVersion },
        })
      case 'notifications/initialized':
        // Pure notification; if a client wrongly attaches an id there is
        // still no result to report.
        return null
      case 'ping':
        return this.resultJson(id, {})
      case 'tools/list':
        if (!this.initialized) {
          return this.errorJson(id, JSONRPC_NOT_INITIALIZED, 'server not initialized')
        }
        try {
          return this.resultJson(id, { tools: this.host.listTools() })
        } catch (err) {
          const message = errorMessage(err)
          this.diagnostic(`tools/list failed: ${boundedOneLine(message)}`)
          return this.errorJson(id, JSONRPC_INTERNAL_ERROR, message)
        }
      case 'tools/call':
        return await this.dispatchToolCall(msg, id)
      default:
        return this.errorJson(id, JSONRPC_METHOD_NOT_FOUND, `method not found: ${boundedOneLine(method)}`)
    }
  }

  private async dispatchToolCall(msg: Record<string, unknown>, id: string | number | null): Promise<string> {
    if (!this.initialized) {
      return this.errorJson(id, JSONRPC_NOT_INITIALIZED, 'server not initialized')
    }
    const params = msg['params']
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return this.errorJson(id, JSONRPC_INVALID_PARAMS, 'invalid params: expected an object with a tool name')
    }
    const name = (params as Record<string, unknown>)['name']
    if (typeof name !== 'string' || name === '') {
      return this.errorJson(id, JSONRPC_INVALID_PARAMS, 'invalid params: missing tool name')
    }
    const args = (params as Record<string, unknown>)['arguments']

    let result: McpToolCallResult
    try {
      result = await this.host.call(name, args)
    } catch (err) {
      const message = errorMessage(err)
      this.diagnostic(`tools/call '${name}' threw: ${boundedOneLine(message)}`)
      return this.resultJson(id, {
        content: [{ type: 'text', text: JSON.stringify({ code: 'internal_error', message }) }],
        isError: true,
      })
    }

    const failure = result.error ?? {
      code: 'internal_error',
      message: 'tool reported failure without an error detail',
    }
    const serialized = this.serializeToolValue(result.ok ? (result.data ?? null) : failure, name)
    return this.resultJson(id, {
      content: [{ type: 'text', text: serialized.text }],
      isError: !result.ok || serialized.isError,
    })
  }

  private serializeToolValue(value: unknown, name: string): { text: string; isError: boolean } {
    try {
      return { text: JSON.stringify(value) ?? 'null', isError: false }
    } catch {
      const message = 'tool result is not JSON-serializable'
      this.diagnostic(`tools/call '${name}': ${message}`)
      return { text: JSON.stringify({ code: 'internal_error', message }), isError: true }
    }
  }

  private resultJson(id: string | number | null, result: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id, result })
  }

  private errorJson(id: string | number | null, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private oversizeMessage(): string {
    return `message exceeds the ${this.maxMessageBytes}-byte limit`
  }

  private diagnostic(message: string): void {
    try {
      this.diagnosticSink(message)
    } catch {
      // A broken diagnostic sink must never break the protocol channel.
    }
  }
}
