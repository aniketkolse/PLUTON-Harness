import type { EngineEvent, ModelSelection } from './contract/types.ts'
import type { ModelErrorCategory, FallbackScope } from './contract/types.ts'
import type { ModelSelectionInput } from './model-selection.ts'
import type { ModelRegistry } from './model-registry.ts'
import type { ModelHealthMonitor } from './model-health.ts'
import { classifyModelError, type ModelErrorContext, type ModelErrorClassification } from './model-health.ts'
import { selectModel, type ModelSelectionOutcome } from './model-selection.ts'

/**
 * Bounded fallback engine (PLUTON 3.2, Phase 5).
 *
 * Decides whether to retry the current model, switch to the next eligible
 * model, or stop. It never retries on its own, never switches models, and
 * never mutates worker assignments; callers apply the decision.
 */

export type FallbackAction =
  | 'retry-same'
  | 'switch'
  | 'exhausted'
  | 'no-action'
  | 'unsafe'

export interface ModelFallbackConfig {
  maxRetriesPerModel: number
  cooldownMs: number
  maxTotalFallbacks: number
  now?: () => number
}

export interface ModelFallbackSwitchRecord {
  from: string
  to: string | null
  reason: string
  at: string
}

export interface ModelFallbackState {
  state: 'healthy' | 'degraded' | 'switching' | 'exhausted'
  currentModelId: string
  originalModelId: string
  fallbacksUsed: number
  exhaustedModels: Set<string>
  retryCounts: Map<string, number>
  switchHistory: ModelFallbackSwitchRecord[]
}

export interface ModelFallbackDecision {
  action: FallbackAction
  fromModelId: string
  toModelId: string | null
  category: ModelErrorCategory
  scope: FallbackScope
  allowed: boolean
  safeToReplay: boolean
  reason: string
  state: ModelFallbackState['state']
  fallbacksUsed: number
  selection: ModelSelection | null
  excludedModelIds: string[]
  decidedAt: string
}

export interface ModelFallbackInput {
  taskInput: Omit<ModelSelectionInput, 'pinnedModelId' | 'pinnedEngineKind'>
  currentModelId: string
  error: ModelErrorContext | ModelErrorClassification
  bufferedEvents: EngineEvent[]
  state: ModelFallbackState
  registry: ModelRegistry
  selector?: (registry: ModelRegistry, input: ModelSelectionInput) => ModelSelectionOutcome
  healthMonitor?: ModelHealthMonitor
  config: ModelFallbackConfig
}

export function createFallbackState(currentModelId: string): ModelFallbackState {
  return {
    state: 'healthy',
    currentModelId,
    originalModelId: currentModelId,
    fallbacksUsed: 0,
    exhaustedModels: new Set<string>(),
    retryCounts: new Map<string, number>(),
    switchHistory: [],
  }
}

export function isSafeToReplay(events: readonly EngineEvent[]): boolean {
  const open = new Set<string>()
  let anonymous = 0
  for (const ev of events) {
    if (ev.kind !== 'tool') continue
    if (ev.phase === 'start') {
      open.add(ev.callId ?? `__anon_${anonymous++}`)
    } else if (ev.phase === 'end') {
      if (ev.callId !== undefined && open.has(ev.callId)) {
        open.delete(ev.callId)
      } else if (open.size > 0) {
        const last = [...open].pop()
        if (last !== undefined) open.delete(last)
      }
    }
  }
  return open.size === 0
}

export function decideFallback(input: ModelFallbackInput): ModelFallbackDecision {
  const now = input.config.now ?? Date.now
  const nowMs = now()
  const nowIso = new Date(nowMs).toISOString()
  const state = input.state
  const registry = input.registry
  const selector = input.selector ?? selectModel

  const classification = isClassification(input.error)
    ? input.error
    : classifyModelError(input.error as ModelErrorContext)

  const category = classification.category
  const scope = classification.suggestedScope
  const retryable = classification.retryable

  const safeToReplay = isSafeToReplay(input.bufferedEvents)

  const excluded = new Set<string>([...state.exhaustedModels])

  // The caller may pass either the raw error context (preferred: it carries
  // engine/model/task identity) or a pre-computed classification. Health
  // recording must keep that identity; recording everything under
  // `engineKind: 'unknown'` makes cooldowns unusable.
  const errorContext: ModelErrorContext | null = isClassification(input.error)
    ? null
    : (input.error as ModelErrorContext)
  const healthContext = (reason: string): ModelErrorContext => ({
    engineKind: errorContext?.engineKind ?? 'unknown',
    modelId: state.currentModelId,
    providerMessage: reason,
    scopeHint: scope,
    ...(errorContext?.provider !== undefined ? { provider: errorContext.provider } : {}),
    ...(errorContext?.quotaScope !== undefined ? { quotaScope: errorContext.quotaScope } : {}),
  })

  // Replay safety comes before every retry/switch decision. A turn that left a
  // tool call open may already have produced an external side effect; neither
  // the same model nor a replacement may be asked to blindly repeat it.
  if (!safeToReplay) {
    state.state = 'degraded'
    return {
      action: 'unsafe',
      fromModelId: state.currentModelId,
      toModelId: null,
      category,
      scope,
      allowed: false,
      safeToReplay: false,
      reason: `buffered turn has unresolved tool calls; manual intervention required before replaying`,
      state: state.state,
      fallbacksUsed: state.fallbacksUsed,
      selection: null,
      excludedModelIds: [...excluded, state.currentModelId],
      decidedAt: nowIso,
    }
  }

  if (category === 'execution-error') {
    if (input.healthMonitor !== undefined) {
      input.healthMonitor.recordFailure(healthContext(classification.reason), classification)
    }
    state.state = 'degraded'
    return {
      action: 'no-action',
      fromModelId: state.currentModelId,
      toModelId: null,
      category,
      scope,
      allowed: false,
      safeToReplay,
      reason: `execution error for '${state.currentModelId}'; no automatic model switch`,
      state: state.state,
      fallbacksUsed: state.fallbacksUsed,
      selection: null,
      excludedModelIds: [...excluded],
      decidedAt: nowIso,
    }
  }

  if (state.fallbacksUsed >= input.config.maxTotalFallbacks) {
    state.state = 'exhausted'
    return {
      action: 'exhausted',
      fromModelId: state.currentModelId,
      toModelId: null,
      category,
      scope,
      allowed: false,
      safeToReplay,
      reason: `maximum total fallbacks (${input.config.maxTotalFallbacks}) reached`,
      state: state.state,
      fallbacksUsed: state.fallbacksUsed,
      selection: null,
      excludedModelIds: [...excluded, state.currentModelId],
      decidedAt: nowIso,
    }
  }

  const retryCount = state.retryCounts.get(state.currentModelId) ?? 0

  if (retryable && retryCount < input.config.maxRetriesPerModel) {
    state.retryCounts.set(state.currentModelId, retryCount + 1)
    state.state = 'degraded'
    if (input.healthMonitor !== undefined) {
      input.healthMonitor.recordFailure(healthContext(classification.reason), classification)
    }
    return {
      action: 'retry-same',
      fromModelId: state.currentModelId,
      toModelId: state.currentModelId,
      category,
      scope,
      allowed: true,
      safeToReplay,
      reason: `retrying '${state.currentModelId}' (attempt ${retryCount + 1}/${input.config.maxRetriesPerModel})`,
      state: state.state,
      fallbacksUsed: state.fallbacksUsed,
      selection: null,
      excludedModelIds: [...excluded],
      decidedAt: nowIso,
    }
  }

  excluded.add(state.currentModelId)
  const excludedList = [...excluded]

  if (input.healthMonitor !== undefined) {
    input.healthMonitor.recordFailure(healthContext(classification.reason), classification)
  }

  const selectionOutcome = selector(registry, {
    ...input.taskInput,
    excludedModelIds: excludedList,
  })
  const candidate = selectionOutcome.selection

  if (candidate === null || candidate.modelId === state.currentModelId) {
    state.state = 'exhausted'
    state.exhaustedModels.add(state.currentModelId)
    return {
      action: 'exhausted',
      fromModelId: state.currentModelId,
      toModelId: null,
      category,
      scope,
      allowed: false,
      safeToReplay,
      reason: `no eligible replacement model for '${state.currentModelId}'`,
      state: state.state,
      fallbacksUsed: state.fallbacksUsed,
      selection: null,
      excludedModelIds: excludedList,
      decidedAt: nowIso,
    }
  }

  state.fallbacksUsed += 1
  state.exhaustedModels.add(state.currentModelId)
  state.switchHistory.push({
    from: state.currentModelId,
    to: candidate.modelId,
    reason: classification.reason,
    at: nowIso,
  })
  state.currentModelId = candidate.modelId
  state.state = 'switching'

  return {
    action: 'switch',
    fromModelId: state.switchHistory[state.switchHistory.length - 1]!.from,
    toModelId: candidate.modelId,
    category,
    scope,
    allowed: true,
    safeToReplay,
    reason: `switching from '${state.switchHistory[state.switchHistory.length - 1]!.from}' to '${candidate.modelId}': ${classification.reason}`,
    state: state.state,
    fallbacksUsed: state.fallbacksUsed,
    selection: candidate,
    excludedModelIds: excludedList,
    decidedAt: nowIso,
  }
}

function isClassification(value: unknown): value is ModelErrorClassification {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { category?: unknown }).category === 'string' &&
    typeof (value as { suggestedScope?: unknown }).suggestedScope === 'string' &&
    typeof (value as { retryable?: unknown }).retryable === 'boolean' &&
    typeof (value as { reason?: unknown }).reason === 'string'
  )
}
