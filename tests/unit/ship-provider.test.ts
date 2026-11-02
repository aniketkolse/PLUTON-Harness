import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.ts'
import { plutonConfigSchema } from '../../src/config/schema.ts'
import { ConfigError, ValidationError } from '../../src/domain/errors.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'
import {
  createShip,
  editShip,
  listShips,
  modelList,
  showShip,
} from '../../src/cli/commands/ship.ts'
import {
  saveProvider,
  writeProviderCredential,
} from '../../src/providers/store.ts'
import { providerConfigSchema } from '../../src/providers/types.ts'

registerBuiltinEngines()

let root: string
let configPath: string

function setupProject(shipsYaml: string = ''): void {
  const content = `version: 1
project:
  name: test-project
  repository: .
  default_branch: main
  verification: []
ships:
${shipsYaml || '  manager:\n    display_name: Manager\n    role: supervisor\n    engine: mock\n    model: mock/test\n    workspace_policy: coordinator-read-only'}
`
  writeFileSync(configPath, content)
}

function configureProvider(id = 'provider-a', engine = 'openai-compatible'): void {
  saveProvider(
    root,
    providerConfigSchema.parse({
      id,
      engine,
      display_name: `Provider ${id}`,
      base_url: 'https://api.example.test/v1',
    }),
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pluton-ship-provider-'))
  configPath = join(root, 'pluton.yaml')
  setupProject()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ship provider config schema', () => {
  it('accepts optional provider field in ship config', () => {
    const raw = {
      version: 1,
      project: { name: 'demo' },
      ships: {
        manager: {
          display_name: 'Manager',
          role: 'supervisor',
          engine: 'mock',
          model: 'mock/test',
          workspace_policy: 'coordinator-read-only',
        },
        worker: {
          display_name: 'Worker',
          role: 'coder',
          engine: 'openai-compatible',
          provider: 'provider-a',
          model: 'vendor/model-1',
          workspace_policy: 'isolated-task-checkout',
        },
      },
    }
    const parsed = plutonConfigSchema.parse(raw)
    expect(parsed.ships['worker']?.provider).toBe('provider-a')
  })

  it('rejects empty provider slug', () => {
    const raw = {
      version: 1,
      project: { name: 'demo' },
      ships: {
        manager: {
          display_name: 'Manager',
          role: 'supervisor',
          engine: 'mock',
          model: 'mock/test',
        },
        worker: {
          display_name: 'Worker',
          role: 'coder',
          engine: 'openai-compatible',
          provider: '',
          model: 'vendor/model-1',
        },
      },
    }
    expect(() => plutonConfigSchema.parse(raw)).toThrow()
  })
})

describe('ship create and edit with provider', () => {
  it('creates a ship with an explicit provider', () => {
    configureProvider('provider-a')
    const ctx = { rootDir: root, configPath, loaded: loadConfig(root) }
    const result = createShip(ctx, {
      id: 'worker-a',
      engine: 'openai-compatible',
      provider: 'provider-a',
      model: 'vendor/model-1',
      role: 'coder',
    })
    expect(result.ship.provider).toBe('provider-a')
    const reloaded = loadConfig(root)
    expect(reloaded.config.ships['worker-a']?.provider).toBe('provider-a')
  })

  it('refuses to create a ship when the explicit provider does not exist', () => {
    const ctx = { rootDir: root, configPath, loaded: loadConfig(root) }
    expect(() =>
      createShip(ctx, {
        id: 'worker-bad',
        engine: 'openai-compatible',
        provider: 'non-existent',
        model: 'vendor/model-1',
        role: 'coder',
      }),
    ).toThrowError(ValidationError)
  })

  it('edits an existing ship to assign a provider', () => {
    configureProvider('provider-b')
    const ctx = { rootDir: root, configPath, loaded: loadConfig(root) }
    createShip(ctx, {
      id: 'worker-b',
      engine: 'openai-compatible',
      provider: 'provider-b',
      model: 'vendor/model-1',
      role: 'coder',
    })

    configureProvider('provider-c')
    const updatedCtx = { rootDir: root, configPath, loaded: loadConfig(root) }
    const edited = editShip(updatedCtx, 'worker-b', { provider: 'provider-c' })
    expect(edited.ship.provider).toBe('provider-c')
    expect(edited.changed).toContain('provider')

    const reloaded = loadConfig(root)
    expect(reloaded.config.ships['worker-b']?.provider).toBe('provider-c')
  })

  it('listShips and showShip expose provider field', async () => {
    configureProvider('provider-a')
    const ctx = { rootDir: root, configPath, loaded: loadConfig(root) }
    createShip(ctx, {
      id: 'worker-a',
      engine: 'openai-compatible',
      provider: 'provider-a',
      model: 'vendor/model-1',
      role: 'coder',
    })

    const loaded = loadConfig(root)
    const list = listShips(loaded.config)
    const entry = list.find((s) => s.id === 'worker-a')
    expect(entry?.provider).toBe('provider-a')

    const detail = await showShip({ rootDir: root, configPath, loaded }, 'worker-a')
    expect(detail.provider).toBe('provider-a')
    expect(detail.discovery?.installed).toBe(true)
  })

  it('modelList fails when provider has no credentials', async () => {
    configureProvider('provider-a')
    const ctx = { rootDir: root, configPath, loaded: loadConfig(root) }
    createShip(ctx, {
      id: 'worker-a',
      engine: 'openai-compatible',
      provider: 'provider-a',
      model: 'vendor/model-1',
      role: 'coder',
    })

    const updatedCtx = { rootDir: root, configPath, loaded: loadConfig(root) }
    await expect(modelList(updatedCtx, 'worker-a')).rejects.toThrow()
  })
})
