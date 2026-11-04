import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getConnection,
  listConnections,
  readConnectionCredential,
  removeConnection,
  saveConnection,
  writeConnectionCredential,
} from '../../src/providers/store.ts'
import { type ConnectionConfig } from '../../src/providers/types.ts'
import { validateEndpointUrl } from '../../src/providers/validation.ts'

let root: string

function connection(
  id = 'conn-work-openrouter',
  overrides: Partial<ConnectionConfig> = {},
): ConnectionConfig {
  return {
    id,
    providerId: 'openrouter',
    displayName: 'OpenRouter Work',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai-compatible',
    auth: { style: 'bearer' },
    ...overrides,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pluton-provider-conn-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('endpoint SSRF and protocol validation', () => {
  it('accepts valid https URLs and loopback http URLs', () => {
    expect(validateEndpointUrl('https://api.openai.com/v1')).toEqual({ ok: true })
    expect(validateEndpointUrl('https://openrouter.ai/api/v1')).toEqual({ ok: true })
    expect(validateEndpointUrl('http://127.0.0.1:20128/v1')).toEqual({ ok: true })
    expect(validateEndpointUrl('http://localhost:11434/v1')).toEqual({ ok: true })
    expect(validateEndpointUrl('http://[::1]:8080/v1')).toEqual({ ok: true })
  })

  it('rejects cloud metadata and link-local addresses', () => {
    expect(validateEndpointUrl('http://169.254.169.254/latest/meta-data')).toEqual({
      ok: false,
      reason: expect.stringMatching(/cloud metadata|link-local|private/i),
    })
    expect(validateEndpointUrl('http://169.254.1.1/v1')).toEqual({
      ok: false,
      reason: expect.stringMatching(/link-local|private/i),
    })
  })

  it('rejects plain http for non-loopback domains', () => {
    const res = validateEndpointUrl('http://api.insecure.example.com/v1')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/https required|loopback/i)
  })

  it('rejects non-http protocols and malformed URLs', () => {
    expect(validateEndpointUrl('file:///etc/passwd').ok).toBe(false)
    expect(validateEndpointUrl('ftp://example.com/v1').ok).toBe(false)
    expect(validateEndpointUrl('not-a-valid-url').ok).toBe(false)
    expect(validateEndpointUrl('https://user:pass@api.example.com/v1').ok).toBe(false)
  })
})

describe('multi-connection management and storage', () => {
  it('stores multiple independent connections for the same provider family', () => {
    const conn1 = connection('conn-work-openrouter', {
      providerId: 'openrouter',
      displayName: 'Work OpenRouter',
    })
    const conn2 = connection('conn-personal-openrouter', {
      providerId: 'openrouter',
      displayName: 'Personal OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    })

    saveConnection(root, conn1)
    saveConnection(root, conn2)

    const list = listConnections(root)
    expect(list.map((c) => c.id).sort()).toEqual([
      'conn-personal-openrouter',
      'conn-work-openrouter',
    ])

    expect(getConnection(root, 'conn-work-openrouter')).toMatchObject({
      id: 'conn-work-openrouter',
      providerId: 'openrouter',
      displayName: 'Work OpenRouter',
    })
    expect(getConnection(root, 'conn-personal-openrouter')).toMatchObject({
      id: 'conn-personal-openrouter',
      providerId: 'openrouter',
      displayName: 'Personal OpenRouter',
    })
  })

  it('isolates credentials per connection id', () => {
    const conn1 = connection('conn-work-openrouter')
    const conn2 = connection('conn-personal-openrouter')
    saveConnection(root, conn1)
    saveConnection(root, conn2)

    writeConnectionCredential(root, conn1.id, 'sk-work-secret-12345')
    writeConnectionCredential(root, conn2.id, 'sk-personal-secret-67890')

    expect(readConnectionCredential(root, conn1.id)).toBe('sk-work-secret-12345')
    expect(readConnectionCredential(root, conn2.id)).toBe('sk-personal-secret-67890')

    removeConnection(root, conn1.id)
    expect(getConnection(root, conn1.id)).toBeNull()
    expect(readConnectionCredential(root, conn1.id)).toBeNull()
    expect(getConnection(root, conn2.id)).not.toBeNull()
    expect(readConnectionCredential(root, conn2.id)).toBe('sk-personal-secret-67890')
  })

  it('reads legacy single-provider entries in providers.json with backward compatibility', () => {
    const legacyPath = join(root, '.pluton', 'providers.json')
    mkdirSync(join(root, '.pluton'), { recursive: true })
    writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          version: 1,
          providers: {
            'legacy-9router': {
              id: 'legacy-9router',
              engine: 'openai-compatible',
              display_name: '9Router Gateway',
              base_url: 'http://127.0.0.1:20128/v1',
              auth: { style: 'bearer' },
              models: ['llama-3.3-70b-instruct'],
            },
          },
        },
        null,
        2,
      ),
    )

    const list = listConnections(root)
    expect(list.length).toBe(1)
    const migrated = list[0]!
    expect(migrated.id).toBe('legacy-9router')
    expect(migrated.providerId).toBe('openai-compatible')
    expect(migrated.displayName).toBe('9Router Gateway')
    expect(migrated.baseUrl).toBe('http://127.0.0.1:20128/v1')
    expect(migrated.models).toEqual(['llama-3.3-70b-instruct'])

    const direct = getConnection(root, 'legacy-9router')
    expect(direct).not.toBeNull()
    expect(direct?.id).toBe('legacy-9router')
  })
})
