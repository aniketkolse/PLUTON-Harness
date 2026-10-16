import { afterEach, describe, expect, it } from 'vitest'
import type { McpToolCallResult, McpToolHost, McpToolInfo } from '../../src/tools/mcp-server.ts'
import { ToolHttpServer } from '../../src/tools/http-transport.ts'

/**
 * HTTP transport conformance: each engine session gets its own bearer token and
 * its own protocol server instance; the transport enforces nothing beyond
 * authentication and body caps (authorization stays in the bridge). Tested over
 * real loopback HTTP with fetch — no Docker involved.
 */

const servers: ToolHttpServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

function stubHost(label: string): McpToolHost {
  return {
    listTools: (): McpToolInfo[] => [{ name: 'echo', description: `echo from ${label}`, inputSchema: { type: 'object' } }],
    call: async (name: string, args: unknown): Promise<McpToolCallResult> =>
      name === 'echo' ? { ok: true, data: { label, args } } : { ok: false, error: { code: 'not_found', message: name } },
  }
}

async function startServer(
  registrations: { label: string; spec?: Partial<{ museId: string; taskId: string | null; runId: string }> }[] = [{ label: 'A' }],
  opts: { maxRequestBytes?: number } = {},
): Promise<{ server: ToolHttpServer; url: string; tokens: string[] }> {
  const server = new ToolHttpServer({
    host: '127.0.0.1',
    port: 0,
    serverName: 'pluton-http-test',
    serverVersion: '0.0.0',
    diagnosticSink: () => {},
    ...opts,
  })
  servers.push(server)
  const { url } = await server.start()
  const tokens = registrations.map(
    (r) =>
      server.register(stubHost(r.label), {
        museId: r.spec?.museId ?? `muse-${r.label}`,
        taskId: r.spec?.taskId ?? null,
        runId: r.spec?.runId ?? 'run-1',
      }).token,
  )
  return { server, url, tokens }
}

async function post(url: string, token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers['authorization'] = `Bearer ${token}`
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }

describe('ToolHttpServer', () => {
  it('rejects requests without or with a wrong token and accepts the registered one', async () => {
    const { url, tokens } = await startServer()
    const noToken = await post(url, null, INITIALIZE)
    expect(noToken.status).toBe(401)
    const wrong = await post(url, 'not-the-token', INITIALIZE)
    expect(wrong.status).toBe(401)
    const ok = await post(url, tokens[0] as string, INITIALIZE)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe(
      'pluton-http-test',
    )
  })

  it('performs the full JSON-RPC handshake, tools/list and tools/call over HTTP', async () => {
    const { url, tokens } = await startServer()
    const token = tokens[0] as string
    const init = await post(url, token, INITIALIZE)
    expect(init.status).toBe(200)
    const list = await post(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(list.status).toBe(200)
    expect(((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toEqual([
      'echo',
    ])
    const call = await post(url, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { n: 1 } } })
    const text = ((await call.json()) as { result: { content: { text: string }[] } }).result.content[0]?.text ?? ''
    expect(text).toContain('"label":"A"')
    expect(text).toContain('"n":1')
  })

  it('isolates sessions: one token cannot use or unlock another session', async () => {
    const { url, tokens } = await startServer([{ label: 'A' }, { label: 'B' }])
    const [tokenA, tokenB] = tokens as [string, string]
    // B has not completed initialize: its own instance must answer -32002.
    const beforeInit = await post(url, tokenB, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const body = (await beforeInit.json()) as { error?: { code: number } }
    expect(body.error?.code).toBe(-32002)
    // A's session stays usable and independent.
    await post(url, tokenA, INITIALIZE)
    const bInit = await post(url, tokenB, INITIALIZE)
    expect(bInit.status).toBe(200)
    const call = await post(url, tokenB, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } })
    expect(((await call.json()) as { result: { content: { text: string }[] } }).result.content[0]?.text).toContain('"label":"B"')
  })

  it('answers notifications with 202 and no body', async () => {
    const { url, tokens } = await startServer()
    await post(url, tokens[0] as string, INITIALIZE)
    const res = await post(url, tokens[0] as string, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('rejects oversized bodies with 413 and non-POST methods with 405', async () => {
    const { url, tokens } = await startServer(undefined, { maxRequestBytes: 256 })
    const big = await post(url, tokens[0] as string, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(1024) } })
    expect(big.status).toBe(413)
    const wrongMethod = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${tokens[0] as string}` } })
    expect(wrongMethod.status).toBe(405)
  })

  it('invalidates unregistered tokens and closes the listener on stop', async () => {
    const { server, url, tokens } = await startServer()
    expect(server.unregister(tokens[0] as string)).toBe(true)
    expect(server.unregister(tokens[0] as string)).toBe(false)
    const rejected = await post(url, tokens[0] as string, INITIALIZE)
    expect(rejected.status).toBe(401)
    expect(server.sessionCount()).toBe(0)
    await server.stop()
    await expect(post(url, null, INITIALIZE)).rejects.toThrow()
  })

  it('stop() aborts in-flight tool calls and drains them before resolving', async () => {
    // Regression pin (host-mode smoke, 2026-10-16): a pending task.wait used to
    // outlive the HTTP server and touch the closed store ("database is not
    // open"). Shutdown must abort the call signal, and stop() must not resolve
    // until the handlers observing it have returned.
    let observedAbort = false
    let signalCallStarted: () => void = () => {}
    const callStarted = new Promise<void>((resolve) => {
      signalCallStarted = resolve
    })
    const host: McpToolHost = {
      listTools: (): McpToolInfo[] => [{ name: 'slow', description: 'slow', inputSchema: { type: 'object' } }],
      call: async (name: string, _args: unknown, opts?: { signal?: AbortSignal }): Promise<McpToolCallResult> => {
        signalCallStarted()
        await new Promise<void>((resolve) => {
          const fallback = setTimeout(resolve, 30_000)
          opts?.signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true
              clearTimeout(fallback)
              resolve()
            },
            { once: true },
          )
        })
        return { ok: true, data: { name } }
      },
    }
    const server = new ToolHttpServer({ host: '127.0.0.1', port: 0, diagnosticSink: () => {} })
    servers.push(server)
    const { url } = await server.start()
    const { token } = server.register(host, { museId: 'muse-m', taskId: null, runId: 'run-1' })
    await post(url, token, INITIALIZE)
    // The client may die with the handler still running: swallow the transport error.
    const callPromise = post(url, token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'slow', arguments: {} },
    }).catch(() => null)
    await callStarted
    const started = Date.now()
    await server.stop()
    expect(observedAbort).toBe(true)
    expect(Date.now() - started).toBeLessThan(4_000) // drain is bounded, not the 30 s fallback
    await callPromise
  })
})
