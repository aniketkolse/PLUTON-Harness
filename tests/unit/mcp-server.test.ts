import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  McpStdioServer,
  MCP_PROTOCOL_VERSION,
  type McpDiagnosticSink,
  type McpToolCallResult,
  type McpToolHost,
  type McpToolInfo,
} from '../../src/tools/mcp-server.ts'
import { PLUTON_VERSION } from '../../src/version.ts'

/**
 * MCP stdio server conformance: framing, JSON-RPC error codes, the initialize
 * gate and the tools/* surface. The host is a stub, so no authorization or
 * tool logic is involved.
 */

const TOOLS: McpToolInfo[] = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List a directory',
    inputSchema: { type: 'object', properties: {} },
  },
]

class StubHost implements McpToolHost {
  readonly calls: Array<{ name: string; args: unknown }> = []
  tools: McpToolInfo[] = TOOLS
  response: McpToolCallResult = { ok: true, data: { content: 'ok' } }
  failure: Error | null = null

  listTools(): McpToolInfo[] {
    return this.tools
  }

  async call(name: string, args: unknown): Promise<McpToolCallResult> {
    this.calls.push({ name, args })
    if (this.failure) throw this.failure
    return this.response
  }
}

interface ServerFixture {
  server: McpStdioServer
  host: StubHost
  diagnostics: string[]
}

function makeServer(
  options: { maxMessageBytes?: number; serverName?: string; serverVersion?: string } = {},
): ServerFixture {
  const host = new StubHost()
  const diagnostics: string[] = []
  const sink: McpDiagnosticSink = (line) => {
    diagnostics.push(line)
  }
  const server = new McpStdioServer({ host, diagnosticSink: sink, ...options })
  return { server, host, diagnostics }
}

interface RpcResponse {
  jsonrpc: string
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

function requestLine(id: string | number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
}

async function exchange(
  server: McpStdioServer,
  id: string | number,
  method: string,
  params?: unknown,
): Promise<RpcResponse> {
  const out = await server.handleLine(requestLine(id, method, params))
  expect(out).not.toBeNull()
  return JSON.parse(out as string) as RpcResponse
}

function initializeRequest(): string {
  return requestLine(0, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'pluton-test', version: '0.0.0' },
  })
}

describe('initialize handshake', () => {
  it('answers initialize with protocol version, tool capabilities and server info', async () => {
    const { server } = makeServer()
    const out = await server.handleLine(initializeRequest())
    const res = JSON.parse(out as string) as RpcResponse
    expect(res.jsonrpc).toBe('2.0')
    expect(res.id).toBe(0)
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'pluton', version: PLUTON_VERSION },
    })
  })

  it('reports explicit serverName/serverVersion options verbatim', async () => {
    const { server } = makeServer({ serverName: 'pluton-bridge', serverVersion: '9.9.9' })
    const res = await exchange(server, 1, 'initialize')
    expect(res.result).toMatchObject({ serverInfo: { name: 'pluton-bridge', version: '9.9.9' } })
  })

  it('re-responds identically to a repeated initialize (idempotent choice)', async () => {
    const { server } = makeServer()
    const first = await exchange(server, 1, 'initialize')
    const second = await exchange(server, 2, 'initialize')
    expect(second.error).toBeUndefined()
    expect(second.result).toEqual(first.result)
  })

  it('treats notifications/initialized as a pure notification', async () => {
    const { server } = makeServer()
    await exchange(server, 1, 'initialize')
    const out = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(out).toBeNull()
  })
})

describe('initialization gate', () => {
  it('rejects tools/list and tools/call with -32002 before initialize', async () => {
    const { server, host } = makeServer()
    const list = await exchange(server, 1, 'tools/list')
    expect(list.error).toEqual({ code: -32002, message: 'server not initialized' })
    const call = await exchange(server, 2, 'tools/call', { name: 'read_file', arguments: {} })
    expect(call.error).toEqual({ code: -32002, message: 'server not initialized' })
    expect(host.calls).toEqual([])
  })

  it('opens the gate once initialize has been answered', async () => {
    const { server } = makeServer()
    await exchange(server, 1, 'initialize')
    const list = await exchange(server, 2, 'tools/list')
    expect(list.error).toBeUndefined()
  })
})

describe('tools/list', () => {
  it('passes the host tools through verbatim (name/description/inputSchema)', async () => {
    const { server } = makeServer()
    await exchange(server, 1, 'initialize')
    const res = await exchange(server, 2, 'tools/list')
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({ tools: TOOLS })
  })

  it('answers an empty tool list as { tools: [] }', async () => {
    const { server, host } = makeServer()
    host.tools = []
    await exchange(server, 1, 'initialize')
    const res = await exchange(server, 2, 'tools/list')
    expect(res.result).toEqual({ tools: [] })
  })
})

describe('tools/call', () => {
  it('returns JSON text content and isError:false on success', async () => {
    const { server, host } = makeServer()
    await exchange(server, 1, 'initialize')
    host.response = { ok: true, data: { answer: 42 } }
    const res = await exchange(server, 2, 'tools/call', { name: 'read_file', arguments: { path: '/tmp/a' } })
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({
      content: [{ type: 'text', text: '{"answer":42}' }],
      isError: false,
    })
    expect(host.calls).toEqual([{ name: 'read_file', args: { path: '/tmp/a' } }])
  })

  it('serializes absent result data as "null"', async () => {
    const { server, host } = makeServer()
    await exchange(server, 1, 'initialize')
    host.response = { ok: true }
    const res = await exchange(server, 2, 'tools/call', { name: 'read_file' })
    expect(res.result).toEqual({ content: [{ type: 'text', text: 'null' }], isError: false })
  })

  it('maps a host ok:false to isError:true tool content, not a JSON-RPC error', async () => {
    const { server, host } = makeServer()
    await exchange(server, 1, 'initialize')
    host.response = { ok: false, error: { code: 'policy_denied', message: 'tool not permitted' } }
    const res = await exchange(server, 2, 'tools/call', { name: 'read_file', arguments: {} })
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ code: 'policy_denied', message: 'tool not permitted' }) }],
      isError: true,
    })
  })

  it('maps a throwing host to isError:true internal_error plus a diagnostic', async () => {
    const { server, host, diagnostics } = makeServer()
    await exchange(server, 1, 'initialize')
    host.failure = new Error('host exploded')
    const res = await exchange(server, 2, 'tools/call', { name: 'read_file', arguments: {} })
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ code: 'internal_error', message: 'host exploded' }) }],
      isError: true,
    })
    expect(diagnostics.join('\n')).toContain('host exploded')
  })

  it('rejects missing or nameless params with -32602 without touching the host', async () => {
    const { server, host } = makeServer()
    await exchange(server, 1, 'initialize')
    const missing = await exchange(server, 2, 'tools/call')
    expect(missing.error?.code).toBe(-32602)
    expect(missing.error?.message).toContain('invalid params')
    const nameless = await exchange(server, 3, 'tools/call', { arguments: {} })
    expect(nameless.error?.code).toBe(-32602)
    expect(host.calls).toEqual([])
  })
})

describe('protocol errors', () => {
  it('answers malformed JSON with -32700 and a null id', async () => {
    const { server } = makeServer()
    const out = await server.handleLine('{"jsonrpc": "2.0", "method": ')
    const res = JSON.parse(out as string) as RpcResponse
    expect(res.jsonrpc).toBe('2.0')
    expect(res.id).toBeNull()
    expect(res.error?.code).toBe(-32700)
    expect(res.result).toBeUndefined()
  })

  it('treats parseable non-objects as parse errors too', async () => {
    const { server } = makeServer()
    for (const line of ['"hello"', '42', '[1,2]', 'null', 'true']) {
      const res = JSON.parse((await server.handleLine(line)) as string) as RpcResponse
      expect(res.id).toBeNull()
      expect(res.error?.code).toBe(-32700)
    }
  })

  it('rejects unknown methods with -32601, echoing the id verbatim', async () => {
    const { server } = makeServer()
    const res = await exchange(server, 'req-abc', 'tools/nonexistent')
    expect(res.id).toBe('req-abc')
    expect(res.error?.code).toBe(-32601)
    expect(res.error?.message).toContain('tools/nonexistent')
  })

  it('answers a request without a method as invalid (-32600), its notification silently', async () => {
    const { server } = makeServer()
    const withId = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3 }))
    expect((JSON.parse(withId as string) as RpcResponse).error?.code).toBe(-32600)
    const notification = await server.handleLine(JSON.stringify({ jsonrpc: '2.0' }))
    expect(notification).toBeNull()
  })

  it('never responds to notifications, even schema-malformed ones', async () => {
    const { server, host } = makeServer()
    await exchange(server, 1, 'initialize')
    for (const line of [
      JSON.stringify({ jsonrpc: '2.0' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'unknown/method' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { arguments: {} } }),
    ]) {
      expect(await server.handleLine(line)).toBeNull()
    }
    expect(host.calls).toEqual([])
  })

  it('answers an explicit null id with id null (an id member makes it a request)', async () => {
    const { server } = makeServer()
    const out = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }))
    const res = JSON.parse(out as string) as RpcResponse
    expect(res.id).toBeNull()
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({})
  })

  it('ignores empty and whitespace-only lines', async () => {
    const { server } = makeServer()
    for (const line of ['', ' ', '\t', '\r']) {
      expect(await server.handleLine(line)).toBeNull()
    }
  })

  it('rejects lines over the byte bound with -32700, allowing exactly the bound', async () => {
    const { server } = makeServer({ maxMessageBytes: 64 })
    const base = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(base.length).toBeLessThan(64)
    const exact = base + ' '.repeat(64 - base.length)
    expect(Buffer.byteLength(exact, 'utf8')).toBe(64)
    const ok = JSON.parse((await server.handleLine(exact)) as string) as RpcResponse
    expect(ok.error).toBeUndefined()
    expect(ok.result).toEqual({})

    const over = base + ' '.repeat(65 - base.length)
    const rejected = JSON.parse((await server.handleLine(over)) as string) as RpcResponse
    expect(rejected.id).toBeNull()
    expect(rejected.error?.code).toBe(-32700)
  })

  it('counts UTF-8 bytes, not JS string length', async () => {
    // 20 x 'é' = 40 bytes but only 20 characters: 81 chars / 101 bytes total,
    // so this passes a char-based bound of 90 and fails a byte-based one.
    const { server } = makeServer({ maxMessageBytes: 90 })
    const line = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: { pad: 'é'.repeat(20) } })
    expect(line.length).toBeLessThanOrEqual(90)
    expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(90)
    const res = JSON.parse((await server.handleLine(line)) as string) as RpcResponse
    expect(res.error?.code).toBe(-32700)
  })
})

describe('serve (stdio transport)', () => {
  it('answers one line per request, in order, and resolves cleanly at EOF', async () => {
    const { server, host } = makeServer()
    host.response = { ok: true, data: { echo: 'héllo 🚀' } }
    const messages = [
      initializeRequest(),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      '',
      '   ',
      requestLine('p-2', 'ping'),
      requestLine(3, 'tools/list'),
      requestLine(4, 'tools/call', { name: 'read_file', arguments: { path: '/tmp/x' } }),
      '{"jsonrpc": "2.0", "id": 5, "method": ',
    ]
    const payload = Buffer.from(`${messages.join('\r\n')}\r\n`, 'utf8')
    // Split at a byte offset that cuts through the multi-byte emoji, proving
    // the framing buffer is byte-safe across chunk boundaries.
    const cut = payload.indexOf(Buffer.from('🚀', 'utf8')) + 2
    const input = Readable.from([payload.subarray(0, cut), payload.subarray(cut)])
    const written: string[] = []
    await expect(
      server.serve(input, (line) => {
        written.push(line)
      }),
    ).resolves.toBeUndefined()

    expect(written).toHaveLength(5)
    const responses = written.map((line) => JSON.parse(line) as RpcResponse)
    expect(responses.map((r) => r.id)).toEqual([0, 'p-2', 3, 4, null])
    expect(responses[0]?.result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION })
    expect(responses[1]?.result).toEqual({})
    expect(responses[2]?.result).toEqual({ tools: TOOLS })
    expect(responses[3]?.result).toMatchObject({ isError: false })
    expect(responses[3]?.result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ echo: 'héllo 🚀' }) }],
      isError: false,
    })
    expect(responses[4]?.error?.code).toBe(-32700)
    expect(written.every((line) => !line.includes('\n'))).toBe(true)
  })

  it('sends the host failure diagnostic to the sink while stdout stays pure JSON-RPC', async () => {
    const { server, host, diagnostics } = makeServer()
    await exchange(server, 1, 'initialize')
    host.failure = new Error('host failure for the log')
    const written: string[] = []
    await server.serve(Readable.from([`${requestLine(9, 'tools/call', { name: 'read_file' })}\n`]), (line) => {
      written.push(line)
    })
    expect(written).toHaveLength(1)
    // The diagnostic goes to the sink...
    expect(diagnostics.some((line) => line.includes('host failure for the log'))).toBe(true)
    // ...while the protocol line is one complete JSON-RPC response whose tool
    // content carries the internal_error detail.
    const res = JSON.parse(written[0] as string) as RpcResponse
    expect(res.jsonrpc).toBe('2.0')
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({
      content: [
        { type: 'text', text: JSON.stringify({ code: 'internal_error', message: 'host failure for the log' }) },
      ],
      isError: true,
    })
  })

  it('rejects an oversized line once, then resumes on the next newline', async () => {
    const { server } = makeServer({ maxMessageBytes: 128 })
    const payload = Buffer.from(
      `${requestLine(1, 'ping', { pad: 'x'.repeat(300) })}\n${requestLine(2, 'ping')}\n`,
      'utf8',
    )
    const written: string[] = []
    await server.serve(
      Readable.from([payload.subarray(0, 50), payload.subarray(50, 200), payload.subarray(200)]),
      (line) => {
        written.push(line)
      },
    )
    expect(written).toHaveLength(2)
    const first = JSON.parse(written[0] as string) as RpcResponse
    const second = JSON.parse(written[1] as string) as RpcResponse
    expect(first.id).toBeNull()
    expect(first.error?.code).toBe(-32700)
    expect(second.id).toBe(2)
    expect(second.result).toEqual({})
  })

  it('processes a final line that arrives without a trailing newline at EOF', async () => {
    const { server } = makeServer()
    const written: string[] = []
    await server.serve(Readable.from([requestLine(11, 'ping')]), async (line) => {
      written.push(line)
    })
    expect(written).toHaveLength(1)
    expect((JSON.parse(written[0] as string) as RpcResponse).id).toBe(11)
  })

  it('supports an async write function and writes one response per request', async () => {
    const { server } = makeServer()
    await exchange(server, 1, 'initialize')
    const written: string[] = []
    const input = Readable.from([`${requestLine(1, 'ping')}\n${requestLine(2, 'ping')}\n`])
    await server.serve(input, async (line) => {
      await Promise.resolve()
      written.push(line)
    })
    expect(written).toHaveLength(2)
    expect(written.map((line) => (JSON.parse(line) as RpcResponse).id)).toEqual([1, 2])
  })
})
