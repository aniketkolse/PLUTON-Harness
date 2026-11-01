import { describe, expect, it } from 'vitest'
import {
  ModelPerformanceMonitor,
  computeRates,
  performanceHealthAdjustment,
} from '../../src/engines/model-performance.ts'

describe('model performance monitoring (Phase 4 Batch 2)', () => {
  it('records observations and reduces to a summary', () => {
    const monitor = new ModelPerformanceMonitor({ now: () => 1_000_000_000_000 })
    monitor.observe({ modelId: 'm-a', engineKind: 'opencode', category: 'success' })
    monitor.observe({ modelId: 'm-a', engineKind: 'opencode', category: 'failure' })
    monitor.observe({ modelId: 'm-a', engineKind: 'opencode', category: 'latency', valueMs: 200 })
    monitor.observe({ modelId: 'm-b', engineKind: 'opencode', category: 'success' })

    const a = monitor.summaryFor('m-a', 'opencode')
    expect(a.sampleCount).toBe(3)
    expect(a.successCount).toBe(1)
    expect(a.failureCount).toBe(1)
    expect(a.latencySumMs).toBe(200)
    expect(a.latencySampleCount).toBe(1)
    expect(a.lastObservedAt).toBeDefined()

    const b = monitor.summaryFor('m-b', 'opencode')
    expect(b.sampleCount).toBe(1)
    expect(b.successCount).toBe(1)

    const missing = monitor.summaryFor('m-missing', 'opencode')
    expect(missing.sampleCount).toBe(0)
    expect(missing.successCount).toBe(0)
  })

  it('observations can be retrieved for a model', () => {
    const monitor = new ModelPerformanceMonitor({ now: () => 0 })
    monitor.observe({ modelId: 'm', engineKind: 'e', category: 'success' })
    monitor.observe({ modelId: 'm', engineKind: 'e', category: 'failure' })
    const obs = monitor.observationsFor('m', 'e')
    expect(obs.length).toBe(2)
    expect(obs.map((o) => o.category).sort()).toEqual(['failure', 'success'])
  })

  it('computeRates returns undefined for empty summary', () => {
    const empty = { modelId: 'm', engineKind: 'e', sampleCount: 0, successCount: 0, failureCount: 0, fallbackCount: 0, contextFailureCount: 0, toolFailureCount: 0, completionCount: 0, latencySumMs: 0, latencySampleCount: 0 }
    const r = computeRates(empty)
    expect(r.successRate).toBeUndefined()
    expect(r.failureRate).toBeUndefined()
    expect(r.avgLatencyMs).toBeUndefined()
  })

  it('computeRates computes success/failure/latency', () => {
    const s = { modelId: 'm', engineKind: 'e', sampleCount: 4, successCount: 3, failureCount: 1, fallbackCount: 0, contextFailureCount: 0, toolFailureCount: 0, completionCount: 2, latencySumMs: 400, latencySampleCount: 2 }
    const r = computeRates(s)
    expect(r.successRate).toBe(0.75)
    expect(r.failureRate).toBe(0.25)
    expect(r.completionRate).toBe(0.5)
    expect(r.avgLatencyMs).toBe(200)
  })

  it('performanceHealthAdjustment is bounded and zero when unknown', () => {
    const unknown = { modelId: 'm', engineKind: 'e', sampleCount: 0, successCount: 0, failureCount: 0, fallbackCount: 0, contextFailureCount: 0, toolFailureCount: 0, completionCount: 0, latencySumMs: 0, latencySampleCount: 0 }
    expect(performanceHealthAdjustment(unknown)).toBe(0)

    const allSuccess = { modelId: 'm', engineKind: 'e', sampleCount: 10, successCount: 10, failureCount: 0, fallbackCount: 0, contextFailureCount: 0, toolFailureCount: 0, completionCount: 10, latencySumMs: 0, latencySampleCount: 0 }
    expect(performanceHealthAdjustment(allSuccess)).toBe(5) // (1 - 0.5) * 10 = 5

    const allFailure = { modelId: 'm', engineKind: 'e', sampleCount: 10, successCount: 0, failureCount: 10, fallbackCount: 0, contextFailureCount: 0, toolFailureCount: 0, completionCount: 0, latencySumMs: 0, latencySampleCount: 0 }
    expect(performanceHealthAdjustment(allFailure)).toBe(-10) // bounded
  })

  it('clear removes all observations', () => {
    const monitor = new ModelPerformanceMonitor()
    monitor.observe({ modelId: 'm', engineKind: 'e', category: 'success' })
    expect(monitor.summaryFor('m', 'e').sampleCount).toBe(1)
    monitor.clear()
    expect(monitor.summaryFor('m', 'e').sampleCount).toBe(0)
  })
})
