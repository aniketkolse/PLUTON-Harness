import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  QwenEngineAdapter,
  type QwenAdapterOptions,
  type QwenEngineSession,
} from '../../src/engines/qwen/adapter.ts'
import { defaultCapabilities } from '../../src/engines/contract/types.ts'
import type { EngineEvent, StartSessionRequest } from '../../src/engines/contract/types.ts'
import {
  CapabilityError,
  EngineAuthMissingError,
  EngineMissingError,
  ValidationError,
} from '../../src/domain/errors.ts'
import type { AcpSpawnFn } from '../../src/engines/acp/client.ts'
import { FakeAcpAgent, fakeSpawn } from '../helpers/fake-acp-agent.ts'
import { loadQwenFrames, scriptQwen, type QwenScriptOptions } from '../helpers/qwen-script.ts'

/**
 * Offline conformance tests for the Qwen Code engine adapter, scripted by the
 * recorded v0.25.2 frames (tests/fixtures/qwen-acp/). These prove the wire
 * behavior — config-option pinning order, approval policy mapping, cancel /
 * timeout semantics, session/load resume, auth mapping — without a live
 * engine; tests/live/qwen.live.test.ts proves the same paths against a real
 * `qwen --acp` process (env-gated).
 */

const MODEL_NAME = 'cbai/glm-5.2'
const MODEL_VALUE = '$runtime|openai|cbai/glm-5.2(openai)'
const OTHER_MODEL_VALUE = '$runtime|openai|qwen3-coder-plus(openai)'
const PERMISSION_CALL_ID = 'call_9122a15976a641919035a4e0'

const frames = loadQwenFrames()

const NODE = join('C:', 'node', 'node.exe')
const ENTRY = join('C:', 'tools', 'qwen', 'cli-entry.js')

function makeAdapter(agent: FakeAcpAgent, overrides: QwenAdapterOptions = {}) {
  const spawn = fakeSpawn(() => agent)
  const adapter = new QwenEngineAdapter({
    binaryPath: ENTRY,
    nodePath: NODE,
    spawnFn: spawn.spawnFn,
    cancelGraceMs: 40,
    ...overrides,
  })
  return { adapter, spawn }
}

function sessionRequest(overrides: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return {
    muse: { id: 'muse_test', slug: 'worker-a', role: 'coder', model: MODEL_NAME },
    workdir: join('C:', 'work'),
    env: {},
    configDir: join('C:', 'muse-home'),
    ...overrides,
  }
}

async function startWithScript(
  opts: QwenScriptOptions = {},
  adapterOverrides: QwenAdapterOptions = {},
): Promise<{ session: QwenEngineSession; agent: FakeAcpAgent; state: ReturnType<typeof scriptQwen> }> {
  const agent = new FakeAcpAgent()
  const state = scriptQwen(agent, opts)
  const { adapter } = makeAdapter(agent, adapterOverrides)
  const session = (await adapter.startSession(sessionRequest())) as QwenEngineSession
  return { session, agent, state }
}

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('qwen adapter: capabilities and discovery', () => {
  it('reports the exact verified capability table (conformance cross-check)', () => {
    const { adapter } = makeAdapter(new FakeAcpAgent())
    const caps = adapter.capabilities()
    expect(caps).toEqual({
      resumeSession: true,
      interrupt: true,
      approvals: true,
      usage: true,
      modelList: true,
      mcpServers: true,
      sessionExport: false,
    })
    expect(Object.keys(caps).sort()).toEqual(Object.keys(defaultCapabilities()).sort())
  })

  it('discover() reports an uninstalled engine with the exact fix', async () => {
    const { adapter } = makeAdapter(new FakeAcpAgent(), {
      binaryPath: undefined,
      envOverrides: { PLUTON_QWEN_BIN: '' },
      platform: 'win32',
      isFile: () => false,
      readTextFile: () => '',
    })
    const d = await adapter.discover()
    expect(d).toMatchObject({ engineKind: 'qwen', installed: false, binaryPath: null, version: null })
    expect(d.fix).toMatch(/PLUTON_QWEN_BIN|install Qwen Code/)
  })

  it('discover() runs --version as `node <cli-entry.js> --version` through the bounded runner', async () => {
    const calls: string[][] = []
    const { adapter } = makeAdapter(new FakeAcpAgent(), {
      runFn: async (argv) => {
        calls.push(argv)
        return { argv, exitCode: 0, timedOut: false, stdout: '0.25.2\n', stderr: '', truncated: false, durationMs: 1 }
      },
    })
    const d = await adapter.discover()
    expect(d).toMatchObject({ installed: true, binaryPath: ENTRY, version: '0.25.2' })
    expect(calls).toEqual([[NODE, ENTRY, '--version']])
  })

  it('listModels() returns the composite engine values with their display labels from a real handshake', async () => {
    const agent = new FakeAcpAgent()
    scriptQwen(agent, {
      modelChoices: [
        { value: MODEL_VALUE, name: MODEL_NAME },
        { value: OTHER_MODEL_VALUE, name: 'qwen3-coder-plus' },
      ],
    })
    const { adapter, spawn } = makeAdapter(agent)
    const models = await adapter.listModels()
    expect(models).toEqual([
      { id: MODEL_VALUE, label: MODEL_NAME, source: 'engine' },
      { id: OTHER_MODEL_VALUE, label: 'qwen3-coder-plus', source: 'engine' },
    ])
    expect(spawn.agents).toHaveLength(1)
    expect(agent.received.filter((m) => m.method).map((m) => m.method)).toEqual(['initialize', 'session/new'])
  })

  it('authStatus() reports environment credentials without spawning anything', async () => {
    const { adapter, spawn } = makeAdapter(new FakeAcpAgent(), {
      envOverrides: { OPENAI_API_KEY: 'not-printed-anywhere' },
    })
    const status = await adapter.authStatus(join('C:', 'muse-home'))
    expect(status.configured).toBe(true)
    expect(status.hint).toMatch(/environment/)
    expect(spawn.agents).toHaveLength(0)
  })

  it('authStatus() succeeds through a real session/new handshake (engine home path)', async () => {
    const agent = new FakeAcpAgent()
    scriptQwen(agent, {})
    const { adapter } = makeAdapter(agent, {
      envOverrides: { OPENAI_API_KEY: '', DASHSCOPE_API_KEY: '' },
    })
    const status = await adapter.authStatus(join('C:', 'muse-home'))
    expect(status.configured).toBe(true)
    expect(status.hint).toMatch(/engine home/)
    expect(agent.received.filter((m) => m.method).map((m) => m.method)).toEqual(['initialize', 'session/new'])
  })

  it('authStatus() maps the recorded -32000 auth error to configured:false with the credential hint', async () => {
    const agent = new FakeAcpAgent()
    scriptQwen(agent, { sessionNewAuthError: true })
    const { adapter } = makeAdapter(agent, {
      envOverrides: { OPENAI_API_KEY: '', DASHSCOPE_API_KEY: '' },
    })
    const status = await adapter.authStatus(join('C:', 'muse-home'))
    expect(status.configured).toBe(false)
    expect(status.hint).toMatch(/OPENAI_API_KEY/)
    expect(status.hint).toMatch(/DASHSCOPE_API_KEY/)
  })
})

describe('qwen adapter: session lifecycle', () => {
  it('spawns `node <cli-entry.js> --acp` in the Muse config dir and sets mode then model', async () => {
    const agent = new FakeAcpAgent()
    const state = scriptQwen(agent, {
      modelChoices: [
        { value: MODEL_VALUE, name: MODEL_NAME },
        { value: OTHER_MODEL_VALUE, name: 'qwen3-coder-plus' },
      ],
    })
    const { adapter } = makeAdapter(agent)
    const session = await adapter.startSession(
      sessionRequest({ muse: { id: 'muse_test', slug: 'worker-a', role: 'coder', model: 'qwen3-coder-plus' } }),
    )

    expect(agent.spawnArgs).toEqual([NODE, ENTRY, '--acp'])
    expect(agent.spawnCwd).toBe(join('C:', 'work'))
    expect(agent.spawnEnv['QWEN_DIR']).toBe(join(join('C:', 'muse-home'), 'qwen'))
    expect(agent.spawnEnv['HOME'] ?? agent.spawnEnv['USERPROFILE']).toBe(join('C:', 'muse-home'))

    const init = agent.received[0]
    expect(init?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })

    const sets = agent.received.filter((m) => m.method === 'session/set_config_option')
    expect(sets.map((m) => m.params)).toEqual([
      { sessionId: 'qwen_fake_1', configId: 'mode', value: 'default' },
      { sessionId: 'qwen_fake_1', configId: 'model', value: OTHER_MODEL_VALUE },
    ])
    expect(state.currentMode).toBe('default')
    expect(state.currentModel).toBe(OTHER_MODEL_VALUE)
    expect(session.info.nativeSessionId).toBe('qwen_fake_1')
    expect(session.info.resumeToken).toBe('qwen_fake_1')
    await session.close()
  })

  it('matches a model by display name and sends the composite engine value verbatim', async () => {
    const agent = new FakeAcpAgent()
    const state = scriptQwen(agent, {
      currentModel: OTHER_MODEL_VALUE,
      modelChoices: [
        { value: MODEL_VALUE, name: MODEL_NAME },
        { value: OTHER_MODEL_VALUE, name: 'qwen3-coder-plus' },
      ],
    })
    const { adapter } = makeAdapter(agent)
    const session = await adapter.startSession(sessionRequest()) // muse model = MODEL_NAME
    const setModel = agent.received.find((m) => {
      const p = m.params as { configId?: string } | undefined
      return m.method === 'session/set_config_option' && p?.configId === 'model'
    })
    expect(setModel?.params).toEqual({ sessionId: 'qwen_fake_1', configId: 'model', value: MODEL_VALUE })
    expect(state.currentModel).toBe(MODEL_VALUE)
    await session.close()
  })

  it('does not re-send set_config_option when mode and model already match', async () => {
    const agent = new FakeAcpAgent()
    scriptQwen(agent, { currentMode: 'default' })
    const { adapter } = makeAdapter(agent)
    const session = await adapter.startSession(
      sessionRequest({ muse: { id: 'muse_test', slug: 'worker-a', role: 'coder', model: MODEL_VALUE } }),
    )
    expect(agent.received.some((m) => m.method === 'session/set_config_option')).toBe(false)
    await session.close()
  })

  it('refuses an approval mode the engine does not offer, before any prompt', async () => {
    const agent = new FakeAcpAgent()
    scriptQwen(agent, {})
    const { adapter } = makeAdapter(agent, { approvalMode: 'definitely-not-a-mode' })
    await expect(adapter.startSession(sessionRequest())).rejects.toThrowError(ValidationError)
    expect(agent.received.some((m) => m.method === 'session/prompt')).toBe(false)
    expect(agent.isExited).toBe(true)
  })

  it('refuses a model the engine does not offer, before any prompt', async () => {
    const agent = new FakeAcpAgent()
    scriptQwen(agent, {})
    const { adapter } = makeAdapter(agent)
    await expect(
      adapter.startSession(sessionRequest({ muse: { id: 'm', slug: 'w', role: 'coder', model: 'not-a-model' } })),
    ).rejects.toThrowError(ValidationError)
    expect(agent.received.some((m) => m.method === 'session/prompt')).toBe(false)
    expect(agent.isExited).toBe(true)
  })

  it('rejects an empty model id outright, before spawning', async () => {
    const { adapter, spawn } = makeAdapter(new FakeAcpAgent())
    await expect(
      adapter.startSession(sessionRequest({ muse: { id: 'm', slug: 'w', role: 'coder', model: '  ' } })),
    ).rejects.toThrowError(ValidationError)
    expect(spawn.agents).toHaveLength(0)
  })

  it('refuses to start when the engine offers no model select (never fakes the pin)', async () => {
    const agent = new FakeAcpAgent()
    const modeOnly = structuredClone(frames.sessionNew.configOptions)
    modeOnly.splice(
      modeOnly.findIndex((o) => o['id'] === 'model'),
      1,
    )
    for (const option of modeOnly) if (option['id'] === 'mode') option['currentValue'] = 'default'
    agent.onMessage = (msg, a) => {
      if (msg.method === 'initialize') {
        a.respond(msg.id as number, structuredClone(frames.initializeResult))
        return true
      }
      if (msg.method === 'session/new') {
        a.respond(msg.id as number, { sessionId: 'qwen_no_model', modes: {}, models: {}, configOptions: modeOnly })
        return true
      }
      return false
    }
    const { adapter } = makeAdapter(agent)
    await expect(adapter.startSession(sessionRequest())).rejects.toThrowError(CapabilityError)
  })

  it('resumes an existing session via session/load and sends no instructions again', async () => {
    const agent = new FakeAcpAgent()
    const state = scriptQwen(agent, {})
    const { adapter } = makeAdapter(agent)
    const session = await adapter.startSession(
      sessionRequest({ resumeToken: 'qwen_old_1', instructions: 'ROLE: must not be re-sent' }),
    )
    expect(agent.received.some((m) => m.method === 'session/new')).toBe(false)
    const load = agent.received.find((m) => m.method === 'session/load')
    expect(load?.params).toMatchObject({ sessionId: 'qwen_old_1', cwd: join('C:', 'work'), mcpServers: [] })
    expect(session.info.nativeSessionId).toBe('qwen_old_1')
    await collect(session.sendPrompt({ text: 'hello again' }))
    expect(state.prompts[0]?.prompt).toEqual([{ type: 'text', text: 'hello again' }])
    await session.close()
  })

  it('refuses resume when the agent does not declare loadSession', async () => {
    const agent = new FakeAcpAgent()
    const caps = structuredClone(frames.initializeResult)
    ;(caps['agentCapabilities'] as Record<string, unknown>)['loadSession'] = false
    agent.onMessage = (msg, a) => {
      if (msg.method === 'initialize') {
        a.respond(msg.id as number, caps)
        return true
      }
      return false
    }
    const { adapter } = makeAdapter(agent)
    await expect(adapter.startSession(sessionRequest({ resumeToken: 'old' }))).rejects.toThrowError(CapabilityError)
    expect(agent.received.some((m) => m.method === 'session/load')).toBe(false)
  })

  it('creates the Muse engine home (QWEN_DIR parent) before spawning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pluton-qwen-home-'))
    const configDir = join(dir, 'engine-home')
    const agent = new FakeAcpAgent()
    scriptQwen(agent, {})
    const { adapter } = makeAdapter(agent)
    const session = await adapter.startSession(sessionRequest({ configDir }))
    expect(existsSync(configDir)).toBe(true)
    expect(existsSync(join(configDir, 'qwen'))).toBe(true)
    await session.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('maps Pluton MCP server specs onto the ACP wire shape', async () => {
    const agent = new FakeAcpAgent()
    scriptQwen(agent, {})
    const { adapter } = makeAdapter(agent)
    const session = await adapter.startSession(
      sessionRequest({
        mcpServers: [{ name: 'pluton-tools', command: ['node', 'server.js', '--flag'], env: { TOKEN_X: 'not-a-secret' } }],
      }),
    )
    const newSession = agent.received.find((m) => m.method === 'session/new')
    expect((newSession?.params as { mcpServers: unknown }).mcpServers).toEqual([
      { name: 'pluton-tools', command: 'node', args: ['server.js', '--flag'], env: [{ name: 'TOKEN_X', value: 'not-a-secret' }] },
    ])
    await session.close()
  })

  it('maps the recorded -32000 session/new auth error to EngineAuthMissingError', async () => {
    const agent = new FakeAcpAgent()
    scriptQwen(agent, { sessionNewAuthError: true })
    const { adapter } = makeAdapter(agent)
    const err = await adapter.startSession(sessionRequest()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EngineAuthMissingError)
    expect((err as EngineAuthMissingError).message).toMatch(/OPENAI_API_KEY/)
    expect(agent.isExited).toBe(true)
  })

  it('maps a spawn ENOENT to EngineMissingError with the install fix', async () => {
    const spawnFn: AcpSpawnFn = () => {
      const fake = new FakeAcpAgent()
      setImmediate(() => fake.emitError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
      return fake.child
    }
    const adapter = new QwenEngineAdapter({ binaryPath: '/does/not/exist-qwen', nodePath: NODE, spawnFn })
    await expect(adapter.startSession(sessionRequest())).rejects.toThrowError(EngineMissingError)
  })
})

describe('qwen adapter: prompts and events', () => {
  it('replays the recorded transcript into normalized events and a success result', async () => {
    const { session } = await startWithScript()
    const events = await collect(session.sendPrompt({ text: 'write a file' }))
    expect(events.map((e) => e.kind)).toEqual(['status', 'tool', 'usage', 'result'])
    expect(events[0]).toEqual({ kind: 'status', status: 'busy' })
    expect(events[1]).toEqual({ kind: 'tool', name: 'WriteFile', phase: 'start', summary: 'WriteFile' })
    expect(events[2]).toEqual({ kind: 'usage' })
    expect(events[3]).toMatchObject({ kind: 'result', outcome: 'success', summary: 'stopReason: end_turn' })
    // agent_thought_chunk, empty agent_message_chunk, in-progress tool_call_update
    // and available_commands_update are counted, never guessed into events.
    expect(session.ignoredUpdates).toBe(4)
    await session.close()
  })

  it('sends role instructions as the first prompt part of a new session only', async () => {
    const agent = new FakeAcpAgent()
    const state = scriptQwen(agent, { promptUpdates: [] })
    const { adapter } = makeAdapter(agent)
    const session = await adapter.startSession(sessionRequest({ instructions: 'ROLE: you are Muse Alpha' }))
    await collect(session.sendPrompt({ text: 'first' }))
    await collect(session.sendPrompt({ text: 'second' }))
    expect(state.prompts[0]?.prompt).toEqual([
      { type: 'text', text: 'ROLE: you are Muse Alpha' },
      { type: 'text', text: 'first' },
    ])
    expect(state.prompts[1]?.prompt).toEqual([{ type: 'text', text: 'second' }])
    await session.close()
  })

  it.each([
    [undefined, 'cancel', 'deny'],
    ['allow_once', 'proceed_once', 'allow_once'],
    ['allow_always', 'proceed_always', 'allow_always'],
  ] as const)(
    'approvalPolicy %s answers the recorded permission request with option %s',
    async (policy, expectedOptionId, expectedDecision) => {
      const agent = new FakeAcpAgent()
      scriptQwen(agent, { promptUpdates: [], permissionOnPrompt: true })
      const { adapter } = makeAdapter(agent, policy ? { approvalPolicy: policy } : {})
      const session = (await adapter.startSession(sessionRequest())) as QwenEngineSession
      const events = await collect(session.sendPrompt({ text: 'edit a file' }))

      expect(events).toContainEqual({
        kind: 'approval_request',
        requestId: PERMISSION_CALL_ID,
        description: expect.stringContaining(`Pluton decision: ${expectedDecision}`),
      })
      const response = agent.receivedResponses.find((m) => m.id === 9000)
      expect(response?.result).toEqual({ outcome: { outcome: 'selected', optionId: expectedOptionId } })
      expect(session.approvalDecisions).toEqual([{ requestId: PERMISSION_CALL_ID, decision: expectedDecision }])
      expect(events.at(-1)).toMatchObject({ kind: 'result', outcome: 'success' })
      await session.close()
    },
  )

  it('answers an unknown server request with -32601 instead of guessing', async () => {
    const agent = new FakeAcpAgent()
    scriptQwen(agent, {
      promptUpdates: [],
      serverRequestDuringPrompt: { method: 'craft/drainMidTurnQueue', payload: {} },
    })
    const { adapter } = makeAdapter(agent)
    const session = await adapter.startSession(sessionRequest())
    const events = await collect(session.sendPrompt({ text: 'x' }))
    await new Promise((r) => setTimeout(r, 20))
    const response = agent.receivedResponses.find((m) => m.id === 9000)
    expect(response?.error?.code).toBe(-32601)
    expect(events.at(-1)).toMatchObject({ kind: 'result', outcome: 'success' })
    await session.close()
  })

  it('ignores qwen-specific notifications without breaking the turn', async () => {
    const { session } = await startWithScript({ promptUpdates: [], qwenNotificationOnPrompt: true })
    const events = await collect(session.sendPrompt({ text: 'x' }))
    expect(events.filter((e) => e.kind === 'error')).toEqual([])
    expect(events.at(-1)).toMatchObject({ kind: 'result', outcome: 'success' })
    await session.close()
  })

  it('interrupt() sends session/cancel and the turn ends cancelled (never success)', async () => {
    const { session, agent } = await startWithScript({ deferPromptUntilCancel: true })
    const stream = session.sendPrompt({ text: 'long task', timeoutMs: 5_000 })
    const events: EngineEvent[] = []
    const consume = (async () => {
      for await (const event of stream) events.push(event)
    })()
    await new Promise((r) => setTimeout(r, 10))
    await session.interrupt()
    await consume
    expect(agent.receivedNotifications.map((m) => m.method)).toContain('session/cancel')
    expect(events.at(-1)).toMatchObject({ kind: 'result', outcome: 'cancelled' })
    await session.close()
  })

  it('a timed-out prompt with unacknowledged cancel ends unknown and poisons the session', async () => {
    const { session } = await startWithScript({ promptNeverResolves: true })
    const events = await collect(session.sendPrompt({ text: 'hang', timeoutMs: 60 }))
    expect(events.filter((e) => e.kind === 'error')).toMatchObject([
      { kind: 'error', message: expect.stringMatching(/timed out after 60ms/) },
    ])
    expect(events.at(-1)).toMatchObject({ kind: 'result', outcome: 'unknown' })
    await expect(collect(session.sendPrompt({ text: 'again' }))).rejects.toThrowError(/close it and start a new one/)
  })

  it('refuses overlapping prompts on one session (per-Muse serialization)', async () => {
    const { session } = await startWithScript({ deferPromptUntilCancel: true })
    const stream = session.sendPrompt({ text: 'one', timeoutMs: 5_000 })
    const consume = (async () => {
      for await (const _ of stream) void _
    })()
    await new Promise((r) => setTimeout(r, 10))
    await expect(collect(session.sendPrompt({ text: 'two' }))).rejects.toThrowError(/in-flight prompt/)
    await session.interrupt()
    await consume
    await session.close()
  })

  it('flags a silent engine-side model change as an error event', async () => {
    const drift = {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: OTHER_MODEL_VALUE,
          options: [{ value: OTHER_MODEL_VALUE, name: 'qwen3-coder-plus' }],
        },
      ],
    }
    const { session } = await startWithScript({ promptUpdates: [...frames.promptUpdates, { sessionId: 'SES', update: drift }] })
    const events = await collect(session.sendPrompt({ text: 'x' }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'engine_model_changed' }))
    expect(session.modelDriftSeen).toBe(true)
    await session.close()
  })

  it('close() ends the transport without sending the unsupported session/close', async () => {
    const { session, agent } = await startWithScript()
    await session.close()
    expect(agent.received.some((m) => m.method === 'session/close')).toBe(false)
    expect(agent.isExited).toBe(true)
  })

  it('rejects a prompt after close and an empty prompt', async () => {
    const { session } = await startWithScript()
    await expect(collect(session.sendPrompt({ text: '   ' }))).rejects.toThrowError(ValidationError)
    await session.close()
    await expect(collect(session.sendPrompt({ text: 'late' }))).rejects.toThrowError(/closed/)
  })
})
