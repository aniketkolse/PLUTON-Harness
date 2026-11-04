import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors.ts'
import { resolveExecutionRoute } from '../../src/engines/execution-router.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'
import { saveProvider, writeProviderCredential } from '../../src/providers/store.ts'
import type { ProviderConfig } from '../../src/providers/types.ts'

const roots: string[] = []

beforeAll(() => {
  registerBuiltinEngines()
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows file locks may linger briefly
    }
  }
})

const FAST_LLM: ProviderConfig = {
  id: 'fast-llm',
  engine: 'openai-compatible',
  display_name: 'Fast LLM',
  base_url: 'http://127.0.0.1:9999/v1',
  auth: { style: 'bearer' },
  models_path: '/models',
  chat_path: '/chat/completions',
}

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'pluton-exec-router-'))
  roots.push(root)
  return root
}

describe('resolveExecutionRoute', () => {
  it('routes a provider-prefixed model to that provider, never to OpenCode', () => {
    const root = setup()
    saveProvider(root, FAST_LLM)

    const route = resolveExecutionRoute({ rootDir: root, model: 'fast-llm/gpt-4o-mini' })

    expect(route.identity).toEqual({
      engineKind: 'openai-compatible',
      providerId: 'fast-llm',
      modelId: 'fast-llm/gpt-4o-mini',
    })
    expect(route.provider?.id).toBe('fast-llm')
    expect(route.adapter.kind).toBe('openai-compatible')
  })

  it('honours an explicit provider id even when the model id has no prefix', () => {
    const root = setup()
    saveProvider(root, FAST_LLM)

    const route = resolveExecutionRoute({
      rootDir: root,
      model: 'gpt-4o-mini',
      providerId: 'fast-llm',
    })

    expect(route.identity.engineKind).toBe('openai-compatible')
    expect(route.identity.providerId).toBe('fast-llm')
  })

  it("refuses to execute a configured provider's model on OpenCode", () => {
    const root = setup()
    saveProvider(root, FAST_LLM)

    expect(() =>
      resolveExecutionRoute({
        rootDir: root,
        model: 'fast-llm/gpt-4o-mini',
        providerId: 'opencode',
      }),
    ).toThrow(ValidationError)
    expect(() =>
      resolveExecutionRoute({
        rootDir: root,
        model: 'fast-llm/gpt-4o-mini',
        providerId: 'opencode',
      }),
    ).toThrow(/fast-llm.*opencode/)
  })

  it('rejects an unknown explicit provider', () => {
    const root = setup()

    expect(() =>
      resolveExecutionRoute({ rootDir: root, model: 'x/y', providerId: 'not-configured' }),
    ).toThrow(/unknown provider 'not-configured'/)
  })

  it('keeps a built-in engine as its own provider identity', () => {
    const root = setup()

    const route = resolveExecutionRoute({
      rootDir: root,
      model: 'mock/model-a',
      engineKind: 'mock',
    })

    expect(route.identity).toEqual({
      engineKind: 'mock',
      providerId: 'mock',
      modelId: 'mock/model-a',
    })
    expect(route.provider).toBeNull()
  })

  it('reports credential state per provider instead of assuming a shared key', () => {
    const root = setup()
    saveProvider(root, FAST_LLM)

    const missing = resolveExecutionRoute({ rootDir: root, model: 'fast-llm/gpt-4o-mini' })
    expect(missing.hasCredentials).toBe(false)
    expect(missing.credentialsReference).toContain('fast-llm')
    expect(missing.credentialHint).toContain('pluton provider key fast-llm')

    writeProviderCredential(root, 'fast-llm', 'test-key')
    const present = resolveExecutionRoute({ rootDir: root, model: 'fast-llm/gpt-4o-mini' })
    expect(present.hasCredentials).toBe(true)
  })

  it('strips the composite provider prefix for the provider API', () => {
    const root = setup()
    saveProvider(root, FAST_LLM)

    const route = resolveExecutionRoute({ rootDir: root, model: 'fast-llm/gpt-4o-mini' })

    expect(route.identity.modelId).toBe('fast-llm/gpt-4o-mini')
    expect(route.providerModelId).toBe('gpt-4o-mini')
  })

  it('keeps a provider-local model unprefixed when the provider is explicit', () => {
    const root = setup()
    saveProvider(root, FAST_LLM)

    const route = resolveExecutionRoute({
      rootDir: root,
      model: 'gpt-4o-mini',
      providerId: 'fast-llm',
    })

    expect(route.providerModelId).toBe('gpt-4o-mini')
  })

  it('lets a built-in model prefix win over an inherited provider hint', () => {
    const root = setup()
    saveProvider(root, FAST_LLM)

    const opencode = resolveExecutionRoute({
      rootDir: root,
      model: 'opencode/deepseek-v4.1-flash-free',
      providerId: 'fast-llm',
      engineKind: 'openai-compatible',
    })
    expect(opencode.identity.engineKind).toBe('opencode')
    expect(opencode.identity.providerId).toBe('opencode')
    expect(opencode.provider).toBeNull()
    expect(opencode.providerModelId).toBe('opencode/deepseek-v4.1-flash-free')

    const mock = resolveExecutionRoute({
      rootDir: root,
      model: 'mock/model-a',
      providerId: 'fast-llm',
      engineKind: 'openai-compatible',
    })
    expect(mock.identity.engineKind).toBe('mock')
    expect(mock.identity.providerId).toBe('mock')
    expect(mock.provider).toBeNull()
  })

  it('auto-imports an unknown provider prefix from the OpenCode config', () => {
    const root = setup()
    const configPath = join(root, 'opencode.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: {
          '9router': {
            npm: '@ai-sdk/openai-compatible',
            options: {
              baseURL: 'http://127.0.0.1:20128/v1',
              apiKey: 'router-key-never-log',
            },
            models: { 'ag/gemini-3.8-flash-high': {} },
          },
        },
      }),
    )

    const route = resolveExecutionRoute({
      rootDir: root,
      model: '9router/ag/gemini-3.8-flash-high',
      opencodeConfigPaths: [configPath],
    })

    expect(route.identity).toEqual({
      engineKind: 'openai-compatible',
      providerId: '9router',
      modelId: '9router/ag/gemini-3.8-flash-high',
    })
    expect(route.providerModelId).toBe('ag/gemini-3.8-flash-high')
    expect(route.hasCredentials).toBe(true)
    expect(route.adapter.kind).toBe('openai-compatible')
  })

  it('explains an unknown model provider instead of handing it to OpenCode', () => {
    const root = setup()

    expect(() =>
      resolveExecutionRoute({ rootDir: root, model: 'unknown-router/model-a' }),
    ).toThrow(/no provider 'unknown-router' configured/)
    expect(() =>
      resolveExecutionRoute({ rootDir: root, model: 'unknown-router/model-a' }),
    ).toThrow(/pluton provider import/)
  })
})
