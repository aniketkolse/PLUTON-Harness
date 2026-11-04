import {
  EngineAuthMissingError,
  EngineProtocolError,
} from '../../domain/errors.ts'
import type { ProviderAuthConfig } from '../../providers/types.ts'

/**
 * OpenAI-compatible HTTP transport. This file owns protocol mechanics only:
 * URLs, auth headers, model listing, and chat-completion streaming. No
 * provider URL, credential, or model id is ever baked in here.
 *
 * Secret discipline: the key exists only inside the request header. It is
 * never placed in a URL, a query string, a log line, or an error message;
 * response snippets are redacted before they can reach a caller.
 */

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_ERROR_SNIPPET = 300
const MAX_SSE_FRAME_BYTES = 4 * 1024 * 1024

export interface OpenAICompatibleClientOptions {
  baseUrl: string
  apiKey: string
  auth: ProviderAuthConfig
  /** Non-secret headers sent on every request. Never put a credential here. */
  headers?: Record<string, string>
  modelsPath?: string
  chatPath?: string
  timeoutMs?: number
  /** Adapter kind used in error messages; defaults to 'openai-compatible'. */
  engineKind?: string
  /** Provider id used only in setup hints. Never a credential. */
  providerId?: string
  fetchFn?: typeof fetch
}

export interface RemoteModel {
  /** Exact id reported by the provider. Never normalized or renamed. */
  id: string
  label?: string
}

export interface ChatToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  name?: string
  tool_calls?: ChatToolCall[]
}

export interface ChatToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ChatToolDefinition[]
  temperature?: number
  signal?: AbortSignal
}

export interface ChatToolCallDelta {
  index: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; calls: ChatToolCallDelta[] }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'finish'; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Replace the exact credential plus common key-shaped tokens. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let result = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    result = result.split(secret).join('[redacted]')
  }
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
  result = result.replace(/\b(?:sk|pk|rk|ak)[-_][A-Za-z0-9._-]{6,}\b/g, '[redacted]')
  return result
}

function oneLine(text: string, max = MAX_ERROR_SNIPPET): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Build request headers from non-secret config plus the credential.
 * Any authorization supplied through `headers` is dropped: the credential
 * path is the only way an Authorization header is produced.
 */
export function buildAuthHeaders(
  auth: ProviderAuthConfig,
  apiKey: string,
  extra?: Record<string, string>,
): Headers {
  const headers = new Headers(extra)
  headers.delete('authorization')
  if (auth.style === 'bearer') {
    headers.set('authorization', `${auth.prefix ?? 'Bearer '}${apiKey}`)
  } else {
    headers.set(auth.header as string, `${auth.prefix ?? ''}${apiKey}`)
  }
  return headers
}

function abortReason(err: unknown, callerSignal: AbortSignal | undefined): 'caller' | 'timeout' | null {
  if (callerSignal?.aborted === true) return 'caller'
  if (!(err instanceof Error)) return null
  if (err.name === 'TimeoutError') return 'timeout'
  if (err.name === 'AbortError') return 'timeout'
  return null
}

/**
 * Yield the payload of each `data:` field in an SSE response. Framing is
 * buffered across arbitrary chunk boundaries; `[DONE]` is yielded verbatim.
 * Malformed framing is a protocol error, never silently skipped.
 */
export async function* sseDataFrames(
  response: Response,
  context: string,
): AsyncGenerator<string> {
  const body = response.body
  if (body === null) {
    throw new EngineProtocolError(`${context} returned an empty streaming response`)
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const drain = function* (final: boolean): Generator<string> {
    for (;;) {
      let index = buffer.indexOf('\n\n')
      let eventText: string | null = null
      if (index >= 0) {
        eventText = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
      } else if (final && buffer.trim() !== '') {
        eventText = buffer
        buffer = ''
      } else {
        return
      }
      const dataLines: string[] = []
      for (const rawLine of eventText.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (!line.startsWith('data:')) continue
        const value = line.slice(5)
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
      }
      if (dataLines.length > 0) yield dataLines.join('\n')
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      if (buffer.length > MAX_SSE_FRAME_BYTES) {
        throw new EngineProtocolError(`${context} sent an oversized streaming frame`)
      }
      yield* drain(false)
    }
    buffer += decoder.decode()
    buffer = buffer.replace(/\r\n/g, '\n')
    yield* drain(true)
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The stream may already be errored/closed; nothing left to release.
    }
  }
}

function parseToolCallDelta(value: unknown): ChatToolCallDelta {
  if (!isRecord(value) || typeof value['index'] !== 'number') {
    throw new EngineProtocolError('provider sent a malformed tool-call delta')
  }
  const delta: ChatToolCallDelta = { index: value['index'] }
  if (typeof value['id'] === 'string') delta.id = value['id']
  if (typeof value['type'] === 'string') delta.type = value['type']
  if (isRecord(value['function'])) {
    const fn: { name?: string; arguments?: string } = {}
    if (typeof value['function']['name'] === 'string') fn.name = value['function']['name']
    if (typeof value['function']['arguments'] === 'string') {
      fn.arguments = value['function']['arguments']
    }
    delta.function = fn
  }
  return delta
}

export class OpenAICompatibleClient {
  private readonly opts: OpenAICompatibleClientOptions
  private readonly fetchFn: typeof fetch
  private readonly engineKind: string
  private readonly modelsPath: string
  private readonly chatPath: string
  private readonly timeoutMs: number

  constructor(opts: OpenAICompatibleClientOptions) {
    this.opts = opts
    this.fetchFn = opts.fetchFn ?? fetch
    this.engineKind = opts.engineKind ?? 'openai-compatible'
    this.modelsPath = opts.modelsPath ?? '/models'
    this.chatPath = opts.chatPath ?? '/chat/completions'
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async listModels(): Promise<RemoteModel[]> {
    const response = await this.request(this.modelsPath, { method: 'GET' })
    const body = await this.readJson(response, 'models')
    const data = isRecord(body) ? body['data'] : undefined
    if (!Array.isArray(data)) {
      throw new EngineProtocolError(
        `provider '${this.engineKind}' models response is malformed: expected a data array`,
      )
    }
    return data.map((entry, index) => {
      if (!isRecord(entry) || typeof entry['id'] !== 'string' || entry['id'] === '') {
        throw new EngineProtocolError(
          `provider '${this.engineKind}' models response entry ${index} has no string id`,
        )
      }
      const model: RemoteModel = { id: entry['id'] }
      const label = entry['name'] ?? entry['display_name'] ?? entry['label']
      if (typeof label === 'string' && label !== '') model.label = label
      return model
    })
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
    }
    if (req.tools !== undefined && req.tools.length > 0) body['tools'] = req.tools
    if (req.temperature !== undefined) body['temperature'] = req.temperature

    const response = await this.request(this.chatPath, {
      method: 'POST',
      body: JSON.stringify(body),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    })

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (contentType.includes('text/event-stream')) {
      yield* this.parseSse(response, req.signal)
      return
    }
    const parsed = await this.readJson(response, 'chat completion')
    yield* this.nonStreamingChunks(parsed)
  }

  private async *parseSse(
    response: Response,
    callerSignal: AbortSignal | undefined,
  ): AsyncIterable<ChatChunk> {
    let finished = false
    try {
      for await (const data of sseDataFrames(response, `provider '${this.engineKind}'`)) {
        if (data === '[DONE]') return
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          throw new EngineProtocolError(
            `provider '${this.engineKind}' sent a malformed streaming data frame`,
          )
        }
        yield* this.chunksFromPayload(parsed, true)
        const choices = isRecord(parsed) ? parsed['choices'] : undefined
        if (
          Array.isArray(choices) &&
          choices.some((choice) => isRecord(choice) && typeof choice['finish_reason'] === 'string')
        ) {
          finished = true
        }
      }
      if (!finished) {
        // A stream that ends without a finish reason and without [DONE] is
        // reported by the session as a truncated completion; nothing is
        // fabricated here.
      }
    } catch (err) {
      const reason = abortReason(err, callerSignal)
      if (reason === 'caller') throw err
      if (reason === 'timeout') {
        throw new EngineProtocolError(
          `provider '${this.engineKind}' streaming request timed out after ${this.timeoutMs}ms`,
        )
      }
      throw err
    }
  }

  private *chunksFromPayload(payload: unknown, streaming: boolean): Iterable<ChatChunk> {
    if (!isRecord(payload)) {
      throw new EngineProtocolError(`provider '${this.engineKind}' sent a malformed response body`)
    }
    const usage = payload['usage']
    if (isRecord(usage)) {
      const chunk: ChatChunk = { type: 'usage' }
      if (typeof usage['prompt_tokens'] === 'number') chunk.inputTokens = usage['prompt_tokens']
      if (typeof usage['completion_tokens'] === 'number') {
        chunk.outputTokens = usage['completion_tokens']
      }
      yield chunk
    }
    const choices = payload['choices']
    if (!Array.isArray(choices)) {
      throw new EngineProtocolError(`provider '${this.engineKind}' response has no choices array`)
    }
    for (const choice of choices) {
      if (!isRecord(choice)) {
        throw new EngineProtocolError(`provider '${this.engineKind}' response has a malformed choice`)
      }
      const delta = streaming ? choice['delta'] : choice['message']
      if (isRecord(delta)) {
        if (typeof delta['content'] === 'string' && delta['content'] !== '') {
          yield { type: 'text', text: delta['content'] }
        }
        if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content'] !== '') {
          yield { type: 'thought', text: delta['reasoning_content'] }
        }
        const toolCalls = delta['tool_calls']
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          yield { type: 'tool_call', calls: toolCalls.map(parseToolCallDelta) }
        }
      }
      if (typeof choice['finish_reason'] === 'string' && choice['finish_reason'] !== '') {
        yield { type: 'finish', reason: choice['finish_reason'] }
      }
    }
  }

  private async *nonStreamingChunks(payload: unknown): AsyncIterable<ChatChunk> {
    yield* this.chunksFromPayload(payload, false)
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = joinUrl(this.opts.baseUrl, path)
    const headers = buildAuthHeaders(this.opts.auth, this.opts.apiKey, this.opts.headers)
    headers.set('accept', 'application/json, text/event-stream')
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const signal =
      init.signal === undefined || init.signal === null
        ? AbortSignal.timeout(this.timeoutMs)
        : AbortSignal.any([init.signal, AbortSignal.timeout(this.timeoutMs)])

    let response: Response
    try {
      response = await this.fetchFn(url, { ...init, headers, signal })
    } catch (err) {
      const reason = abortReason(err, init.signal ?? undefined)
      if (reason === 'caller') throw err
      if (reason === 'timeout') {
        throw new EngineProtocolError(
          `provider '${this.engineKind}' request timed out after ${this.timeoutMs}ms`,
        )
      }
      let message = err instanceof Error ? err.message : String(err)
      if (err instanceof Error && err.cause instanceof Error) {
        message = `${message} (${err.cause.message})`
      } else if (
        err instanceof Error &&
        typeof err.cause === 'object' &&
        err.cause !== null &&
        'message' in err.cause
      ) {
        message = `${message} (${String((err.cause as { message: unknown }).message)})`
      }
      throw new EngineProtocolError(
        `provider '${this.engineKind}' request failed: ${oneLine(
          redactSecrets(message, [this.opts.apiKey]),
        )}`,
        { cause: err },
      )
    }

    if (!response.ok) {
      const snippet = await this.errorSnippet(response)
      if (response.status === 401 || response.status === 403) {
        throw new EngineAuthMissingError(
          this.engineKind,
          `the provider rejected the configured credential (HTTP ${response.status}). ` +
            (this.opts.providerId !== undefined
              ? `Run \`pluton provider key ${this.opts.providerId}\` with a current key.`
              : 'Store a current key with `pluton provider key <id>`.'),
        )
      }
      throw new EngineProtocolError(
        `provider '${this.engineKind}' request failed: HTTP ${response.status}` +
          (snippet !== '' ? `: ${snippet}` : ''),
        { details: { status: response.status } },
      )
    }
    return response
  }

  private async errorSnippet(response: Response): Promise<string> {
    try {
      const text = await response.text()
      return oneLine(redactSecrets(text, [this.opts.apiKey]))
    } catch {
      return ''
    }
  }

  private async readJson(response: Response, what: string): Promise<unknown> {
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new EngineProtocolError(
        `provider '${this.engineKind}' ${what} response is not valid JSON`,
      )
    }
  }
}
