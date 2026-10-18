import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcpClient, type AcpSpawnFn } from '../../src/engines/acp/client.ts'
import { OpenCodeEngineAdapter, type OpenCodeEngineSession } from '../../src/engines/opencode/adapter.ts'
import type { EngineEvent, StartSessionRequest } from '../../src/engines/contract/types.ts'
import { FakeAcpAgent, fakeSpawn } from '../helpers/fake-acp-agent.ts'
import { scriptOpencode } from '../helpers/opencode-script.ts'

const MODEL = 'opencode/deepseek-v4.1-flash-free'

function sessionRequest(overrides: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return {
    muse: { id: 'muse_test', slug: 'worker-a', role: 'coder', model: MODEL },
    workdir: join('C:', 'work'),
    env: {},
    configDir: join('C:', 'muse-home'),
    ...overrides,
  }
}

describe('PR-3: transport retry for side-effect-free phases', () => {
  it('AcpClient.start() retries process spawn on transient error and succeeds', async () => {
    let spawnAttempts = 0
    const sleptDelays: number[] = []
    const agent = new FakeAcpAgent()

    const faultySpawnFn: AcpSpawnFn = () => {
      spawnAttempts++
      if (spawnAttempts < 3) {
        throw new Error(`transient process spawn error on attempt ${spawnAttempts}`)
      }
      setImmediate(() => agent.emitSpawn())
      return agent.child
    }

    const client = new AcpClient({
      command: 'opencode',
      cwd: '/tmp',
      env: {},
      spawnFn: faultySpawnFn,
      spawnRetry: {
        maxRetries: 3,
        initialDelayMs: 20,
        maxDelayMs: 100,
        sleepFn: async (ms) => {
          sleptDelays.push(ms)
        },
      },
    })

    await client.start()

    expect(client.isRunning).toBe(true)
    expect(spawnAttempts).toBe(3) // 2 failures + 1 success
    expect(sleptDelays.length).toBe(2)
    for (const d of sleptDelays) {
      expect(d).toBeLessThanOrEqual(100)
    }

    await client.close()
  })

  it('OpenCode adapter startSession retries spawn and handshake, returning exactly one session', async () => {
    let spawnAttempts = 0
    const sleptDelays: number[] = []
    const agent = new FakeAcpAgent()
    scriptOpencode(agent)

    const faultySpawnFn: AcpSpawnFn = () => {
      spawnAttempts++
      if (spawnAttempts < 3) {
        throw new Error(`handshake spawn failure ${spawnAttempts}`)
      }
      setImmediate(() => agent.emitSpawn())
      return agent.child
    }

    const adapter = new OpenCodeEngineAdapter({
      binaryPath: '/fake/opencode',
      spawnFn: faultySpawnFn,
      spawnRetry: {
        maxRetries: 3,
        initialDelayMs: 25,
        maxDelayMs: 200,
        sleepFn: async (ms) => {
          sleptDelays.push(ms)
        },
      },
    })

    const session = await adapter.startSession(sessionRequest())
    expect(session).toBeDefined()
    expect(session.info.nativeSessionId).toBeDefined()
    expect(spawnAttempts).toBe(3) // N=2 failures -> N+1 = 3 spawns
    expect(sleptDelays.length).toBe(2)

    await session.close()
  })

  it('prompt-phase failures are not retried (never blindly resend prompts)', async () => {
    let promptCallCount = 0
    const agent = new FakeAcpAgent()
    scriptOpencode(agent)

    // Intercept prompt call: simulate an engine-level error during prompt
    const prevOnMessage = agent.onMessage
    agent.onMessage = (msg, a) => {
      if (msg.method === 'session/prompt') {
        promptCallCount++
        a.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'model inference failed unexpectedly' },
        })
        return true
      }
      return prevOnMessage(msg, a)
    }

    const { spawnFn } = fakeSpawn(() => agent)
    const adapter = new OpenCodeEngineAdapter({
      binaryPath: '/fake/opencode',
      spawnFn,
      spawnRetry: {
        maxRetries: 3,
      },
    })

    const session = (await adapter.startSession(sessionRequest())) as OpenCodeEngineSession

    // Dispatch prompt
    const events: EngineEvent[] = []
    for await (const ev of session.sendPrompt({ text: 'Hello model' })) {
      events.push(ev)
    }

    // Must receive error event and prompt must NOT have been retried
    expect(promptCallCount).toBe(1)
    const errorEv = events.find((e) => e.kind === 'error')
    expect(errorEv).toBeDefined()
    expect((errorEv as { message: string }).message).toContain('model inference failed')

    await session.close()
  })
})
