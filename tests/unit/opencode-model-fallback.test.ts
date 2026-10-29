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

  it('auto-switches to available fallback model when prompt hits free limit and retries successfully', async () => {
    const agent = new FakeAcpAgent()
    const scriptState = scriptOpencode(agent, {
      defaultModel: MODEL_A,
      models: [
        { value: MODEL_A, name: 'DeepSeek Flash' },
        { value: MODEL_B, name: 'Beam Free' },
      ],
    })

    // Custom behavior: MODEL_A fails with free limit error, MODEL_B succeeds
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

    expect(session.pinnedModel).toBe(MODEL_A)
    const events = await collect(session.sendPrompt({ text: 'Hello' }))
    // Should have switched to MODEL_B and completed successfully
    expect(session.pinnedModel).toBe(MODEL_B)
    expect(scriptState.currentModel).toBe(MODEL_B)
    const text = events.filter((e) => e.kind === 'text').map((e) => e.text).join('')
    expect(text).toContain('switched to opencode/beam-free')
    expect(events.at(-1)).toMatchObject({ kind: 'result', outcome: 'success' })

    await session.close()
  })

  it('asks operator when interactive permissionChannel is present and stops if operator denies', async () => {
    const agent = new FakeAcpAgent()
    const scriptState = scriptOpencode(agent, {
      defaultModel: MODEL_A,
      models: [
        { value: MODEL_A, name: 'DeepSeek Flash' },
        { value: MODEL_B, name: 'Beam Free' },
      ],
    })

    const origOnMessage = agent.onMessage
    agent.onMessage = (msg, a) => {
      if (msg.method === 'session/prompt' && scriptState.currentModel === MODEL_A) {
        a.respondError(msg.id as number, -32603, 'Free usage limit reached. (code -32603)')
        return true
      }
      return origOnMessage(msg, a)
    }

    const spawn = fakeSpawn(() => agent)
    const adapter = new OpenCodeEngineAdapter({
      binaryPath: '/fake/opencode',
      spawnFn: spawn.spawnFn,
      approvalPolicy: 'interactive',
    })

    const askedRequests: EnginePermissionRequest[] = []
    const fakeChannel: EnginePermissionChannel = {
      async requestPermission(req) {
        askedRequests.push(req)
        return 'deny' // Operator denies switch
      },
      abort() {},
    }

    const session = await adapter.startSession({
      muse: { id: 'worker-1', slug: 'worker-1', role: 'coder', model: MODEL_A },
      workdir: 'C:\\work',
      env: {},
      configDir: 'C:\\conf',
      approvals: fakeChannel,
    })

    const events = await collect(session.sendPrompt({ text: 'Hello' }))
    expect(askedRequests.length).toBe(1)
    expect(askedRequests[0]!.description).toContain("Model 'opencode/deepseek-v4.1-flash-free' reached usage limit")
    expect(session.pinnedModel).toBe(MODEL_A) // Not switched
    expect(events.some((e) => e.kind === 'error' && /denied|stopped/i.test(e.message))).toBe(true)

    await session.close()
  })
})
