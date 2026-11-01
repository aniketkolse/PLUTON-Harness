import { describe, expect, it } from 'vitest'
import { ModelRegistry } from '../../src/engines/model-registry.ts'
import {
  resolveTaskRequirements,
  selectModel,
  evaluateModel,
  type ModelSelectionInput,
} from '../../src/engines/model-selection.ts'
import type { EngineModel, ModelAvailability } from '../../src/engines/contract/types.ts'

/** Dynamically generated opaque ids. */
let seq = 0
function modelId(name = `m${(seq += 1)}`): string {
  return `test-provider/${name}`
}

function model(id: string, extra: Partial<EngineModel> = {}): EngineModel {
  return { id, source: 'engine', ...extra }
}

function registryOf(models: EngineModel[]): ModelRegistry {
  const registry = new ModelRegistry()
  registry.replaceEngineModels('engine-test', models, '2030-01-01T00:00:00.000Z')
  return registry
}

function availability(overrides: Partial<ModelAvailability>): ModelAvailability {
  return { id: overrides.id ?? modelId(), available: true, ...overrides }
}

describe('resolveTaskRequirements', () => {
  it('uses explicit hints with highest precedence', () => {
    const result = resolveTaskRequirements({
      task: { title: 'write unit tests for the parser' },
      shipRole: 'coder',
      hint: { taskType: 'research', requiredCapabilities: ['research'] },
    })
    expect(result.classificationSource).toBe('hint')
    expect(result.classificationConfidence).toBe('high')
    expect(result.requirements.taskType).toBe('research')
    expect(result.requirements.preferredCapabilities).toEqual(['research'])
  })

  it('classifies task content when hints are absent', () => {
    const result = resolveTaskRequirements({
      task: { title: 'Implement a new endpoint and fix the compile error' },
    })
    expect(result.classificationSource).toBe('content')
    expect(result.requirements.taskType).toBe('coding')
  })

  it('falls back to ship role when content is empty or ambiguous', () => {
    const result = resolveTaskRequirements({ shipRole: 'tester' })
    expect(result.classificationSource).toBe('role')
    expect(result.requirements.taskType).toBe('testing')
  })

  it('uses general-purpose requirements when nothing else applies', () => {
    const result = resolveTaskRequirements({})
    expect(result.classificationSource).toBe('general')
    expect(result.requirements.taskType).toBe('simple')
    expect(result.requirements.requiresToolCalling).toBe(false)
  })

  it('propagates hard ceilings from input', () => {
    const result = resolveTaskRequirements({
      maxCostUsdPerMillionTokens: 5,
      maxLatencyMs: 1000,
      minContextWindow: 4096,
    })
    expect(result.requirements.maxCostUsdPerMillionTokens).toBe(5)
    expect(result.requirements.maxLatencyMs).toBe(1000)
    expect(result.requirements.minContextWindow).toBe(4096)
  })
})

describe('evaluateModel', () => {
  it('marks a fully-supported model eligible', () => {
    const id = modelId()
    const entry = registryOf([
      model(id, {
        toolCalling: true,
        contextWindow: 32_000,
        capabilities: { taskFit: ['coding'] },
      }),
    ]).get('engine-test', id)!
    const { requirements } = resolveTaskRequirements({
      task: { title: 'implement endpoint' },
    })
    const ev = evaluateModel(entry, requirements, { allowlist: [], denylist: [] }, Date.now())
    expect(ev.eligible).toBe(true)
    expect(ev.exclusion).toBeUndefined()
  })

  it('excludes a model missing mandatory tool calling', () => {
    const id = modelId()
    const entry = registryOf([model(id, { toolCalling: false, contextWindow: 32_000 })]).get(
      'engine-test',
      id,
    )!
    const { requirements } = resolveTaskRequirements({
      task: { title: 'implement endpoint' },
    })
    const ev = evaluateModel(entry, requirements, { allowlist: [], denylist: [] }, Date.now())
    expect(ev.eligible).toBe(false)
    expect(ev.exclusion?.code).toBe('tool-calling-missing')
  })

  it('excludes when tool calling is unknown for a tool-requiring task', () => {
    const id = modelId()
    const entry = registryOf([model(id, { contextWindow: 32_000 })]).get('engine-test', id)!
    const { requirements } = resolveTaskRequirements({
      task: { title: 'implement endpoint' },
    })
    const ev = evaluateModel(entry, requirements, { allowlist: [], denylist: [] }, Date.now())
    expect(ev.eligible).toBe(false)
    expect(ev.exclusion?.code).toBe('tool-calling-missing')
  })

  it('excludes a model with unknown context window under a hard requirement', () => {
    const id = modelId()
    const entry = registryOf([model(id, { toolCalling: true })]).get('engine-test', id)!
    const { requirements } = resolveTaskRequirements({
      hint: { taskType: 'coding', minContextWindow: 1000 },
    })
    const ev = evaluateModel(entry, requirements, { allowlist: [], denylist: [] }, Date.now())
    expect(ev.eligible).toBe(false)
    expect(ev.exclusion?.code).toBe('context-too-small')
  })

  it('excludes an unavailable model', () => {
    const id = modelId()
    const entry = registryOf([
      model(id, {
        toolCalling: true,
        contextWindow: 32_000,
        availability: availability({ id, available: false, reason: 'down', category: 'provider-unavailable' }),
      }),
    ]).get('engine-test', id)!
    const { requirements } = resolveTaskRequirements({ task: { title: 'simple task' } })
    const ev = evaluateModel(entry, requirements, { allowlist: [], denylist: [] }, Date.now())
    expect(ev.eligible).toBe(false)
    expect(ev.exclusion?.code).toBe('unavailable')
  })

  it('excludes a temporarily ineligible model', () => {
    const id = modelId()
    const future = new Date(Date.now() + 60_000).toISOString()
    const entry = registryOf([
      model(id, {
        toolCalling: true,
        contextWindow: 32_000,
        availability: availability({ id, available: true, temporarilyIneligibleUntil: future }),
      }),
    ]).get('engine-test', id)!
    const { requirements } = resolveTaskRequirements({ task: { title: 'simple task' } })
    const ev = evaluateModel(entry, requirements, { allowlist: [], denylist: [] }, Date.now())
    expect(ev.eligible).toBe(false)
    expect(ev.exclusion?.code).toBe('temporarily-ineligible')
  })

  it('excludes a model blocked by provider restrictions', () => {
    const id = modelId()
    const entry = registryOf([
      model(id, { toolCalling: true, contextWindow: 32_000, provider: 'blocked-provider' }),
    ]).get('engine-test', id)!
    const { requirements } = resolveTaskRequirements({ task: { title: 'simple task' } })
    const ev = evaluateModel(entry, requirements, { allowlist: [], denylist: ['blocked-provider'] }, Date.now())
    expect(ev.eligible).toBe(false)
    expect(ev.exclusion?.code).toBe('provider-restricted')
  })

  it('fails a hard cost ceiling when cost is unknown', () => {
    const id = modelId()
    const entry = registryOf([model(id, { toolCalling: true, contextWindow: 32_000 })]).get(
      'engine-test',
      id,
    )!
    const { requirements } = resolveTaskRequirements({
      task: { title: 'simple task' },
      maxCostUsdPerMillionTokens: 1,
    })
    const ev = evaluateModel(entry, requirements, { allowlist: [], denylist: [] }, Date.now())
    expect(ev.eligible).toBe(false)
    expect(ev.exclusion?.code).toBe('cost-ceiling')
  })

  it('fails a hard latency ceiling when latency is known and too high', () => {
    const id = modelId()
    const entry = registryOf([
      model(id, { toolCalling: true, contextWindow: 32_000, latencyMs: 5000 }),
    ]).get('engine-test', id)!
    const { requirements } = resolveTaskRequirements({
      task: { title: 'simple task' },
      maxLatencyMs: 1000,
    })
    const ev = evaluateModel(entry, requirements, { allowlist: [], denylist: [] }, Date.now())
    expect(ev.eligible).toBe(false)
    expect(ev.exclusion?.code).toBe('latency-ceiling')
  })
})

describe('selectModel', () => {
  it('returns null when no models are discovered', () => {
    const registry = new ModelRegistry()
    const outcome = selectModel(registry, { task: { title: 'implement endpoint' } })
    expect(outcome.selection).toBeNull()
    expect(outcome.eligibleCount).toBe(0)
    expect(outcome.candidatesConsidered).toBe(0)
  })

  it('selects the only eligible model', () => {
    const id = modelId()
    const registry = registryOf([model(id, { toolCalling: true, contextWindow: 32_000 })])
    const outcome = selectModel(registry, { task: { title: 'implement endpoint' } })
    expect(outcome.selection?.modelId).toBe(id)
    expect(outcome.selection?.selectionMode).toBe('automatic')
    expect(outcome.eligibleCount).toBe(1)
  })

  it('selects the highest-ranked eligible model among several', () => {
    const weak = modelId()
    const strong = modelId()
    const registry = registryOf([
      model(weak, { toolCalling: true, contextWindow: 8_000, capabilities: { taskFit: [] } }),
      model(strong, {
        toolCalling: true,
        contextWindow: 64_000,
        capabilities: { taskFit: ['coding'] },
        codingCapable: true,
      }),
    ])
    const outcome = selectModel(registry, { task: { title: 'implement endpoint' } })
    expect(outcome.selection?.modelId).toBe(strong)
    expect(outcome.eligibleCount).toBe(2)
  })

  it('excludes ineligible models and records exclusion reasons', () => {
    const good = modelId()
    const bad = modelId()
    const registry = registryOf([
      model(good, { toolCalling: true, contextWindow: 32_000 }),
      model(bad, { toolCalling: false, contextWindow: 32_000 }),
    ])
    const outcome = selectModel(registry, { task: { title: 'implement endpoint' } })
    expect(outcome.selection?.modelId).toBe(good)
    expect(outcome.exclusions.some((e) => e.modelId === bad && e.code === 'tool-calling-missing')).toBe(true)
  })

  it('returns null with no eligible models and no pin', () => {
    const id = modelId()
    const registry = registryOf([model(id, { toolCalling: false, contextWindow: 32_000 })])
    const outcome = selectModel(registry, { task: { title: 'implement endpoint' } })
    expect(outcome.selection).toBeNull()
    expect(outcome.eligibleCount).toBe(0)
  })

  it('honors an explicit pin that is available and eligible', () => {
    const pinned = modelId()
    const other = modelId()
    const registry = registryOf([
      model(pinned, { toolCalling: true, contextWindow: 32_000 }),
      model(other, { toolCalling: true, contextWindow: 64_000, capabilities: { taskFit: ['coding'] } }),
    ])
    const outcome = selectModel(registry, {
      task: { title: 'implement endpoint' },
      pinnedModelId: pinned,
    })
    expect(outcome.selection?.modelId).toBe(pinned)
    expect(outcome.selection?.selectionMode).toBe('pinned')
    expect(outcome.pinBlocked).toBeNull()
  })

  it('blocks an unavailable pin without silently substituting', () => {
    const pinned = modelId()
    const other = modelId()
    const registry = registryOf([
      model(pinned, { toolCalling: true, contextWindow: 32_000, availability: availability({ id: pinned, available: false, reason: 'down' }) }),
      model(other, { toolCalling: true, contextWindow: 64_000 }),
    ])
    const outcome = selectModel(registry, {
      task: { title: 'implement endpoint' },
      pinnedModelId: pinned,
    })
    expect(outcome.selection).toBeNull()
    expect(outcome.pinBlocked?.modelId).toBe(pinned)
    expect(outcome.pinBlocked?.reason).toContain('not available')
  })

  it('blocks an incompatible pin without silently substituting', () => {
    const pinned = modelId()
    const other = modelId()
    const registry = registryOf([
      model(pinned, { toolCalling: false, contextWindow: 32_000 }),
      model(other, { toolCalling: true, contextWindow: 64_000 }),
    ])
    const outcome = selectModel(registry, {
      task: { title: 'implement endpoint' },
      pinnedModelId: pinned,
    })
    expect(outcome.selection).toBeNull()
    expect(outcome.pinBlocked?.modelId).toBe(pinned)
    expect(outcome.pinBlocked?.reason).toContain('tool/function-calling')
  })

  it('blocks a pin that is not in the discovered inventory', () => {
    const other = modelId()
    const registry = registryOf([model(other, { toolCalling: true, contextWindow: 32_000 })])
    const outcome = selectModel(registry, {
      task: { title: 'implement endpoint' },
      pinnedModelId: 'never-discovered/model',
    })
    expect(outcome.selection).toBeNull()
    expect(outcome.pinBlocked?.modelId).toBe('never-discovered/model')
    expect(outcome.pinBlocked?.reason).toContain('not found')
  })

  it('uses deterministic tie-breaking that does not favor a hardcoded model', () => {
    const a = modelId('a')
    const b = modelId('b')
    const registry = registryOf([
      model(a, { toolCalling: true, contextWindow: 32_000 }),
      model(b, { toolCalling: true, contextWindow: 32_000 }),
    ])
    const first = selectModel(registry, { task: { title: 'simple task' } })
    const second = selectModel(registry, { task: { title: 'simple task' } })
    expect(first.selection?.modelId).toBe(second.selection?.modelId)
    // Tie-break by engineKind then id (lexicographic), not a preferred name.
    expect(first.selection?.modelId).toBe(a < b ? a : b)
  })

  it('treats unknown cost and latency as neutral in ranking', () => {
    const a = modelId()
    const b = modelId()
    const registry = registryOf([
      model(a, { toolCalling: true, contextWindow: 32_000 }),
      model(b, { toolCalling: true, contextWindow: 32_000, costUsdPerMillionTokens: 1, latencyMs: 100 }),
    ])
    const outcome = selectModel(registry, {
      task: { title: 'simple task' },
      costPreference: 'low',
      latencyPreference: 'low',
    })
    // The model with known low cost/latency should score at least as well.
    expect(outcome.selection?.modelId).toBe(b)
  })

  it('does not mutate the registry during selection', () => {
    const id = modelId()
    const registry = registryOf([model(id, { toolCalling: true, contextWindow: 32_000 })])
    const before = registry.snapshot()
    selectModel(registry, { task: { title: 'implement endpoint' } })
    const after = registry.snapshot()
    expect(after).toEqual(before)
    expect(registry.size).toBe(1)
  })

  it('selects independently per task without reserving a model', () => {
    const coding = modelId()
    const research = modelId()
    const registry = registryOf([
      model(coding, { toolCalling: true, contextWindow: 32_000, codingCapable: true, capabilities: { taskFit: ['coding'] } }),
      model(research, { toolCalling: true, contextWindow: 32_000, reasoningCapable: true, capabilities: { taskFit: ['research'] } }),
    ])
    const codingOutcome = selectModel(registry, { task: { title: 'implement endpoint' } })
    const researchOutcome = selectModel(registry, { task: { title: 'research the codebase' } })
    expect(codingOutcome.selection?.modelId).toBe(coding)
    expect(researchOutcome.selection?.modelId).toBe(research)
  })

  it('reflects registry updates in subsequent selections', () => {
    const first = modelId()
    const registry = registryOf([model(first, { toolCalling: true, contextWindow: 32_000 })])
    const before = selectModel(registry, { task: { title: 'simple task' } })
    expect(before.selection?.modelId).toBe(first)

    const second = modelId()
    registry.replaceEngineModels(
      'engine-test',
      [model(second, { toolCalling: true, contextWindow: 64_000 })],
      '2030-01-01T00:00:10.000Z',
    )
    const after = selectModel(registry, { task: { title: 'simple task' } })
    expect(after.selection?.modelId).toBe(second)
    expect(registry.get('engine-test', first)).toBeNull()
  })

  it('records a score breakdown in the selection', () => {
    const id = modelId()
    const registry = registryOf([model(id, { toolCalling: true, contextWindow: 32_000 })])
    const outcome = selectModel(registry, { task: { title: 'simple task' } })
    expect(outcome.selection?.scoreBreakdown).toBeDefined()
    expect(outcome.selection?.scoreBreakdown?.total).toBe(outcome.selection?.score)
  })

  it('never crosses engine boundaries when an engine kind is requested', () => {
    const dev = 'mock/high-scoring-model'
    const real = 'opencode/low-scoring-model'
    const registry = new ModelRegistry()
    // The dev-only entry has complete metadata and would outrank the real one.
    registry.replaceEngineModels(
      'mock',
      [model(dev, { toolCalling: true, contextWindow: 128_000, capabilities: { taskFit: ['simple'] } })],
      '2030-01-01T00:00:00.000Z',
    )
    registry.replaceEngineModels(
      'opencode',
      [model(real, { toolCalling: true, contextWindow: 8_000 })],
      '2030-01-01T00:00:00.000Z',
    )

    const unrestricted = selectModel(registry, { task: { title: 'simple task' } })
    expect(unrestricted.selection?.modelId).toBe(dev)

    const restricted = selectModel(registry, { task: { title: 'simple task' }, engineKind: 'opencode' })
    expect(restricted.selection?.modelId).toBe(real)
    expect(restricted.candidatesConsidered).toBe(1)
  })
})
