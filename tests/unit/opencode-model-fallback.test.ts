import { describe, expect, it } from 'vitest'
import {
  OpenCodeEngineAdapter,
  OpenCodeEngineSession,
  isModelLimitError,
} from '../../src/engines/opencode/adapter.ts'
import type { EngineEvent, StartSessionRequest } from '../../src/engines/contract/types.ts'
import type { EnginePermissionChannel, EnginePermissionRequest, EnginePermissionDecision } from '../../src/engines/interactive-approval.ts'
import { FakeAcpAgent, fakeSpawn } from '../helpers/fake-acp-agent.ts'
import { scriptOpencode } from '../helpers/opencode-script.ts'

const MODEL_A = 'opencode/deepseek-v4.1-flash-free'
const MODEL_B = 'opencode/beam-free'

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('opencode model limit detection & auto-switch', () => {
  it('detects usage limit error strings correctly', () => {
    expect(isModelLimitError('Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models. (code -32603)')).toBe(true)
    expect(isModelLimitError('rate limit exceeded')).toBe(true)
    expect(isModelLimitError('quota exceeded for model')).toBe(true)
    expect(isModelLimitError('syntax error')).toBe(false)
  })

  it('surfaces usage limit error as error and result events without silent auto-switch', async () => {
    const agent = new FakeAcpAgent()
    const scriptState = scriptOpencode(agent, {
      defaultModel: MODEL_A,
      models: [
        { value: MODEL_A, name: 'DeepSeek Flash' },
        { value: MODEL_B, name: 'Beam Free' },
      ],
    })

    // Custom behavior: MODEL_A fails with free limit error
    const origOnMessage = agent.onMessage
    agent.onMessage = (msg, a) => {
      if (msg.method === 'session/prompt' && scriptState.currentModel === MODEL_A) {
        a.respondError(msg.id as number, -32603, 'Internal error: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models. (code -32603)')
        return true
      }
      return origOnMessage(msg, a)
    }

    const spawn = fakeSpawn(() => agent)
    const adapter = new OpenCodeEngineAdapter({
      binaryPath: '/fake/opencode',
      spawnFn: spawn.spawnFn,
    })

    const session = await adapter.startSession({
      muse: { id: 'worker-1', slug: 'worker-1', role: 'coder', model: MODEL_A },
      workdir: 'C:\\work',
      env: {},
      configDir: 'C:\\conf',
    })
    expect(session).toBeInstanceOf(OpenCodeEngineSession)
    if (!(session instanceof OpenCodeEngineSession)) throw new Error('expected an OpenCode engine session')

    expect(session.pinnedModel).toBe(MODEL_A)
    const events = await collect(session.sendPrompt({ text: 'Hello' }))

    // The adapter must not silently auto-switch; the supervisor owns fallback decisions.
    // The model stays pinned to MODEL_A and the usage limit error is surfaced.
    expect(session.pinnedModel).toBe(MODEL_A)
    expect(scriptState.currentModel).toBe(MODEL_A)
    const err = events.find((e) => e.kind === 'error')
    expect(err).toBeDefined()
    expect((err as any)?.message).toContain('Free usage limit reached')

    await session.close()
  })

  it('supports explicit model switching on the session via switchModel', async () => {
    const agent = new FakeAcpAgent()
    const scriptState = scriptOpencode(agent, {
      defaultModel: MODEL_A,
      models: [
        { value: MODEL_A, name: 'DeepSeek Flash' },
        { value: MODEL_B, name: 'Beam Free' },
      ],
    })

    const spawn = fakeSpawn(() => agent)
    const adapter = new OpenCodeEngineAdapter({
      binaryPath: '/fake/opencode',
      spawnFn: spawn.spawnFn,
    })

    const session = await adapter.startSession({
      muse: { id: 'worker-1', slug: 'worker-1', role: 'coder', model: MODEL_A },
      workdir: 'C:\\work',
      env: {},
      configDir: 'C:\\conf',
    })
    expect(session).toBeInstanceOf(OpenCodeEngineSession)
    if (!(session instanceof OpenCodeEngineSession)) throw new Error('expected an OpenCode engine session')

    expect(session.pinnedModel).toBe(MODEL_A)
    const switched = await session.switchModel(MODEL_B)
    expect(switched).toBe(true)
    expect(session.pinnedModel).toBe(MODEL_B)
    expect(scriptState.currentModel).toBe(MODEL_B)

    await session.close()
  })
})
