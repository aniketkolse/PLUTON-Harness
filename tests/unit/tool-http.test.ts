import { afterEach, describe, expect, it } from 'vitest'
import type { McpToolCallResult, McpToolHost, McpToolInfo } from '../../src/tools/mcp-server.ts'
import { ToolHttpServer, type ToolHttpServerOptions } from '../../src/tools/http-transport.ts'

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
  opts: ToolHttpServerOptions = {},
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
    // open"). Two properties, both asserted: shutdown must abort the call
    // signal, AND stop() must not resolve until the handler has returned —
    // this stub deliberately ignores the abort, so only a real bounded drain
    // keeps store.close() behind the handler.
    let observedAbort = false
    let handlerReturnedAt = 0
    let signalCallStarted: () => void = () => {}
    const callStarted = new Promise<void>((resolve) => {
      signalCallStarted = resolve
    })
    const host: McpToolHost = {
      listTools: (): McpToolInfo[] => [{ name: 'slow', description: 'slow', inputSchema: { type: 'object' } }],
      call: async (name: string, _args: unknown, opts?: { signal?: AbortSignal }): Promise<McpToolCallResult> => {
        signalCallStarted()
        opts?.signal?.addEventListener(
          'abort',
          () => {
            observedAbort = true
          },
          { once: true },
        )
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 200) // ignores the abort: pins the drain, not just the signal
        })
        handlerReturnedAt = Date.now()
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
    expect(observedAbort).toBe(true) // the signal fired even though the handler ignored it
    expect(handlerReturnedAt).toBeGreaterThan(0)
    expect(Date.now()).toBeGreaterThanOrEqual(handlerReturnedAt) // stop() resolved after the handler returned
    expect(Date.now() - started).toBeGreaterThanOrEqual(150) // it really waited for the 200 ms handler
    expect(Date.now() - started).toBeLessThan(4_000) // bounded by the drain grace, not the 30 s handler fallback
    await callPromise
  })

  it('enforces concurrency limits and queues requests up to maxQueueDepth', async () => {
    let activeCalls = 0
    let peakActive = 0
    let releaseFirst: () => void = () => {}
    const firstCallRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const host: McpToolHost = {
      listTools: (): McpToolInfo[] => [{ name: 'gate', description: 'gate', inputSchema: { type: 'object' } }],
      call: async (_name: string, _args: unknown): Promise<McpToolCallResult> => {
        activeCalls++
        if (activeCalls > peakActive) peakActive = activeCalls
        if (activeCalls === 1) {
          await firstCallRunning
        }
        activeCalls--
        return { ok: true, data: { done: true } }
      },
    }

    const { server, url } = await startServer([], {
      maxConcurrentRequests: 2,
      maxConcurrentRequestsPerSession: 1,
      maxQueueDepth: 2,
    })
    const { token } = server.register(host, { museId: 'muse-m', taskId: null, runId: 'run-1' })
    await post(url, token, INITIALIZE)

    // Call 1: starts and holds the only slot for this session
    const p1 = post(url, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gate', arguments: {} } })

    // Wait a brief moment to ensure Call 1 has begun executing
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(activeCalls).toBe(1)

    // Call 2: should be queued because maxConcurrentRequestsPerSession is 1
    const p2 = post(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gate', arguments: {} } })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(activeCalls).toBe(1) // Still only 1 active call

    // Now release the first call
    releaseFirst()

    const [res1, res2] = await Promise.all([p1, p2])
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(peakActive).toBe(1) // Never exceeded 1 concurrent call for this session
  })

  it('rejects with 429 backpressure when queue capacity is exhausted', async () => {
    let unblock: () => void = () => {}
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve
    })

    const host: McpToolHost = {
      listTools: (): McpToolInfo[] => [{ name: 'slow', description: 'slow', inputSchema: { type: 'object' } }],
      call: async (): Promise<McpToolCallResult> => {
        await blocker
        return { ok: true, data: { ok: true } }
      },
    }

    const server = new ToolHttpServer({
      host: '127.0.0.1',
      port: 0,
      diagnosticSink: () => {},
      maxConcurrentRequestsPerSession: 1,
      maxQueueDepth: 1,
    })
    servers.push(server)
    const { url } = await server.start()
    const { token } = server.register(host, { museId: 'm1', taskId: null, runId: 'run-1' })
    await post(url, token, INITIALIZE)

    // Request 1: occupies the 1 running slot
    const req1 = post(url, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } })
    await new Promise((r) => setTimeout(r, 40))

    // Request 2: occupies the 1 queue slot
    const req2 = post(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } })
    await new Promise((r) => setTimeout(r, 40))

    // Request 3: capacity exhausted -> HTTP 429
    const req3 = await post(url, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow', arguments: {} } })
    expect(req3.status).toBe(429)
    const body3 = (await req3.json()) as { error: string }
    expect(body3.error).toBe('capacity_exhausted')

    unblock()
    await Promise.all([req1, req2])
  })

  it('drops queued requests cleanly when aborted before running', async () => {
    let unblockFirst: () => void = () => {}
    const blocker = new Promise<void>((resolve) => {
      unblockFirst = resolve
    })

    let queuedExecuted = false
    const host: McpToolHost = {
      listTools: (): McpToolInfo[] => [{ name: 'op', description: 'op', inputSchema: { type: 'object' } }],
      call: async (_name, args: unknown): Promise<McpToolCallResult> => {
        const id = (args as { id?: number })?.id
        if (id === 1) {
          await blocker
          return { ok: true, data: { id: 1 } }
        }
        queuedExecuted = true
        return { ok: true, data: { id } }
      },
    }

    const server = new ToolHttpServer({
      host: '127.0.0.1',
      port: 0,
      diagnosticSink: () => {},
      maxConcurrentRequestsPerSession: 1,
      maxQueueDepth: 2,
    })
    servers.push(server)
    const { url } = await server.start()
    const { token } = server.register(host, { museId: 'm1', taskId: null, runId: 'run-1' })
    await post(url, token, INITIALIZE)

    const r1 = post(url, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'op', arguments: { id: 1 } } })
    await new Promise((r) => setTimeout(r, 40))

    // Enqueue request 2 with an AbortController and immediately abort it
    const abortCtrl = new AbortController()
    const r2 = fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'op', arguments: { id: 2 } } }),
      signal: abortCtrl.signal,
    }).catch(() => null)

    await new Promise((r) => setTimeout(r, 40))
    abortCtrl.abort()
    await new Promise((r) => setTimeout(r, 40))

    unblockFirst()
    await Promise.all([r1, r2])

    expect(queuedExecuted).toBe(false)
  })

  it('unregisterMatching removes sessions matching predicate and leaves others intact', async () => {
    const { server, url } = await startServer([])
    const { token: t1 } = server.register(stubHost('task1'), { museId: 'm', taskId: 'task-1', runId: 'run-1' })
    const { token: t2 } = server.register(stubHost('task2'), { museId: 'm', taskId: 'task-2', runId: 'run-1' })

    expect(server.sessionCount()).toBe(2)
    const unregisteredCount = server.unregisterMatching((spec) => spec.taskId === 'task-1')
    expect(unregisteredCount).toBe(1)
    expect(server.sessionCount()).toBe(1)

    // t1 is gone (401)
    const res1 = await post(url, t1, INITIALIZE)
    expect(res1.status).toBe(401)

    // t2 is intact (200)
    const res2 = await post(url, t2, INITIALIZE)
    expect(res2.status).toBe(200)
  })
})
