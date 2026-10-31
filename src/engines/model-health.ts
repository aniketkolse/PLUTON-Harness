import { redactProseSecrets } from '../util/redact.ts'
import type { FallbackScope, ModelAvailability, ModelErrorCategory } from './contract/types.ts'
import { ModelRegistry, type ModelRegistryEntry } from './model-registry.ts'

/**
 * Runtime health monitoring and error classification (PLUTON 3.2, Phase 4).
 *
 * Classification and health-state mutation are deliberately separate: callers
 * can inspect a classification before deciding to record it. The monitor never
 * retries, never switches models, and never mutates worker assignments.
 */

export interface ModelErrorContext {
  error?: unknown
  httpStatus?: number
  providerCode?: string
  providerMessage?: string
  errorCode?: string
  toolName?: string
  provider?: string
  modelId?: string
  engineKind?: string
  quotaScope?: string
  taskId?: string
  scopeHint?: FallbackScope
}

export interface ModelErrorClassification {
  category: ModelErrorCategory
  confidence?: 'high' | 'medium' | 'low'
  reason: string
  httpStatus?: number
  providerCode?: string
  suggestedScope: FallbackScope
  retryable: boolean
  rawSummary?: string
}

export interface ModelHealthState {
  engineKind: string
  modelId: string
  state: 'healthy' | 'degraded' | 'unavailable' | 'temporarily-ineligible' | 'unknown'
  lastErrorCategory?: ModelErrorCategory
  lastErrorAt?: string
  lastSuccessAt?: string
  cooldownUntil?: string
  diagnostic?: string
}

export interface ProviderHealthState {
  engineKind: string
  providerScope: string
  healthy: boolean
  lastErrorCategory?: ModelErrorCategory
  lastErrorAt?: string
  lastSuccessAt?: string
  cooldownUntil?: string
  diagnostic?: string
}

export interface TaskHealthState {
  engineKind: string
  modelId: string
  taskId: string
  temporarilyIneligibleUntil?: string
  lastErrorCategory?: ModelErrorCategory
  lastErrorAt?: string
}

export interface ModelHealthChange {
  scope: 'model' | 'provider' | 'task'
  engineKind: string
  modelId?: string
  providerScope?: string
  taskId?: string
  category: ModelErrorCategory
  action: 'failure-recorded' | 'cooldown-applied' | 'recovered' | 'expired'
  at: string
}

export interface ModelHealthMonitorOptions {
  registry: ModelRegistry
  now?: () => number
  cooldowns?: Partial<Record<ModelErrorCategory, number>>
}

const DEFAULT_COOLDOWNS: Record<ModelErrorCategory, number> = {
  'usage-limit': 5 * 60 * 1000,
  'provider-unavailable': 60 * 1000,
  'auth-failure': 0,
  'context-limit-exceeded': 0,
  'unsupported-tool-capability': 0,
  'temporary-network-error': 30 * 1000,
  'execution-error': 0,
  unknown: 60 * 1000,
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function errorText(context: ModelErrorContext): string {
  if (typeof context.providerMessage === 'string' && context.providerMessage.trim().length > 0) {
    return context.providerMessage
  }
  if (context.error instanceof Error) return context.error.message
  if (typeof context.error === 'string') return context.error
  if (context.error !== undefined && context.error !== null) {
    try {
      return JSON.stringify(context.error)
    } catch {
      return String(context.error)
    }
  }
  return ''
}

function classifyByCode(code: string | undefined): ModelErrorCategory | null {
  if (typeof code !== 'string' || code.trim().length === 0) return null
  const normalized = code.trim().toLowerCase().replace(/[\s-]+/g, '_')
  const map: Record<string, ModelErrorCategory> = {
    usage_limit: 'usage-limit',
    quota_exceeded: 'usage-limit',
    rate_limit: 'usage-limit',
    resource_exhausted: 'usage-limit',
    too_many_requests: 'usage-limit',
    provider_unavailable: 'provider-unavailable',
    service_unavailable: 'provider-unavailable',
    auth_failure: 'auth-failure',
    unauthorized: 'auth-failure',
    forbidden: 'auth-failure',
    invalid_api_key: 'auth-failure',
    invalid_credential: 'auth-failure',
    context_length_exceeded: 'context-limit-exceeded',
    context_limit_exceeded: 'context-limit-exceeded',
    max_tokens: 'context-limit-exceeded',
    token_limit_exceeded: 'context-limit-exceeded',
    unsupported_tool: 'unsupported-tool-capability',
    tool_not_supported: 'unsupported-tool-capability',
    unsupported_function: 'unsupported-tool-capability',
    network_error: 'temporary-network-error',
    timeout: 'temporary-network-error',
    econnreset: 'temporary-network-error',
    econnrefused: 'provider-unavailable',
    execution_error: 'execution-error',
    generation_failed: 'execution-error',
  }
  return map[normalized] ?? null
}

function classifyByStatus(status: number | undefined): ModelErrorCategory | null {
  if (typeof status !== 'number' || !Number.isFinite(status)) return null
  if (status === 401 || status === 403) return 'auth-failure'
  if (status === 429) return 'usage-limit'
  if (status === 408 || status === 504) return 'temporary-network-error'
  if (status === 502 || status === 503) return 'provider-unavailable'
  if (status === 413) return 'context-limit-exceeded'
  if (status >= 500) return 'provider-unavailable'
  return null
}

const MESSAGE_PATTERNS: Array<{ category: ModelErrorCategory; pattern: RegExp }> = [
  { category: 'context-limit-exceeded', pattern: /context (length|window|limit)|too many tokens|max(?:imum)? tokens|context_length_exceeded|token limit exceeded/i },
  { category: 'unsupported-tool-capability', pattern: /tool .* not (supported|available)|unsupported tool|function .* not supported|does not support .* tool/i },
  { category: 'auth-failure', pattern: /unauthorized|forbidden|invalid (api )?key|authentication (failed|required)|credential|access denied|permission denied/i },
  { category: 'usage-limit', pattern: /free usage limit reached|quota exceeded|rate limit|resource[_\s]exhausted|too many requests|usage limit (reached|exceeded)|quota (exhausted|exceeded)/i },
  { category: 'provider-unavailable', pattern: /service unavailable|provider unavailable|bad gateway|gateway timeout|ECONNREFUSED|ENOTFOUND|DNS (resolution|lookup)|provider (is )?down/i },
  { category: 'temporary-network-error', pattern: /timeout|timed out|ECONNRESET|socket hang up|network error|fetch failed|ETIMEDOUT|connection (reset|refused)/i },
  { category: 'execution-error', pattern: /generation failed|invalid (json|output)|model (error|failed)|completion failed|inference failed/i },
]

function classifyByMessage(text: string): ModelErrorCategory | null {
  for (const { category, pattern } of MESSAGE_PATTERNS) {
    if (pattern.test(text)) return category
  }
  return null
}

function suggestedScopeFor(category: ModelErrorCategory, context: ModelErrorContext): FallbackScope {
  if (context.scopeHint !== undefined) return context.scopeHint
  switch (category) {
    case 'usage-limit':
      return context.quotaScope !== undefined ? 'provider' : 'task'
    case 'provider-unavailable':
    case 'auth-failure':
      return 'provider'
    case 'context-limit-exceeded':
    case 'unsupported-tool-capability':
    case 'execution-error':
    case 'unknown':
      return 'task'
    case 'temporary-network-error':
      return 'task'
  }
}

function retryableFor(category: ModelErrorCategory): boolean {
  return category === 'temporary-network-error' || category === 'provider-unavailable'
}

export function classifyModelError(context: ModelErrorContext): ModelErrorClassification {
  const rawText = errorText(context)
  const safeText = redactProseSecrets(rawText).slice(0, 300)

  // 1. Structured adapter error code.
  let category: ModelErrorCategory | null = classifyByCode(context.errorCode)
  let confidence: ModelErrorClassification['confidence'] = 'high'
  let providerCode: string | undefined = context.errorCode

  // 2. HTTP status.
  if (category === null) {
    category = classifyByStatus(context.httpStatus)
    if (category !== null) {
      confidence = 'high'
      providerCode = context.providerCode
    }
  }

  // 3. Provider-specific structured error code.
  if (category === null && context.providerCode !== undefined) {
    const fromProvider = classifyByCode(context.providerCode)
    if (fromProvider !== null) {
      category = fromProvider
      confidence = 'medium'
      providerCode = context.providerCode
    }
  }

  // 4. Message patterns.
  if (category === null) {
    category = classifyByMessage(rawText)
    if (category !== null) {
      // If we got here via a structured-ish provider message, medium; else low.
      confidence = context.providerMessage !== undefined ? 'medium' : 'low'
    }
  }

  // 5. Unknown.
  if (category === null) {
    category = 'unknown'
    confidence = 'low'
  }

  const suggestedScope = suggestedScopeFor(category, context)
  const reason = safeText.length > 0 ? safeText : `${category} (no diagnostic detail)`

  return {
    category,
    confidence,
    reason,
    httpStatus: context.httpStatus,
    providerCode,
    suggestedScope,
    retryable: retryableFor(category),
    rawSummary: safeText,
  }
}

// ---------------------------------------------------------------------------
// Health monitor
// ---------------------------------------------------------------------------

export class ModelHealthMonitor {
  private readonly registry: ModelRegistry
  private readonly clock: () => number
  private readonly cooldowns: Record<ModelErrorCategory, number>
  private readonly modelHealth = new Map<string, ModelHealthState>()
  private readonly providerHealth = new Map<string, ProviderHealthState>()
  private readonly taskHealth = new Map<string, TaskHealthState>()

  constructor(options: ModelHealthMonitorOptions) {
    this.registry = options.registry
    this.clock = options.now ?? Date.now
    this.cooldowns = { ...DEFAULT_COOLDOWNS, ...(options.cooldowns ?? {}) }
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString()
  }

  private modelKey(engineKind: string, modelId: string): string {
    return `${engineKind}\u0000${modelId}`
  }

  private providerKey(engineKind: string, scope: string): string {
    return `${engineKind}\u0000${scope}`
  }

  private taskKey(engineKind: string, modelId: string, taskId: string): string {
    return `${engineKind}\u0000${modelId}\u0000${taskId}`
  }

  private cooldownMs(category: ModelErrorCategory): number {
    return this.cooldowns[category] ?? 0
  }

  private affectedModels(engineKind: string, providerScope: string): ModelRegistryEntry[] {
    return this.registry.list(engineKind).filter((entry) => {
      if (providerScope === engineKind) return true
      return entry.provider === providerScope
    })
  }

  private applyModelFailure(
    engineKind: string,
    modelId: string,
    classification: ModelErrorClassification,
    cooldownMs: number,
    diagnostic: string,
    changes: ModelHealthChange[],
  ): void {
    const now = this.clock()
    const nowIso = this.nowIso()
    const cooldownUntil = cooldownMs > 0 ? new Date(now + cooldownMs).toISOString() : undefined

    const state: ModelHealthState['state'] =
      cooldownMs > 0
        ? 'temporarily-ineligible'
        : classification.category === 'provider-unavailable' || classification.category === 'auth-failure'
          ? 'unavailable'
          : 'degraded'

    this.modelHealth.set(this.modelKey(engineKind, modelId), {
      engineKind,
      modelId,
      state,
      lastErrorCategory: classification.category,
      lastErrorAt: nowIso,
      cooldownUntil,
      diagnostic,
    })

    const available =
      classification.category !== 'provider-unavailable' && classification.category !== 'auth-failure'

    const availability: ModelAvailability = {
      id: modelId,
      available,
      reason: diagnostic,
      category: classification.category,
      healthCheckedAt: nowIso,
      temporarilyIneligibleUntil: cooldownUntil,
      source: 'engine',
    }
    this.registry.setAvailability(engineKind, modelId, availability)

    changes.push({
      scope: 'model',
      engineKind,
      modelId,
      category: classification.category,
      action: cooldownMs > 0 ? 'cooldown-applied' : 'failure-recorded',
      at: nowIso,
    })
  }

  /**
   * Classify and record a failure. Returns the changes applied (for observability).
   * Does not retry or switch models.
   */
  recordFailure(
    context: ModelErrorContext,
    classification?: ModelErrorClassification,
  ): { classification: ModelErrorClassification; changes: ModelHealthChange[] } {
    const resolved = classification ?? classifyModelError(context)
    const changes: ModelHealthChange[] = []
    const diagnostic = resolved.reason
    const cooldownMs = this.cooldownMs(resolved.category)
    const nowIso = this.nowIso()

    const engineKind = context.engineKind ?? 'unknown'
    const modelId = context.modelId
    const providerScope = context.quotaScope ?? context.provider ?? engineKind
    const scope = resolved.suggestedScope

    // Task-level: only this task is affected.
    if (scope === 'task' && context.taskId !== undefined && modelId !== undefined) {
      const cooldownUntil = cooldownMs > 0 ? new Date(this.clock() + cooldownMs).toISOString() : undefined
      this.taskHealth.set(this.taskKey(engineKind, modelId, context.taskId), {
        engineKind,
        modelId,
        taskId: context.taskId,
        temporarilyIneligibleUntil: cooldownUntil,
        lastErrorCategory: resolved.category,
        lastErrorAt: nowIso,
      })
      changes.push({
        scope: 'task',
        engineKind,
        modelId,
        taskId: context.taskId,
        category: resolved.category,
        action: cooldownMs > 0 ? 'cooldown-applied' : 'failure-recorded',
        at: nowIso,
      })
      // Model-level health is still recorded lightly (degraded) without registry cooldown,
      // so other tasks can react but the model stays eligible unless a model-level
      // failure is also recorded. We do not mutate registry availability here.
      return { classification: resolved, changes }
    }

    // Model-level task scope (no taskId): single model.
    if (scope === 'task') {
      if (modelId !== undefined) {
        this.applyModelFailure(engineKind, modelId, resolved, cooldownMs, diagnostic, changes)
      }
      return { classification: resolved, changes }
    }

    // Provider scope: provider health + all models sharing the quota/provider scope.
    if (scope === 'provider') {
      this.providerHealth.set(this.providerKey(engineKind, providerScope), {
        engineKind,
        providerScope,
        healthy: false,
        lastErrorCategory: resolved.category,
        lastErrorAt: nowIso,
        cooldownUntil: cooldownMs > 0 ? new Date(this.clock() + cooldownMs).toISOString() : undefined,
        diagnostic,
      })
      const models = this.affectedModels(engineKind, providerScope)
      for (const entry of models) {
        this.applyModelFailure(engineKind, entry.id, resolved, cooldownMs, diagnostic, changes)
      }
      // If no models discovered yet, still record provider health only.
      changes.unshift({
        scope: 'provider',
        engineKind,
        providerScope,
        category: resolved.category,
        action: cooldownMs > 0 ? 'cooldown-applied' : 'failure-recorded',
        at: nowIso,
      })
      return { classification: resolved, changes }
    }

    // Global scope: whole engine.
    this.providerHealth.set(this.providerKey(engineKind, engineKind), {
      engineKind,
      providerScope: engineKind,
      healthy: false,
      lastErrorCategory: resolved.category,
      lastErrorAt: nowIso,
      cooldownUntil: cooldownMs > 0 ? new Date(this.clock() + cooldownMs).toISOString() : undefined,
      diagnostic,
    })
    const allModels = this.registry.list(engineKind)
    for (const entry of allModels) {
      this.applyModelFailure(engineKind, entry.id, resolved, cooldownMs, diagnostic, changes)
    }
    changes.unshift({
      scope: 'provider',
      engineKind,
      providerScope: engineKind,
      category: resolved.category,
      action: cooldownMs > 0 ? 'cooldown-applied' : 'failure-recorded',
      at: nowIso,
    })
    return { classification: resolved, changes }
  }

  /**
   * Record successful health evidence. Clears cooldowns and marks healthy.
   * Does not switch models.
   */
  recordSuccess(scope: {
    engineKind: string
    modelId: string
    provider?: string
    quotaScope?: string
    taskId?: string
  }): ModelHealthChange[] {
    const changes: ModelHealthChange[] = []
    const nowIso = this.nowIso()
    const engineKind = scope.engineKind
    const modelId = scope.modelId
    const providerScope = scope.quotaScope ?? scope.provider ?? engineKind

    // Clear task-level ineligibility if a taskId is provided.
    if (scope.taskId !== undefined) {
      this.taskHealth.delete(this.taskKey(engineKind, modelId, scope.taskId))
      changes.push({
        scope: 'task',
        engineKind,
        modelId,
        taskId: scope.taskId,
        category: 'unknown',
        action: 'recovered',
        at: nowIso,
      })
    }

    // Model health.
    const existing = this.modelHealth.get(this.modelKey(engineKind, modelId))
    this.modelHealth.set(this.modelKey(engineKind, modelId), {
      engineKind,
      modelId,
      state: 'healthy',
      lastErrorCategory: undefined,
      lastErrorAt: existing?.lastErrorAt,
      lastSuccessAt: nowIso,
      cooldownUntil: undefined,
      diagnostic: undefined,
    })

    // Provider health.
    const providerKey = this.providerKey(engineKind, providerScope)
    const existingProvider = this.providerHealth.get(providerKey)
    if (existingProvider !== undefined) {
      this.providerHealth.set(providerKey, {
        ...existingProvider,
        healthy: true,
        lastErrorCategory: undefined,
        lastSuccessAt: nowIso,
        cooldownUntil: undefined,
        diagnostic: undefined,
      })
    }

    // Registry availability: clear runtime failure.
    const entry = this.registry.get(engineKind, modelId)
    if (entry !== undefined && entry !== null) {
      this.registry.setAvailability(engineKind, modelId, {
        id: modelId,
        available: true,
        reason: undefined,
        category: undefined,
        healthCheckedAt: nowIso,
        temporarilyIneligibleUntil: undefined,
        source: entry.availability?.source ?? 'engine',
        label: entry.availability?.label,
      })
    }

    changes.push({
      scope: 'model',
      engineKind,
      modelId,
      category: 'unknown',
      action: 'recovered',
      at: nowIso,
    })
    return changes
  }

  getModelHealth(engineKind: string, modelId: string): ModelHealthState {
    const existing = this.modelHealth.get(this.modelKey(engineKind, modelId))
    if (existing !== undefined) return existing
    // Fall back to registry availability if present.
    const entry = this.registry.get(engineKind, modelId)
    if (entry === null) {
      return { engineKind, modelId, state: 'unknown' }
    }
    const avail = entry.availability
    if (avail === undefined) {
      return { engineKind, modelId, state: 'healthy' }
    }
    if (avail.available === false) {
      return {
        engineKind,
        modelId,
        state: 'unavailable',
        lastErrorCategory: avail.category,
        lastErrorAt: avail.healthCheckedAt,
        cooldownUntil: avail.temporarilyIneligibleUntil,
        diagnostic: avail.reason,
      }
    }
    if (avail.temporarilyIneligibleUntil !== undefined) {
      const untilMs = Date.parse(avail.temporarilyIneligibleUntil)
      if (Number.isFinite(untilMs) && untilMs > this.clock()) {
        return {
          engineKind,
          modelId,
          state: 'temporarily-ineligible',
          lastErrorCategory: avail.category,
          cooldownUntil: avail.temporarilyIneligibleUntil,
          diagnostic: avail.reason,
        }
      }
    }
    return { engineKind, modelId, state: 'healthy' }
  }

  getProviderHealth(engineKind: string, providerScope: string): ProviderHealthState {
    const existing = this.providerHealth.get(this.providerKey(engineKind, providerScope))
    if (existing !== undefined) return existing
    return { engineKind, providerScope, healthy: true }
  }

  getTaskHealth(engineKind: string, modelId: string, taskId: string): TaskHealthState {
    const existing = this.taskHealth.get(this.taskKey(engineKind, modelId, taskId))
    if (existing !== undefined) return existing
    return { engineKind, modelId, taskId }
  }

  isTemporarilyIneligible(scope: {
    engineKind: string
    modelId: string
    taskId?: string
  }): boolean {
    const now = this.clock()
    if (scope.taskId !== undefined) {
      const task = this.taskHealth.get(this.taskKey(scope.engineKind, scope.modelId, scope.taskId))
      if (task?.temporarilyIneligibleUntil !== undefined) {
        const untilMs = Date.parse(task.temporarilyIneligibleUntil)
        if (Number.isFinite(untilMs) && untilMs > now) return true
      }
    }
    const model = this.modelHealth.get(this.modelKey(scope.engineKind, scope.modelId))
    if (model?.cooldownUntil !== undefined) {
      const untilMs = Date.parse(model.cooldownUntil)
      if (Number.isFinite(untilMs) && untilMs > now) return true
    }
    const entry = this.registry.get(scope.engineKind, scope.modelId)
    const until = entry?.availability?.temporarilyIneligibleUntil
    if (typeof until === 'string') {
      const untilMs = Date.parse(until)
      if (Number.isFinite(untilMs) && untilMs > now) return true
    }
    return false
  }
}
