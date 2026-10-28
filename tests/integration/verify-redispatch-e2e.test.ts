import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { admitTask } from '../../src/orchestrator/task-graph.ts'
import { resumeRun } from '../../src/cli/commands/run.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'
import { createVerificationExecutor } from '../../src/verify/executor.ts'

const BIN = fileURLToPath(new URL('../../bin/pluton.js', import.meta.url))
const NODE = JSON.stringify(process.execPath)
// `pluton verify` cannot inject a test executor. The completion e2e only runs
// where production verification confinement is actually available; elsewhere
// the same test asserts fail-closed behaviour instead.
const ISOLATION_AVAILABLE = createVerificationExecutor().availability?.available === true

let projectDir: string

const CONFIG = `version: 1
project:
  name: verify-redispatch-it
  repository: .
  default_branch: main
  verification:
    - name: check-pass
      command: [${NODE}, "-e", "process.exit(0)"]
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
sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
    mode_by_platform:
      darwin: unconfined
      win32: unconfined
    acknowledge_unconfined: true
git:
  protected_paths: []
  require_approval_for_main_branch_integration: false
muses:
  manager:
    display_name: Manager
    role: supervisor
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
  worker-a:
    display_name: Worker A
    role: coder
    engine: mock
    model: mock/model-a
    workspace_policy: isolated-task-checkout
    approval_mode: autonomous-bounded
`

beforeAll(() => {
  registerBuiltinEngines()
  // Project identity is keyed on the literal root path, and the CLI resolves
  // its cwd to the canonical path. `tmpdir()` itself can sit behind a symlink
  // — on macOS `/var` is a symlink to `/private/var` — so seeding the store
  // through the raw temp path would create a second project that the CLI
  // cannot see. Hand both sides the same canonical directory.
  projectDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-redispatch-')))
  execFileSync('git', ['init', '-b', 'main', projectDir])
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'root'], { cwd: projectDir })
  writeFileSync(join(projectDir, 'pluton.yaml'), CONFIG)
})

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd: projectDir, encoding: 'utf8', timeout: 60_000 })
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr }
}

describe('PR-4: E2E Verification Gate Re-dispatch', () => {
  it.runIf(ISOLATION_AVAILABLE)('unblocks downstream task via pluton verify --dispatch and runs pipeline to completion', async () => {
    const loaded = loadConfig(projectDir)
    const { store, projectId } = bootstrapStore(loaded)

    let runId: string
    let task1Id: string
    let task2Id: string

    try {
      const run = store.createRun({
        projectId,
        goal: 'test pipeline e2e re-dispatch',
        origin: 'cli',
        requestedBy: 'test-e2e',
        acceptanceCriteria: [],
        managerMuseId: 'manager',
        budget: {
          maxConcurrentWorkers: 2,
          maxTasks: 10,
          maxDelegationDepth: 3,
          maxRunMinutes: 30,
          defaultTaskMinutes: 10,
        },
      })
      runId = run.id
      store.setRunState(runId, 'active')

      // Task 1: in verifying state
      const task1 = admitTask(
        store,
        {
          runId,
          parentTaskId: null,
          title: 'upstream task 1',
          brief: 'echo upstream-finished',
          acceptanceCriteria: [],
          assigneeMuseId: 'worker-a',
        },
        { maxChildrenPerTask: 5 },
      )
      task1Id = task1.id
      store.setTaskState(task1Id, 'admitted')
      store.setTaskState(task1Id, 'running')
      store.setTaskState(task1Id, 'verifying', { result: { outcome: 'success', summary: 'upstream complete' } })

      // Task 2: queued, depends on task 1
      const task2 = admitTask(
        store,
        {
          runId,
          parentTaskId: null,
          title: 'downstream task 2',
          brief: 'echo downstream-finished',
          acceptanceCriteria: [],
          assigneeMuseId: 'worker-a',
          dependsOn: [task1Id],
        },
        { maxChildrenPerTask: 5 },
      )
      task2Id = task2.id

      // Run parked in verifying
      store.setRunState(runId, 'verifying')
    } finally {
      store.close()
    }

    // Now execute: pluton verify --run <runId> --dispatch --json
    const res = runCli(['verify', '--run', runId, '--dispatch', '--json'])
    if (res.status !== 0) {
      console.error('CLI stderr:', res.stderr, 'stdout:', res.stdout)
    }
    expect(res.status).toBe(0)
    const env = JSON.parse(res.stdout) as {
      ok: boolean
      data: {
        run: { id: string; state: string }
        tasks: { taskId: string; verdict: string }[]
        runVerdict: { state: string; outcome: string; redispatchedTasks?: string[] }
        redispatchSummary?: { state: string; outcome: string }
      }
    }

    expect(env.ok).toBe(true)
    expect(env.data.tasks[0]?.taskId).toBe(task1Id)
    expect(env.data.tasks[0]?.verdict).toBe('completed')
    expect(env.data.runVerdict.outcome).toBe('redispatched')
    expect(env.data.runVerdict.redispatchedTasks).toEqual([task2Id])
    expect(env.data.redispatchSummary).toBeDefined()
    expect(env.data.redispatchSummary?.state).toBe('verifying')
    expect(env.data.redispatchSummary?.outcome).toBe('pending_verification')

    // Second verify pass: verifies downstream task 2 to bring pipeline to completed!
    const res2 = runCli(['verify', '--run', runId, '--json'])
    expect(res2.status).toBe(0)
    const env2 = JSON.parse(res2.stdout) as {
      ok: boolean
      data: {
        run: { id: string; state: string }
        tasks: { taskId: string; verdict: string }[]
        runVerdict: { state: string; outcome: string }
      }
    }
    expect(env2.ok).toBe(true)
    expect(env2.data.tasks[0]?.taskId).toBe(task2Id)
    expect(env2.data.tasks[0]?.verdict).toBe('completed')
    expect(env2.data.runVerdict.state).toBe('completed')
    expect(env2.data.runVerdict.outcome).toBe('success')

    // Verify durable state in store: both task 1 and task 2 are completed!
    const reopened = bootstrapStore(loadConfig(projectDir))
    try {
      const finalTask1 = reopened.store.getTask(task1Id)
      const finalTask2 = reopened.store.getTask(task2Id)
      const finalRun = reopened.store.getRun(runId)

      expect(finalTask1.state).toBe('completed')
      expect(finalTask2.state).toBe('completed')
      expect(finalRun.state).toBe('completed')
    } finally {
      reopened.store.close()
    }
  })

  it.runIf(!ISOLATION_AVAILABLE)('fails closed and does not redispatch when verification cannot be confined', () => {
    const loaded = loadConfig(projectDir)
    const { store, projectId } = bootstrapStore(loaded)

    let runId: string
    let task1Id: string
    let task2Id: string

    try {
      const run = store.createRun({
        projectId,
        goal: 'fail closed without verification confinement',
        origin: 'cli',
        requestedBy: 'test-e2e',
        acceptanceCriteria: [],
        managerMuseId: 'manager',
        budget: {
          maxConcurrentWorkers: 2,
          maxTasks: 10,
          maxDelegationDepth: 3,
          maxRunMinutes: 30,
          defaultTaskMinutes: 10,
        },
      })
      runId = run.id
      store.setRunState(runId, 'active')
      const task1 = admitTask(
        store,
        {
          runId,
          parentTaskId: null,
          title: 'upstream task 1',
          brief: 'echo upstream-finished',
          acceptanceCriteria: [],
          assigneeMuseId: 'worker-a',
        },
        { maxChildrenPerTask: 5 },
      )
      task1Id = task1.id
      store.setTaskState(task1Id, 'admitted')
      store.setTaskState(task1Id, 'running')
      store.setTaskState(task1Id, 'verifying', { result: { outcome: 'success', summary: 'upstream complete' } })
      const task2 = admitTask(
        store,
        {
          runId,
          parentTaskId: null,
          title: 'downstream task 2',
          brief: 'echo downstream-finished',
          acceptanceCriteria: [],
          assigneeMuseId: 'worker-a',
          dependsOn: [task1Id],
        },
        { maxChildrenPerTask: 5 },
      )
      task2Id = task2.id
      store.setRunState(runId, 'verifying')
    } finally {
      store.close()
    }

    const res = runCli(['verify', '--run', runId, '--dispatch', '--json'])
    expect(res.status).toBe(0)
    const env = JSON.parse(res.stdout) as {
      ok: boolean
      data: {
        tasks: { taskId: string; verdict: string; checks: { status: string; note: string | null }[] }[]
        runVerdict: { state: string; outcome: string; redispatchedTasks?: string[] } | null
        redispatchSummary?: unknown
      }
    }
    expect(env.ok).toBe(true)
    expect(env.data.tasks[0]?.taskId).toBe(task1Id)
    expect(env.data.tasks[0]?.verdict).toBe('failed')
    expect(env.data.tasks[0]?.checks[0]?.status).toBe('failed')
    expect(env.data.tasks[0]?.checks[0]?.note).toMatch(/verification isolation is unavailable/)
    expect(env.data.redispatchSummary).toBeUndefined()
    expect(env.data.runVerdict?.redispatchedTasks ?? []).toEqual([])

    const reopened = bootstrapStore(loadConfig(projectDir))
    try {
      expect(reopened.store.getTask(task1Id).state).toBe('failed')
      expect(reopened.store.getTask(task2Id).state).toBe('queued')
      expect(reopened.store.getRun(runId).state).not.toBe('completed')
    } finally {
      reopened.store.close()
    }
  })

  it('allows resuming an unblocked active run via resumeRun directly', async () => {
    const loaded = loadConfig(projectDir)
    const { store, projectId } = bootstrapStore(loaded)

    let runId: string
    let task1Id: string
    let task2Id: string

    try {
      const run = store.createRun({
        projectId,
        goal: 'test resumeRun directly',
        origin: 'cli',
        requestedBy: 'test-resume',
        acceptanceCriteria: [],
        managerMuseId: 'manager',
        budget: {
          maxConcurrentWorkers: 2,
          maxTasks: 10,
          maxDelegationDepth: 3,
          maxRunMinutes: 30,
          defaultTaskMinutes: 10,
        },
      })
      runId = run.id
      store.setRunState(runId, 'active')

      const task1 = admitTask(
        store,
        {
          runId,
          parentTaskId: null,
          title: 'upstream task 1',
          brief: 'task 1',
          acceptanceCriteria: [],
          assigneeMuseId: 'worker-a',
        },
        { maxChildrenPerTask: 5 },
      )
      task1Id = task1.id
      store.setTaskState(task1Id, 'admitted')
      store.setTaskState(task1Id, 'running')
      store.setTaskState(task1Id, 'completed', { result: { outcome: 'success' } })

      // Task 2: queued, ready because task 1 is already completed
      const task2 = admitTask(
        store,
        {
          runId,
          parentTaskId: null,
          title: 'downstream task 2',
          brief: 'task 2',
          acceptanceCriteria: [],
          assigneeMuseId: 'worker-a',
          dependsOn: [task1Id],
        },
        { maxChildrenPerTask: 5 },
      )
      task2Id = task2.id
    } finally {
      store.close()
    }

    const ctx = {
      rootDir: projectDir,
      configPath: join(projectDir, 'pluton.yaml'),
      loaded,
    }

    const summary = await resumeRun(ctx, runId, { skipManager: true })
    expect(summary.state).toBe('verifying')
    expect(summary.outcome).toBe('pending_verification')

    const reopened = bootstrapStore(loadConfig(projectDir))
    try {
      expect(reopened.store.getTask(task2Id).state).toBe('verifying')
      expect(reopened.store.getRun(runId).state).toBe('verifying')
    } finally {
      reopened.store.close()
    }
  })
})
