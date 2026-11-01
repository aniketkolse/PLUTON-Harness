import type { ModelRegistryEntry } from './model-registry.ts'

/**
 * Model performance measurement (Phase 4, Batch 2).
 *
 * Collects observed, per-model performance signals and reduces them to a
 * summary used as a bounded routing input. All values default to `undefined`
 * (unknown) — never estimated, never fabricated, per Phase 4 rule 13.
 *
 * This layer is read-only with respect to selection: it records observations
 * and exposes summaries; the selector decides how much weight to give them.
 */

export type PerformanceCategory =
  | 'latency'
  | 'success'
  | 'failure'
  | 'fallback'
  | 'context_failure'
  | 'tool_failure'
  | 'completion'

export interface ModelPerformanceObservation {
  /** Composite model identity (engineKind reported separately for lookup). */
  modelId: string
  engineKind: string
  taskId?: string
  category: PerformanceCategory
  /** Value in ms for latency; unitless count/flag otherwise. */
  valueMs?: number
  value?: number
  detail?: string
  at: string
}

export interface ModelPerformanceSummary {
  modelId: string
  engineKind: string
  /** Total number of observations. */
  sampleCount: number
  /** Observed successful requests (category 'success'). */
  successCount: number
  /** Observed failed requests (category 'failure'). */
  failureCount: number
  /** Observed fallback triggers attributed to this model. */
  fallbackCount: number
  /** Observed context-limit failures. */
  contextFailureCount: number
  /** Observed tool-call failures. */
  toolFailureCount: number
  /** Observed task completions attributed to this model. */
  completionCount: number
  /** Sum of latency observations (ms) for averaging. */
  latencySumMs: number
  latencySampleCount: number
  lastObservedAt?: string
}

const EMPTY_SUMMARY: ModelPerformanceSummary = {
  modelId: '',
  engineKind: '',
  sampleCount: 0,
  successCount: 0,
  failureCount: 0,
  fallbackCount: 0,
  contextFailureCount: 0,
  toolFailureCount: 0,
  completionCount: 0,
  latencySumMs: 0,
  latencySampleCount: 0,
}

/**
 * Accumulates observations for one model. Pure reduction over the observation
 * list; no mutation of the registry, no network, no clock besides injection.
 */
export class ModelPerformanceMonitor {
  private readonly now: () => number
  private readonly observations: ModelPerformanceObservation[] = []

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now
  }

  /** Record one observation. Returns the observation (with timestamp filled in). */
  observe(input: {
    modelId: string
    engineKind: string
    taskId?: string
    category: PerformanceCategory
    valueMs?: number
    value?: number
    detail?: string
  }): ModelPerformanceObservation {
    const observation: ModelPerformanceObservation = {
      modelId: input.modelId,
      engineKind: input.engineKind,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      category: input.category,
      ...(input.valueMs !== undefined ? { valueMs: input.valueMs } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      at: new Date(this.now()).toISOString(),
    }
    this.observations.push(observation)
    return observation
  }

  /** All observations for a model, newest first. */
  observationsFor(modelId: string, engineKind?: string): ModelPerformanceObservation[] {
    return this.observations
      .filter((o) => o.modelId === modelId && (engineKind === undefined || o.engineKind === engineKind))
      .slice()
      .sort((a, b) => b.at.localeCompare(a.at))
  }

  /** Reduced summary for one model. Returns an empty summary when no observations. */
  summaryFor(modelId: string, engineKind?: string): ModelPerformanceSummary {
    const obs = this.observationsFor(modelId, engineKind)
    if (obs.length === 0) {
      return { ...EMPTY_SUMMARY, modelId, ...(engineKind !== undefined ? { engineKind } : {}) }
    }
    let successCount = 0
    let failureCount = 0
    let fallbackCount = 0
    let contextFailureCount = 0
    let toolFailureCount = 0
    let completionCount = 0
    let latencySumMs = 0
    let latencySampleCount = 0
    let lastObservedAt = obs[0]!.at
    for (const o of obs) {
      switch (o.category) {
        case 'success':
          successCount += 1
          break
        case 'failure':
          failureCount += 1
          break
        case 'fallback':
          fallbackCount += 1
          break
        case 'context_failure':
          contextFailureCount += 1
          break
        case 'tool_failure':
          toolFailureCount += 1
          break
        case 'completion':
          completionCount += 1
          break
      }
      if (o.category === 'latency' && typeof o.valueMs === 'number') {
        latencySumMs += o.valueMs
        latencySampleCount += 1
      }
    }
    return {
      modelId,
      engineKind: obs[0]!.engineKind,
      sampleCount: obs.length,
      successCount,
      failureCount,
      fallbackCount,
      contextFailureCount,
      toolFailureCount,
      completionCount,
      latencySumMs,
      latencySampleCount,
      lastObservedAt,
    }
  }

  /** Clear all observations (test seam / reset). */
  clear(): void {
    this.observations.length = 0
  }
}

/** Derived rates computed from a summary. All undefined when no samples. */
export interface ModelPerformanceRates {
  successRate: number | undefined
  failureRate: number | undefined
  fallbackRate: number | undefined
  avgLatencyMs: number | undefined
  completionRate: number | undefined
}

export function computeRates(summary: ModelPerformanceSummary): ModelPerformanceRates {
  const n = summary.sampleCount
  return {
    successRate: n > 0 ? summary.successCount / n : undefined,
    failureRate: n > 0 ? summary.failureCount / n : undefined,
    fallbackRate: n > 0 ? summary.fallbackCount / n : undefined,
    avgLatencyMs:
      summary.latencySampleCount > 0 ? summary.latencySumMs / summary.latencySampleCount : undefined,
    completionRate: n > 0 ? summary.completionCount / n : undefined,
  }
}

/**
 * Bounded performance adjustment applied to a model's health score component.
 * Observed performance adjusts health within a narrow band so capability and
 * health remain the primary routing signals; observed performance never
 * overrides a hard eligibility decision.
 *
 * Returns a value in [-10, +10] added to the health (0-20) component, capped
 * so the adjusted health stays within [0, 20].
 */
export function performanceHealthAdjustment(summary: ModelPerformanceSummary): number {
  const rates = computeRates(summary)
  if (rates.successRate === undefined && rates.failureRate === undefined) return 0

  let adjustment = 0
  if (rates.successRate !== undefined) {
    adjustment += Math.round((rates.successRate - 0.5) * 10) // [-5, +5]
  }
  if (rates.failureRate !== undefined) {
    adjustment -= Math.round(rates.failureRate * 5) // [0, -5]
  }
  const contextRate =
    summary.sampleCount > 0 ? summary.contextFailureCount / summary.sampleCount : undefined
  if (contextRate !== undefined && contextRate > 0) {
    adjustment -= 2 // penalize repeated context failures
  }
  return Math.max(-10, Math.min(10, adjustment))
}
