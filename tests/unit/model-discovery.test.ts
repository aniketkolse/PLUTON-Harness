import { describe, expect, it, vi } from 'vitest'
import type { EngineAdapter, EngineModel } from '../../src/engines/contract/types.ts'
import { defaultCapabilities } from '../../src/engines/contract/types.ts'
import {
  ModelDiscoveryService,
  registeredEngineModelDiscovery,
  type ModelDiscoveryTimers,
} from '../../src/engines/model-discovery.ts'
import { ModelHealthMonitor, classifyModelError } from '../../src/engines/model-health.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'

/** Dynamically generated opaque ids: no real model names or versions. */
let seq = 0
function modelId(name = `m${(seq += 1)}`): string {
  return `test-provider/${name}`
}

function model(id: string, extra: Partial<EngineModel> = {}): EngineModel {
  return { id, source: 'engine', ...extra }
}

function testAdapter(kind: string, listModels: () => Promise<EngineModel[]>): EngineAdapter {
  return {
    kind,
    capabilities: () => ({ ...defaultCapabilities(), modelList: true }),
    discover: async () => ({
      engineKind: kind,
      installed: true,
      binaryPath: `<${kind}>`,
      version: 'test',
      fix: '',
    }),
    listModels,
    authStatus: async () => ({ configured: true, hint: 'test adapter needs no auth' }),
    startSession: async () => {
      throw new Error('not used in discovery tests')
    },
  }
}

function fixedClock(startMs = Date.parse('2030-01-01T00:00:00.000Z')) {
  let ms = startMs
  return {
    now: () => ms,
    advance: (deltaMs = 1_000) => {
      ms += deltaMs
      return new Date(ms).toISOString()
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ModelDiscoveryService', () => {
  it('discovers every adapter and reports additions', async () => {
    const clock = fixedClock()
    const a1 = modelId()
    const a2 = modelId()
    const b1 = modelId()
    const service = new ModelDiscoveryService({
      engines: [
        { engineKind: 'engine-a', adapter: testAdapter('engine-a', async () => [model(a1), model(a2)]) },
        { engineKind: 'engine-b', adapter: testAdapter('engine-b', async () => [model(b1)]) },
      ],
      now: clock.now,
    })

    const report = await service.refresh()

    expect(report.coalesced).toBe(false)
    expect(report.results.map((result) => result.engineKind)).toEqual(['engine-a', 'engine-b'])
    expect(report.results.every((result) => result.ok)).toBe(true)
    expect(report.results.map((result) => result.modelCount)).toEqual([2, 1])
    expect(report.changes.map((change) => change.type)).toEqual(['added', 'added', 'added'])
    expect(service.registry.size).toBe(3)
    expect(service.registry.get('engine-a', a1)?.engineKind).toBe('engine-a')
    expect(service.registry.get('engine-b', b1)?.engineKind).toBe('engine-b')
  })

  it('isolates a failing adapter and retains its previous inventory', async () => {
    const clock = fixedClock()
    const a1 = modelId()
    const b1 = modelId()
    let betaFails = false
    const service = new ModelDiscoveryService({
      engines: [
        { engineKind: 'engine-a', adapter: testAdapter('engine-a', async () => [model(a1)]) },
        {
          engineKind: 'engine-b',
          adapter: testAdapter('engine-b', async () => {
            if (betaFails) throw new Error('provider refused the model list')
            return [model(b1)]
          }),
        },
      ],
      now: clock.now,
    })

    await service.refresh()
    betaFails = true
    clock.advance()
    const report = await service.refresh()

    const failure = report.results.find((result) => result.engineKind === 'engine-b')
    expect(failure?.ok).toBe(false)
    expect(failure?.error).toContain('provider refused')
    expect(failure?.changes).toEqual([])
    expect(report.changes.some((change) => change.engineKind === 'engine-b')).toBe(false)

    // The failing adapter's inventory survives; the healthy adapter is updated.
    expect(service.registry.get('engine-b', b1)).not.toBeNull()
    expect(service.registry.get('engine-a', a1)).not.toBeNull()
  })

  it('removes an adapter inventory when a successful refresh returns an empty list', async () => {
    const clock = fixedClock()
    const a1 = modelId()
    const b1 = modelId()
    let alphaModels = [model(a1)]
    const service = new ModelDiscoveryService({
      engines: [
        { engineKind: 'engine-a', adapter: testAdapter('engine-a', async () => alphaModels) },
        { engineKind: 'engine-b', adapter: testAdapter('engine-b', async () => [model(b1)]) },
      ],
      now: clock.now,
    })

    await service.refresh()
    alphaModels = []
    clock.advance()
    const report = await service.refresh()

    expect(report.changes).toHaveLength(1)
    expect(report.changes[0]?.type).toBe('removed')
    expect(report.changes[0]?.engineKind).toBe('engine-a')
    expect(service.registry.get('engine-a', a1)).toBeNull()
    expect(service.registry.get('engine-b', b1)).not.toBeNull()
  })

  it('reports add and update changes when a failed provider recovers', async () => {
    const clock = fixedClock()
    const stable = modelId()
    const recovered = modelId()
    let betaPhase = 0
    const service = new ModelDiscoveryService({
      engines: [
        { engineKind: 'engine-a', adapter: testAdapter('engine-a', async () => [model(stable)]) },
        {
          engineKind: 'engine-b',
          adapter: testAdapter('engine-b', async () => {
            if (betaPhase === 1) throw new Error('temporarily unavailable')
            if (betaPhase === 0) return [model(stable)]
            return [model(stable, { label: 'recovered label' }), model(recovered)]
          }),
        },
      ],
      now: clock.now,
    })

    await service.refresh()
    expect(service.registry.get('engine-b', stable)?.label).toBeUndefined()

    betaPhase = 1
    clock.advance()
    const failed = await service.refresh()
    expect(failed.results.find((result) => result.engineKind === 'engine-b')?.ok).toBe(false)
    expect(service.registry.get('engine-b', stable)).not.toBeNull()

    betaPhase = 2
    clock.advance()
    const report = await service.refresh()

    const beta = report.results.find((result) => result.engineKind === 'engine-b')
    expect(beta?.ok).toBe(true)
    expect(beta?.changes.map((change) => change.type).sort()).toEqual(['added', 'updated'])
    expect(service.registry.get('engine-b', stable)?.label).toBe('recovered label')
    expect(service.registry.get('engine-b', recovered)).not.toBeNull()
  })

  it('keeps identical opaque ids from different adapters collision-free', async () => {
    const clock = fixedClock()
    const shared = modelId('shared')
    let alphaModels = [model(shared, { label: 'alpha' })]
    const service = new ModelDiscoveryService({
      engines: [
        { engineKind: 'engine-a', adapter: testAdapter('engine-a', async () => alphaModels) },
        { engineKind: 'engine-b', adapter: testAdapter('engine-b', async () => [model(shared, { label: 'beta' })]) },
      ],
      now: clock.now,
    })

    await service.refresh()
    expect(service.registry.size).toBe(2)
    expect(service.registry.findById(shared).map((entry) => entry.label)).toEqual(['alpha', 'beta'])

    alphaModels = []
    clock.advance()
    await service.refresh()
    expect(service.registry.get('engine-a', shared)).toBeNull()
    expect(service.registry.get('engine-b', shared)?.label).toBe('beta')
  })

  it('probes each provider scope on the same engine independently', async () => {
    const clock = fixedClock()
    const fast = 'fast-llm/model-a'
    const slow = 'slow-llm/model-a'
    const service = new ModelDiscoveryService({
      engines: [
        {
          engineKind: 'openai-compatible',
          providerId: 'fast-llm',
          adapter: testAdapter('openai-compatible', async () => [model(fast)]),
        },
        {
          engineKind: 'openai-compatible',
          providerId: 'slow-llm',
          adapter: testAdapter('openai-compatible', async () => [model(slow)]),
        },
      ],
      now: clock.now,
    })

    const report = await service.refresh()

    expect(report.results.map((result) => result.providerId)).toEqual(['fast-llm', 'slow-llm'])
    expect(report.results.every((result) => result.ok)).toBe(true)
    expect(service.registry.size).toBe(2)
    expect(service.registry.get('openai-compatible', fast)?.provider).toBe('fast-llm')
    expect(service.registry.get('openai-compatible', slow)?.provider).toBe('slow-llm')
  })

  it('preserves partial metadata and never infers capabilities from names', async () => {
    const clock = fixedClock()
    const id = 'some-provider/research-coder-testing-ultra'
    const service = new ModelDiscoveryService({
      engines: [{ engineKind: 'engine-a', adapter: testAdapter('engine-a', async () => [model(id)]) }],
      now: clock.now,
    })

    await service.refresh()
    const entry = service.registry.get('engine-a', id)
    expect(entry?.capabilities).toBeUndefined()
    expect(entry?.provider).toBeUndefined()
    expect(entry?.contextWindow).toBeUndefined()
    expect(entry?.toolCalling).toBeUndefined()
    expect(entry?.codingCapable).toBeUndefined()
    expect(entry?.reasoningCapable).toBeUndefined()
    expect(entry?.availability).toBeUndefined()
  })

  it('filters malformed adapter entries without failing the adapter', async () => {
    const clock = fixedClock()
    const valid = modelId()
    const listed = [
      model(valid),
      { id: '', source: 'engine' },
      { label: 'no id', source: 'engine' },
      null,
    ] as unknown as EngineModel[]
    const service = new ModelDiscoveryService({
      engines: [{ engineKind: 'engine-a', adapter: testAdapter('engine-a', async () => listed) }],
      now: clock.now,
    })

    const report = await service.refresh()
    expect(report.results[0]?.ok).toBe(true)
    expect(report.results[0]?.modelCount).toBe(1)
    expect(report.results[0]?.invalidCount).toBe(3)
    expect(service.registry.size).toBe(1)
    expect(service.registry.get('engine-a', valid)).not.toBeNull()
  })

  it('coalesces overlapping refreshes into one adapter pass', async () => {
    const clock = fixedClock()
    const id = modelId()
    const gate = deferred<EngineModel[]>()
    let calls = 0
    const service = new ModelDiscoveryService({
      engines: [
        {
          engineKind: 'engine-a',
          adapter: testAdapter('engine-a', async () => {
            calls += 1
            return gate.promise
          }),
        },
      ],
      now: clock.now,
    })

    const first = service.refresh()
    const second = service.refresh()
    expect(calls).toBe(1)
    expect(service.discovering).toBe(true)

    gate.resolve([model(id)])
    const [firstReport, secondReport] = await Promise.all([first, second])

    expect(firstReport.coalesced).toBe(false)
    expect(secondReport.coalesced).toBe(true)
    expect(calls).toBe(1)
    expect(service.discovering).toBe(false)
    expect(service.registry.get('engine-a', id)).not.toBeNull()
  })

  it('probes independent adapters concurrently', async () => {
    const clock = fixedClock()
    const gateA = deferred<EngineModel[]>()
    const gateB = deferred<EngineModel[]>()
    let startedA = false
    let startedB = false
    const service = new ModelDiscoveryService({
      engines: [
        {
          engineKind: 'engine-a',
          adapter: testAdapter('engine-a', async () => {
            startedA = true
            return gateA.promise
          }),
        },
        {
          engineKind: 'engine-b',
          adapter: testAdapter('engine-b', async () => {
            startedB = true
            return gateB.promise
          }),
        },
      ],
      now: clock.now,
    })

    const running = service.refresh()
    expect(startedA).toBe(true)
    expect(startedB).toBe(true)

    gateB.resolve([model(modelId())])
    gateA.resolve([model(modelId())])
    const report = await running
    expect(report.results.every((result) => result.ok)).toBe(true)
  })

  it('starts and stops periodic refresh with injectable timers', async () => {
    const clock = fixedClock()
    let calls = 0
    let tick: (() => void) | null = null
    let cleared = 0
    let unrefs = 0
    const timers: ModelDiscoveryTimers = {
      setInterval: (fn, ms) => {
        expect(ms).toBe(50)
        tick = fn
        return {
          unref: () => {
            unrefs += 1
          },
        }
      },
      clearInterval: () => {
        cleared += 1
      },
    }
    const service = new ModelDiscoveryService({
      engines: [
        {
          engineKind: 'engine-a',
          adapter: testAdapter('engine-a', async () => {
            calls += 1
            return [model(modelId())]
          }),
        },
      ],
      refreshIntervalMs: 50,
      now: clock.now,
      timers,
    })

    const initial = await service.start()
    expect(initial.results).toHaveLength(1)
    expect(calls).toBe(1)
    expect(unrefs).toBe(1)
    expect(tick).not.toBeNull()

    ;(tick as (() => void) | null)?.()
    await vi.waitFor(() => expect(calls).toBe(2))

    service.stop()
    service.stop()
    expect(cleared).toBe(1)
  })

  it('excludes dev-only engines from production discovery by default', () => {
    registerBuiltinEngines()
    const service = registeredEngineModelDiscovery()
    expect(service.engineKinds).toContain('opencode')
    expect(service.engineKinds).not.toContain('mock')

    const optedIn = registeredEngineModelDiscovery({ includeDevOnly: true })
    expect(optedIn.engineKinds).toContain('mock')
  })

  it('composes discovery from the registered engine factories', async () => {
    registerBuiltinEngines()
    const service = registeredEngineModelDiscovery({ only: ['mock'] })
    expect(service.engineKinds).toEqual(['mock'])

    const report = await service.refresh()
    expect(report.results).toHaveLength(1)
    expect(report.results[0]?.engineKind).toBe('mock')
    expect(report.results[0]?.ok).toBe(true)
  })

  it('recovers unavailable models in healthMonitor when successfully rediscovered', async () => {
    const clock = fixedClock()
    const m1 = modelId('m1')
    const adapter = testAdapter('engine-recover', async () => [model(m1)])
    const service = new ModelDiscoveryService({
      engines: [{ engineKind: 'engine-recover', adapter }],
      now: clock.now,
    })
    const healthMonitor = new ModelHealthMonitor({ registry: service.registry, now: clock.now })
    const discoveryWithHealth = new ModelDiscoveryService({
      engines: [{ engineKind: 'engine-recover', adapter }],
      registry: service.registry,
      healthMonitor,
      now: clock.now,
    })

    // Populate registry first
    await discoveryWithHealth.refresh()

    // Mark model unavailable via auth/provider failure with 0 cooldown
    const error = classifyModelError({
      engineKind: 'engine-recover',
      modelId: m1,
      providerMessage: 'unauthorized: bad token',
    })
    healthMonitor.recordFailure(
      { engineKind: 'engine-recover', modelId: m1, providerMessage: 'unauthorized: bad token' },
      error,
    )
    expect(healthMonitor.getModelHealth('engine-recover', m1).state).toBe('unavailable')

    // Rediscovery sees the engine respond with the model again
    await discoveryWithHealth.refresh()
    expect(healthMonitor.getModelHealth('engine-recover', m1).state).toBe('healthy')
  })
})
