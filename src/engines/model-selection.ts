import type { ShipRole } from '../domain/models.ts'
import type {
  EngineModel,
  ModelAvailability,
  ModelCapabilities,
  ModelErrorCategory,
  ModelSelection,
  TaskClassificationHint,
  TaskModelRequirements,
} from './contract/types.ts'
import { ModelRegistry, type ModelRegistryEntry } from './model-registry.ts'
import { ModelPerformanceMonitor, performanceHealthAdjustment } from './model-performance.ts'

/**
 * Capability-based model evaluation and task-aware selection (PLUTON 3.2, Phase 3).
 *
 * Selection is a pure function of the registry snapshot and an explicit
 * requirements input. It never mutates the registry, never reserves a model,
 * and never infers capabilities from model ids, labels, or provider names.
 */

export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown'

export interface ModelSelectionInput {
  /** Task content used for defensible classification. */
  task?: {
    title?: string
    brief?: string
    acceptanceCriteria?: string[]
  }
  /** Ship role used only as a fallback classification hint. */
  shipRole?: ShipRole
  /** Explicit task-level hints; take precedence over content and role. */
  hint?: TaskClassificationHint
  /** Explicit model pin (provider-qualified id). */
  pinnedModelId?: string
  /** Engine adapter kind for the pin, when known. */
  pinnedEngineKind?: string
  /**
   * Restrict selection to one engine adapter kind. A Ship can only execute on
   * its own engine, so candidates discovered from other adapters (including the
   * dev-only mock engine) must never be selected for it.
   */
  engineKind?: string
  /** Provider restrictions from configuration. */
  providerAllowlist?: readonly string[]
  providerDenylist?: readonly string[]
  /** Cost/latency preferences (default 'balanced'). */
  costPreference?: 'low' | 'balanced' | 'indifferent'
  latencyPreference?: 'low' | 'balanced' | 'indifferent'
  /** Hard cost ceiling in USD per million tokens. */
  maxCostUsdPerMillionTokens?: number
  /** Hard latency ceiling in milliseconds. */
  maxLatencyMs?: number
  /** Hard context ceiling override (also derivable from hint). */
  minContextWindow?: number
  /** Model ids to exclude from selection (e.g. exhausted during fallback). */
  excludedModelIds?: readonly string[]
  /** Injectable clock for cooldown checks. */
  now?: () => number
  /** Optional observed-performance monitor used as a bounded routing input. */
  performance?: ModelPerformanceMonitor
}

export interface ModelCandidateExclusion {
  engineKind: string
  modelId: string
  code:
    | 'provider-restricted'
    | 'unavailable'
    | 'temporarily-ineligible'
    | 'missing-capability'
    | 'context-too-small'
    | 'tool-calling-missing'
    | 'multimodal-missing'
    | 'cost-ceiling'
    | 'latency-ceiling'
    | 'pin-unavailable'
    | 'pin-incompatible'
  reason: string
}

export interface ModelScoreBreakdown {
  capabilityFit: number
  context: number
  health: number
  cost: number
  latency: number
  verified: number
  total: number
}

export interface ModelCapabilityEvaluation {
  engineKind: string
  modelId: string
  eligible: boolean
  exclusion?: ModelCandidateExclusion
  statuses: {
    taskFit: CapabilityStatus
    toolCalling: CapabilityStatus
    multimodal: CapabilityStatus
    coding: CapabilityStatus
    reasoning: CapabilityStatus
  }
  contextStatus: CapabilityStatus
  costStatus: CapabilityStatus
  latencyStatus: CapabilityStatus
  providerAllowed: boolean
  score: number
  breakdown: ModelScoreBreakdown
  /** Whether observed performance influenced this evaluation. */
  performanceApplied?: boolean
  /** Bounded health adjustment applied ([-10, +10]); undefined when not applied. */
  healthAdjustment?: number
}

export interface ModelSelectionOutcome {
  selection: ModelSelection | null
  eligibleCount: number
  candidatesConsidered: number
  exclusions: ModelCandidateExclusion[]
  pinBlocked: { modelId: string; reason: string } | null
  evaluatedAt: string
  evaluations: ModelCapabilityEvaluation[]
  /** Whether observed performance was applied to any candidate's health score. */
  performanceApplied?: boolean
}

export interface TaskClassificationResult {
  requirements: TaskModelRequirements
  classificationSource: 'hint' | 'content' | 'role' | 'general'
  classificationConfidence: 'high' | 'medium' | 'low'
}

// ---------------------------------------------------------------------------
// Task classification
// ---------------------------------------------------------------------------

const CODING_KEYWORDS = [
  'code', 'implement', 'fix', 'bug', 'refactor', 'compile', 'build', 'function',
  'class', 'endpoint', 'api', 'typescript', 'javascript', 'python', 'module',
  'component', 'database', 'migration', 'deploy', 'lint', 'typecheck',
]
const RESEARCH_KEYWORDS = [
  'research', 'investigate', 'analyze', 'explore', 'document', 'summarize',
  'compare', 'find', 'understand', 'explain', 'review', 'audit', 'discover',
  'study', 'inspect',
]
const TESTING_KEYWORDS = [
  'test', 'spec', 'coverage', 'qa', 'verify', 'assert', 'regression', 'e2e',
  'unit', 'integration', 'fixture',
]
const PLANNING_KEYWORDS = [
  'plan', 'coordinate', 'manage', 'supervise', 'orchestrate', 'delegate',
  'schedule', 'roadmap',
]

function countKeywordHits(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase()
  let hits = 0
  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) hits += 1
  }
  return hits
}

function roleToTaskType(role: ShipRole | undefined): TaskModelRequirements['taskType'] | null {
  switch (role) {
    case 'coder':
      return 'coding'
    case 'researcher':
      return 'research'
    case 'tester':
      return 'testing'
    case 'supervisor':
      return 'planning'
    case 'reviewer':
      return 'research'
    default:
      return null
  }
}

function baseRequirementsFor(taskType: TaskModelRequirements['taskType']): Omit<
  TaskModelRequirements,
  'costPreference' | 'latencyPreference' | 'classificationSource' | 'classificationConfidence'
> {
  switch (taskType) {
    case 'research':
      return {
        taskType: 'research',
        requiresToolCalling: true,
        requiresMultimodal: false,
        preferredCapabilities: ['research'],
      }
    case 'coding':
      return {
        taskType: 'coding',
        requiresToolCalling: true,
        requiresMultimodal: false,
        preferredCapabilities: ['coding'],
      }
    case 'testing':
      return {
        taskType: 'testing',
        requiresToolCalling: true,
        requiresMultimodal: false,
        preferredCapabilities: ['testing'],
      }
    case 'planning':
      return {
        taskType: 'planning',
        requiresToolCalling: false,
        requiresMultimodal: false,
        preferredCapabilities: [],
      }
    case 'simple':
    default:
      return {
        taskType: 'simple',
        requiresToolCalling: false,
        requiresMultimodal: false,
        preferredCapabilities: [],
      }
  }
}

export function resolveTaskRequirements(input: ModelSelectionInput): TaskClassificationResult {
  const hint = input.hint
  const content = [input.task?.title, input.task?.brief, ...(input.task?.acceptanceCriteria ?? [])]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')

  let taskType: TaskModelRequirements['taskType'] = 'simple'
  let classificationSource: TaskClassificationResult['classificationSource'] = 'general'
  let classificationConfidence: TaskClassificationResult['classificationConfidence'] = 'low'

  // 1. Explicit hint wins.
  if (hint?.taskType !== undefined) {
    taskType = hint.taskType
    classificationSource = 'hint'
    classificationConfidence = 'high'
  } else if (content.trim().length > 0) {
    // 2. Task content.
    const scores = {
      coding: countKeywordHits(content, CODING_KEYWORDS),
      research: countKeywordHits(content, RESEARCH_KEYWORDS),
      testing: countKeywordHits(content, TESTING_KEYWORDS),
      planning: countKeywordHits(content, PLANNING_KEYWORDS),
    }
    const best = (Object.entries(scores) as Array<[keyof typeof scores, number]>).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]
    if (best !== undefined && best[1] > 0) {
      taskType = best[0]
      classificationSource = 'content'
      classificationConfidence = best[1] >= 3 ? 'high' : 'medium'
    } else {
      // 3. Ship role fallback.
      const fromRole = roleToTaskType(input.shipRole)
      if (fromRole !== null) {
        taskType = fromRole
        classificationSource = 'role'
        classificationConfidence = 'medium'
      } else {
        taskType = 'simple'
        classificationSource = 'general'
        classificationConfidence = 'low'
      }
    }
  } else {
    // No content: role fallback.
    const fromRole = roleToTaskType(input.shipRole)
    if (fromRole !== null) {
      taskType = fromRole
      classificationSource = 'role'
      classificationConfidence = 'medium'
    } else {
      taskType = 'simple'
      classificationSource = 'general'
      classificationConfidence = 'low'
    }
  }

  const base = baseRequirementsFor(taskType)

  const requiredCapabilities =
    hint?.requiredCapabilities !== undefined && hint.requiredCapabilities.length > 0
      ? [...hint.requiredCapabilities]
      : undefined

  const preferredCapabilities =
    hint?.requiredCapabilities !== undefined && hint.requiredCapabilities.length > 0
      ? [...hint.requiredCapabilities]
      : hint?.taskType !== undefined && hint.requiredCapabilities === undefined
        ? base.preferredCapabilities
        : base.preferredCapabilities

  const requirements: TaskModelRequirements = {
    taskType: base.taskType,
    requiresToolCalling:
      hint?.requiresToolCalling !== undefined ? hint.requiresToolCalling : base.requiresToolCalling,
    requiresMultimodal:
      hint?.requiresMultimodal !== undefined ? hint.requiresMultimodal : base.requiresMultimodal,
    minContextWindow:
      hint?.minContextWindow !== undefined
        ? hint.minContextWindow
        : input.minContextWindow !== undefined
          ? input.minContextWindow
          : base.minContextWindow,
    preferredCapabilities,
    requiredCapabilities,
    costPreference: input.costPreference ?? 'balanced',
    latencyPreference: input.latencyPreference ?? 'balanced',
    maxCostUsdPerMillionTokens: input.maxCostUsdPerMillionTokens,
    maxLatencyMs: input.maxLatencyMs,
    classificationSource,
    classificationConfidence,
  }

  return { requirements, classificationSource, classificationConfidence }
}

// ---------------------------------------------------------------------------
// Capability evaluation
// ---------------------------------------------------------------------------

function knownCount(model: ModelRegistryEntry): number {
  let count = 0
  if (Array.isArray(model.capabilities?.taskFit)) count += 1
  if (typeof model.contextWindow === 'number') count += 1
  if (typeof model.toolCalling === 'boolean') count += 1
  if (typeof model.codingCapable === 'boolean') count += 1
  if (typeof model.reasoningCapable === 'boolean') count += 1
  if (typeof model.costUsdPerMillionTokens === 'number') count += 1
  if (typeof model.latencyMs === 'number') count += 1
  return count
}

function capabilityStatus(value: boolean | undefined): CapabilityStatus {
  if (value === true) return 'supported'
  if (value === false) return 'unsupported'
  return 'unknown'
}

function isTemporarilyIneligible(entry: ModelRegistryEntry, nowMs: number): boolean {
  const until = entry.availability?.temporarilyIneligibleUntil
  if (typeof until !== 'string') return false
  const untilMs = Date.parse(until)
  return Number.isFinite(untilMs) && untilMs > nowMs
}

function providerAllowed(
  entry: ModelRegistryEntry,
  allowlist: readonly string[],
  denylist: readonly string[],
): boolean {
  const provider = entry.provider
  if (denylist.length > 0 && provider !== undefined && denylist.includes(provider)) return false
  if (allowlist.length > 0) {
    if (provider === undefined) return false
    if (!allowlist.includes(provider)) return false
  }
  return true
}

export function evaluateModel(
  entry: ModelRegistryEntry,
  requirements: TaskModelRequirements,
  restrictions: { allowlist: readonly string[]; denylist: readonly string[] },
  nowMs: number,
  performance?: ModelPerformanceMonitor,
): ModelCapabilityEvaluation {
  // 1. Provider restrictions.
  const allowed = providerAllowed(entry, restrictions.allowlist, restrictions.denylist)
  if (!allowed) {
    return makeEvaluation(entry, requirements, false, {
      code: 'provider-restricted',
      reason: `provider '${entry.provider ?? '(unknown)'}' is not allowed by the configured restrictions`,
    }, 0, false, nowMs, allowed)
  }

  // 2. Availability + cooldown.
  const availability: ModelAvailability | undefined = entry.availability
  if (availability !== undefined && availability.available === false) {
    return makeEvaluation(entry, requirements, false, {
      code: 'unavailable',
      reason: availability.reason ?? `model '${entry.id}' is not available`,
    }, 0, false, nowMs, allowed)
  }
  if (isTemporarilyIneligible(entry, nowMs)) {
    return makeEvaluation(entry, requirements, false, {
      code: 'temporarily-ineligible',
      reason: `model '${entry.id}' is in cooldown until ${entry.availability?.temporarilyIneligibleUntil}`,
    }, 0, false, nowMs, allowed)
  }

  // 3. Hard required capabilities.
  if (requirements.requiresToolCalling && entry.toolCalling !== true) {
    return makeEvaluation(entry, requirements, false, {
      code: 'tool-calling-missing',
      reason: `model '${entry.id}' does not report tool/function-calling support`,
    }, 0, false, nowMs, allowed)
  }
  if (requirements.requiresMultimodal && entry.multimodal !== true) {
    return makeEvaluation(entry, requirements, false, {
      code: 'multimodal-missing',
      reason: `model '${entry.id}' does not report multimodal support`,
    }, 0, false, nowMs, allowed)
  }
  if (requirements.minContextWindow !== undefined) {
    if (typeof entry.contextWindow !== 'number' || entry.contextWindow < requirements.minContextWindow) {
      return makeEvaluation(entry, requirements, false, {
        code: 'context-too-small',
        reason:
          typeof entry.contextWindow !== 'number'
            ? `model '${entry.id}' has unknown context window (required ${requirements.minContextWindow})`
            : `model '${entry.id}' context window ${entry.contextWindow} < required ${requirements.minContextWindow}`,
      }, 0, false, nowMs, allowed)
    }
  }
  if (requirements.requiredCapabilities && requirements.requiredCapabilities.length > 0) {
    const fit = entry.capabilities?.taskFit
    const intersects =
      Array.isArray(fit) && requirements.requiredCapabilities.some((cap) => fit.includes(cap))
    if (!intersects) {
      return makeEvaluation(entry, requirements, false, {
        code: 'missing-capability',
        reason: `model '${entry.id}' lacks required capabilities ${requirements.requiredCapabilities.join(', ')}`,
      }, 0, false, nowMs, allowed)
    }
  }
  // Hard cost ceiling.
  if (requirements.maxCostUsdPerMillionTokens !== undefined) {
    const cost = entry.costUsdPerMillionTokens
    if (typeof cost !== 'number' || cost > requirements.maxCostUsdPerMillionTokens) {
      return makeEvaluation(entry, requirements, false, {
        code: 'cost-ceiling',
        reason:
          typeof cost !== 'number'
            ? `model '${entry.id}' has unknown cost (ceiling ${requirements.maxCostUsdPerMillionTokens})`
            : `model '${entry.id}' cost ${cost} > ceiling ${requirements.maxCostUsdPerMillionTokens}`,
      }, 0, false, nowMs, allowed)
    }
  }
  // Hard latency ceiling.
  if (requirements.maxLatencyMs !== undefined) {
    const latency = entry.latencyMs
    if (typeof latency !== 'number' || latency > requirements.maxLatencyMs) {
      return makeEvaluation(entry, requirements, false, {
        code: 'latency-ceiling',
        reason:
          typeof latency !== 'number'
            ? `model '${entry.id}' has unknown latency (ceiling ${requirements.maxLatencyMs})`
            : `model '${entry.id}' latency ${latency} > ceiling ${requirements.maxLatencyMs}`,
      }, 0, false, nowMs, allowed)
    }
  }

  // Eligible: compute score, applying bounded observed-performance adjustment.
  let performanceAdjustment = 0
  let performanceApplied = false
  if (performance !== undefined) {
    const summary = performance.summaryFor(entry.id, entry.engineKind)
    if (summary.sampleCount > 0) {
      performanceAdjustment = performanceHealthAdjustment(summary)
      performanceApplied = true
    }
  }
  return makeEvaluation(
    entry,
    requirements,
    true,
    undefined,
    nowMs,
    allowed,
    performanceAdjustment,
    performanceApplied,
  )
}

function makeEvaluation(
  entry: ModelRegistryEntry,
  requirements: TaskModelRequirements,
  eligible: boolean,
  exclusion: Omit<ModelCandidateExclusion, 'engineKind' | 'modelId'> | undefined,
  nowMs: number,
  providerAllowed: boolean,
  performanceAdjustment: number,
  performanceApplied: boolean,
): ModelCapabilityEvaluation {
  const normalizedExclusion =
    exclusion === undefined
      ? undefined
      : { engineKind: entry.engineKind, modelId: entry.id, code: exclusion.code, reason: exclusion.reason }

  const statuses = {
    taskFit: capabilityStatus(
      Array.isArray(entry.capabilities?.taskFit) ? true : undefined,
    ),
    toolCalling: capabilityStatus(entry.toolCalling),
    multimodal: capabilityStatus(entry.multimodal),
    coding: capabilityStatus(entry.codingCapable),
    reasoning: capabilityStatus(entry.reasoningCapable),
  }

  // Context status.
  const contextStatus: CapabilityStatus =
    typeof entry.contextWindow === 'number' ? 'supported' : 'unknown'

  const costStatus: CapabilityStatus =
    typeof entry.costUsdPerMillionTokens === 'number' ? 'supported' : 'unknown'

  const latencyStatus: CapabilityStatus =
    typeof entry.latencyMs === 'number' ? 'supported' : 'unknown'

  const breakdown = computeScore(entry, requirements, eligible, performanceAdjustment)

  return {
    engineKind: entry.engineKind,
    modelId: entry.id,
    eligible,
    exclusion: normalizedExclusion,
    statuses,
    contextStatus,
    costStatus,
    latencyStatus,
    providerAllowed,
    score: eligible ? breakdown.total : 0,
    breakdown,
    ...(performanceApplied ? { performanceApplied: true } : {}),
    ...(performanceAdjustment !== 0 ? { healthAdjustment: performanceAdjustment } : {}),
  }
}

function computeScore(
  entry: ModelRegistryEntry,
  requirements: TaskModelRequirements,
  eligible: boolean,
  performanceAdjustment?: number,
): ModelScoreBreakdown {
  if (!eligible) {
    return { capabilityFit: 0, context: 0, health: 0, cost: 0, latency: 0, verified: 0, total: 0 }
  }

  // Capability fit (0-40).
  let capabilityFit = 0
  const preferred = requirements.preferredCapabilities
  const taskFit = entry.capabilities?.taskFit
  if (preferred.length === 0) {
    capabilityFit += 10
  } else if (Array.isArray(taskFit)) {
    const matched = preferred.filter((cap) => taskFit.includes(cap)).length
    capabilityFit += Math.round((matched / preferred.length) * 40)
  }
  if (preferred.includes('coding') && entry.codingCapable === true) capabilityFit = Math.min(40, capabilityFit + 5)
  if (preferred.includes('research') && entry.reasoningCapable === true) capabilityFit = Math.min(40, capabilityFit + 5)
  if (requirements.requiresToolCalling && entry.toolCalling === true) capabilityFit = Math.min(40, capabilityFit + 5)

  // Context (0-20).
  let context = 0
  if (typeof entry.contextWindow === 'number') {
    context = Math.min(20, Math.floor(entry.contextWindow / 8000))
  }

  // Health (0-20).
  let health = 0
  if (entry.capabilities?.providerHealth?.healthy === true) health = 20
  else if (entry.availability?.available === true) health = 10
  // unknown contributes 0

  // Cost (0-10), only when preference is 'low' and data exists.
  let cost = 0
  if (requirements.costPreference === 'low' && typeof entry.costUsdPerMillionTokens === 'number') {
    cost = Math.max(0, Math.min(10, 10 - entry.costUsdPerMillionTokens / 10))
  }

  // Latency (0-10), only when preference is 'low' and data exists.
  let latency = 0
  if (requirements.latencyPreference === 'low' && typeof entry.latencyMs === 'number') {
    latency = Math.max(0, Math.min(10, 10 - entry.latencyMs / 200))
  }

  // Verified metadata bonus (0-5).
  let verified = 0
  if (Array.isArray(entry.capabilities?.taskFit)) verified += 1
  if (typeof entry.contextWindow === 'number') verified += 1
  if (typeof entry.toolCalling === 'boolean') verified += 1
  if (typeof entry.codingCapable === 'boolean') verified += 1
  if (typeof entry.costUsdPerMillionTokens === 'number') verified += 1
  if (typeof entry.latencyMs === 'number') verified += 1
  verified = Math.min(5, verified)

  // Bounded observed-performance adjustment to health only (applied before total).
  if (performanceAdjustment !== undefined && performanceAdjustment !== 0) {
    health = Math.max(0, Math.min(20, health + performanceAdjustment))
  }

  const total = capabilityFit + context + health + cost + latency + verified
  return { capabilityFit, context, health, cost, latency, verified, total }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function selectModel(
  registry: ModelRegistry,
  input: ModelSelectionInput = {},
): ModelSelectionOutcome {
  const now = input.now ?? Date.now
  const nowMs = now()
  const nowIso = new Date(nowMs).toISOString()

  const { requirements } = resolveTaskRequirements(input)

  // Apply input-level hard ceilings into requirements (already there, but ensure).
  if (input.maxCostUsdPerMillionTokens !== undefined) {
    requirements.maxCostUsdPerMillionTokens = input.maxCostUsdPerMillionTokens
  }
  if (input.maxLatencyMs !== undefined) {
    requirements.maxLatencyMs = input.maxLatencyMs
  }
  if (input.minContextWindow !== undefined) {
    requirements.minContextWindow = input.minContextWindow
  }

  const allowlist = input.providerAllowlist ?? []
  const denylist = input.providerDenylist ?? []
  const restrictions = { allowlist, denylist }

  const excludedSet = new Set(input.excludedModelIds ?? [])
  const performance = input.performance
  const entries = registry
    .list()
    .filter((entry) => !excludedSet.has(entry.id))
    .filter((entry) => input.engineKind === undefined || entry.engineKind === input.engineKind)
  const evaluations: ModelCapabilityEvaluation[] = entries.map((entry) =>
    evaluateModel(entry, requirements, restrictions, nowMs, performance),
  )

  let performanceApplied = false
  for (const ev of evaluations) {
    if (ev.performanceApplied) performanceApplied = true
  }

  const exclusions = evaluations
    .filter((ev) => !ev.eligible && ev.exclusion !== undefined)
    .map((ev) => ev.exclusion as ModelCandidateExclusion)

  const eligibleEvals = evaluations.filter((ev) => ev.eligible)

  // Deterministic ordering for eligible candidates.
  const orderedEligible = [...eligibleEvals].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const aKnown = a.breakdown.verified
    const bKnown = b.breakdown.verified
    if (bKnown !== aKnown) return bKnown - aKnown
    // stable tie-break: engineKind then model id (never a hardcoded model)
    const aKey = `${a.engineKind}\u0000${a.modelId}`
    const bKey = `${b.engineKind}\u0000${b.modelId}`
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
  })

  const pinnedId = input.pinnedModelId
  let pinBlocked: ModelSelectionOutcome['pinBlocked'] = null
  let selection: ModelSelection | null = null

  if (pinnedId !== undefined && pinnedId.length > 0) {
    const pinnedEval = evaluations.find((ev) => {
      if (ev.modelId !== pinnedId) return false
      if (input.pinnedEngineKind !== undefined && ev.engineKind !== input.pinnedEngineKind) return false
      return true
    })

    if (pinnedEval === undefined) {
      pinBlocked = { modelId: pinnedId, reason: `pinned model '${pinnedId}' was not found in the discovered inventory` }
    } else if (!pinnedEval.eligible) {
      pinBlocked = {
        modelId: pinnedId,
        reason:
          pinnedEval.exclusion?.code === 'unavailable'
            ? `pinned model '${pinnedId}' is not available: ${pinnedEval.exclusion.reason}`
            : pinnedEval.exclusion?.reason ?? `pinned model '${pinnedId}' is not eligible`,
      }
      // Record as an exclusion if not already.
      if (!exclusions.some((e) => e.modelId === pinnedId && e.engineKind === pinnedEval.engineKind)) {
        exclusions.push({
          engineKind: pinnedEval.engineKind,
          modelId: pinnedEval.modelId,
          code: pinnedEval.exclusion?.code ?? 'pin-incompatible',
          reason: pinBlocked.reason,
        })
      }
    } else {
      const entry = entries.find(
        (e) => e.id === pinnedEval.modelId && e.engineKind === pinnedEval.engineKind,
      ) as ModelRegistryEntry
      selection = {
        modelId: pinnedEval.modelId,
        engineKind: pinnedEval.engineKind,
        provider: entry?.provider,
        reason: `Pinned model selected: ${pinnedEval.modelId} (score ${pinnedEval.score})`,
        score: pinnedEval.score,
        scoreBreakdown: pinnedEval.breakdown,
        candidatesConsidered: entries.length,
        eligibleCandidates: eligibleEvals.map((e) => e.modelId),
        selectedAt: nowIso,
        selectionMode: 'pinned',
      }
    }
  } else if (orderedEligible.length > 0) {
    const top = orderedEligible[0]!
    const entry = entries.find(
      (e) => e.id === top.modelId && e.engineKind === top.engineKind,
    ) as ModelRegistryEntry
    const runnerUp = orderedEligible[1]
    selection = {
      modelId: top.modelId,
      engineKind: top.engineKind,
      provider: entry?.provider,
      reason: runnerUp
        ? `Selected highest-ranked eligible model '${top.modelId}' (score ${top.score}) among ${eligibleEvals.length} eligible of ${entries.length} candidates; next best '${runnerUp.modelId}' scored ${runnerUp.score}`
        : `Selected only eligible model '${top.modelId}' (score ${top.score}) among ${entries.length} candidates`,
      score: top.score,
      scoreBreakdown: top.breakdown,
      candidatesConsidered: entries.length,
      eligibleCandidates: orderedEligible.map((e) => e.modelId),
      selectedAt: nowIso,
      selectionMode: 'automatic',
    }
  }

  return {
    selection,
    eligibleCount: eligibleEvals.length,
    candidatesConsidered: entries.length,
    exclusions,
    pinBlocked,
    evaluatedAt: nowIso,
    evaluations,
    ...(performanceApplied ? { performanceApplied: true } : {}),
  }
}
