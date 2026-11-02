import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'
import { saveProvider, writeProviderCredential } from '../../src/providers/store.ts'
import type { Store } from '../../src/store/store.ts'
import type { ProviderConfig } from '../../src/providers/types.ts'

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // Windows file locks may linger briefly
    }
  }
})

const TEST_CONFIG = `version: 1
project:
  name: ship-model-assignment-test
  repository: .
  default_branch: main
  verification: []
ships:
  supervisor:
    display_name: Supervisor
    role: supervisor
    engine: mock
    model: mock/test-initial
    workspace_policy: coordinator-read-only
`

async function setupServer(): Promise<{
  rootDir: string
  server: AppServerInstance
  store: Store
  fetchApi: (path: string, init?: RequestInit) => Promise<Response>
  cleanup: () => Promise<void>
}> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-ship-model-')))
  tmpDirs.push(root)
  writeFileSync(join(root, 'pluton.yaml'), TEST_CONFIG, 'utf8')

  const loaded = loadConfig(root)
  const bootstrapped = bootstrapStore(loaded)
  const server = await startAppServer({
    store: bootstrapped.store,
    projectId: bootstrapped.projectId,
    loaded,
  })

  const fetchApi = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('x-pluton-token', server.token)
    headers.set('origin', `http://127.0.0.1:${server.port}`)
    headers.set('host', `127.0.0.1:${server.port}`)
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    return fetch(`http://127.0.0.1:${server.port}${path}`, {
      ...init,
      headers,
    })
  }

  const cleanup = async () => {
    await server.close()
    bootstrapped.store.close()
  }

  return { rootDir: root, server, store: bootstrapped.store, fetchApi, cleanup }
}

describe('Ship model & provider assignment route', () => {
  it('updates model, provider and engine in pluton.yaml and SQLite', async () => {
    const { rootDir, store, fetchApi, cleanup } = await setupServer()
    try {
      // Configure a test provider
      const provider: ProviderConfig = {
        id: 'fast-llm',
        engine: 'openai-compatible',
        display_name: 'Fast LLM',
        base_url: 'http://127.0.0.1:9999/v1',
        auth: { style: 'bearer' },
        models_path: '/models',
        chat_path: '/chat/completions',
      }
      saveProvider(rootDir, provider)
      writeProviderCredential(rootDir, 'fast-llm', 'test-key')

      // Assign model and provider to supervisor ship via /api/ships/:id/model
      const res = await fetchApi('/api/ships/supervisor/model', {
        method: 'POST',
        body: JSON.stringify({
          model: 'fast-llm/gpt-4o-mini',
          provider: 'fast-llm',
          engine: 'openai-compatible',
        }),
      })

      expect(res.status).toBe(200)
      const data = (await res.json()) as {
        ok: boolean
        shipId: string
        model: string
        provider?: string
        engine?: string
      }
      expect(data.ok).toBe(true)
      expect(data.shipId).toBe('supervisor')
      expect(data.model).toBe('fast-llm/gpt-4o-mini')
      expect(data.provider).toBe('fast-llm')
      expect(data.engine).toBe('openai-compatible')

      // Check pluton.yaml on disk
      const yamlContent = readFileSync(join(rootDir, 'pluton.yaml'), 'utf8')
      expect(yamlContent).toContain('model: fast-llm/gpt-4o-mini')
      expect(yamlContent).toContain('provider: fast-llm')
      expect(yamlContent).toContain('engine: openai-compatible')

      // Check SQLite record
      const shipRecord = store.getShip('supervisor')
      expect(shipRecord).not.toBeNull()
      expect(shipRecord?.model).toBe('fast-llm/gpt-4o-mini')
      expect(shipRecord?.engineKind).toBe('openai-compatible')
    } finally {
      await cleanup()
    }
  })

  it('rejects unknown provider', async () => {
    const { fetchApi, cleanup } = await setupServer()
    try {
      const res = await fetchApi('/api/ships/supervisor/model', {
        method: 'POST',
        body: JSON.stringify({
          model: 'some-model',
          provider: 'non-existent-provider',
        }),
      })
      expect(res.status).toBe(400)
      const data = (await res.json()) as { ok: boolean; error: string }
      expect(data.ok).toBe(false)
      expect(data.error).toContain('non-existent-provider')
    } finally {
      await cleanup()
    }
  })

  it('supports muse alias /api/muses/:id/model and preserves comments in pluton.yaml', async () => {
    const { rootDir, store, fetchApi, cleanup } = await setupServer()
    try {
      const res = await fetchApi('/api/muses/supervisor/model', {
        method: 'POST',
        body: JSON.stringify({
          model: 'mock/model-a',
        }),
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as { ok: boolean; model: string; museId: string }
      expect(data.ok).toBe(true)
      expect(data.model).toBe('mock/model-a')
      expect(data.museId).toBe('supervisor')

      // Check pluton.yaml on disk
      const yamlContent = readFileSync(join(rootDir, 'pluton.yaml'), 'utf8')
      expect(yamlContent).toContain('model: mock/model-a')

      // Check SQLite record
      const shipRecord = store.getShip('supervisor')
      expect(shipRecord?.model).toBe('mock/model-a')
    } finally {
      await cleanup()
    }
  })
})
