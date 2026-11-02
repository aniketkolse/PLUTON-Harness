import {
  EngineAuthMissingError,
  EngineProtocolError,
} from '../../domain/errors.ts'
import { PLUTON_VERSION } from '../../version.ts'
import { redactSecrets, sseDataFrames } from './client.ts'

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

/**
 * Minimal MCP client for Pluton's own HTTP tool bridge. It implements only
 * the methods Pluton actually uses (`initialize`, `tools/list`, `tools/call`)
 * and never spawns a process. Tool results are mapped back to the same
 * `McpToolCallResult` shape the in-process bridge produces.
 */

const MCP_PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_ERROR_SNIPPET = 300

export interface McpHttpClientOptions {
  url: string
  headers?: Record<string, string>
  timeoutMs?: number
  /** Adapter kind reported by errors; defaults to 'openai-compatible'. */
  engineKind?: string
  clientName?: string
  fetchFn?: typeof fetch
}

export interface McpInitializeResult {
  protocolVersion?: string
  serverInfo?: { name?: string; version?: string }
  capabilities?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_ERROR_SNIPPET
    ? `${collapsed.slice(0, MAX_ERROR_SNIPPET)}…`
    : collapsed
}

export class McpHttpClient {
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly engineKind: string
  private readonly clientName: string
  private readonly fetchFn: typeof fetch
  private readonly secrets: string[]
  private nextId = 1
  private initialized = false
  private closed = false
  private initializeResult: McpInitializeResult | null = null

  constructor(opts: McpHttpClientOptions) {
    this.url = opts.url
    this.headers = opts.headers ?? {}
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.engineKind = opts.engineKind ?? 'openai-compatible'
    this.clientName = opts.clientName ?? 'pluton'
    this.fetchFn = opts.fetchFn ?? fetch
    this.secrets = Object.values(this.headers).flatMap((value) => {
      const bearer = /^Bearer\s+(.+)$/i.exec(value)
      return bearer?.[1] !== undefined ? [value, bearer[1]] : [value]
    })
  }

  async initialize(): Promise<McpInitializeResult> {
    if (this.initialized && this.initializeResult !== null) return this.initializeResult
    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: PLUTON_VERSION },
    })
    if (!isRecord(result)) {
      throw new EngineProtocolError('MCP endpoint returned a malformed initialize result')
    }
    this.initializeResult = result as McpInitializeResult
    await this.notify('notifications/initialized', {})
    this.initialized = true
    return this.initializeResult
  }

  async listTools(): Promise<McpToolInfo[]> {
    this.assertReady()
    const result = await this.request('tools/list', {})
    if (!isRecord(result) || !Array.isArray(result['tools'])) {
      throw new EngineProtocolError('MCP endpoint returned a malformed tools/list result')
    }
    return result['tools'].map((entry, index) => {
      if (!isRecord(entry) || typeof entry['name'] !== 'string' || entry['name'] === '') {
        throw new EngineProtocolError(`MCP tools/list entry ${index} has no tool name`)
      }
      return {
        name: entry['name'],
        description: typeof entry['description'] === 'string' ? entry['description'] : '',
        inputSchema: isRecord(entry['inputSchema']) ? entry['inputSchema'] : {},
      }
    })
  }

  async callTool(
    name: string,
    args: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<McpToolCallResult> {
    this.assertReady()
    const result = await this.request('tools/call', { name, arguments: args }, opts)
    if (!isRecord(result) || !Array.isArray(result['content'])) {
      throw new EngineProtocolError(`MCP tools/call '${name}' returned a malformed result`)
    }
    const textParts = result['content']
      .filter((part): part is Record<string, unknown> => isRecord(part) && part['type'] === 'text')
      .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
    const text = textParts.join('\n')
    const isError = result['isError'] === true
    if (isError) {
      const parsed = tryParseJson(text)
      if (isRecord(parsed) && typeof parsed['code'] === 'string') {
        return {
          ok: false,
          error: {
            code: parsed['code'],
            message: typeof parsed['message'] === 'string' ? parsed['message'] : text,
          },
        }
      }
      return { ok: false, error: { code: 'tool_error', message: text || `tool '${name}' failed` } }
    }
    return { ok: true, data: tryParseJson(text) ?? text }
  }

  /** Idempotent: the bridge is stateless over HTTP; no session teardown call. */
  async close(): Promise<void> {
    this.closed = true
  }

  private assertReady(): void {
    if (this.closed) {
      throw new EngineProtocolError('MCP client is closed')
    }
    if (!this.initialized) {
      throw new EngineProtocolError('MCP client is not initialized; call initialize() first')
    }
  }

  private async request(
    method: string,
    params: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const id = this.nextId++
    const response = await this.post(
      { jsonrpc: '2.0', id, method, params },
      opts.signal,
      true,
    )
    const messages = await this.readMessages(response, method)
    const message = messages.find((entry) => entry['id'] === id)
    if (message === undefined) {
      throw new EngineProtocolError(`MCP endpoint returned no response for '${method}'`)
    }
    const error = message['error']
    if (isRecord(error)) {
      const code = typeof error['code'] === 'number' ? error['code'] : -32603
      const text = typeof error['message'] === 'string' ? error['message'] : 'unknown MCP error'
      throw new EngineProtocolError(
        `MCP '${method}' failed (${String(code)}): ${oneLine(
          redactSecrets(text, this.secrets),
        )}`,
      )
    }
    return message['result']
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const response = await this.post({ jsonrpc: '2.0', method, params }, undefined, false)
    // A notification must not produce a JSON-RPC response. Drain any body so
    // the connection can be reused; malformed bodies are not meaningful here.
    await response.text().catch(() => '')
  }

  private async post(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
    expectResponse: boolean,
  ): Promise<Response> {
    if (this.closed) throw new EngineProtocolError('MCP client is closed')
    const headers = new Headers(this.headers)
    headers.set('content-type', 'application/json')
    headers.set('accept', 'application/json, text/event-stream')
    const combined =
      signal === undefined
        ? AbortSignal.timeout(this.timeoutMs)
        : AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
    let response: Response
    try {
      response = await this.fetchFn(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: combined,
      })
    } catch (err) {
      if (signal?.aborted === true) throw err
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new EngineProtocolError(`MCP endpoint request timed out after ${this.timeoutMs}ms`)
      }
      const message = err instanceof Error ? err.message : String(err)
      throw new EngineProtocolError(
        `MCP endpoint request failed: ${oneLine(redactSecrets(message, this.secrets))}`,
        { cause: err },
      )
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new EngineAuthMissingError(
          this.engineKind,
          `the MCP tool endpoint rejected Pluton's session token (HTTP ${response.status}); restart the session`,
        )
      }
      throw new EngineProtocolError(
        `MCP endpoint request failed: HTTP ${response.status}`,
        { details: { status: response.status } },
      )
    }
    if (!expectResponse) return response
    return response
  }

  private async readMessages(response: Response, method: string): Promise<Record<string, unknown>[]> {
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (contentType.includes('text/event-stream')) {
      const messages: Record<string, unknown>[] = []
      for await (const data of sseDataFrames(response, 'MCP endpoint')) {
        const parsed = tryParseJson(data)
        if (!isRecord(parsed)) {
          throw new EngineProtocolError(`MCP endpoint sent a malformed event for '${method}'`)
        }
        messages.push(parsed)
      }
      return messages
    }
    const text = await response.text()
    if (text.trim() === '') return []
    const parsed = tryParseJson(text)
    if (!isRecord(parsed)) {
      throw new EngineProtocolError(`MCP endpoint returned a malformed response for '${method}'`)
    }
    return [parsed]
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
