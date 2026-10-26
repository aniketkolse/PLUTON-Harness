import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'

const tmpDirs: string[] = []

const TEST_CONFIG = `version: 1
project:
  name: spa-inbox-test
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
    engine: mock
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
  const root = mkdtempSync(join(tmpdir(), 'pluton-spa-inbox-it-'))
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

describe('SPA Inbox UI', () => {
  it('supports sending prompts while busy and presents queued badge', async () => {
    const { appServer } = setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()
      const css = await (await fetch(`http://127.0.0.1:${server.port}/app.css`)).text()

      // Checks for queue badge and non-blocking composer handling
      expect(js).toContain('queueLength')
      expect(js).toContain('status === \'enqueued\'')
      expect(css).toContain('queue-badge')
    } finally {
      await server.close()
    }
  })
})
