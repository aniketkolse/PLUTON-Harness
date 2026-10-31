import { describe, expect, it } from 'vitest'
import { ModelRegistry } from '../../src/engines/model-registry.ts'
import { ModelHealthMonitor, classifyModelError } from '../../src/engines/model-health.ts'
import type { EngineModel, ModelAvailability } from '../../src/engines/contract/types.ts'
import type { ModelErrorContext } from '../../src/engines/model-health.ts'

/** Dynamically generated opaque ids. */
let seq = 0
function modelId(name = `m${(seq += 1)}`): string {
  return `test-provider/${name}`
}

function model(id: string, extra: Partial<EngineModel> = {}): EngineModel {
  return { id, source: 'engine', ...extra }
}

function fixedClock(startMs = Date.parse('2030-01-01T00:00:00.000Z')) {
  let ms = startMs
  return {
    now: () => ms,
    advance: (deltaMs = 1_000) => {
      ms += deltaMs
      return new Date(ms).toISOString()
    },
    iso: () => new Date(ms).toISOString(),
  }
}

function registryWith(models: EngineModel[]): ModelRegistry {
  const registry = new ModelRegistry()
  registry.replaceEngineModels('engine-test', models, '2030-01-01T00:00:00.000Z')
  return registry
}

describe('classifyModelError', () => {
  it('classifies a structured usage-limit error as usage-limit', () => {
    const result = classifyModelError({ errorCode: 'usage_limit', providerMessage: 'quota exceeded' })
    expect(result.category).toBe('usage-limit')
    expect(result.confidence).toBe('high')
    expect(result.retryable).toBe(false)
    expect(result.suggestedScope).toBe('task')
  })

  it('classifies provider-wide quota exhaustion as provider scope', () => {
    const result = classifyModelError({
      errorCode: 'quota_exceeded',
      quotaScope: 'account-1',
      scopeHint: 'provider',
    })
    expect(result.category).toBe('usage-limit')
    expect(result.suggestedScope).toBe('provider')
  })

  it('classifies task-specific quota exhaustion as task scope', () => {
    const result = classifyModelError({
      errorCode: 'rate_limit',
      quotaScope: undefined,
      scopeHint: 'task',
    })
    expect(result.category).toBe('usage-limit')
    expect(result.suggestedScope).toBe('task')
  })

  it('classifies provider unavailable from HTTP status', () => {
    const result = classifyModelError({ httpStatus: 503 })
    expect(result.category).toBe('provider-unavailable')
    expect(result.confidence).toBe('high')
    expect(result.retryable).toBe(true)
  })

  it('classifies authentication failures from HTTP 401', () => {
    const result = classifyModelError({ httpStatus: 401, providerMessage: 'invalid api key' })
    expect(result.category).toBe('auth-failure')
    expect(result.suggestedScope).toBe('provider')
  })

  it('classifies context-window exhaustion separately from execution failure', () => {
    const result = classifyModelError({ providerMessage: 'context length exceeded: max 4096 tokens' })
    expect(result.category).toBe('context-limit-exceeded')
  })

  it('classifies unsupported tool capability', () => {
    const result = classifyModelError({ providerMessage: 'tool foo is not supported by this model' })
    expect(result.category).toBe('unsupported-tool-capability')
  })

  it('classifies temporary network timeouts', () => {
    const result = classifyModelError({ providerMessage: 'request timed out after 30000ms' })
    expect(result.category).toBe('temporary-network-error')
    expect(result.retryable).toBe(true)
  })

  it('classifies execution errors', () => {
    const result = classifyModelError({ providerMessage: 'generation failed: invalid json output' })
    expect(result.category).toBe('execution-error')
    expect(result.retryable).toBe(false)
  })

  it('classifies ambiguous errors as unknown', () => {
    const result = classifyModelError({ providerMessage: 'something weird happened' })
    expect(result.category).toBe('unknown')
    expect(result.confidence).toBe('low')
  })

  it('follows evidence precedence: structured code beats message', () => {
    const result = classifyModelError({
      errorCode: 'auth_failure',
      providerMessage: 'quota exceeded',
    })
    expect(result.category).toBe('auth-failure')
  })

  it('redacts sensitive data in diagnostics', () => {
    const result = classifyModelError({
      providerMessage: 'failed with api_key=supersecret123',
    })
    expect(result.reason).not.toContain('supersecret123')
    expect(result.reason).toContain('[redacted]')
  })
})

describe('ModelHealthMonitor scoped health', () => {
  it('records a task-level failure without affecting other tasks or the model globally', () => {
    const id = modelId()
    const clock = fixedClock()
    const registry = registryWith([model(id, { toolCalling: true, contextWindow: 32_000 })])
    const monitor = new ModelHealthMonitor({ registry, now: clock.now })

    const { classification, changes } = monitor.recordFailure({
      engineKind: 'engine-test',
      modelId: id,
      taskId: 'task-a',
      providerMessage: 'usage limit reached',
      scopeHint: 'task',
    })
    expect(classification.category).toBe('usage-limit')
    expect(changes.some((c) => c.scope === 'task')).toBe(true)

    expect(monitor.isTemporarilyIneligible({ engineKind: 'engine-test', modelId: id, taskId: 'task-a' })).toBe(true)
    expect(monitor.isTemporarilyIneligible({ engineKind: 'engine-test', modelId: id, taskId: 'task-b' })).toBe(false)
    // Model-level health stays healthy (task scope does not mutate registry availability).
    expect(monitor.getModelHealth('engine-test', id).state).not.toBe('temporarily-ineligible')
  })

  it('a provider quota error affects only models sharing that quota scope', () => {
    const a = modelId()
    const b = modelId()
    const c = modelId()
    const clock = fixedClock()
    const registry = new ModelRegistry()
    registry.replaceEngineModels(
      'engine-test',
      [
        model(a, { provider: 'acct-1', toolCalling: true, contextWindow: 32_000 }),
        model(b, { provider: 'acct-1', toolCalling: true, contextWindow: 32_000 }),
        model(c, { provider: 'acct-2', toolCalling: true, contextWindow: 32_000 }),
      ],
      '2030-01-01T00:00:00.000Z',
    )
    const monitor = new ModelHealthMonitor({ registry, now: clock.now })

    monitor.recordFailure({
      engineKind: 'engine-test',
      modelId: a,
      quotaScope: 'acct-1',
      provider: 'acct-1',
      providerMessage: 'quota exceeded',
      scopeHint: 'provider',
    })

    expect(monitor.getModelHealth('engine-test', a).state).toBe('temporarily-ineligible')
    expect(monitor.getModelHealth('engine-test', b).state).toBe('temporarily-ineligible')
    expect(monitor.getModelHealth('engine-test', c).state).not.toBe('temporarily-ineligible')
  })

  it('authentication failures do not affect unrelated providers', () => {
    const a = modelId()
    const b = modelId()
    const clock = fixedClock()
    const registry = new ModelRegistry()
    registry.replaceEngineModels(
      'engine-test',
      [
        model(a, { provider: 'provider-x', toolCalling: true, contextWindow: 32_000 }),
        model(b, { provider: 'provider-y', toolCalling: true, contextWindow: 32_000 }),
      ],
      '2030-01-01T00:00:00.000Z',
    )
    const monitor = new ModelHealthMonitor({ registry, now: clock.now })

    monitor.recordFailure({
      engineKind: 'engine-test',
      modelId: a,
      provider: 'provider-x',
      providerMessage: 'invalid api key',
      scopeHint: 'provider',
    })

    expect(monitor.getModelHealth('engine-test', a).state).toBe('unavailable')
    expect(monitor.getModelHealth('engine-test', b).state).not.toBe('unavailable')
  })

  it('a model-level failure affects only that model', () => {
    const a = modelId()
    const b = modelId()
    const clock = fixedClock()
    const registry = registryWith([model(a, { toolCalling: true, contextWindow: 32_000 }), model(b, { toolCalling: true, contextWindow: 32_000 })])
    const monitor = new ModelHealthMonitor({ registry, now: clock.now })

    monitor.recordFailure({
      engineKind: 'engine-test',
      modelId: a,
      providerMessage: 'execution failed',
      scopeHint: 'task',
    })

    expect(monitor.getModelHealth('engine-test', a).state).not.toBe('healthy')
    expect(monitor.getModelHealth('engine-test', b).state).toBe('healthy')
  })

  it('temporary network degradation expires after cooldown', () => {
    const id = modelId()
    const clock = fixedClock()
    const registry = registryWith([model(id, { toolCalling: true, contextWindow: 32_000 })])
    const monitor = new ModelHealthMonitor({
      registry,
      now: clock.now,
      cooldowns: { 'temporary-network-error': 10 },
    })

    monitor.recordFailure({
      engineKind: 'engine-test',
      modelId: id,
      providerMessage: 'request timed out',
      scopeHint: 'task',
    })
    expect(monitor.isTemporarilyIneligible({ engineKind: 'engine-test', modelId: id })).toBe(true)

    clock.advance(20)
    expect(monitor.isTemporarilyIneligible({ engineKind: 'engine-test', modelId: id })).toBe(false)
  })

  it('successful health evidence restores eligible state and clears registry cooldown', () => {
    const id = modelId()
    const clock = fixedClock()
    const registry = registryWith([model(id, { toolCalling: true, contextWindow: 32_000 })])
    const monitor = new ModelHealthMonitor({ registry, now: clock.now })

    monitor.recordFailure({
      engineKind: 'engine-test',
      modelId: id,
      providerMessage: 'usage limit reached',
      scopeHint: 'task',
    })
    const entry = registry.get('engine-test', id)
    expect(entry?.availability?.temporarilyIneligibleUntil).toBeDefined()

    monitor.recordSuccess({ engineKind: 'engine-test', modelId: id })
    const after = registry.get('engine-test', id)
    expect(after?.availability?.available).toBe(true)
    expect(after?.availability?.temporarilyIneligibleUntil).toBeUndefined()
    expect(monitor.getModelHealth('engine-test', id).state).toBe('healthy')
  })

  it('discovery refresh does not erase runtime health', () => {
    const id = modelId()
    const clock = fixedClock()
    const registry = registryWith([model(id, { toolCalling: true, contextWindow: 32_000 })])
    const monitor = new ModelHealthMonitor({ registry, now: clock.now })

    monitor.recordFailure({
      engineKind: 'engine-test',
      modelId: id,
      providerMessage: 'usage limit reached',
      scopeHint: 'task',
    })
    const before = registry.get('engine-test', id)?.availability?.temporarilyIneligibleUntil
    expect(before).toBeDefined()

    // A discovery refresh replaces the model list but preserves availability.
    registry.replaceEngineModels('engine-test', [model(id, { toolCalling: true, contextWindow: 32_000 })], clock.advance())
    const after = registry.get('engine-test', id)?.availability?.temporarilyIneligibleUntil
    expect(after).toBe(before)
  })

  it('does not permanently mark a model unavailable for a transient error', () => {
    const id = modelId()
    const clock = fixedClock()
    const registry = registryWith([model(id, { toolCalling: true, contextWindow: 32_000 })])
    const monitor = new ModelHealthMonitor({
      registry,
      now: clock.now,
      cooldowns: { 'temporary-network-error': 5 },
    })

    monitor.recordFailure({
      engineKind: 'engine-test',
      modelId: id,
      providerMessage: 'request timed out',
      scopeHint: 'task',
    })
    expect(monitor.getModelHealth('engine-test', id).state).toBe('temporarily-ineligible')

    clock.advance(10)
    expect(monitor.isTemporarilyIneligible({ engineKind: 'engine-test', modelId: id })).toBe(false)
  })

  it('returns unknown health state for an untracked model', () => {
    const id = modelId()
    const clock = fixedClock()
    const registry = new ModelRegistry()
    const monitor = new ModelHealthMonitor({ registry, now: clock.now })
    expect(monitor.getModelHealth('engine-test', id).state).toBe('unknown')
  })

  it('recordFailure classification can be supplied by the caller', () => {
    const id = modelId()
    const clock = fixedClock()
    const registry = registryWith([model(id, { toolCalling: true, contextWindow: 32_000 })])
    const monitor = new ModelHealthMonitor({ registry, now: clock.now })
    const classification = classifyModelError({ providerMessage: 'usage limit reached' })
    const result = monitor.recordFailure(
      { engineKind: 'engine-test', modelId: id, providerMessage: 'anything' },
      classification,
    )
    expect(result.classification.category).toBe('usage-limit')
  })
})
