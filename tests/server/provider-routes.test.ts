import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'

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
  name: provider-routes-test
  repository: .
  default_branch: main
  verification: []
ships:
  supervisor:
    display_name: Supervisor
    role: supervisor
    engine: mock
    model: mock/test
    workspace_policy: coordinator-read-only
`

async function setupServer(): Promise<{
  rootDir: string
  server: AppServerInstance
  fetchApi: (path: string, init?: RequestInit) => Promise<Response>
  cleanup: () => Promise<void>
}> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-prov-routes-')))
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

  return { rootDir: root, server, fetchApi, cleanup }
}

describe('Provider REST API routes', () => {
  it('manages provider lifecycle via REST endpoints', async () => {
    const { server: _server, fetchApi, cleanup } = await setupServer()
    try {
      // 1. Initial list is empty
      const listRes1 = await fetchApi('/api/providers')
      expect(listRes1.status).toBe(200)
      const listData1 = (await listRes1.json()) as { ok: boolean; providers: unknown[] }
      expect(listData1.ok).toBe(true)
      expect(listData1.providers).toEqual([])

      // 2. Add provider with API key
      const addRes = await fetchApi('/api/providers', {
        method: 'POST',
        body: JSON.stringify({
          id: 'test-llm',
          engine: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          displayName: 'Test LLM',
          apiKey: 'super-secret-key-123',
        }),
      })
      expect(addRes.status).toBe(200)
      const addData = (await addRes.json()) as {
        ok: boolean
        provider: Record<string, unknown>
      }
      expect(addData.ok).toBe(true)
      expect(addData.provider.id).toBe('test-llm')
      expect(addData.provider.base_url).toBe('https://api.example.com/v1')
      // Crucial: Secret must never be in returned JSON
      expect(JSON.stringify(addData)).not.toContain('super-secret-key-123')

      // 3. List shows provider with hasCredential: true
      const listRes2 = await fetchApi('/api/providers')
      const listData2 = (await listRes2.json()) as {
        ok: boolean
        providers: Array<{ id: string; hasCredential: boolean }>
      }
      expect(listData2.ok).toBe(true)
      expect(listData2.providers).toHaveLength(1)
      expect(listData2.providers[0]?.id).toBe('test-llm')
      expect(listData2.providers[0]?.hasCredential).toBe(true)
      expect(JSON.stringify(listData2)).not.toContain('super-secret-key-123')

      // 4. Update key
      const keyRes = await fetchApi('/api/providers/test-llm/key', {
        method: 'POST',
        body: JSON.stringify({ apiKey: 'new-key-456' }),
      })
      expect(keyRes.status).toBe(200)
      const keyData = (await keyRes.json()) as { ok: boolean; configured: boolean }
      expect(keyData.ok).toBe(true)
      expect(keyData.configured).toBe(true)

      // 5. Remove key
      const delKeyRes = await fetchApi('/api/providers/test-llm/key', {
        method: 'DELETE',
      })
      expect(delKeyRes.status).toBe(200)
      const delKeyData = (await delKeyRes.json()) as { ok: boolean; removed: boolean }
      expect(delKeyData.ok).toBe(true)
      expect(delKeyData.removed).toBe(true)

      // 6. List now shows hasCredential: false
      const listRes3 = await fetchApi('/api/providers')
      const listData3 = (await listRes3.json()) as {
        ok: boolean
        providers: Array<{ id: string; hasCredential: boolean }>
      }
      expect(listData3.providers[0]?.hasCredential).toBe(false)

      // 7. Validate provider (without key)
      const valRes = await fetchApi('/api/providers/test-llm/validate', {
        method: 'POST',
      })
      expect(valRes.status).toBe(200)
      const valData = (await valRes.json()) as {
        ok: boolean
        report: { id: string; hasCredential: boolean; liveCheck: string }
      }
      expect(valData.ok).toBe(true)
      expect(valData.report.id).toBe('test-llm')
      expect(valData.report.hasCredential).toBe(false)
      expect(valData.report.liveCheck).toBe('not-attempted')

      // 8. Delete provider
      const delRes = await fetchApi('/api/providers/test-llm', {
        method: 'DELETE',
      })
      expect(delRes.status).toBe(200)
      const delData = (await delRes.json()) as { ok: boolean; removed: boolean }
      expect(delData.ok).toBe(true)
      expect(delData.removed).toBe(true)

      // 9. List is empty again
      const listRes4 = await fetchApi('/api/providers')
      const listData4 = (await listRes4.json()) as { ok: boolean; providers: unknown[] }
      expect(listData4.providers).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('rejects adding invalid provider id or malformed payload', async () => {
    const { server: _server, fetchApi, cleanup } = await setupServer()
    try {
      const badIdRes = await fetchApi('/api/providers', {
        method: 'POST',
        body: JSON.stringify({
          id: 'sk-invalid-id',
          engine: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
        }),
      })
      expect(badIdRes.status).toBe(400)
      const data = (await badIdRes.json()) as { ok: boolean; error: string }
      expect(data.ok).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
