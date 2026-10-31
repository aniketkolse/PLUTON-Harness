import { describe, expect, it } from 'vitest'
import type { EngineModel } from '../../src/engines/contract/types.ts'
import { ModelRegistry } from '../../src/engines/model-registry.ts'

/** Dynamically generated opaque ids: nothing here depends on a real model. */
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

describe('ModelRegistry', () => {
  it('starts empty and answers lookups safely', () => {
    const registry = new ModelRegistry()
    expect(registry.size).toBe(0)
    expect(registry.snapshot()).toEqual([])
    expect(registry.list()).toEqual([])
    expect(registry.get('engine-a', modelId())).toBeNull()
    expect(registry.findById(modelId())).toEqual([])
  })

  it('registers models with composite identity, provenance, and timestamps', () => {
    const clock = fixedClock()
    const registry = new ModelRegistry({ now: clock.now })
    const id = modelId()
    const changes = registry.replaceEngineModels(
      'engine-a',
      [model(id, { label: 'Alpha', provider: 'provider-x' })],
      clock.iso(),
    )

    expect(changes).toHaveLength(1)
    expect(changes[0]?.type).toBe('added')
    expect(changes[0]?.modelId).toBe(id)
    expect(registry.size).toBe(1)

    const entry = registry.get('engine-a', id)
    expect(entry).not.toBeNull()
    expect(entry?.id).toBe(id)
    expect(entry?.engineKind).toBe('engine-a')
    expect(entry?.provider).toBe('provider-x')
    expect(entry?.label).toBe('Alpha')
    expect(entry?.source).toBe('engine')
    expect(entry?.discoveredAt).toBe(clock.iso())
    expect(entry?.lastRefreshedAt).toBe(clock.iso())
    expect(entry?.availability).toBeUndefined()
  })

  it('reports metadata updates without moving discoveredAt', () => {
    const clock = fixedClock()
    const registry = new ModelRegistry({ now: clock.now })
    const id = modelId()
    registry.replaceEngineModels('engine-a', [model(id, { label: 'before' })], clock.iso())
    const discoveredAt = registry.get('engine-a', id)?.discoveredAt

    const later = clock.advance()
    const changes = registry.replaceEngineModels(
      'engine-a',
      [model(id, { label: 'after', capabilities: { taskFit: ['coding'] }, contextWindow: 32_000 })],
      later,
    )

    expect(changes).toHaveLength(1)
    expect(changes[0]?.type).toBe('updated')
    expect(changes[0]?.changedFields.sort()).toEqual(['capabilities', 'contextWindow', 'label'])
    const entry = registry.get('engine-a', id)
    expect(entry?.label).toBe('after')
    expect(entry?.contextWindow).toBe(32_000)
    expect(entry?.discoveredAt).toBe(discoveredAt)
    expect(entry?.lastRefreshedAt).toBe(later)
  })

  it('emits no change when a refresh is identical, but advances lastRefreshedAt', () => {
    const clock = fixedClock()
    const registry = new ModelRegistry({ now: clock.now })
    const id = modelId()
    registry.replaceEngineModels('engine-a', [model(id)], clock.iso())
    const later = clock.advance()

    const changes = registry.replaceEngineModels('engine-a', [model(id)], later)

    expect(changes).toEqual([])
    expect(registry.get('engine-a', id)?.lastRefreshedAt).toBe(later)
  })

  it('removes models omitted from a successful refresh', () => {
    const clock = fixedClock()
    const registry = new ModelRegistry({ now: clock.now })
    const keep = modelId()
    const drop = modelId()
    registry.replaceEngineModels('engine-a', [model(keep), model(drop)], clock.iso())

    const changes = registry.replaceEngineModels('engine-a', [model(keep)], clock.advance())

    expect(changes).toHaveLength(1)
    expect(changes[0]?.type).toBe('removed')
    expect(changes[0]?.modelId).toBe(drop)
    expect(changes[0]?.entry).toBeNull()
    expect(changes[0]?.previous?.id).toBe(drop)
    expect(registry.get('engine-a', drop)).toBeNull()
    expect(registry.get('engine-a', keep)).not.toBeNull()
  })

  it('keeps the same opaque id from different adapters as distinct entries', () => {
    const clock = fixedClock()
    const registry = new ModelRegistry({ now: clock.now })
    const id = modelId('shared')

    registry.replaceEngineModels('engine-a', [model(id, { label: 'from-a' })], clock.iso())
    registry.replaceEngineModels('engine-b', [model(id, { label: 'from-b' })], clock.iso())

    expect(registry.size).toBe(2)
    expect(registry.get('engine-a', id)?.label).toBe('from-a')
    expect(registry.get('engine-b', id)?.label).toBe('from-b')
    const matches = registry.findById(id)
    expect(matches.map((entry) => entry.engineKind)).toEqual(['engine-a', 'engine-b'])

    // Refreshing one adapter cannot remove the other adapter's entry.
    registry.replaceEngineModels('engine-a', [], clock.advance())
    expect(registry.get('engine-b', id)?.label).toBe('from-b')
  })

  it('never infers provider or capabilities from the model id', () => {
    const clock = fixedClock()
    const registry = new ModelRegistry({ now: clock.now })
    const id = 'coder-provider/ultra-coder-reasoner-9000'
    registry.replaceEngineModels('engine-a', [model(id)], clock.iso())

    const entry = registry.get('engine-a', id)
    expect(entry?.provider).toBeUndefined()
    expect(entry?.capabilities).toBeUndefined()
    expect(entry?.contextWindow).toBeUndefined()
    expect(entry?.toolCalling).toBeUndefined()
    expect(entry?.codingCapable).toBeUndefined()
  })

  it('stores frozen snapshots and defensively copies adapter metadata', () => {
    const clock = fixedClock()
    const registry = new ModelRegistry({ now: clock.now })
    const id = modelId()
    const capabilities: { taskFit: ('research' | 'coding')[] } = { taskFit: ['research'] }
    const source = model(id, { capabilities })

    registry.replaceEngineModels('engine-a', [source], clock.iso())
    capabilities.taskFit.push('coding')
    source.label = 'mutated-after-registration'

    const snapshot = registry.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[0])).toBe(true)
    expect(Object.isFrozen(snapshot[0]?.capabilities)).toBe(true)
    expect(snapshot[0]?.capabilities?.taskFit).toEqual(['research'])
    expect(snapshot[0]?.label).toBeUndefined()
    expect(() => {
      ;(snapshot[0] as { label?: string }).label = 'nope'
    }).toThrow()
  })

  it('ignores stale discovery results so metadata never rolls backwards', () => {
    const registry = new ModelRegistry()
    const id = modelId()
    const newer = '2030-01-01T00:00:10.000Z'
    const older = '2030-01-01T00:00:05.000Z'

    registry.replaceEngineModels('engine-a', [model(id, { label: 'newer' })], newer)
    const changes = registry.replaceEngineModels('engine-a', [model(id, { label: 'older' })], older)

    expect(changes).toEqual([])
    expect(registry.get('engine-a', id)?.label).toBe('newer')

    // A stale list cannot remove a newer entry either.
    registry.replaceEngineModels('engine-a', [], older)
    expect(registry.get('engine-a', id)?.label).toBe('newer')
  })

  it('stores availability without inventing inventory', () => {
    const clock = fixedClock()
    const registry = new ModelRegistry({ now: clock.now })
    const id = modelId()
    registry.replaceEngineModels('engine-a', [model(id)], clock.iso())

    const missing = modelId('never-seen')
    const unknown = registry.setAvailability('engine-a', missing, { id: missing, available: true })
    expect(unknown).toBeNull()

    const change = registry.setAvailability('engine-a', id, {
      id,
      available: false,
      reason: 'usage limit',
      category: 'usage-limit',
      healthCheckedAt: clock.iso(),
    })
    expect(change?.type).toBe('updated')
    expect(change?.changedFields).toEqual(['availability'])
    expect(registry.get('engine-a', id)?.availability?.category).toBe('usage-limit')

    // Availability survives a metadata refresh.
    registry.replaceEngineModels('engine-a', [model(id, { label: 'refreshed' })], clock.advance())
    expect(registry.get('engine-a', id)?.availability?.category).toBe('usage-limit')
  })

  it('filters invalid ids and de-duplicates repeated ids within one result', () => {
    const clock = fixedClock()
    const registry = new ModelRegistry({ now: clock.now })
    const id = modelId()
    const changes = registry.replaceEngineModels(
      'engine-a',
      [
        model(id, { label: 'first' }),
        model(id, { label: 'second' }),
        { id: '', source: 'engine' },
      ] as EngineModel[],
      clock.iso(),
    )

    expect(changes).toHaveLength(1)
    expect(changes[0]?.type).toBe('added')
    expect(registry.size).toBe(1)
    expect(registry.get('engine-a', id)?.label).toBe('first')
  })

  it('upserts one model without touching the rest of the inventory', () => {
    const clock = fixedClock()
    const registry = new ModelRegistry({ now: clock.now })
    const existing = modelId()
    const added = modelId()
    registry.replaceEngineModels('engine-a', [model(existing)], clock.iso())

    expect(registry.upsertModel('engine-a', model(added), clock.advance())?.type).toBe('added')
    expect(registry.size).toBe(2)
    expect(registry.get('engine-a', existing)).not.toBeNull()

    const updated = registry.upsertModel('engine-a', model(existing, { label: 'new' }), clock.advance())
    expect(updated?.type).toBe('updated')
    expect(updated?.changedFields).toEqual(['label'])

    const removed = registry.removeModel('engine-a', added)
    expect(removed?.type).toBe('removed')
    expect(registry.get('engine-a', added)).toBeNull()
  })
})
