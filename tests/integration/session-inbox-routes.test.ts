import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { registerEngine } from '../../src/engines/registry.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

registerEngine({
  kind: 'delayed-mock',
  description: 'delayed mock for concurrency test',
  devOnly: true,
  create: () => new MockEngineAdapter({ script: [{ text: 'done 1', delayMs: 150 }, { text: 'done 2', delayMs: 150 }] }),
})

const TEST_CONFIG = `version: 1
project:
  name: inbox-routes-test
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
    mode_by_platform:
      darwin: unconfined
      win32: unconfined
    acknowledge_unconfined: true
runtime:
  max_concurrent_workers: 2
  max_team_size: 4
  max_delegation_depth: 3
  max_child_tasks_per_task: 5
  max_tasks_per_run: 10
  max_run_minutes: 30
  default_task_minutes: 10
  default_cpu_limit: 2
  default_memory_mb: 2048
  max_retries_per_task: 1
  network_policy: open
  max_prompt_chars: 60000
  max_event_payload_chars: 8000
  max_tool_result_chars: 120000
  heartbeat_seconds: 30
muses:
  supervisor:
    display_name: Supervisor
    role: supervisor
    engine: delayed-mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
    permissions:
      - project.status
`

function setupTestProject(): {
  rootDir: string
  appServer: Promise<AppServerInstance>
} {
  const root = mkdtempSync(join(tmpdir(), 'pluton-inbox-it-'))
  tmpDirs.push(root)
  writeFileSync(join(root, 'pluton.yaml'), TEST_CONFIG, 'utf8')

  const loaded = loadConfig(root)
  const bootstrapped = bootstrapStore(loaded)

  const serverPromise = startAppServer({
    store: bootstrapped.store,
    projectId: bootstrapped.projectId,
    loaded,
  })

  return { rootDir: root, appServer: serverPromise }
}

describe('Session Inbox HTTP Routes', () => {
  it('accepts subsequent prompts with HTTP 202 instead of 409 when busy', async () => {
    const { appServer } = setupTestProject()
    const server = await appServer
    try {
      const headers = {
        'Content-Type': 'application/json',
        'x-pluton-token': server.token,
      }

      // Create session
      const createRes = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Inbox Route Test' }),
      })
      const createData = (await createRes.json()) as { session: { id: string } }
      expect(createRes.status).toBe(201)
      const session = createData.session

      // Send two prompts concurrently
      const [p1, p2] = await Promise.all([
        fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/prompt`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: 'Count to 5' }),
        }),
        fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/prompt`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: 'Count to 10' }),
        }),
      ])
      expect(p1.status).toBe(202)
      expect(p2.status).toBe(202)

      const [data1, data2] = (await Promise.all([p1.json(), p2.json()])) as [
        { ok: boolean; status: string },
        { ok: boolean; status: string },
      ]
      expect(data1.ok).toBe(true)
      expect(data2.ok).toBe(true)
      const statuses = [data1.status, data2.status]
      expect(statuses).toContain('streaming')
      expect(statuses).toContain('enqueued')

      // Check detail reflects busy and queue length
      const detailRes = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}`, {
        headers,
      })
      const detailData = (await detailRes.json()) as { session: { busy: boolean } }
      expect(detailData.session.busy).toBe(true)

      // Cancel turn and queue
      const cancelRes = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/cancel`, {
        method: 'POST',
        headers,
      })
      const cancelData = (await cancelRes.json()) as { ok: boolean; cancelled: boolean }
      expect(cancelData.ok).toBe(true)
      expect(cancelData.cancelled).toBe(true)
    } finally {
      await server.close()
    }
  })
})
