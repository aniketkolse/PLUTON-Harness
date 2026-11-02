import { describe, expect, it } from 'vitest'
import {
  EngineAuthMissingError,
  EngineProtocolError,
} from '../../src/domain/errors.ts'
import {
  McpHttpClient,
} from '../../src/engines/openai-compatible/mcp-client.ts'
import {
  OpenAICompatibleClient,
  type ChatChunk,
} from '../../src/engines/openai-compatible/client.ts'

const KEY = 'unit-test-key-do-not-log'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  )
}

interface Captured {
  url: string
  init: RequestInit
}

function client(
  respond: (captured: Captured) => Response | Promise<Response>,
  overrides: Partial<ConstructorParameters<typeof OpenAICompatibleClient>[0]> = {},
): { client: OpenAICompatibleClient; calls: Captured[] } {
  const calls: Captured[] = []
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const captured = { url: String(input), init: init ?? {} }
    calls.push(captured)
    return await respond(captured)
  }) as typeof fetch
  return {
    client: new OpenAICompatibleClient({
      baseUrl: 'https://provider.example.test/v1',
      apiKey: KEY,
      auth: { style: 'bearer' },
      fetchFn,
      ...overrides,
    }),
    calls,
  }
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('OpenAI-compatible model listing', () => {
  it('preserves each model id exactly and never invents names', async () => {
    const { client: c, calls } = client(() =>
      jsonResponse({
        object: 'list',
        data: [
          { id: 'vendor/Model-A:free', owned_by: 'vendor' },
          { id: 'plain-model', created: 1 },
        ],
      }),
    )
    const models = await c.listModels()
    expect(models.map((m) => m.id)).toEqual(['vendor/Model-A:free', 'plain-model'])
    expect(calls[0]?.url).toBe('https://provider.example.test/v1/models')
    expect(calls[0]?.init.method).toBe('GET')
  })

  it('sends a bearer credential without putting it in the URL', async () => {
    const { client: c, calls } = client(() => jsonResponse({ data: [] }))
    await c.listModels()
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(calls[0]?.url).not.toContain(KEY)
  })

  it('supports a named header with a custom prefix', async () => {
    const { client: c, calls } = client(() => jsonResponse({ data: [] }), {
      auth: { style: 'header', header: 'x-api-key', prefix: 'Key ' },
    })
    await c.listModels()
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('x-api-key')).toBe(`Key ${KEY}`)
    expect(headers.get('authorization')).toBeNull()
  })

  it('merges non-secret configured headers without letting them overwrite auth', async () => {
    const { client: c, calls } = client(() => jsonResponse({ data: [] }), {
      headers: { 'x-title': 'pluton', authorization: 'Bearer attacker' },
    })
    await c.listModels()
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('x-title')).toBe('pluton')
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`)
  })

  it('joins base URLs without doubling slashes', async () => {
    const { client: c, calls } = client(() => jsonResponse({ data: [] }), {
      baseUrl: 'https://provider.example.test/v1/',
    })
    await c.listModels()
    expect(calls[0]?.url).toBe('https://provider.example.test/v1/models')
  })

  it('maps 401 to EngineAuthMissingError and never echoes the credential', async () => {
    const { client: c } = client(
      () => new Response(`invalid key ${KEY}`, { status: 401 }),
    )
    await expect(c.listModels()).rejects.toBeInstanceOf(EngineAuthMissingError)
    try {
      await c.listModels()
    } catch (err) {
      expect(String(err)).not.toContain(KEY)
      expect(JSON.stringify(err)).not.toContain(KEY)
    }
  })

  it('maps provider failures to EngineProtocolError with status and redacted body', async () => {
    const { client: c } = client(
      () => new Response(`upstream said: ${KEY} rejected`, { status: 429 }),
    )
    try {
      await c.listModels()
      expect.unreachable('expected listModels to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(EngineProtocolError)
      expect((err as EngineProtocolError).details).toMatchObject({ status: 429 })
      expect(String(err)).not.toContain(KEY)
      expect(String(err)).toContain('429')
    }
  })

  it('rejects a malformed models payload instead of silently returning nothing', async () => {
    const { client: c } = client(() => jsonResponse({ data: { id: 'x' } }))
    await expect(c.listModels()).rejects.toBeInstanceOf(EngineProtocolError)
  })

  it('rejects a models entry without a string id', async () => {
    const { client: c } = client(() => jsonResponse({ data: [{ id: 7 }] }))
    await expect(c.listModels()).rejects.toBeInstanceOf(EngineProtocolError)
  })
})

describe('OpenAI-compatible chat streaming', () => {
  const request = {
    model: 'vendor/Model-A:free',
    messages: [{ role: 'user' as const, content: 'hello' }],
  }

  it('sends the exact model and tool schema with stream=true', async () => {
    const { client: c, calls } = client(() =>
      sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']),
    )
    await collect(
      c.streamChat({
        ...request,
        tools: [
          {
            type: 'function',
            function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
          },
        ],
      }),
    )
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body['model']).toBe('vendor/Model-A:free')
    expect(body['stream']).toBe(true)
    expect(body['tools']).toHaveLength(1)
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('accept')).toContain('text/event-stream')
  })

  it('parses SSE frames split at arbitrary byte boundaries', async () => {
    const { client: c } = client(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    )
    const chunks = await collect(c.streamChat(request))
    expect(chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.text).join('')).toBe(
      'Hello world',
    )
  })

  it('streams reasoning_content as thought events, never as text', async () => {
    const { client: c } = client(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n',
      ]),
    )
    const chunks = await collect(c.streamChat(request))
    expect(chunks).toContainEqual({ type: 'thought', text: 'thinking' })
    expect(chunks).toContainEqual({ type: 'text', text: 'answer' })
  })

  it('forwards tool-call deltas with their index and partial arguments', async () => {
    const { client: c } = client(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    )
    const chunks = await collect(c.streamChat(request))
    const calls = chunks.filter((chunk) => chunk.type === 'tool_call')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      type: 'tool_call',
      calls: [{ index: 0, id: 'call_1', function: { name: 'read_file' } }],
    })
  })

  it('reports usage when the provider sends it', async () => {
    const { client: c } = client(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ]),
    )
    const chunks = await collect(c.streamChat(request))
    expect(chunks).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 3 })
  })

  it('falls back to a non-streaming JSON completion', async () => {
    const { client: c } = client(() =>
      jsonResponse({
        choices: [
          {
            message: { role: 'assistant', content: 'hi there', reasoning_content: 'because' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    )
    const chunks = await collect(c.streamChat(request))
    expect(chunks).toContainEqual({ type: 'text', text: 'hi there' })
    expect(chunks).toContainEqual({ type: 'thought', text: 'because' })
    expect(chunks).toContainEqual({ type: 'usage', inputTokens: 4, outputTokens: 2 })
    expect(chunks).toContainEqual({ type: 'finish', reason: 'stop' })
  })

  it('rejects a malformed SSE data frame with a protocol error', async () => {
    const { client: c } = client(() => sseResponse(['data: {not json}\n\ndata: [DONE]\n\n']))
    await expect(collect(c.streamChat(request))).rejects.toBeInstanceOf(EngineProtocolError)
  })

  it('rejects an HTTP error before consuming the stream', async () => {
    const { client: c } = client(
      () => new Response(`denied ${KEY}`, { status: 403 }),
    )
    await expect(collect(c.streamChat(request))).rejects.toBeInstanceOf(EngineAuthMissingError)
  })
})

describe('MCP HTTP client', () => {
  function mcp(
    respond: (captured: Captured) => Response | Promise<Response>,
    token = 'mcp-token-value',
  ): { mcp: McpHttpClient; calls: Captured[] } {
    const calls: Captured[] = []
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const captured = { url: String(input), init: init ?? {} }
      calls.push(captured)
      return await respond(captured)
    }) as typeof fetch
    return {
      mcp: new McpHttpClient({
        url: 'http://127.0.0.1:1234/mcp',
        headers: { authorization: `Bearer ${token}` },
        fetchFn,
      }),
      calls,
    }
  }

  it('initializes with the MCP protocol version and reports server info', async () => {
    const { mcp: c, calls } = mcp((captured) => {
      const body = JSON.parse(String(captured.init.body)) as { id: number }
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'pluton', version: '1.0.0' },
        },
      })
    })
    const info = await c.initialize()
    expect(info.serverInfo?.name).toBe('pluton')
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body['method']).toBe('initialize')
    expect((body['params'] as Record<string, unknown>)['protocolVersion']).toBe('2024-11-05')
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('authorization')).toBe('Bearer mcp-token-value')
    expect(headers.get('content-type')).toContain('application/json')
  })

  it('refuses tools/list before initialize', async () => {
    const { mcp: c } = mcp(() => jsonResponse({}))
    await expect(c.listTools()).rejects.toBeInstanceOf(EngineProtocolError)
  })

  it('lists tools after initialize', async () => {
    const { mcp: c } = mcp((captured) => {
      const body = JSON.parse(String(captured.init.body)) as { id: number; method: string }
      if (body.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }] },
      })
    })
    await c.initialize()
    const tools = await c.listTools()
    expect(tools).toEqual([{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }])
  })

  it('maps a successful tool result back to structured data', async () => {
    const { mcp: c } = mcp((captured) => {
      const body = JSON.parse(String(captured.init.body)) as { id: number; method: string }
      if (body.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: '{"bytes":3}' }], isError: false },
      })
    })
    await c.initialize()
    await expect(c.callTool('read_file', { path: 'a.txt' })).resolves.toEqual({
      ok: true,
      data: { bytes: 3 },
    })
  })

  it('maps a tool-level error without throwing a protocol error', async () => {
    const { mcp: c } = mcp((captured) => {
      const body = JSON.parse(String(captured.init.body)) as { id: number; method: string }
      if (body.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{ type: 'text', text: '{"code":"policy_denied","message":"no"}' }],
          isError: true,
        },
      })
    })
    await c.initialize()
    await expect(c.callTool('read_file', {})).resolves.toEqual({
      ok: false,
      error: { code: 'policy_denied', message: 'no' },
    })
  })

  it('raises a protocol error for a JSON-RPC error response', async () => {
    const { mcp: c } = mcp((captured) => {
      const body = JSON.parse(String(captured.init.body)) as { id: number; method: string }
      if (body.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })
      }
      return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } })
    })
    await c.initialize()
    await expect(c.callTool('read_file', {})).rejects.toBeInstanceOf(EngineProtocolError)
  })

  it('maps an unauthorized MCP endpoint to EngineAuthMissingError without echoing the token', async () => {
    const { mcp: c } = mcp(() => new Response('bad token mcp-token-value', { status: 401 }))
    await expect(c.initialize()).rejects.toBeInstanceOf(EngineAuthMissingError)
    try {
      await c.initialize()
    } catch (err) {
      expect(String(err)).not.toContain('mcp-token-value')
    }
  })
})
