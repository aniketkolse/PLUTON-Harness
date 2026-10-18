import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appRun } from '../../src/cli/commands/app.ts'
import { readServerInstance } from '../../src/server/instance.ts'

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

const TEST_CONFIG = `version: 1
project:
  name: cli-app-it
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: local-process
  local_process_acknowledged: true
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
  network_policy: restricted
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
      - run.list
      - run.inspect
      - run.start
      - approvals.list
`

describe('pluton app CLI command lifecycle', () => {
  it('reports stopped status when no server is running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-app-it-'))
    tmpDirs.push(root)
    writeFileSync(join(root, 'pluton.yaml'), TEST_CONFIG, 'utf8')

    const res = await appRun(null, { status: true }, root)
    expect(res.ok).toBe(true)
    expect(res.mode).toBe('status')
    expect(res.stopped).toBe(true)
  })

  it('starts detached headless server, reports status, and stops cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-app-it-'))
    tmpDirs.push(root)
    writeFileSync(join(root, 'pluton.yaml'), TEST_CONFIG, 'utf8')

    // 1. Start detached headless
    const startRes = await appRun(null, { headless: true, detach: true }, root)
    expect(startRes.ok).toBe(true)
    expect(startRes.mode).toBe('headless')
    expect(startRes.reused).toBe(false)
    expect(typeof startRes.port).toBe('number')
    expect(typeof startRes.pid).toBe('number')

    // 2. Instance file exists
    const instance = readServerInstance(root)
    expect(instance).not.toBeNull()
    expect(instance!.port).toBe(startRes.port)

    // 3. Status reports running
    const statusRes = await appRun(null, { status: true }, root)
    expect(statusRes.ok).toBe(true)
    expect(statusRes.reused).toBe(true)
    expect(statusRes.port).toBe(startRes.port)

    // 4. Second start reuses running instance
    const secondStart = await appRun(null, { headless: true }, root)
    expect(secondStart.ok).toBe(true)
    expect(secondStart.reused).toBe(true)
    expect(secondStart.port).toBe(startRes.port)

    // 5. Stop server
    const stopRes = await appRun(null, { stop: true }, root)
    expect(stopRes.ok).toBe(true)
    expect(stopRes.stopped).toBe(true)

    // Verify cleanup
    expect(readServerInstance(root)).toBeNull()
  })

  it('supports Windows paths with spaces and auto-inits workspace', async () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'pluton space test-'))
    const root = join(parentDir, 'sub folder with spaces')
    tmpDirs.push(parentDir)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'pluton.yaml'), TEST_CONFIG, 'utf8')

    // Run on directory with spaces
    const startRes = await appRun(null, { headless: true, detach: true }, root)
    expect(startRes.ok).toBe(true)
    expect(startRes.rootDir).toBe(root)

    const stopRes = await appRun(null, { stop: true }, root)
    expect(stopRes.ok).toBe(true)
    expect(stopRes.stopped).toBe(true)
  })
})
