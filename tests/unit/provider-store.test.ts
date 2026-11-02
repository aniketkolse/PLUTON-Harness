import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, ValidationError } from '../../src/domain/errors.ts'
import {
  credentialHint,
  getProvider,
  hasProviderCredential,
  listProviders,
  loadProviderRegistry,
  providerCredentialPath,
  providerHomeDir,
  providerRegistryPath,
  readProviderCredential,
  removeProvider,
  removeProviderCredential,
  resolveProviderForEngine,
  saveProvider,
  writeProviderCredential,
} from '../../src/providers/store.ts'
import { providerConfigSchema, type ProviderConfig } from '../../src/providers/types.ts'

let root: string

function provider(id = 'alpha', overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return providerConfigSchema.parse({
    id,
    engine: 'openai-compatible',
    display_name: `Provider ${id}`,
    base_url: 'https://api.example.test/v1',
    auth: { style: 'bearer' },
    ...overrides,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pluton-provider-store-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('provider metadata store', () => {
  it('starts empty when no providers.json exists', () => {
    expect(loadProviderRegistry(root)).toEqual({ version: 1, providers: {} })
    expect(listProviders(root)).toEqual([])
    expect(getProvider(root, 'missing')).toBeNull()
  })

  it('round-trips metadata and never stores a credential value', () => {
    const config = provider()
    saveProvider(root, config)

    expect(getProvider(root, 'alpha')).toEqual(config)
    expect(listProviders(root).map((p) => p.id)).toEqual(['alpha'])
    const raw = readFileSync(providerRegistryPath(root), 'utf8')
    expect(raw).not.toMatch(/api[_-]?key|secret|bearer [a-z0-9]/i)
    expect(JSON.parse(raw)).toMatchObject({ version: 1, providers: { alpha: { id: 'alpha' } } })
  })

  it('rejects malformed registries with the file path, not file contents', () => {
    saveProvider(root, provider())
    const path = providerRegistryPath(root)
    writeFileSync(path, '{"version":1,"providers":{"alpha":{"id":"alpha"}}}')
    expect(() => loadProviderRegistry(root)).toThrowError(ConfigError)
    expect(() => loadProviderRegistry(root)).toThrowError(path)
    try {
      loadProviderRegistry(root)
    } catch (err) {
      expect(String(err)).not.toContain('api_key')
    }
  })

  it('rejects a provider id that does not match its registry key', () => {
    saveProvider(root, provider())
    const path = providerRegistryPath(root)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { providers: Record<string, unknown> }
    raw.providers['renamed'] = raw.providers['alpha']
    writeFileSync(path, JSON.stringify(raw))
    expect(() => loadProviderRegistry(root)).toThrowError(/id must match/i)
  })

  it('rejects a second provider with the same engine id when resolution is ambiguous', () => {
    saveProvider(root, provider('alpha'))
    expect(resolveProviderForEngine(root, 'openai-compatible').id).toBe('alpha')
    saveProvider(root, provider('beta'))

    expect(() => resolveProviderForEngine(root, 'openai-compatible')).toThrowError(ConfigError)
    expect(() => resolveProviderForEngine(root, 'openai-compatible')).toThrowError(/ambiguous/)
    expect(resolveProviderForEngine(root, 'openai-compatible', 'beta').id).toBe('beta')
  })

  it('reports a missing named provider explicitly', () => {
    expect(() => resolveProviderForEngine(root, 'openai-compatible', 'missing')).toThrowError(ValidationError)
  })

  it('removes metadata and the provider home together', () => {
    saveProvider(root, provider())
    writeProviderCredential(root, 'alpha', 'test-key-value')
    expect(existsSync(providerHomeDir(root, 'alpha'))).toBe(true)

    expect(removeProvider(root, 'alpha')).toBe(true)
    expect(removeProvider(root, 'alpha')).toBe(false)
    expect(getProvider(root, 'alpha')).toBeNull()
    expect(existsSync(providerHomeDir(root, 'alpha'))).toBe(false)
  })
})

describe('provider credential store', () => {
  it('writes and reads a credential without touching providers.json', () => {
    saveProvider(root, provider())
    writeProviderCredential(root, 'alpha', 'test-key-value')

    expect(readProviderCredential(root, 'alpha')).toBe('test-key-value')
    expect(hasProviderCredential(root, 'alpha')).toBe(true)
    expect(readFileSync(providerRegistryPath(root), 'utf8')).not.toContain('test-key-value')
    const credential = readFileSync(providerCredentialPath(root, 'alpha'), 'utf8')
    expect(JSON.parse(credential)).toEqual({ version: 1, api_key: 'test-key-value' })
  })

  it('uses owner-only permissions for the directory and file', () => {
    writeProviderCredential(root, 'alpha', 'test-key-value')
    if (process.platform !== 'win32') {
      expect(statSync(providerHomeDir(root, 'alpha')).mode & 0o777).toBe(0o700)
      expect(statSync(providerCredentialPath(root, 'alpha')).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects empty, multiline, and oversized credentials', () => {
    for (const bad of ['', '   ', 'line1\nline2', 'key\tvalue', 'x'.repeat(16_385)]) {
      expect(() => writeProviderCredential(root, 'alpha', bad)).toThrowError(ValidationError)
    }
    expect(hasProviderCredential(root, 'alpha')).toBe(false)
  })

  it('refuses to read a malformed credential and never echoes its contents', () => {
    saveProvider(root, provider())
    writeFileSync(providerCredentialPath(root, 'alpha'), '{"version":1,"api_key":""}')
    expect(() => readProviderCredential(root, 'alpha')).toThrowError(ConfigError)
    try {
      readProviderCredential(root, 'alpha')
    } catch (err) {
      expect(String(err)).not.toContain('api_key')
    }
  })

  it('removes a credential idempotently', () => {
    writeProviderCredential(root, 'alpha', 'test-key-value')
    expect(removeProviderCredential(root, 'alpha')).toBe(true)
    expect(removeProviderCredential(root, 'alpha')).toBe(false)
    expect(readProviderCredential(root, 'alpha')).toBeNull()
  })

  it('provides a setup hint that contains no secret', () => {
    expect(credentialHint('alpha')).toContain('pluton provider key alpha')
    expect(credentialHint('alpha')).not.toMatch(/sk-/)
  })
})

describe('provider config validation', () => {
  it('accepts bearer and custom-header auth styles', () => {
    expect(providerConfigSchema.parse(provider())).toMatchObject({ auth: { style: 'bearer' } })
    expect(
      providerConfigSchema.parse(provider('header', { auth: { style: 'header', header: 'x-api-key' } })),
    ).toMatchObject({ auth: { style: 'header', header: 'x-api-key' } })
  })

  it('rejects header auth without a header name', () => {
    expect(() =>
      providerConfigSchema.parse(provider('bad', { auth: { style: 'header' } as ProviderConfig['auth'] })),
    ).toThrow()
  })

  it('rejects credential-bearing and plaintext non-loopback base URLs', () => {
    for (const baseUrl of [
      'https://user:pass@api.example.test/v1',
      'http://api.example.test/v1',
      'ftp://api.example.test/v1',
    ]) {
      expect(() => providerConfigSchema.parse(provider('bad', { base_url: baseUrl }))).toThrow()
    }
  })

  it('allows plaintext loopback URLs for local gateways', () => {
    expect(
      providerConfigSchema.parse(provider('local', { base_url: 'http://127.0.0.1:11434/v1' })).id,
    ).toBe('local')
    expect(
      providerConfigSchema.parse(provider('local6', { base_url: 'http://[::1]:11434/v1' })).id,
    ).toBe('local6')
  })

  it('rejects header injection in custom headers', () => {
    expect(() =>
      providerConfigSchema.parse(provider('bad', { headers: { 'x-ok': 'value\r\nx-evil: 1' } })),
    ).toThrow()
  })

  it('rejects unknown fields instead of silently ignoring them', () => {
    expect(() =>
      providerConfigSchema.parse({ ...provider('bad'), api_key: 'test-key-value' }),
    ).toThrow()
  })

  it('does not allow a credential to be placed in the provider id', () => {
    expect(() => providerConfigSchema.parse(provider('sk-test-key-value'))).toThrow()
  })
})

// A credential file can be replaced by the operator; chmod is only a
// best-effort hardening on Windows, so the test above asserts POSIX modes only.
describe('credential file replacement', () => {
  it('replaces an existing credential atomically', () => {
    writeProviderCredential(root, 'alpha', 'first-key-value')
    writeProviderCredential(root, 'alpha', 'second-key-value')
    expect(readProviderCredential(root, 'alpha')).toBe('second-key-value')
  })

  it('does not leave a temp file behind', () => {
    writeProviderCredential(root, 'alpha', 'first-key-value')
    const home = providerHomeDir(root, 'alpha')
    const files = readdirSync(home)
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([])
  })
})
