import { describe, expect, it, vi } from 'vitest'
import { ConflictError } from '../../src/domain/errors.ts'
import type { ChatChunk, ChatRequest } from '../../src/engines/openai-compatible/client.ts'
import {
  OpenAICompatibleSession,
  type ChatStreamClient,
  type ToolClient,
} from '../../src/engines/openai-compatible/session.ts'
import type { EngineEvent } from '../../src/engines/contract/types.ts'

interface ScriptedCall {
  request: ChatRequest
}

function scriptedClient(
  scripts: Array<ChatChunk[] | ((req: ChatRequest) => AsyncIterable<ChatChunk>)>,
): { client: ChatStreamClient; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = []
  let index = 0
  return {
    calls,
    client: {
      async *streamChat(req: ChatRequest): AsyncIterable<ChatChunk> {
        calls.push({ request: req })
        const script = scripts[index++]
        if (script === undefined) throw new Error('unexpected extra model call')
        if (typeof script === 'function') {
          yield* script(req)
          return
        }
        for (const chunk of script) yield chunk
      },
    },
  }
}

function toolClient(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [
  { name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } },
]): { mcp: ToolClient; calls: Array<{ name: string; args: unknown }>; closed: () => number } {
  const calls: Array<{ name: string; args: unknown }> = []
  let closeCount = 0
  return {
    calls,
    closed: () => closeCount,
    mcp: {
      async initialize() {
        return {}
      },
      async listTools() {
        return tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema ?? {},
        }))
      },
      async callTool(name: string, args: unknown) {
        calls.push({ name, args })
        return { ok: true, data: { ok: true, name } }
      },
      async close() {
        closeCount += 1
      },
    },
  }
}

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function session(
  scripts: Array<ChatChunk[] | ((req: ChatRequest) => AsyncIterable<ChatChunk>)>,
  opts: {
    mcp?: ToolClient | null
    instructions?: string
    maxToolIterations?: number
  } = {},
): {
  session: OpenAICompatibleSession
  calls: ScriptedCall[]
  mcpCalls: Array<{ name: string; args: unknown }>
} {
  const scripted = scriptedClient(scripts)
  const tools = opts.mcp === undefined ? toolClient() : null
  return {
    session: new OpenAICompatibleSession({
      client: scripted.client,
      model: 'vendor/model-a',
      ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
      mcpClient: opts.mcp === undefined ? tools!.mcp : opts.mcp,
      ...(opts.maxToolIterations !== undefined ? { maxToolIterations: opts.maxToolIterations } : {}),
    }),
    calls: scripted.calls,
    mcpCalls: tools?.calls ?? [],
  }
}

describe('OpenAI-compatible session text streaming', () => {
  it('streams text, forwards usage, and ends with exactly one success result', async () => {
    const s = session([
      [
        { type: 'text', text: 'hel' },
        { type: 'text', text: 'lo' },
        { type: 'usage', inputTokens: 10, outputTokens: 2 },
        { type: 'finish', reason: 'stop' },
      ],
    ])
    const events = await collect(s.session.sendPrompt({ text: 'say hello' }))

    expect(events.filter((e) => e.kind === 'text')).toEqual([
      { kind: 'text', text: 'hel' },
      { kind: 'text', text: 'lo' },
    ])
    expect(events).toContainEqual({ kind: 'usage', inputTokens: 10, outputTokens: 2 })
    const results = events.filter((e) => e.kind === 'result')
    expect(results).toEqual([{ kind: 'result', outcome: 'success' }])
    expect(events[events.length - 1]?.kind).toBe('result')
  })

  it('prepends role instructions as a system message and sends the exact model', async () => {
    const s = session([[{ type: 'text', text: 'ok' }]], { instructions: 'you are a coder' })
    await collect(s.session.sendPrompt({ text: 'do work' }))
    expect(s.calls[0]?.request.model).toBe('vendor/model-a')
    expect(s.calls[0]?.request.messages).toEqual([
      { role: 'system', content: 'you are a coder' },
      { role: 'user', content: 'do work' },
    ])
  })

  it('keeps history across prompts and never re-sends instructions twice', async () => {
    const s = session([[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]], {
      instructions: 'rules',
    })
    await collect(s.session.sendPrompt({ text: 'one' }))
    await collect(s.session.sendPrompt({ text: 'two' }))
    expect(s.calls[1]?.request.messages).toEqual([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'two' },
    ])
  })

  it('rejects a concurrent prompt instead of interleaving history', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const s = session([
      async function* (): AsyncIterable<ChatChunk> {
        yield { type: 'text', text: 'start' }
        await gate
        yield { type: 'finish', reason: 'stop' }
      },
    ])
    const first = s.session.sendPrompt({ text: 'one' })[Symbol.asyncIterator]()
    await first.next()
    await expect(collect(s.session.sendPrompt({ text: 'two' }))).rejects.toBeInstanceOf(ConflictError)
    release()
    for (;;) {
      const next = await first.next()
      if (next.done === true) break
    }
  })
})

describe('OpenAI-compatible session tool loop', () => {
  it('executes one tool call, feeds the result back, and completes the turn', async () => {
    const s = session([
      [
        {
          type: 'tool_call',
          calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        },
        { type: 'finish', reason: 'tool_calls' },
      ],
      [{ type: 'text', text: 'file says hi' }, { type: 'finish', reason: 'stop' }],
    ])
    const events = await collect(s.session.sendPrompt({ text: 'read a.txt' }))

    expect(s.mcpCalls).toEqual([{ name: 'read_file', args: { path: 'a.txt' } }])
    expect(events).toContainEqual({
      kind: 'tool',
      name: 'read_file',
      phase: 'start',
      callId: 'call_1',
      input: { path: 'a.txt' },
    })
    expect(events.some((e) => e.kind === 'tool' && e.phase === 'end' && e.isError !== true)).toBe(true)
    expect(events).toContainEqual({ kind: 'text', text: 'file says hi' })
    expect(events[events.length - 1]).toEqual({ kind: 'result', outcome: 'success' })

    const secondMessages = s.calls[1]?.request.messages ?? []
    expect(secondMessages).toContainEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        },
      ],
    })
    expect(secondMessages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: JSON.stringify({ ok: true, name: 'read_file' }),
    })
    expect(s.calls[1]?.request.tools?.map((tool) => tool.function.name)).toEqual(['read_file'])
  })

  it('executes multiple tool calls from one assistant message in order', async () => {
    const s = session([
      [
        {
          type: 'tool_call',
          calls: [
            { index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":"a"}' } },
            { index: 1, id: 'call_b', function: { name: 'read_file', arguments: '{"path":"b"}' } },
          ],
        },
        { type: 'finish', reason: 'tool_calls' },
      ],
      [{ type: 'text', text: 'done' }],
    ])
    await collect(s.session.sendPrompt({ text: 'read both' }))
    expect(s.mcpCalls).toEqual([
      { name: 'read_file', args: { path: 'a' } },
      { name: 'read_file', args: { path: 'b' } },
    ])
  })

  it('accumulates tool-call arguments split across streaming deltas', async () => {
    const s = session([
      [
        { type: 'tool_call', calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] },
        { type: 'tool_call', calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] },
        { type: 'finish', reason: 'tool_calls' },
      ],
      [{ type: 'text', text: 'ok' }],
    ])
    await collect(s.session.sendPrompt({ text: 'read' }))
    expect(s.mcpCalls).toEqual([{ name: 'read_file', args: { path: 'a.txt' } }])
  })

  it('returns tool failure to the model instead of failing the turn', async () => {
    const tools = toolClient()
    tools.mcp.callTool = async () => ({ ok: false, error: { code: 'policy_denied', message: 'no' } })
    const s = session(
      [
        [
          {
            type: 'tool_call',
            calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{}' } }],
          },
        ],
        [{ type: 'text', text: 'understood' }],
      ],
      { mcp: tools.mcp },
    )
    const events = await collect(s.session.sendPrompt({ text: 'read' }))
    expect(events.some((e) => e.kind === 'tool' && e.phase === 'end' && e.isError === true)).toBe(true)
    const toolMessage = s.calls[1]?.request.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('policy_denied')
    expect(events[events.length - 1]).toEqual({ kind: 'result', outcome: 'success' })
  })

  it('reports malformed tool arguments without calling the tool', async () => {
    const s = session([
      [
        {
          type: 'tool_call',
          calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{broken' } }],
        },
      ],
      [{ type: 'text', text: 'ok' }],
    ])
    const events = await collect(s.session.sendPrompt({ text: 'read' }))
    expect(s.mcpCalls).toEqual([])
    expect(events.some((e) => e.kind === 'tool' && e.phase === 'end' && e.isError === true)).toBe(true)
    const toolMessage = s.calls[1]?.request.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('invalid')
  })

  it('stops at the tool-iteration bound without executing another call', async () => {
    const toolTurn: ChatChunk[] = [
      {
        type: 'tool_call',
        calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{}' } }],
      },
    ]
    const s = session([toolTurn, toolTurn, toolTurn, toolTurn], { maxToolIterations: 2 })
    const events = await collect(s.session.sendPrompt({ text: 'loop' }))
    expect(s.mcpCalls).toHaveLength(2)
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'tool_iteration_limit' }),
    )
    expect(events[events.length - 1]).toEqual({ kind: 'result', outcome: 'failure' })
  })
})

describe('OpenAI-compatible session failure and interrupt handling', () => {
  it('reports a truncated completion as failure, never success', async () => {
    const s = session([[{ type: 'text', text: 'half' }, { type: 'finish', reason: 'length' }]])
    const events = await collect(s.session.sendPrompt({ text: 'long' }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'completion_truncated' }))
    expect(events[events.length - 1]).toEqual({ kind: 'result', outcome: 'failure' })
  })

  it('reports a filtered completion as failure', async () => {
    const s = session([[{ type: 'finish', reason: 'content_filter' }]])
    const events = await collect(s.session.sendPrompt({ text: 'x' }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'completion_filtered' }))
    expect(events[events.length - 1]).toEqual({ kind: 'result', outcome: 'failure' })
  })

  it('turns a provider error into an error event plus failure result', async () => {
    const s = session([
      async function* (): AsyncIterable<ChatChunk> {
        throw Object.assign(new Error('provider exploded'), { code: 'engine_protocol_error' })
      },
    ])
    const events = await collect(s.session.sendPrompt({ text: 'x' }))
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'engine_protocol_error' }),
    )
    expect(events[events.length - 1]).toEqual({ kind: 'result', outcome: 'failure' })
  })

  it('interrupts a live stream and ends with cancelled, not success', async () => {
    const s = session([
      async function* (req: ChatRequest): AsyncIterable<ChatChunk> {
        yield { type: 'text', text: 'partial' }
        if (req.signal?.aborted === true) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        }
        await new Promise<void>((resolve, reject) => {
          req.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
          void resolve
        })
        yield { type: 'text', text: 'never' }
      },
    ])
    const iterator = s.session.sendPrompt({ text: 'stop me' })[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toEqual({ kind: 'text', text: 'partial' })
    await s.session.interrupt()
    const rest: EngineEvent[] = []
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      rest.push(next.value)
    }
    expect(rest.some((e) => e.kind === 'text')).toBe(false)
    expect(rest[rest.length - 1]).toEqual({ kind: 'result', outcome: 'cancelled' })
  })

  it('interrupts a running tool call without retrying it', async () => {
    let callStarted: (() => void) | null = null
    const started = new Promise<void>((resolve) => {
      callStarted = resolve
    })
    const tools = toolClient()
    let invocations = 0
    tools.mcp.callTool = async (_name, _args, opts) => {
      invocations += 1
      callStarted?.()
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted === true) return resolve()
        opts?.signal?.addEventListener('abort', () => resolve())
      })
      return { ok: true, data: null }
    }
    const s = session(
      [
        [
          {
            type: 'tool_call',
            calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{}' } }],
          },
        ],
      ],
      { mcp: tools.mcp },
    )
    const iterator = s.session.sendPrompt({ text: 'do' })[Symbol.asyncIterator]()
    await iterator.next()
    // Pull the next event so the generator enters callTool, then interrupt
    // while the tool is still running rather than after it returned.
    const whileRunning = iterator.next()
    await started
    await s.session.interrupt()
    const rest: EngineEvent[] = []
    const afterTool = await whileRunning
    if (afterTool.done !== true) rest.push(afterTool.value)
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      rest.push(next.value)
    }
    expect(invocations).toBe(1)
    expect(rest[rest.length - 1]).toEqual({ kind: 'result', outcome: 'cancelled' })
  })

  it('fails the turn when the MCP bridge cannot initialize', async () => {
    const tools = toolClient()
    tools.mcp.initialize = async () => {
      throw new Error('bridge down')
    }
    const s = session([[{ type: 'text', text: 'never' }]], { mcp: tools.mcp })
    const events = await collect(s.session.sendPrompt({ text: 'x' }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'mcp_unavailable' }))
    expect(events[events.length - 1]).toEqual({ kind: 'result', outcome: 'failure' })
  })

  it('closes idempotently, closes the MCP client, and refuses further prompts', async () => {
    const tools = toolClient()
    const s = session([[{ type: 'text', text: 'ok' }]], { mcp: tools.mcp })
    await s.session.close()
    await s.session.close()
    expect(tools.closed()).toBe(1)
    await expect(collect(s.session.sendPrompt({ text: 'after' }))).rejects.toBeInstanceOf(ConflictError)
  })
})

describe('OpenAI-compatible session tool schema discovery', () => {
  it('lists MCP tools once and exposes them to every model call', async () => {
    const initialize = vi.fn(async () => ({}))
    const listTools = vi.fn(async () => [
      { name: 'ship_list', description: 'list ships', inputSchema: { type: 'object', properties: {} } },
    ])
    const mcp: ToolClient = {
      initialize,
      listTools,
      callTool: async () => ({ ok: true, data: null }),
      close: async () => {},
    }
    const s = session(
      [
        [{ type: 'text', text: 'a' }],
        [{ type: 'text', text: 'b' }],
      ],
      { mcp },
    )
    await collect(s.session.sendPrompt({ text: 'one' }))
    await collect(s.session.sendPrompt({ text: 'two' }))
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(listTools).toHaveBeenCalledTimes(1)
    expect(s.calls[1]?.request.tools).toEqual([
      { type: 'function', function: { name: 'ship_list', description: 'list ships', parameters: { type: 'object', properties: {} } } },
    ])
  })

  it('sends no tools array when no MCP server was supplied', async () => {
    const s = session([[{ type: 'text', text: 'ok' }]], { mcp: null })
    await collect(s.session.sendPrompt({ text: 'x' }))
    expect(s.calls[0]?.request.tools).toBeUndefined()
  })
})
