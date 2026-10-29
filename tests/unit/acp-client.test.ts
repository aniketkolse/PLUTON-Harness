import { describe, expect, it } from 'vitest'
import { AcpClient } from '../../src/engines/acp/client.ts'
import { EngineProtocolError } from '../../src/domain/errors.ts'
import { FakeAcpAgent, fakeSpawn } from '../helpers/fake-acp-agent.ts'

function makeClient(agent: FakeAcpAgent, overrides: Partial<ConstructorParameters<typeof AcpClient>[0]> = {}): AcpClient {
  const { spawnFn } = fakeSpawn(() => agent)
  return new AcpClient({
    command: 'fake-opencode',
    args: ['acp'],
    cwd: '/tmp',
    env: { PATH: '' },
    spawnFn,
    requestTimeoutMs: 2_000,
    ...overrides,
  })
}

const tick = () => new Promise((r) => setTimeout(r, 5))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AcpClient transport', () => {
  it('round-trips requests and notifications over NDJSON', async () => {
    const agent = new FakeAcpAgent()
    agent.onMessage = (msg, a) => {
      if (msg.method === 'ping') {
        a.respond(msg.id as number, { pong: true })
        return true
      }
      return false
    }
    const receivedNotifications: Array<{ method: string; params: unknown }> = []
    const client = makeClient(agent, {
      onNotification: (method, params) => receivedNotifications.push({ method, params }),
    })
    await client.start()
    const result = await client.request<{ pong: boolean }>('ping', { n: 1 })
    expect(result).toEqual({ pong: true })
    expect(agent.received[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'ping', params: { n: 1 } })

    client.notify('session/cancel', { sessionId: 'ses_1' })
    agent.notify('session/update', { sessionId: 'ses_1', update: { sessionUpdate: 'agent_message_chunk' } })
    await tick()
    expect(agent.receivedNotifications.map((m) => m.method)).toContain('session/cancel')
    expect(receivedNotifications).toEqual([
      { method: 'session/update', params: { sessionId: 'ses_1', update: { sessionUpdate: 'agent_message_chunk' } } },
    ])
    await client.close()
  })

  it('answers unsupported server->client requests with -32601 (never leaves the agent hanging)', async () => {
    const agent = new FakeAcpAgent()
    const client = makeClient(agent)
    await client.start()
    agent.send({ id: 77, method: 'session/request_permission', params: { sessionId: 'ses' } })
    await tick()
    const response = agent.receivedResponses.find((m) => m.id === 77)
    expect(response?.error?.code).toBe(-32601)
    await client.close()
  })

  it('routes server->client requests through a handler', async () => {
    const agent = new FakeAcpAgent()
    const client = makeClient(agent, {
      onServerRequest: (method, params) => {
        if (method !== 'session/request_permission') return null
        expect(params).toMatchObject({ toolCall: { toolCallId: 't1' } })
        return { result: { outcome: { outcome: 'selected', optionId: 'reject_once' } } }
      },
    })
    await client.start()
    agent.send({ id: 5, method: 'session/request_permission', params: { toolCall: { toolCallId: 't1' } } })
    await tick()
    expect(agent.receivedResponses.find((m) => m.id === 5)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject_once' },
    })
    await client.close()
  })

  it('awaits an async server->client request handler and answers with the correlated id', async () => {
    const agent = new FakeAcpAgent()
    const gate = deferred<{ result: unknown } | null>()
    const client = makeClient(agent, { onServerRequest: () => gate.promise })
    await client.start()

    agent.send({ id: 41, method: 'session/request_permission', params: { sessionId: 'ses' } })
    await tick()
    // The engine's request stays pending while the operator decides: no
    // response may be written before the handler settles.
    expect(agent.receivedResponses.find((m) => m.id === 41)).toBeUndefined()

    gate.resolve({ result: { outcome: { outcome: 'selected', optionId: 'proceed_once' } } })
    await tick()
    expect(agent.receivedResponses.find((m) => m.id === 41)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    })
    await client.close()
  })

  it('answers -32601 when an async handler resolves null (unsupported request)', async () => {
    const agent = new FakeAcpAgent()
    const client = makeClient(agent, { onServerRequest: async () => null })
    await client.start()
    agent.send({ id: 42, method: 'unknown/method', params: {} })
    await tick()
    expect(agent.receivedResponses.find((m) => m.id === 42)?.error?.code).toBe(-32601)
    await client.close()
  })

  it('drops a server->client answer that settles while close() is still in flight', async () => {
    const agent = new FakeAcpAgent()
    agent.ignoreStdinEnd = true
    const gate = deferred<{ result: unknown } | null>()
    const client = makeClient(agent, { onServerRequest: () => gate.promise })
    await client.start()
    agent.send({ id: 45, method: 'session/request_permission', params: {} })
    await tick()

    // close() has begun (stdin ended, grace running) but the transport is not
    // dead yet; a handler that resolves now must not write after close.
    const closing = client.close(60)
    gate.resolve({ result: { outcome: { outcome: 'selected', optionId: 'proceed_once' } } })
    await tick()
    expect(agent.receivedResponses.find((m) => m.id === 45)).toBeUndefined()
    await closing
  })

  it('maps an async handler rejection to -32603 and keeps the transport alive', async () => {
    const agent = new FakeAcpAgent()
    const gate = deferred<{ result: unknown } | null>()
    const client = makeClient(agent, { onServerRequest: () => gate.promise })
    await client.start()
    agent.send({ id: 43, method: 'session/request_permission', params: {} })
    await tick()

    gate.reject(new Error('operator channel exploded'))
    await tick()
    expect(agent.receivedResponses.find((m) => m.id === 43)?.error?.code).toBe(-32603)
    expect(client.handlerErrors).toBe(1)
    expect(client.isRunning).toBe(true)
    await client.close()
  })

  it('drops a server->client answer that settles only after the transport closed', async () => {
    const agent = new FakeAcpAgent()
    const gate = deferred<{ result: unknown } | null>()
    const client = makeClient(agent, { onServerRequest: () => gate.promise })
    await client.start()
    agent.send({ id: 44, method: 'session/request_permission', params: {} })
    await tick()

    await client.close()
    gate.resolve({ result: { outcome: { outcome: 'selected', optionId: 'proceed_once' } } })
    await tick()
    expect(agent.receivedResponses.find((m) => m.id === 44)).toBeUndefined()
    expect(client.isDead).toBe(true)
  })

  it('rejects a timed-out request but keeps the connection alive; late responses are counted as orphans', async () => {
    const agent = new FakeAcpAgent()
    agent.onMessage = () => true // swallow, never respond
    const client = makeClient(agent)
    await client.start()
    await expect(client.request('slow', {}, { timeoutMs: 30 })).rejects.toThrowError(/timed out/)
    expect(client.isRunning).toBe(true)
    agent.send({ id: 1, result: { late: true } })
    await tick()
    expect(client.orphanResponses).toBe(1)
    await client.close()
  })

  it('fails all in-flight requests when the agent exits', async () => {
    const agent = new FakeAcpAgent()
    agent.onMessage = () => true
    const client = makeClient(agent)
    await client.start()
    const pending = client.request('work', {})
    await tick()
    agent.emitExit(3, null)
    await expect(pending).rejects.toThrowError(/exited unexpectedly/)
    expect(client.isDead).toBe(true)
    await expect(client.request('later', {})).rejects.toThrowError(EngineProtocolError)
  })

  it('turns an asynchronous stdin EPIPE into a controlled transport failure', async () => {
    const agent = new FakeAcpAgent()
    agent.onMessage = () => true
    const client = makeClient(agent)
    await client.start()

    const pending = client.request('work', {})
    // Node reports failed writes on the stream instead of throwing, so an
    // unhandled 'error' event would crash the whole process.
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    agent.child.stdin!.emit('error', epipe)

    await expect(pending).rejects.toThrowError(/acp write failed: write EPIPE/)
    expect(client.isDead).toBe(true)
    expect(agent.killed).toBe(true)
  })

  it('fails closed on a non-JSON stdout frame and kills the child', async () => {
    const agent = new FakeAcpAgent()
    agent.onMessage = () => true // swallow requests; we only care about the bad frame
    const client = makeClient(agent)
    await client.start()
    const pending = client.request('work', {})
    agent.sendRawLine('this is not json')
    await expect(pending).rejects.toThrowError(/not JSON/)
    expect(client.isDead).toBe(true)
    expect(agent.killed).toBe(true)
  })

  it('fails closed when a frame exceeds the line limit', async () => {
    const agent = new FakeAcpAgent()
    agent.onMessage = () => true
    const client = makeClient(agent, { maxLineBytes: 64 })
    await client.start()
    const pending = client.request('work', {})
    agent.sendPartial('x'.repeat(200))
    await expect(pending).rejects.toThrowError(/exceeded 64 bytes without a newline/)
    expect(client.isDead).toBe(true)
  })

  it('rejects start() when the spawn fails, and reports protocol errors with stderr context', async () => {
    const agent = new FakeAcpAgent()
    agent.stderrText('boom: reason\n')
    const { spawnFn } = fakeSpawn(() => agent)
    const client = new AcpClient({ command: 'nope', cwd: '/tmp', env: {}, spawnFn })
    const startPromise = client.start()
    agent.emitError(Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }))
    await expect(startPromise).rejects.toThrowError(/ENOENT/)
  })

  it('close() ends stdin and lets the agent exit gracefully (no kill)', async () => {
    const agent = new FakeAcpAgent()
    const client = makeClient(agent)
    await client.start()
    await client.close()
    expect(agent.isExited).toBe(true)
    expect(agent.killed).toBe(false)
    expect(client.isRunning).toBe(false)
  })

  it('close() kills an agent that ignores stdin shutdown, and is idempotent', async () => {
    const agent = new FakeAcpAgent()
    agent.ignoreStdinEnd = true
    const client = makeClient(agent)
    await client.start()
    await client.close(50)
    expect(agent.killed).toBe(true)
    await client.close(10)
    expect(agent.killed).toBe(true)
  })
})
