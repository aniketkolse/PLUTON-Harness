import { readFileSync } from 'node:fs'
import type { FakeAcpAgent, FakeAgentMessage } from './fake-acp-agent.ts'

/**
 * Scripts a FakeAcpAgent to behave like the recorded Qwen Code v0.25.2 ACP
 * session (tests/fixtures/qwen-acp/recorded-frames.json): object-shaped
 * `sessionCapabilities` without `close`, `mode` + `model` config options,
 * policy-testable `session/request_permission`, qwen-specific notifications
 * and an unsupported `session/close` (-32601).
 */

export interface QwenRecordedFrames {
  initializeResult: Record<string, unknown>
  sessionNew: {
    sessionId: string
    models: Record<string, unknown>
    modes: Record<string, unknown>
    configOptions: Array<Record<string, unknown>>
  }
  setModeResult: { configOptions: Array<Record<string, unknown>> }
  setModelResult: { configOptions: Array<Record<string, unknown>> }
  permissionRequest: Record<string, unknown> | null
  promptUpdates: Array<{ sessionId: string; update: Record<string, unknown> }>
  promptResult: Record<string, unknown>
  cancelResult: { stopReason: string }
  loadResult: Record<string, unknown>
  sessionList: Record<string, unknown> | null
  authError: { code: number; message: string; data?: unknown } | null
}

export function loadQwenFrames(): QwenRecordedFrames {
  const url = new URL('../fixtures/qwen-acp/recorded-frames.json', import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as QwenRecordedFrames
}

export interface QwenScriptOptions {
  /** Model the session starts on (composite value); default: recorded. */
  currentModel?: string
  /** Model choice values offered; default: recorded single-choice list. */
  modelChoices?: Array<{ value: string; name?: string }>
  /** Session mode at creation; default: recorded 'auto'. */
  currentMode?: string
  /** `session/update` frames sent per prompt; default: the recorded list. */
  promptUpdates?: Array<{ sessionId: string; update: unknown }>
  /** Fail session/new with the recorded auth error (code -32000). */
  sessionNewAuthError?: boolean
  /** Send this server request during a prompt (default: null). */
  serverRequestDuringPrompt?: Record<string, unknown>
  /** Send the recorded permission request during prompts. */
  permissionOnPrompt?: boolean
  /** Send a qwen-specific notification during prompts (ignored-updates path). */
  qwenNotificationOnPrompt?: boolean
  /** Never answer session/prompt (timeout tests). */
  promptNeverResolves?: boolean
  /** Keep the prompt pending until session/cancel arrives, then answer 'cancelled'. */
  deferPromptUntilCancel?: boolean
  /** stopReason for prompt results; default 'end_turn'. */
  stopReason?: string
  loadError?: { code: number; message: string }
}

export interface QwenScriptState {
  sessionCounter: number
  currentModel: string
  currentMode: string
  prompts: Array<{ sessionId: string; prompt: unknown[] }>
  cancels: string[]
  pendingPrompts: Map<number, string>
  permissionRequestsSent: number
  /** Server requests sent by the fake (id -> params), for response assertions. */
  serverRequests: Map<number, unknown>
}

export function scriptQwen(agent: FakeAcpAgent, opts: QwenScriptOptions = {}): QwenScriptState {
  const frames = loadQwenFrames()
  const recordedModel = frames.sessionNew.configOptions.find((o) => o['id'] === 'model')
  const state: QwenScriptState = {
    sessionCounter: 0,
    currentModel:
      opts.currentModel ??
      (typeof recordedModel?.['currentValue'] === 'string' ? (recordedModel['currentValue'] as string) : '$runtime|openai|test-model(openai)'),
    currentMode: opts.currentMode ?? 'auto',
    prompts: [],
    cancels: [],
    pendingPrompts: new Map(),
    permissionRequestsSent: 0,
    serverRequests: new Map(),
  }
  let serverRequestId = 9000

  function buildConfigOptions(): Array<Record<string, unknown>> {
    const options = structuredClone(frames.sessionNew.configOptions)
    for (const option of options) {
      if (option['id'] === 'mode') option['currentValue'] = state.currentMode
      if (option['id'] === 'model') {
        option['currentValue'] = state.currentModel
        if (opts.modelChoices) {
          option['options'] = opts.modelChoices.map((c) => ({ value: c.value, name: c.name ?? c.value, description: '' }))
        }
      }
    }
    return options
  }

  function buildSessionPayload(sessionId: string): Record<string, unknown> {
    const baked = structuredClone(frames.sessionNew)
    const choices = (opts.modelChoices ?? baked.models['availableModels']) as Array<Record<string, unknown>>
    return {
      sessionId,
      models: {
        currentModelId: state.currentModel,
        availableModels: choices.map((m) => ({
          modelId: m['value'] ?? m['modelId'],
          name: m['name'] ?? m['value'] ?? m['modelId'],
          _meta: { contextLimit: 1_000_000 },
        })),
      },
      modes: {
        currentModeId: state.currentMode,
        availableModes: baked.modes['availableModes'],
      },
      configOptions: buildConfigOptions(),
    }
  }

  function sendUpdates(sessionId: string): void {
    for (const entry of opts.promptUpdates ?? frames.promptUpdates) {
      const e = entry as { sessionId: string; update: unknown }
      agent.notify('session/update', { sessionId, update: e.update })
    }
  }

  function sendServerRequestDuringPrompt(): void {
    if (opts.qwenNotificationOnPrompt) {
      agent.notify('qwen/notify/session/prompt-suggestion', { v: 1, sessionId: 'x', suggestion: 'test' })
    }
    if (opts.permissionOnPrompt && frames.permissionRequest) {
      const id = serverRequestId++
      state.permissionRequestsSent += 1
      state.serverRequests.set(id, frames.permissionRequest)
      agent.send({ id, method: 'session/request_permission', params: frames.permissionRequest })
    }
    if (opts.serverRequestDuringPrompt) {
      const id = serverRequestId++
      state.serverRequests.set(id, opts.serverRequestDuringPrompt)
      agent.send({ id, method: String(opts.serverRequestDuringPrompt['method'] ?? 'craft/drainMidTurnQueue'), params: opts.serverRequestDuringPrompt })
    }
  }

  function finishPrompt(requestId: number, sessionId: string, stopReason: string): void {
    sendUpdates(sessionId)
    const result = structuredClone(frames.promptResult)
    result['stopReason'] = stopReason
    agent.respond(requestId, result)
  }

  agent.onMessage = (msg: FakeAgentMessage, a: FakeAcpAgent): boolean => {
    const id = msg.id as number
    switch (msg.method) {
      case 'initialize':
        a.respond(id, structuredClone(frames.initializeResult))
        return true
      case 'session/new': {
        if (opts.sessionNewAuthError) {
          const err = frames.authError ?? { code: -32000, message: 'Authentication required' }
          a.respondError(id, err.code, err.message, err.data)
          return true
        }
        state.sessionCounter += 1
        const sessionId = `qwen_fake_${state.sessionCounter}`
        a.respond(id, buildSessionPayload(sessionId))
        return true
      }
      case 'session/load': {
        if (opts.loadError) {
          a.respondError(id, opts.loadError.code, opts.loadError.message)
          return true
        }
        a.respond(id, { ...structuredClone(frames.loadResult), configOptions: buildConfigOptions() })
        return true
      }
      case 'session/set_config_option': {
        const params = msg.params as { configId?: string; value?: string } | undefined
        if (params?.configId === 'mode' && typeof params.value === 'string') state.currentMode = params.value
        if (params?.configId === 'model' && typeof params.value === 'string') state.currentModel = params.value
        a.respond(id, { configOptions: buildConfigOptions() })
        return true
      }
      case 'session/prompt': {
        const params = (msg.params ?? {}) as { sessionId: string; prompt: unknown[] }
        state.prompts.push({ sessionId: params.sessionId, prompt: params.prompt })
        if (opts.promptNeverResolves || opts.deferPromptUntilCancel) {
          state.pendingPrompts.set(id, params.sessionId)
          return true
        }
        sendServerRequestDuringPrompt()
        // Permission requests are answered by the client; give the answer a
        // tick to arrive before ending the turn (real qwen continues after a
        // rejection and still ends the turn).
        if (opts.permissionOnPrompt) {
          state.pendingPrompts.set(id, params.sessionId)
          setTimeout(() => {
            if (!state.pendingPrompts.has(id)) return
            state.pendingPrompts.delete(id)
            finishPrompt(id, params.sessionId, opts.stopReason ?? 'end_turn')
          }, 60)
          return true
        }
        finishPrompt(id, params.sessionId, opts.stopReason ?? 'end_turn')
        return true
      }
      // NOTE: no session/close — qwen v0.25.2 answers -32601 (default branch).
      default:
        return false
    }
  }

  agent.onNotification = (msg: FakeAgentMessage, a: FakeAcpAgent): void => {
    if (msg.method !== 'session/cancel') return
    const params = msg.params as { sessionId: string }
    state.cancels.push(params.sessionId)
    for (const [requestId, sessionId] of [...state.pendingPrompts]) {
      if (sessionId !== params.sessionId) continue
      state.pendingPrompts.delete(requestId)
      if (opts.promptNeverResolves) continue
      a.respond(requestId, structuredClone(frames.cancelResult))
    }
  }

  return state
}
