import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getProvider,
  providerRegistryPath,
  readProviderCredential,
} from '../../src/providers/store.ts'
import { importOpenCodeProviders } from '../../src/providers/opencode-import.ts'

const SECRET = 'opencode-import-secret-never-log'
const SECOND_SECRET = 'opencode-import-second-secret-never-log'

let root: string
let configPath: string

function writeConfig(value: unknown, file = 'opencode.json'): string {
  const path = join(root, file)
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8')
  return path
}

function configWithKey(apiKey: string): unknown {
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      '9router': {
        npm: '@ai-sdk/openai-compatible',
        name: '9Router',
        options: {
          baseURL: 'http://127.0.0.1:20128/v1',
          apiKey,
        },
        models: {
          'ag/gemini-3.8-flash-high': { name: 'Gemini 3.8 Flash High' },
          'ag/claude-opus-4-6-thinking': {},
        },
      },
    },
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pluton-opencode-import-'))
  configPath = join(root, 'opencode.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('importOpenCodeProviders', () => {
  it('imports an OpenAI-compatible provider and its models without storing the key in providers.json', () => {
    writeConfig(configWithKey(SECRET))

    const report = importOpenCodeProviders(root, { configPaths: [configPath] })

    expect(report.imported.map((entry) => entry.id)).toEqual(['9router'])
    const provider = getProvider(root, '9router')
    expect(provider).toMatchObject({
      id: '9router',
      engine: 'openai-compatible',
      display_name: '9Router',
      base_url: 'http://127.0.0.1:20128/v1',
      auth: { style: 'bearer' },
      models: ['ag/gemini-3.8-flash-high', 'ag/claude-opus-4-6-thinking'],
    })
    expect(readProviderCredential(root, '9router')).toBe(SECRET)

    const registry = readFileSync(providerRegistryPath(root), 'utf8')
    expect(registry).not.toContain(SECRET)
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  it('supports the legacy providers/package/settings shape and the aisdk: package prefix', () => {
    configPath = writeConfig({
      providers: {
        'legacy-router': {
          package: 'aisdk:@ai-sdk/openai-compatible',
          settings: {
            baseUrl: 'https://api.example.test/v1',
            apiKey: SECOND_SECRET,
          },
          models: ['vendor/model-a'],
        },
      },
    })

    const report = importOpenCodeProviders(root, { configPaths: [configPath] })

    expect(report.imported.map((entry) => entry.id)).toEqual(['legacy-router'])
    expect(getProvider(root, 'legacy-router')).toMatchObject({
      base_url: 'https://api.example.test/v1',
      models: ['vendor/model-a'],
    })
    expect(readProviderCredential(root, 'legacy-router')).toBe(SECOND_SECRET)
  })

  it('parses JSONC comments and trailing commas', () => {
    configPath = writeConfig(
      `{
  // local router
  "provider": {
    "9router": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:20128/v1", "apiKey": "${SECRET}" },
      "models": { "ag/model": {} },
    },
  },
}`,
      'opencode.jsonc',
    )

    const report = importOpenCodeProviders(root, { configPaths: [configPath] })

    expect(report.imported.map((entry) => entry.id)).toEqual(['9router'])
    expect(getProvider(root, '9router')?.models).toEqual(['ag/model'])
  })

  it('is idempotent and never overwrites an existing PLUTON credential', () => {
    writeConfig(configWithKey(SECRET))
    importOpenCodeProviders(root, { configPaths: [configPath] })

    writeConfig(configWithKey(SECOND_SECRET))
    const second = importOpenCodeProviders(root, { configPaths: [configPath] })

    expect(second.imported).toEqual([])
    expect(second.skipped.map((entry) => entry.id)).toEqual(['9router'])
    expect(readProviderCredential(root, '9router')).toBe(SECRET)
  })

  it('ignores providers that are not OpenAI-compatible and reports one bad entry without aborting the rest', () => {
    configPath = writeConfig({
      provider: {
        anthropic: {
          npm: '@ai-sdk/anthropic',
          options: { apiKey: SECOND_SECRET },
        },
        'bad-url': {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://not-loopback.example.test/v1', apiKey: SECOND_SECRET },
        },
        '9router': {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:20128/v1', apiKey: SECRET },
          models: { 'ag/model': {} },
        },
      },
    })

    const report = importOpenCodeProviders(root, { configPaths: [configPath] })

    expect(report.imported.map((entry) => entry.id)).toEqual(['9router'])
    expect(report.failed.map((entry) => entry.id)).toEqual(['bad-url'])
    expect(report.skipped.map((entry) => entry.id)).toContain('anthropic')
    expect(getProvider(root, 'anthropic')).toBeNull()
  })

  it('does nothing when no OpenCode config exists', () => {
    const report = importOpenCodeProviders(root, {
      configPaths: [join(root, 'missing.json')],
    })
    expect(report.imported).toEqual([])
    expect(existsSync(providerRegistryPath(root))).toBe(false)
  })
})
