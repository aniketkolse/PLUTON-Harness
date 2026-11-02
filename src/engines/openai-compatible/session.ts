import { ConflictError } from '../../domain/errors.ts'
import { newId } from '../../domain/ids.ts'
import type {
  EngineEvent,
  EngineSession,
  EngineSessionInfo,
  PromptRequest,
} from '../contract/types.ts'
import type { McpToolCallResult, McpToolInfo } from './mcp-client.ts'
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  ChatToolDefinition,
} from './client.ts'

/**
 * One OpenAI-compatible chat session: owns conversation history, the tool
 * loop, and interrupt state. Provider-specific protocol stays in the client;
 * this class only speaks normalized `ChatChunk` values.
 *
 * Failure rules:
 * - A completion that ends by length or content filtering is reported as a
 *   failed turn, never as success.
 * - Tool errors (including malformed arguments) are returned to the model as
 *   tool results; they do not abort the turn.
 * - After interrupt or a transport failure, the partial turn is NOT written
 *   into history and no tool call is replayed.
 */

export interface ToolClient {
  initialize(): Promise<unknown>
  listTools(): Promise<McpToolInfo[]>
  callTool(
    name: string,
    args: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<McpToolCallResult>
  close(): Promise<void>
}

export interface ChatStreamClient {
  streamChat(req: ChatRequest): AsyncIterable<ChatChunk>
}

export interface OpenAICompatibleSessionOptions {
  client: ChatStreamClient
  model: string
  instructions?: string
  mcpClient?: ToolClient | null
  /** Maximum tool-execution rounds in one prompt (default 8). */
  maxToolIterations?: number
}

interface PendingToolCall {
  index: number
  id: string
  type: string
  name: string
  argumentsText: string
}

const DEFAULT_MAX_TOOL_ITERATIONS = 8

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return 'engine_protocol_error'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return JSON.stringify({ code: 'internal_error', message: 'tool result was not JSON-serializable' })
  }
}

export class OpenAICompatibleSession implements EngineSession {
  readonly info: EngineSessionInfo = {
    id: newId('session'),
    nativeSessionId: null,
    resumeToken: null,
  }

  private readonly client: ChatStreamClient
  private readonly model: string
  private readonly mcpClient: ToolClient | null
  private readonly maxToolIterations: number
  private history: ChatMessage[] = []
  private tools: ChatToolDefinition[] | null = null
  private toolsInitialized = false
  private active: AbortController | null = null
  private closed = false
  private mcpClosed = false

  constructor(opts: OpenAICompatibleSessionOptions) {
    this.client = opts.client
    this.model = opts.model
    this.mcpClient = opts.mcpClient ?? null
    this.maxToolIterations = opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS
    if (opts.instructions !== undefined && opts.instructions.trim() !== '') {
      this.history.push({ role: 'system', content: opts.instructions })
    }
  }

  async *sendPrompt(req: PromptRequest): AsyncIterable<EngineEvent> {
    if (this.closed) {
      throw new ConflictError(`session '${this.info.id}' is closed`)
    }
    if (this.active !== null) {
      throw new ConflictError(`session '${this.info.id}' is already processing a prompt`)
    }
    const controller = new AbortController()
    this.active = controller

    try {
      if (this.mcpClient !== null && !this.toolsInitialized) {
        try {
          await this.mcpClient.initialize()
          const listed = await this.mcpClient.listTools()
          this.tools = listed.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          }))
          this.toolsInitialized = true
        } catch (err) {
          yield { kind: 'error', code: 'mcp_unavailable', message: errorMessage(err) }
          yield { kind: 'result', outcome: 'failure' }
          return
        }
      }

      const working: ChatMessage[] = [...this.history, { role: 'user', content: req.text }]
      let toolRounds = 0

      for (;;) {
        if (controller.signal.aborted) {
          yield { kind: 'result', outcome: 'cancelled' }
          return
        }

        let text = ''
        let finishReason: string | null = null
        const pending = new Map<number, PendingToolCall>()

        try {
          const request: ChatRequest = {
            model: this.model,
            messages: [...working],
            signal: controller.signal,
            ...(this.tools !== null && this.tools.length > 0 ? { tools: this.tools } : {}),
          }
          for await (const chunk of this.client.streamChat(request)) {
            if (controller.signal.aborted) {
              yield { kind: 'result', outcome: 'cancelled' }
              return
            }
            switch (chunk.type) {
              case 'text':
                text += chunk.text
                yield { kind: 'text', text: chunk.text }
                break
              case 'thought':
                yield { kind: 'thought', text: chunk.text }
                break
              case 'usage':
                yield {
                  kind: 'usage',
                  ...(chunk.inputTokens !== undefined ? { inputTokens: chunk.inputTokens } : {}),
                  ...(chunk.outputTokens !== undefined ? { outputTokens: chunk.outputTokens } : {}),
                }
                break
              case 'finish':
                finishReason = chunk.reason
                break
              case 'tool_call':
                for (const delta of chunk.calls) {
                  const existing = pending.get(delta.index)
                  if (existing === undefined) {
                    pending.set(delta.index, {
                      index: delta.index,
                      id: delta.id ?? `call_${String(toolRounds)}_${String(delta.index)}`,
                      type: delta.type ?? 'function',
                      name: delta.function?.name ?? '',
                      argumentsText: delta.function?.arguments ?? '',
                    })
                  } else {
                    if (delta.id !== undefined) existing.id = delta.id
                    if (delta.type !== undefined) existing.type = delta.type
                    if (delta.function?.name !== undefined && existing.name === '') {
                      existing.name = delta.function.name
                    }
                    if (delta.function?.arguments !== undefined) {
                      existing.argumentsText += delta.function.arguments
                    }
                  }
                }
                break
            }
          }
        } catch (err) {
          if (controller.signal.aborted || isAbortError(err)) {
            yield { kind: 'result', outcome: 'cancelled' }
            return
          }
          yield { kind: 'error', code: errorCode(err), message: errorMessage(err) }
          yield { kind: 'result', outcome: 'failure' }
          return
        }

        if (controller.signal.aborted) {
          yield { kind: 'result', outcome: 'cancelled' }
          return
        }
        if (finishReason === 'length') {
          yield {
            kind: 'error',
            code: 'completion_truncated',
            message: 'the provider stopped the completion at its token limit; the answer is incomplete',
          }
          yield { kind: 'result', outcome: 'failure' }
          return
        }
        if (finishReason === 'content_filter') {
          yield {
            kind: 'error',
            code: 'completion_filtered',
            message: 'the provider filtered the completion; no complete answer was produced',
          }
          yield { kind: 'result', outcome: 'failure' }
          return
        }

        if (pending.size > 0) {
          if (toolRounds >= this.maxToolIterations) {
            yield {
              kind: 'error',
              code: 'tool_iteration_limit',
              message: `the model exceeded the ${String(this.maxToolIterations)} tool-call rounds allowed for one prompt`,
            }
            yield { kind: 'result', outcome: 'failure' }
            return
          }
          const calls = [...pending.values()].sort((a, b) => a.index - b.index)
          const assistantCalls: ChatToolCall[] = calls.map((call) => ({
            id: call.id,
            type: call.type,
            function: { name: call.name, arguments: call.argumentsText },
          }))
          working.push({
            role: 'assistant',
            content: text === '' ? null : text,
            tool_calls: assistantCalls,
          })

          for (const call of calls) {
            if (controller.signal.aborted) {
              yield { kind: 'result', outcome: 'cancelled' }
              return
            }
            const name = call.name === '' ? '(unnamed tool)' : call.name
            let args: unknown = null
            let argError: string | null = null
            if (call.argumentsText.trim() === '') {
              args = {}
            } else {
              try {
                args = JSON.parse(call.argumentsText)
              } catch {
                argError = 'invalid tool arguments: expected a JSON value'
              }
            }

            yield {
              kind: 'tool',
              name,
              phase: 'start',
              callId: call.id,
              ...(argError === null ? { input: args } : {}),
            }

            let result: McpToolCallResult
            if (argError !== null) {
              result = { ok: false, error: { code: 'invalid_tool_arguments', message: argError } }
            } else if (this.mcpClient === null) {
              result = {
                ok: false,
                error: { code: 'mcp_unavailable', message: 'no tool bridge is attached to this session' },
              }
            } else {
              try {
                result = await this.mcpClient.callTool(name, args, { signal: controller.signal })
              } catch (err) {
                if (controller.signal.aborted || isAbortError(err)) {
                  yield { kind: 'result', outcome: 'cancelled' }
                  return
                }
                result = { ok: false, error: { code: errorCode(err), message: errorMessage(err) } }
              }
            }

            if (controller.signal.aborted) {
              yield { kind: 'result', outcome: 'cancelled' }
              return
            }

            const content = result.ok
              ? safeSerialize(result.data ?? null)
              : safeSerialize(
                  result.error ?? { code: 'tool_error', message: `tool '${name}' failed without detail` },
                )
            yield {
              kind: 'tool',
              name,
              phase: 'end',
              callId: call.id,
              output: content,
              isError: !result.ok,
            }
            working.push({ role: 'tool', tool_call_id: call.id, content })
          }
          toolRounds += 1
          continue
        }

        working.push({ role: 'assistant', content: text === '' ? null : text })
        this.history = working
        yield { kind: 'result', outcome: 'success' }
        return
      }
    } finally {
      if (this.active === controller) this.active = null
    }
  }

  async interrupt(): Promise<void> {
    this.active?.abort()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.active?.abort()
    this.active = null
    if (this.mcpClient !== null && !this.mcpClosed) {
      this.mcpClosed = true
      await this.mcpClient.close().catch(() => {
        // Session teardown is best-effort; the session is unusable regardless.
      })
    }
  }
}
