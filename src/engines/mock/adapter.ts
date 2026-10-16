import { newId } from '../../domain/ids.ts'
import {
  defaultCapabilities,
  type EngineAdapter,
  type EngineAuthStatus,
  type EngineCapabilities,
  type EngineDiscovery,
  type EngineEvent,
  type EngineModel,
  type EngineSession,
  type EngineSessionInfo,
  type PromptRequest,
  type StartSessionRequest,
} from '../contract/types.ts'

/**
 * Deterministic mock engine for tests and dev configs. No models, no network:
 * behavior comes entirely from a per-prompt script so orchestration logic can
 * be exercised without paid engines or Docker (prompt §12).
 */

export type MockOutcome = 'success' | 'failure' | 'cancelled' | 'unknown'

export interface MockScriptStep {
  /** Events emitted before the result (default: nothing extra). */
  events?: EngineEvent[]
  /** Text convenience: equivalent to a single text event. */
  text?: string
  /** Delay before the result; used to test interrupt races. */
  delayMs?: number
  /** Result outcome; default 'success'. */
  outcome?: MockOutcome
  /** If true, the prompt stream ends with an error event and unknown outcome. */
  protocolCrash?: boolean
  /**
   * If set, `sendPrompt` THROWS with this message instead of yielding — the
   * transport-failure path. Callers must still close the session.
   */
  throw?: string
}

export interface MockAdapterOptions {
  kind?: string
  capabilities?: Partial<EngineCapabilities>
  discovery?: Partial<EngineDiscovery>
  models?: EngineModel[]
  auth?: EngineAuthStatus
  /** Per-prompt scripts, consumed in order; after exhaustion a default success is returned. */
  script?: MockScriptStep[]
  onPrompt?: (req: PromptRequest, session: EngineSessionInfo) => void
  onStartSession?: (req: StartSessionRequest) => void
  /** Test hook: called when a session is closed (leak assertions). */
  onSessionClose?: (session: EngineSessionInfo) => void
}

interface MockSessionState {
  interrupted: boolean
  wake: (() => void) | null
}

class MockEngineSession implements EngineSession {
  readonly info: EngineSessionInfo
  private readonly state: MockSessionState = { interrupted: false, wake: null }
  private readonly script: MockScriptStep[]
  private readonly onPrompt: MockAdapterOptions['onPrompt']
  private readonly onSessionClose: MockAdapterOptions['onSessionClose']

  constructor(
    info: EngineSessionInfo,
    script: MockScriptStep[],
    onPrompt: MockAdapterOptions['onPrompt'],
    onSessionClose: MockAdapterOptions['onSessionClose'],
  ) {
    this.info = info
    this.script = script
    this.onPrompt = onPrompt
    this.onSessionClose = onSessionClose
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolveFn) => {
      if (ms <= 0 || this.state.interrupted) return resolveFn()
      const t = setTimeout(() => {
        this.state.wake = null
        resolveFn()
      }, ms)
      this.state.wake = () => {
        clearTimeout(t)
        this.state.wake = null
        resolveFn()
      }
    })
  }

  async *sendPrompt(req: PromptRequest): AsyncIterable<EngineEvent> {
    this.onPrompt?.(req, this.info)
    yield { kind: 'status', status: 'busy' }
    const step = this.script.shift() ?? {}
    if (step.throw !== undefined) throw new Error(step.throw)
    for (const ev of step.events ?? []) {
      if (this.state.interrupted) break
      yield ev
    }
    if (step.text !== undefined && !this.state.interrupted) yield { kind: 'text', text: step.text }
    if (step.delayMs !== undefined) await this.sleep(step.delayMs)
    if (step.protocolCrash) {
      yield { kind: 'error', code: 'mock_protocol_crash', message: 'scripted protocol crash' }
      yield { kind: 'result', outcome: 'unknown', summary: 'scripted crash' }
      return
    }
    if (this.state.interrupted) {
      yield { kind: 'result', outcome: 'cancelled', summary: 'interrupted' }
      return
    }
    yield { kind: 'result', outcome: step.outcome ?? 'success', summary: `mock:${step.outcome ?? 'success'}` }
  }

  async interrupt(): Promise<void> {
    this.state.interrupted = true
    this.state.wake?.()
  }

  async close(): Promise<void> {
    this.state.wake?.()
    this.onSessionClose?.(this.info)
  }
}

export class MockEngineAdapter implements EngineAdapter {
  readonly kind: string
  private readonly opts: MockAdapterOptions

  constructor(opts: MockAdapterOptions = {}) {
    this.kind = opts.kind ?? 'mock'
    this.opts = opts
  }

  capabilities(): EngineCapabilities {
    return { ...defaultCapabilities(), modelList: true, interrupt: true, resumeSession: true, ...this.opts.capabilities }
  }

  async discover(): Promise<EngineDiscovery> {
    return {
      engineKind: this.kind,
      installed: true,
      binaryPath: '<mock>',
      version: 'mock-1.0.0',
      fix: 'nothing to install — mock engine',
      ...this.opts.discovery,
    }
  }

  async listModels(): Promise<EngineModel[]> {
    return this.opts.models ?? [{ id: 'mock/model-a', source: 'static' }]
  }

  async authStatus(): Promise<EngineAuthStatus> {
    return this.opts.auth ?? { configured: true, hint: 'mock engine needs no auth' }
  }

  async startSession(req: StartSessionRequest): Promise<EngineSession> {
    this.opts.onStartSession?.(req)
    const info: EngineSessionInfo = {
      id: newId('session'),
      nativeSessionId: `mock-session-${newId('session')}`,
      resumeToken: req.resumeToken ?? `mock-resume-${newId('session')}`,
    }
    const script = [...(this.opts.script ?? [])]
    return new MockEngineSession(info, script, this.opts.onPrompt, this.opts.onSessionClose)
  }
}
