import { readFileSync } from 'node:fs'
import type { FakeAcpAgent, FakeAgentMessage } from './fake-acp-agent.ts'

/**
 * Scripts a FakeAcpAgent to behave like the recorded opencode v2.0.29 ACP
 * session (tests/fixtures/opencode-acp/recorded-frames.json). Tests can
 * override individual behaviors without re-implementing the protocol.
 */

export interface RecordedFrames {
  initializeResult: Record<string, unknown>
  sessionNew: { configOptions: Array<Record<string, unknown>> }
  promptUpdates: unknown[]
  promptResult: { stopReason: string; usage?: Record<string, unknown> }
  toolCallPair: unknown[]
  cancelResult: { stopReason: string }
}

export function loadRecordedFrames(): RecordedFrames {
  const url = new URL('../fixtures/opencode-acp/recorded-frames.json', import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as RecordedFrames
}

/** Synthetic ACP permission shape used by tests; not part of the recorded live frames. */
export const OPENCODE_PERMISSION_PARAMS = {
  sessionId: 'ses_permission',
  toolCall: {
    toolCallId: 'call_fake_permission',
    title: 'write worker note',
    kind: 'edit',
    locations: [{ path: 'worker-note.txt' }],
  },
  options: [
    { optionId: 'proceed_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'deny_once', name: 'Deny', kind: 'reject_once' },
  ],
} as const

export interface OpencodeScriptOptions {
  loadSession?: boolean
  /** Override the model option list; default: recorded list. */
  models?: Array<{ value: string; name: string }>
  /** Model a fresh session starts on; default: recorded default. */
  defaultModel?: string
  /** session/update payloads emitted during a prompt; default: recorded. */
  promptUpdates?: unknown[]
  /** Result stopReason; default 'end_turn'. */
  stopReason?: string
  /** Result usage; default: recorded. */
  usage?: Record<string, unknown>
  /** Never answer session/prompt (timeout tests). */
  promptNeverResolves?: boolean
  /** Answer session/prompt only once session/cancel arrives (interrupt tests). */
  deferPromptUntilCancel?: boolean
  initializeError?: { code: number; message: string }
  newSessionError?: { code: number; message: string }
  loadError?: { code: number; message: string }
  /** Extra behavior when a prompt arrives (e.g. send a permission request). */
  onPrompt?: (agent: FakeAcpAgent, sessionId: string, requestId: number, params: unknown) => void
  /** Send a synthetic session/request_permission during a prompt. */
  permissionOnPrompt?: boolean
}

export interface OpencodeScriptState {
  sessionCounter: number
  currentModel: string
  pendingPrompts: Map<number, string>
  /** Every prompt request's params, in order. */
  prompts: Array<{ sessionId: string; prompt: unknown[] }>
  cancels: string[]
  permissionRequestsSent: number
  /** Server requests sent by the fake (id -> params), for response assertions. */
  serverRequests: Map<number, unknown>
}

export function scriptOpencode(agent: FakeAcpAgent, opts: OpencodeScriptOptions = {}): OpencodeScriptState {
  const frames = loadRecordedFrames()
  const recordedModelOption = frames.sessionNew.configOptions.find((o) => o['id'] === 'model')
  const defaultModel =
    opts.defaultModel ??
    (typeof recordedModelOption?.['currentValue'] === 'string' ? (recordedModelOption['currentValue'] as string) : 'opencode/unknown')
  const state: OpencodeScriptState = {
    sessionCounter: 0,
    currentModel: defaultModel,
    pendingPrompts: new Map(),
    prompts: [],
    cancels: [],
    permissionRequestsSent: 0,
    serverRequests: new Map(),
  }
  let serverRequestId = 9000

  function buildConfigOptions(currentModel: string): Array<Record<string, unknown>> {
    const options = structuredClone(frames.sessionNew.configOptions)
    for (const option of options) {
      if (option['id'] === 'model') {
        option['currentValue'] = currentModel
        if (opts.models) option['options'] = opts.models
      }
    }
    return options
  }

  function sendUpdates(sessionId: string, updates: unknown[]): void {
    for (const update of updates) {
      agent.notify('session/update', { sessionId, update })
    }
  }

  function finishPrompt(requestId: number, sessionId: string, stopReason: string): void {
    sendUpdates(sessionId, opts.promptUpdates ?? frames.promptUpdates)
    agent.respond(requestId, {
      stopReason,
      usage: opts.usage ?? frames.promptResult.usage,
    })
  }

  agent.onMessage = (msg: FakeAgentMessage, a: FakeAcpAgent): boolean => {
    const id = msg.id as number
    switch (msg.method) {
      case 'initialize': {
        if (opts.initializeError) {
          a.respondError(id, opts.initializeError.code, opts.initializeError.message)
          return true
        }
        const result = structuredClone(frames.initializeResult)
        if (opts.loadSession === false) {
          const caps = result['agentCapabilities'] as Record<string, unknown>
          caps['loadSession'] = false
        }
        a.respond(id, result)
        return true
      }
      case 'session/new': {
        if (opts.newSessionError) {
          a.respondError(id, opts.newSessionError.code, opts.newSessionError.message)
          return true
        }
        state.sessionCounter += 1
        const sessionId = `ses_fake_${state.sessionCounter}`
        a.respond(id, { sessionId, configOptions: buildConfigOptions(defaultModel) })
        return true
      }
      case 'session/load': {
        if (opts.loadError) {
          a.respondError(id, opts.loadError.code, opts.loadError.message)
          return true
        }
        const params = msg.params as { sessionId?: string } | undefined
        a.respond(id, { configOptions: buildConfigOptions(params?.sessionId ? state.currentModel : defaultModel) })
        return true
      }
      case 'session/set_config_option': {
        const params = msg.params as { value?: string } | undefined
        if (typeof params?.value === 'string') state.currentModel = params.value
        a.respond(id, { configOptions: buildConfigOptions(state.currentModel) })
        return true
      }
      case 'session/prompt': {
        const params = (msg.params ?? {}) as { sessionId: string; prompt: unknown[] }
        state.pendingPrompts.set(id, params.sessionId)
        state.prompts.push({ sessionId: params.sessionId, prompt: params.prompt })
        opts.onPrompt?.(a, params.sessionId, id, msg.params)
        if (opts.permissionOnPrompt) {
          const requestId = serverRequestId++
          const permissionParams = { ...OPENCODE_PERMISSION_PARAMS, sessionId: params.sessionId }
          state.permissionRequestsSent += 1
          state.serverRequests.set(requestId, permissionParams)
          a.send({ id: requestId, method: 'session/request_permission', params: permissionParams })
          // Give the client time to answer before ending the turn, matching a
          // real engine that continues after a denial.
          setTimeout(() => {
            if (!state.pendingPrompts.has(id)) return
            state.pendingPrompts.delete(id)
            finishPrompt(id, params.sessionId, opts.stopReason ?? 'end_turn')
          }, 250)
          return true
        }
        if (!opts.promptNeverResolves && !opts.deferPromptUntilCancel) {
          state.pendingPrompts.delete(id)
          finishPrompt(id, params.sessionId, opts.stopReason ?? 'end_turn')
        }
        return true
      }
      case 'session/close': {
        a.respond(id, {})
        return true
      }
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
      if (opts.deferPromptUntilCancel) {
        finishPrompt(requestId, sessionId, 'cancelled')
      } else if (!opts.promptNeverResolves) {
        a.respond(requestId, { stopReason: 'cancelled' })
      }
      // promptNeverResolves: stay pending forever, even after cancel
    }
  }

  return state
}
