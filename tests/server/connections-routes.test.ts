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
      // Windows lock cleanup
    }
  }
})

const TEST_CONFIG = `version: 1
project:
  name: connection-routes-test
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
  worker:
    display_name: Worker
    role: coder
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-conn-routes-')))
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

describe('Connection REST API routes (Multi-Connection Management)', () => {
  it('creates, lists, validates, registers manual model, and deletes a connection', async () => {
    const { fetchApi, cleanup } = await setupServer()
    try {
      // 1. Initial list of connections is empty
      const listRes1 = await fetchApi('/api/connections')
      expect(listRes1.status).toBe(200)
      const listData1 = (await listRes1.json()) as { ok: boolean; connections: unknown[] }
      expect(listData1.ok).toBe(true)
      expect(listData1.connections).toEqual([])

      // 2. Create connection with API key
      const createRes = await fetchApi('/api/connections', {
        method: 'POST',
        body: JSON.stringify({
          id: 'openrouter-prod',
          providerId: 'openrouter',
          displayName: 'OpenRouter Production',
          baseUrl: 'http://127.0.0.1:20128/v1',
          protocol: 'openai-compatible',
          apiKey: 'sk-or-test-secret-key',
        }),
      })
      expect(createRes.status).toBe(200)
      const createData = (await createRes.json()) as {
        ok: boolean
        connection: Record<string, unknown>
      }
      expect(createData.ok).toBe(true)
      expect(createData.connection.id).toBe('openrouter-prod')
      expect(createData.connection.baseUrl).toBe('http://127.0.0.1:20128/v1')
      // Secret must never leak in response JSON
      expect(JSON.stringify(createData)).not.toContain('sk-or-test-secret-key')

      // 3. List shows connection with hasCredential: true
      const listRes2 = await fetchApi('/api/connections')
      const listData2 = (await listRes2.json()) as {
        ok: boolean
        connections: Array<{ id: string; hasCredential: boolean }>
      }
      expect(listData2.ok).toBe(true)
      expect(listData2.connections).toHaveLength(1)
      expect(listData2.connections[0]?.id).toBe('openrouter-prod')
      expect(listData2.connections[0]?.hasCredential).toBe(true)

      // 4. Validate connection endpoint
      const validateRes = await fetchApi('/api/connections/openrouter-prod/validate', {
        method: 'POST',
      })
      expect(validateRes.status).toBe(200)
      const validateData = (await validateRes.json()) as {
        ok: boolean
        report: { id: string; hasCredential: boolean }
      }
      expect(validateData.ok).toBe(true)
      expect(validateData.report.id).toBe('openrouter-prod')
      expect(validateData.report.hasCredential).toBe(true)

      // 5. Register manual model on connection
      const registerRes = await fetchApi('/api/connections/openrouter-prod/models', {
        method: 'POST',
        body: JSON.stringify({
          modelId: 'nvidia/nemotron-4-340b-instruct',
          displayName: 'Nemotron 340B',
          capabilities: {
            toolCalling: true,
            contextWindow: 128000,
            coding: true,
            reasoning: true,
          },
        }),
      })
      expect(registerRes.status).toBe(200)
      const registerData = (await registerRes.json()) as {
        ok: boolean
        model: { connectionId: string; modelId: string }
      }
      expect(registerData.ok).toBe(true)
      expect(registerData.model.connectionId).toBe('openrouter-prod')
      expect(registerData.model.modelId).toBe('nvidia/nemotron-4-340b-instruct')

      // 6. Switch ship's model to the external connection model without triggering OpenCode validation trap
      const switchRes = await fetchApi('/api/ships/worker/model', {
        method: 'POST',
        body: JSON.stringify({
          model: 'openrouter-prod:nvidia/nemotron-4-340b-instruct',
          engine: 'openai-compatible',
        }),
      })
      expect(switchRes.status).toBe(200)
      const switchData = (await switchRes.json()) as {
        ok: boolean
        ship: { model: string; engine: string }
      }
      expect(switchData.ok).toBe(true)
      expect(switchData.ship.model).toBe('openrouter-prod:nvidia/nemotron-4-340b-instruct')

      // 7. Delete connection
      const deleteRes = await fetchApi('/api/connections/openrouter-prod', {
        method: 'DELETE',
      })
      expect(deleteRes.status).toBe(200)
      const deleteData = (await deleteRes.json()) as { ok: boolean; removed: boolean }
      expect(deleteData.ok).toBe(true)
      expect(deleteData.removed).toBe(true)

      // 8. Confirm connection is removed
      const listRes3 = await fetchApi('/api/connections')
      const listData3 = (await listRes3.json()) as { ok: boolean; connections: unknown[] }
      expect(listData3.connections).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })
})
