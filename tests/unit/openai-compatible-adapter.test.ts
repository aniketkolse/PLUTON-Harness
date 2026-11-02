import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CapabilityError,
  ConfigError,
  EngineAuthMissingError,
  ValidationError,
} from '../../src/domain/errors.ts'
import { OpenAICompatibleAdapter } from '../../src/engines/openai-compatible/adapter.ts'
import type { EngineEvent } from '../../src/engines/contract/types.ts'
import {
  saveProvider,
  writeProviderCredential,
} from '../../src/providers/store.ts'
import { providerConfigSchema } from '../../src/providers/types.ts'

const KEY = 'adapter-test-key-never-log'
let root: string

function configure(
  overrides: Record<string, unknown> = {},
  id = 'alpha',
): void {
  saveProvider(
    root,
    providerConfigSchema.parse({
      id,
      engine: 'openai-compatible',
      display_name: `Provider ${id}`,
      base_url: 'https://provider.example.test/v1',
      ...overrides,
    }),
  )
  writeProviderCredential(root, id, KEY)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pluton-provider-adapter-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('openai-compatible adapter capabilities and discovery', () => {
  it('declares exactly the capabilities it implements', () => {
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    expect(adapter.capabilities()).toEqual({
      resumeSession: false,
      interrupt: true,
      approvals: false,
      usage: true,
      modelList: true,
      mcpServers: true,
      sessionExport: false,
    })
  })

  it('reports a missing provider as not installed with a fix, without throwing', async () => {
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    const discovery = await adapter.discover()
    expect(discovery.installed).toBe(false)
    expect(discovery.binaryPath).toBeNull()
    expect(discovery.fix).toContain('pluton provider add')
  })

  it('reports an HTTP provider as installed without inventing a binary or version', async () => {
    configure()
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    const discovery = await adapter.discover()
    expect(discovery).toMatchObject({
      engineKind: 'openai-compatible',
      installed: true,
      binaryPath: null,
      version: null,
    })
    expect(discovery.fix).toContain('pluton provider key alpha')
  })

  it('fails discovery explicitly when two providers are configured without a Ship choice', async () => {
    configure({}, 'alpha')
    configure({}, 'beta')
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    await expect(adapter.discover()).rejects.toBeInstanceOf(ConfigError)
    await expect(adapter.discover()).rejects.toThrow(/ambiguous/i)
  })

  it('uses the explicitly selected provider when several exist', async () => {
    configure({ base_url: 'https://alpha.example.test/v1' }, 'alpha')
    configure({ base_url: 'https://beta.example.test/v1' }, 'beta')
    const adapter = new OpenAICompatibleAdapter({ rootDir: root, providerId: 'beta' })
    const discovery = await adapter.discover()
    expect(discovery.installed).toBe(true)
    expect(discovery.fix).toContain('beta')
  })
})

describe('openai-compatible adapter auth status', () => {
  it('reports credential presence only, with a non-secret setup hint', async () => {
    configure()
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    const status = await adapter.authStatus(join(root, '.pluton'))
    expect(status.configured).toBe(true)
    expect(status.hint).toContain('pluton provider key alpha')
    expect(status.hint).not.toContain(KEY)
  })

  it('reports a missing credential without throwing', async () => {
    saveProvider(
      root,
      providerConfigSchema.parse({
        id: 'alpha',
        engine: 'openai-compatible',
        display_name: 'Alpha',
        base_url: 'https://provider.example.test/v1',
      }),
    )
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    const status = await adapter.authStatus(join(root, '.pluton'))
    expect(status.configured).toBe(false)
    expect(status.hint).toContain('pluton provider key alpha')
  })
})

describe('openai-compatible adapter model discovery', () => {
  it('returns exact ids, marks the provider, and uses the configured auth style', async () => {
    configure({ auth: { style: 'header', header: 'x-api-key', prefix: 'Key ' } })
    const seen: Array<{ url: string; headers: Headers }> = []
    const adapter = new OpenAICompatibleAdapter({
      rootDir: root,
      fetchFn: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) })
        return jsonResponse({ data: [{ id: 'vendor/model-a' }, { id: 'vendor/model-b' }] })
      }) as typeof fetch,
    })
    const models = await adapter.listModels()
    expect(models).toEqual([
      { id: 'vendor/model-a', source: 'engine', provider: 'alpha' },
      { id: 'vendor/model-b', source: 'engine', provider: 'alpha' },
    ])
    expect(seen[0]?.url).toBe('https://provider.example.test/v1/models')
    expect(seen[0]?.headers.get('x-api-key')).toBe(`Key ${KEY}`)
    expect(seen[0]?.headers.get('authorization')).toBeNull()
  })

  it('fails model discovery when the credential is missing', async () => {
    saveProvider(
      root,
      providerConfigSchema.parse({
        id: 'alpha',
        engine: 'openai-compatible',
        display_name: 'Alpha',
        base_url: 'https://provider.example.test/v1',
      }),
    )
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    await expect(adapter.listModels()).rejects.toBeInstanceOf(EngineAuthMissingError)
  })

  it('never echoes a rejected credential in a model-discovery error', async () => {
    configure()
    const adapter = new OpenAICompatibleAdapter({
      rootDir: root,
      fetchFn: (async () => new Response(`bad ${KEY}`, { status: 401 })) as typeof fetch,
    })
    try {
      await adapter.listModels()
      expect.unreachable('expected listModels to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(EngineAuthMissingError)
      expect(String(err)).not.toContain(KEY)
      expect(JSON.stringify(err)).not.toContain(KEY)
    }
  })

  it('reports availability per requested candidate without a hardcoded catalog', async () => {
    configure()
    const adapter = new OpenAICompatibleAdapter({
      rootDir: root,
      fetchFn: (async () =>
        jsonResponse({ data: [{ id: 'vendor/model-a' }] })) as typeof fetch,
    })
    const availability = await adapter.listModelsWithAvailability([
      'vendor/model-a',
      'vendor/model-missing',
    ])
    expect(availability).toEqual([
      { id: 'vendor/model-a', available: true, label: 'vendor/model-a', source: 'engine' },
      {
        id: 'vendor/model-missing',
        available: false,
        reason: 'not reported by provider alpha',
        source: 'engine',
      },
    ])
  })

  it('marks every candidate unavailable when discovery fails, without substituting a catalog', async () => {
    configure()
    const adapter = new OpenAICompatibleAdapter({
      rootDir: root,
      fetchFn: (async () => new Response('down', { status: 503 })) as typeof fetch,
    })
    const availability = await adapter.listModelsWithAvailability(['vendor/model-a'])
    expect(availability).toHaveLength(1)
    expect(availability[0]).toMatchObject({ id: 'vendor/model-a', available: false })
    expect(availability[0]?.reason).toContain('503')
  })
})

describe('openai-compatible adapter startSession validation', () => {
  const validRequest = {
    ship: { id: 'ship-1', slug: 'ship-1', role: 'coder', model: 'vendor/model-a' },
    workdir: root,
    env: {},
    configDir: root,
  }

  it('refuses resume tokens because resume is not implemented', async () => {
    configure()
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    await expect(
      adapter.startSession({ ...validRequest, resumeToken: 'previous' }),
    ).rejects.toBeInstanceOf(CapabilityError)
  })

  it('refuses stdio MCP servers explicitly', async () => {
    configure()
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    await expect(
      adapter.startSession({
        ...validRequest,
        mcpServers: [{ kind: 'stdio', name: 'pluton', command: ['pluton', 'mcp'] }],
      }),
    ).rejects.toBeInstanceOf(CapabilityError)
  })

  it('refuses more than one MCP server instead of silently dropping one', async () => {
    configure()
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    await expect(
      adapter.startSession({
        ...validRequest,
        mcpServers: [
          { kind: 'http', name: 'a', url: 'http://127.0.0.1:1/a' },
          { kind: 'http', name: 'b', url: 'http://127.0.0.1:2/b' },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('requires an exact model id', async () => {
    configure()
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    await expect(
      adapter.startSession({
        ...validRequest,
        ship: { id: 'ship-1', slug: 'ship-1', role: 'coder', model: '' },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('requires a configured provider', async () => {
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    await expect(adapter.startSession(validRequest)).rejects.toBeInstanceOf(ConfigError)
  })

  it('requires a credential and never includes it in the error', async () => {
    saveProvider(
      root,
      providerConfigSchema.parse({
        id: 'alpha',
        engine: 'openai-compatible',
        display_name: 'Alpha',
        base_url: 'https://provider.example.test/v1',
      }),
    )
    const adapter = new OpenAICompatibleAdapter({ rootDir: root })
    try {
      await adapter.startSession(validRequest)
      expect.unreachable('expected startSession to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(EngineAuthMissingError)
      expect(String(err)).not.toContain(KEY)
    }
  })

  it('returns a working session that streams through the adapter client', async () => {
    configure()
    const adapter = new OpenAICompatibleAdapter({
      rootDir: root,
      fetchFn: (async (input: Parameters<typeof fetch>[0]) =>
        String(input).endsWith('/models')
          ? jsonResponse({ data: [{ id: 'vendor/model-a' }] })
          : sseResponse([
              'data: {"choices":[{"delta":{"content":"from provider"}}]}\n\n',
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
              'data: [DONE]\n\n',
            ])) as typeof fetch,
    })
    const session = await adapter.startSession(validRequest)
    const events = await collect(session.sendPrompt({ text: 'hello' }))
    expect(events).toContainEqual({ kind: 'text', text: 'from provider' })
    expect(events[events.length - 1]).toEqual({ kind: 'result', outcome: 'success' })
    await session.close()
  })
})
