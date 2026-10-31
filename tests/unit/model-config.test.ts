import { describe, expect, it } from 'vitest'
import { resolveModelConfig } from '../../src/config/model-config.ts'
import type { PlutonConfig } from '../../src/config/schema.ts'

function makeConfig(ships: Record<string, any>, models?: any): PlutonConfig {
  return {
    version: 1,
    project: { name: 'test', repository: '.', default_branch: 'main', verification: [] },
    runtime: {} as any,
    sandbox: {} as any,
    git: {} as any,
    ships,
    models,
  } as unknown as PlutonConfig
}

describe('resolveModelConfig', () => {
  it('marks a ship with an explicit model as pinned', () => {
    const config = makeConfig({
      worker: { display_name: 'Worker', role: 'coder', engine: 'opencode', model: 'opencode/beam-free' },
    })
    const resolved = resolveModelConfig(config)
    expect(resolved.ships.worker?.selectionMode).toBe('pinned')
    expect(resolved.ships.worker?.pin).toBe('opencode/beam-free')
  })

  it('marks a ship without a model as automatic', () => {
    const config = makeConfig({
      worker: { display_name: 'Worker', role: 'coder', engine: 'opencode' },
    })
    const resolved = resolveModelConfig(config)
    expect(resolved.ships.worker?.selectionMode).toBe('automatic')
    expect(resolved.ships.worker?.pin).toBeNull()
  })

  it('applies global discovery allowlist to ships', () => {
    const config = makeConfig(
      { worker: { display_name: 'Worker', role: 'coder', engine: 'opencode' } },
      { discovery: { providers: { allowlist: ['opencode'], denylist: [] } } },
    )
    const resolved = resolveModelConfig(config)
    expect(resolved.ships.worker?.providerAllowlist).toEqual(['opencode'])
    expect(resolved.models.discovery.providerAllowlist).toEqual(['opencode'])
  })

  it('preserves task hints and preferences on the ship', () => {
    const config = makeConfig({
      worker: {
        display_name: 'Worker',
        role: 'coder',
        engine: 'opencode',
        model_requirements: { taskType: 'coding', requiresToolCalling: true },
        model_preferences: { costPreference: 'low', maxCostUsdPerMillionTokens: 5 },
      },
    })
    const resolved = resolveModelConfig(config)
    expect(resolved.ships.worker?.taskHints?.taskType).toBe('coding')
    expect(resolved.ships.worker?.taskHints?.requiresToolCalling).toBe(true)
    expect(resolved.ships.worker?.preferences?.costPreference).toBe('low')
    expect(resolved.ships.worker?.preferences?.maxCostUsdPerMillionTokens).toBe(5)
  })

  it('defaults discovery refresh to 0 (disabled)', () => {
    const config = makeConfig({ worker: { display_name: 'Worker', role: 'coder', engine: 'opencode' } })
    const resolved = resolveModelConfig(config)
    expect(resolved.models.discovery.refreshIntervalMs).toBe(0)
  })
})
