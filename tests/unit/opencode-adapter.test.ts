import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OpenCodeEngineAdapter,
  buildEngineEnv,
  toAcpMcpServers,
  readModelOption,
  type OpenCodeAdapterOptions,
  OpenCodeEngineSession,
} from '../../src/engines/opencode/adapter.ts'
import { defaultCapabilities } from '../../src/engines/contract/types.ts'
import type { EngineEvent, EngineModel, PromptRequest, StartSessionRequest } from '../../src/engines/contract/types.ts'
import {
  CapabilityError,
  EngineAuthMissingError,
  EngineMissingError,
  ValidationError,
} from '../../src/domain/errors.ts'
import type { AcpSpawnFn } from '../../src/engines/acp/client.ts'
import { controlledChannel } from '../helpers/controlled-channel.ts'
import { FakeAcpAgent, fakeSpawn } from '../helpers/fake-acp-agent.ts'
import { loadRecordedFrames, scriptOpencode, type OpencodeScriptOptions } from '../helpers/opencode-script.ts'

const MODEL = 'opencode/deepseek-v4.1-flash-free'
const DEFAULT_MODEL = 'opencode/nemotron-3.5-super-vl-free'

const frames = loadRecordedFrames()

function makeAdapter(agent: FakeAcpAgent, overrides: OpenCodeAdapterOptions = {}) {
  const spawn = fakeSpawn(() => agent)
  const adapter = new OpenCodeEngineAdapter({
    binaryPath: '/fake/opencode',
    spawnFn: spawn.spawnFn,
    cancelGraceMs: 40,
    ...overrides,
  })
  return { adapter, spawn }
}

function sessionRequest(overrides: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return {
    muse: { id: 'muse_test', slug: 'worker-a', role: 'coder', model: MODEL },
    workdir: join('C:', 'work'),
    env: {},
    configDir: join('C:', 'muse-home'),
    ...overrides,
  }
}

async function startWithScript(
  opts: OpencodeScriptOptions = {},
  adapterOverrides: OpenCodeAdapterOptions = {},
): Promise<{ session: OpenCodeEngineSession; agent: FakeAcpAgent; state: ReturnType<typeof scriptOpencode> }> {
  const agent = new FakeAcpAgent()
  const state = scriptOpencode(agent, opts)
  const { adapter } = makeAdapter(agent, adapterOverrides)
  const session = (await adapter.startSession(sessionRequest())) as OpenCodeEngineSession
  return { session, agent, state }
}

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('opencode adapter: capabilities and discovery', () => {
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
      envOverrides: { PATH: '' },
      platform: 'win32',
      isFile: () => false,
    })
    const d = await adapter.discover()
    expect(d).toMatchObject({ engineKind: 'opencode', installed: false, binaryPath: null, version: null })
    expect(d.fix).toMatch(/PLUTON_OPENCODE_BIN|install OpenCode/)
  })

  it('discover() runs --version through the bounded runner', async () => {
    const calls: string[][] = []
    const { adapter } = makeAdapter(new FakeAcpAgent(), {
      runFn: async (argv) => {
        calls.push(argv)
        return { argv, exitCode: 0, timedOut: false, stdout: 'opencode v2.0.29\n', stderr: '', truncated: false, durationMs: 1 }
      },
    })
    const d = await adapter.discover()
    expect(d).toMatchObject({ installed: true, binaryPath: '/fake/opencode', version: 'opencode v2.0.29' })
    expect(calls).toEqual([['/fake/opencode', '--version']])
  })

  it('listModels() parses the real `opencode models` line format', async () => {
    let seenArgv: string[] | undefined
    const { adapter } = makeAdapter(new FakeAcpAgent(), {
      runFn: async (argv) => {
        seenArgv = argv
        return {
          argv,
          exitCode: 0,
          timedOut: false,
          stdout: 'opencode/big-pickle\nopencode/cat-jam-free\n\njunk line with spaces\nopencode/big-pickle\nopencode/deepseek-v4.1-flash-free\n',
          stderr: '',
          truncated: false,
          durationMs: 1,
        }
      },
    })
    const models = await adapter.listModels()
    expect(seenArgv).toEqual(['/fake/opencode', 'models', '--standalone'])
    expect(models.map((m: EngineModel) => m.id)).toEqual([
      'opencode/big-pickle',
      'opencode/cat-jam-free',
      'opencode/deepseek-v4.1-flash-free',
    ])
    expect(models.every((m) => m.source === 'engine')).toBe(true)
  })

  it('listModels() refuses truncated or failing output instead of inventing models', async () => {
    const { adapter: truncated } = makeAdapter(new FakeAcpAgent(), {
      runFn: async (argv) => ({ argv, exitCode: 0, timedOut: false, stdout: 'opencode/a\n', stderr: '', truncated: true, durationMs: 1 }),
    })
    await expect(truncated.listModels()).rejects.toThrowError(/512 KiB cap/)
    const { adapter: failing } = makeAdapter(new FakeAcpAgent(), {
      runFn: async (argv) => ({ argv, exitCode: 1, timedOut: false, stdout: '', stderr: 'boom\n', truncated: false, durationMs: 1 }),
    })
    await expect(failing.listModels()).rejects.toThrowError(/exit code 1/)
  })

  it('authStatus() checks the Muse engine home and reports presence only', async () => {
    let seenEnv: Record<string, string> | undefined
    let seenArgv: string[] | undefined
    const { adapter } = makeAdapter(new FakeAcpAgent(), {
      runFn: async (argv, options) => {
        seenArgv = argv
        seenEnv = options?.env as Record<string, string> | undefined
        return { argv, exitCode: 0, timedOut: false, stdout: 'No authenticated integrations\n', stderr: '', truncated: false, durationMs: 1 }
      },
    })
    const none = await adapter.authStatus(join('C:', 'muse-home'))
    expect(none.configured).toBe(false)
    expect(none.hint).toMatch(/auth login/)
    expect(seenArgv).toEqual(['/fake/opencode', 'auth', 'list', '--standalone'])
    expect(seenEnv?.['XDG_CONFIG_HOME']).toBe(join(join('C:', 'muse-home'), 'config'))
  })
})

describe('opencode adapter: session lifecycle', () => {
  it('initializes, creates a session and pins the model via set_config_option', async () => {
    const { session, agent } = await startWithScript()
    const methods = agent.received.filter((m) => m.method).map((m) => m.method)
    expect(methods).toEqual(['initialize', 'session/new', 'session/set_config_option'])

    const init = agent.received[0]
    expect(init?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const newSession = agent.received.find((m) => m.method === 'session/new')
    expect(newSession?.params).toMatchObject({ cwd: join('C:', 'work'), mcpServers: [] })
    const setModel = agent.received.find((m) => m.method === 'session/set_config_option')
    expect(setModel?.params).toEqual({ sessionId: 'ses_fake_1', configId: 'model', value: MODEL })

    expect(session.info.nativeSessionId).toBe('ses_fake_1')
    expect(session.info.resumeToken).toBe('ses_fake_1')
    await session.close()
  })

  it('does not call set_config_option when the session already runs the requested model', async () => {
    const { session, agent } = await startWithScript({ defaultModel: MODEL })
    expect(agent.received.some((m) => m.method === 'session/set_config_option')).toBe(false)
    await session.close()
  })

  it('refuses a model the engine does not offer, before any prompt', async () => {
    const agent = new FakeAcpAgent()
    scriptOpencode(agent, {})
    const { adapter } = makeAdapter(agent)
    await expect(
      adapter.startSession(sessionRequest({ muse: { id: 'm', slug: 'w', role: 'coder', model: 'opencode/not-a-model' } })),
    ).rejects.toThrowError(ValidationError)
    expect(agent.received.some((m) => m.method === 'session/set_config_option')).toBe(false)
    expect(agent.isExited).toBe(true)
  })

  it('rejects an empty model id outright', async () => {
    const { adapter } = makeAdapter(new FakeAcpAgent())
    await expect(
      adapter.startSession(sessionRequest({ muse: { id: 'm', slug: 'w', role: 'coder', model: '  ' } })),
    ).rejects.toThrowError(ValidationError)
  })

  it('refuses resume when the agent does not declare loadSession', async () => {
    const agent = new FakeAcpAgent()
    scriptOpencode(agent, { loadSession: false })
    const { adapter } = makeAdapter(agent)
    await expect(adapter.startSession(sessionRequest({ resumeToken: 'ses_old' }))).rejects.toThrowError(CapabilityError)
    expect(agent.received.some((m) => m.method === 'session/load')).toBe(false)
  })

  it('resumes an existing session via session/load and reuses the native id', async () => {
    const agent = new FakeAcpAgent()
    const state = scriptOpencode(agent, {})
    state.currentModel = MODEL
    const { adapter } = makeAdapter(agent)
    const session = await adapter.startSession(sessionRequest({ resumeToken: 'ses_old_1' }))
    const load = agent.received.find((m) => m.method === 'session/load')
    expect(load?.params).toMatchObject({ sessionId: 'ses_old_1', cwd: join('C:', 'work'), mcpServers: [] })
    expect(session.info.nativeSessionId).toBe('ses_old_1')
    await session.close()
  })

  it('maps Pluton MCP server specs onto the ACP wire shape', async () => {
    const agent = new FakeAcpAgent()
    scriptOpencode(agent, {})
    const { adapter } = makeAdapter(agent)
    const session = await adapter.startSession(
      sessionRequest({
        mcpServers: [
          { kind: 'stdio', name: 'pluton-tools', command: ['node', 'server.js', '--flag'], env: { TOKEN_X: 'not-a-secret' } },
        ],
      }),
    )
    const newSession = agent.received.find((m) => m.method === 'session/new')
    expect((newSession?.params as { mcpServers: unknown }).mcpServers).toEqual([
      { name: 'pluton-tools', command: 'node', args: ['server.js', '--flag'], env: [{ name: 'TOKEN_X', value: 'not-a-secret' }] },
    ])
    await session.close()
  })

  it('passes the Muse-isolated engine home through the child environment', async () => {
    const { session, agent } = await startWithScript()
    expect(agent.spawnEnv['XDG_CONFIG_HOME']).toBe(join(join('C:', 'muse-home'), 'config'))
    expect(agent.spawnEnv['XDG_DATA_HOME']).toBe(join(join('C:', 'muse-home'), 'data'))
    expect(agent.spawnArgs.slice(0, 2)).toEqual(['/fake/opencode', 'acp'])
    await session.close()
  })

  it('maps a spawn ENOENT to EngineMissingError with the install fix', async () => {
    const spawnFn: AcpSpawnFn = () => {
      const fake = new FakeAcpAgent()
      setImmediate(() => fake.emitError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
      return fake.child
    }
    const adapter = new OpenCodeEngineAdapter({ binaryPath: '/does/not/exist', spawnFn })
    await expect(adapter.startSession(sessionRequest())).rejects.toThrowError(EngineMissingError)
  })

  it('maps an authentication failure from the engine to EngineAuthMissingError', async () => {
    const agent = new FakeAcpAgent()
    scriptOpencode(agent, { initializeError: { code: -32000, message: 'Unauthorized: no valid credentials' } })
    const { adapter } = makeAdapter(agent)
    await expect(adapter.startSession(sessionRequest())).rejects.toThrowError(EngineAuthMissingError)
  })
})

describe('opencode adapter: prompts and events', () => {
  it('replays the recorded transcript into normalized events and a success result', async () => {
    const { session } = await startWithScript()
    const events = await collect(session.sendPrompt({ text: 'Reply with exactly the text PLUTON_ACP_OK and nothing else.' }))
    expect(events.map((e) => e.kind)).toEqual(['status', 'text', 'usage', 'usage', 'result'])
    expect(events[1]).toEqual({ kind: 'text', text: 'PLUTON_ACP_OK' })
    expect(events[2]).toMatchObject({ kind: 'usage', costUsd: 0 })
    expect(events[3]).toMatchObject({ kind: 'usage', inputTokens: 16525, outputTokens: 8 })
    expect(events[4]).toMatchObject({ kind: 'result', outcome: 'success', summary: 'stopReason: end_turn' })
    await session.close()
  })

  it('normalizes the recorded tool-call pair into start/end tool events', async () => {
    const { session } = await startWithScript({ promptUpdates: frames.toolCallPair })
    const events = await collect(session.sendPrompt({ text: 'write a file' }))
    const tools = events.filter((e) => e.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ kind: 'tool', name: 'write', phase: 'start' })
    expect(tools[1]).toMatchObject({ kind: 'tool', name: 'write', phase: 'end', isError: false })
    await session.close()
  })

  it.each([
    ['cancelled', 'cancelled'],
    ['refusal', 'failure'],
    ['max_tokens', 'failure'],
    ['some_future_reason', 'unknown'],
  ])('maps stopReason %s to outcome %s', async (stopReason, expected) => {
    const { session } = await startWithScript({ stopReason, promptUpdates: [] })
    const events = await collect(session.sendPrompt({ text: 'x' }))
    expect(events.filter((e) => e.kind === 'result')).toMatchObject([{ outcome: expected }])
    await session.close()
  })

  it('sends role instructions as the first prompt part of a new session only', async () => {
    const agent = new FakeAcpAgent()
    const state = scriptOpencode(agent, { promptUpdates: [] })
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

  it('surfaces permission requests as approval_request events and denies fail-closed', async () => {
    const agent = new FakeAcpAgent()
    scriptOpencode(agent, {
      promptUpdates: [],
      onPrompt: (a, sessionId) => {
        a.send({
          id: 900,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 'call_1', title: 'write file' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        })
      },
    })
    const { adapter } = makeAdapter(agent)
    const session = await adapter.startSession(sessionRequest())
    const events = await collect(session.sendPrompt({ text: 'do work' }))
    expect(events).toContainEqual({
      kind: 'approval_request',
      requestId: 'call_1',
      description: 'engine requested permission: write file — Pluton decision: deny(fail-closed) (approvalPolicy=deny)',
    })
    const response = agent.receivedResponses.find((m) => m.id === 900)
    expect(response?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
    await session.close()
  })

  it('interactive policy holds the engine request pending and grants the narrow option on approval', async () => {
    const agent = new FakeAcpAgent()
    scriptOpencode(agent, {
      promptUpdates: [],
      onPrompt: (a, sessionId) => {
        a.send({
          id: 901,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 'call_i1', title: 'write file', kind: 'edit' },
            options: [
              { optionId: 'always', name: 'Always', kind: 'allow_always' },
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        })
      },
    })
    const controlled = controlledChannel()
    const { adapter } = makeAdapter(agent, { approvalPolicy: 'interactive' })
    const session = (await adapter.startSession(
      sessionRequest({ approvals: controlled.channel }),
    )) as OpenCodeEngineSession

    const consume = collect(session.sendPrompt({ text: 'do work' }))
    const req = await controlled.whenRequested
    expect(req.requestId).toBe('call_i1')
    expect(req.description).toContain('write file')
    expect(req.scope).toMatchObject({ toolKind: 'edit', toolTitle: 'write file' })
    // The engine keeps waiting while the operator decides.
    expect(agent.receivedResponses.some((m) => m.id === 901)).toBe(false)

    controlled.respond('allow')
    await consume
    // Narrow grant only: never the allow_always option.
    expect(agent.receivedResponses.find((m) => m.id === 901)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })
    await session.close()
  })

  it('interactive policy answers the reject option when the operator denies', async () => {
    const agent = new FakeAcpAgent()
    scriptOpencode(agent, {
      promptUpdates: [],
      onPrompt: (a, sessionId) => {
        a.send({
          id: 902,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 'call_i2', title: 'shell command' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        })
      },
    })
    const controlled = controlledChannel()
    const { adapter } = makeAdapter(agent, { approvalPolicy: 'interactive' })
    const session = (await adapter.startSession(
      sessionRequest({ approvals: controlled.channel }),
    )) as OpenCodeEngineSession

    const consume = collect(session.sendPrompt({ text: 'do work' }))
    await controlled.whenRequested
    controlled.respond('deny')
    await consume
    expect(agent.receivedResponses.find((m) => m.id === 902)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    })
    expect(session.approvalDecisions).toEqual([{ requestId: 'call_i2', decision: 'deny(operator)' }])
    await session.close()
  })

  it('interactive policy fails closed immediately when no operator channel is wired', async () => {
    const agent = new FakeAcpAgent()
    scriptOpencode(agent, {
      promptUpdates: [],
      onPrompt: (a, sessionId) => {
        a.send({
          id: 903,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 'call_i3', title: 'write file' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        })
      },
    })
    const { adapter } = makeAdapter(agent, { approvalPolicy: 'interactive' })
    const session = (await adapter.startSession(sessionRequest())) as OpenCodeEngineSession

    await collect(session.sendPrompt({ text: 'do work' }))
    expect(agent.receivedResponses.find((m) => m.id === 903)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    })
    expect(session.approvalDecisions).toEqual([{ requestId: 'call_i3', decision: 'deny(no operator channel)' }])
    await session.close()
  })

  it('interrupt() aborts a pending operator request fail-closed and answers the engine', async () => {
    const agent = new FakeAcpAgent()
    scriptOpencode(agent, {
      promptUpdates: [],
      deferPromptUntilCancel: true,
      onPrompt: (a, sessionId) => {
        a.send({
          id: 904,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 'call_i4', title: 'write file' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        })
      },
    })
    const controlled = controlledChannel()
    const { adapter } = makeAdapter(agent, { approvalPolicy: 'interactive' })
    const session = (await adapter.startSession(
      sessionRequest({ approvals: controlled.channel }),
    )) as OpenCodeEngineSession

    const events: EngineEvent[] = []
    const consume = (async () => {
      for await (const event of session.sendPrompt({ text: 'do work', timeoutMs: 5_000 })) events.push(event)
    })()
    await controlled.whenRequested

    await session.interrupt()
    await consume
    expect(controlled.aborted.length).toBeGreaterThanOrEqual(1)
    expect(agent.receivedResponses.find((m) => m.id === 904)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    })
    expect(events.at(-1)).toMatchObject({ kind: 'result', outcome: 'cancelled' })
    await session.close()
  })

  it('refuses a permission request that arrives after close (no wait, fail-closed answer)', async () => {
    const agent = new FakeAcpAgent()
    scriptOpencode(agent, { promptUpdates: [] })
    const controlled = controlledChannel()
    const { adapter } = makeAdapter(agent, { approvalPolicy: 'interactive' })
    const session = (await adapter.startSession(
      sessionRequest({ approvals: controlled.channel }),
    )) as OpenCodeEngineSession

    await session.close()
    const response = await session.handleServerRequest('session/request_permission', {
      sessionId: session.info.nativeSessionId,
      toolCall: { toolCallId: 'call_late', title: 'write file' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    })

    expect(response).toEqual({ result: { outcome: { outcome: 'selected', optionId: 'reject' } } })
    expect(controlled.requests).toHaveLength(0)
    expect(session.approvalDecisions).toEqual([{ requestId: 'call_late', decision: 'deny(session closed)' }])
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
    await session.close()
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
          currentValue: 'opencode/some-other-model',
          options: [{ value: 'opencode/some-other-model', name: 'Other' }],
        },
      ],
    }
    const { session } = await startWithScript({ promptUpdates: [...frames.promptUpdates, drift] })
    const events = await collect(session.sendPrompt({ text: 'x' }))
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'engine_model_changed' }),
    )
    expect(session.modelDriftSeen).toBe(true)
    await session.close()
  })

  it('rejects a prompt after close and an empty prompt', async () => {
    const { session } = await startWithScript()
    await expect(collect(session.sendPrompt({ text: '   ' }))).rejects.toThrowError(ValidationError)
    await session.close()
    await expect(collect(session.sendPrompt({ text: 'late' }))).rejects.toThrowError(/closed/)
  })
})

describe('opencode adapter: pure helpers', () => {
  it('buildEngineEnv isolates the engine home and keeps platform essentials', () => {
    const env = buildEngineEnv(join('C:', 'home'), { EXTRA: '1' }, 'win32')
    expect(env['XDG_CONFIG_HOME']).toBe(join(join('C:', 'home'), 'config'))
    expect(env['USERPROFILE']).toBe(join('C:', 'home'))
    expect(env['EXTRA']).toBe('1')
    expect(env['HOME']).toBeUndefined()
    const posix = buildEngineEnv('/home/x', {}, 'linux')
    expect(posix['HOME']).toBe('/home/x')
    expect(posix['USERPROFILE']).toBeUndefined()
  })

  it('toAcpMcpServers rejects an empty argv instead of sending a broken server', () => {
    expect(() => toAcpMcpServers([{ kind: 'stdio', name: 'x', command: [] }])).toThrowError(ValidationError)
  })

  it('readModelOption understands flat and grouped value lists', () => {
    const flat = readModelOption([
      { id: 'model', currentValue: 'a', options: [{ value: 'a' }, { value: 'b' }] },
    ])
    expect(flat).toMatchObject({ id: 'model', currentValue: 'a', values: ['a', 'b'] })
    expect(flat?.choices.map((c) => c.value)).toEqual(['a', 'b'])
    const grouped = readModelOption([
      {
        id: 'model',
        currentValue: 'a',
        options: [{ group: 'g', name: 'G', options: [{ value: 'a' }, { value: 'b' }] }],
      },
    ])
    expect(grouped?.values).toEqual(['a', 'b'])
    expect(readModelOption(undefined)).toBeNull()
  })
})
