import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ValidationError } from '../../src/domain/errors.ts'
import type { ShipRecord } from '../../src/domain/models.ts'
import { nativeAdapterFor } from '../../src/execution/adapter.ts'
import type { ExecutionProvider } from '../../src/execution/native.ts'
import {
  engineSpawnsProcess,
  getEngineAdapter,
  listEngineKinds,
  registerBuiltinEngines,
} from '../../src/engines/registry.ts'
import {
  saveProvider,
  writeProviderCredential,
} from '../../src/providers/store.ts'
import { providerConfigSchema } from '../../src/providers/types.ts'

registerBuiltinEngines()

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pluton-provider-registry-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function configureProvider(): void {
  saveProvider(
    root,
    providerConfigSchema.parse({
      id: 'alpha',
      engine: 'openai-compatible',
      display_name: 'Alpha',
      base_url: 'https://provider.example.test/v1',
    }),
  )
  writeProviderCredential(root, 'alpha', 'registry-test-key')
}

function ship(): ShipRecord {
  return {
    id: 'ship-1',
    slug: 'ship-1',
    displayName: 'Ship',
    role: 'coder',
    engineKind: 'openai-compatible',
    model: 'vendor/model-a',
    workspacePolicy: 'isolated-task-checkout',
    approvalMode: 'autonomous-bounded',
    permissions: [],
    instructionsFile: null,
    engineHome: join(root, '.pluton', 'engine-homes', 'ship-1'),
  } as unknown as ShipRecord
}

describe('engine registry provider metadata', () => {
  it('registers the OpenAI-compatible adapter as a real, non-process engine', () => {
    const byKind = new Map(listEngineKinds().map((factory) => [factory.kind, factory]))
    const factory = byKind.get('openai-compatible')
    expect(factory).toBeDefined()
    expect(factory?.devOnly).toBe(false)
    expect(factory?.spawnsProcess).toBe(false)
    expect(factory?.description.length).toBeGreaterThan(0)
  })

  it('keeps process engines spawning by default', () => {
    const byKind = new Map(listEngineKinds().map((factory) => [factory.kind, factory]))
    expect(byKind.get('opencode')?.spawnsProcess).not.toBe(false)
    expect(engineSpawnsProcess('opencode')).toBe(true)
    expect(engineSpawnsProcess('openai-compatible')).toBe(false)
  })

  it('rejects an unknown engine when asking about process spawning', () => {
    expect(() => engineSpawnsProcess('nope')).toThrowError(ValidationError)
  })

  it('continues to exclude the dev-only mock from production discovery', () => {
    const production = listEngineKinds().filter((factory) => factory.devOnly !== true)
    expect(production.map((factory) => factory.kind)).toContain('opencode')
    expect(production.map((factory) => factory.kind)).toContain('openai-compatible')
    expect(production.map((factory) => factory.kind)).not.toContain('mock')
  })

  it('threads rootDir and providerId through factory construction', async () => {
    configureProvider()
    const adapter = getEngineAdapter('openai-compatible', {
      rootDir: root,
      providerId: 'alpha',
    })
    const status = await adapter.authStatus(join(root, '.pluton'))
    expect(status.configured).toBe(true)
  })
})

describe('native execution wrapper for non-process engines', () => {
  function providerSpy(): { provider: ExecutionProvider; prepare: ReturnType<typeof vi.fn> } {
    const prepare = vi.fn(async () => {
      throw new Error('a non-process engine must never prepare an execution session')
    })
    const provider = {
      kind: 'native',
      probe: async () => ({ available: true }),
      prepare,
      listSessions: () => [],
      close: async () => {},
    } as unknown as ExecutionProvider
    return { provider, prepare }
  }

  it('returns the HTTP adapter directly and never calls provider.prepare', async () => {
    configureProvider()
    const { provider, prepare } = providerSpy()
    const adapter = nativeAdapterFor(ship(), {
      provider,
      isolatedCheckout: false,
      specFor: () => {
        throw new Error('no execution spec for a non-process engine')
      },
      engineOptions: { rootDir: root, providerId: 'alpha' },
    })
    expect(adapter.kind).toBe('openai-compatible')
    expect(adapter.capabilities().mcpServers).toBe(true)

    const session = await adapter.startSession({
      ship: { id: 'ship-1', slug: 'ship-1', role: 'coder', model: 'vendor/model-a' },
      workdir: root,
      env: {},
      configDir: root,
    })
    await session.close()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('still wraps process engines with the execution provider', async () => {
    const { provider, prepare } = providerSpy()
    // The prepare call is attempted before any engine process is spawned; the
    // stub's failure proves the wrapper path is still taken for OpenCode.
    const adapter = nativeAdapterFor(
      { ...ship(), engineKind: 'opencode' } as ShipRecord,
      {
        provider,
        isolatedCheckout: false,
        specFor: () => ({}) as never,
        engineOptions: { rootDir: root },
      },
    )
    await expect(
      adapter.startSession({
        ship: { id: 'ship-1', slug: 'ship-1', role: 'coder', model: 'vendor/model-a' },
        workdir: root,
        env: {},
        configDir: root,
      }),
    ).rejects.toThrow(/never prepare/)
    expect(prepare).toHaveBeenCalledTimes(1)
  })
})
