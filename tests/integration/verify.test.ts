import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { admitTask } from '../../src/orchestrator/task-graph.ts'
import { applyTaskVerificationVerdict, runVerificationChecks } from '../../src/verify/runner.ts'
import { createVerificationExecutor } from '../../src/verify/executor.ts'
import { hostTestExecutor } from '../helpers/verification.ts'

/**
 * Integration: the Phase-7 verification gate. Checks are configured argv
 * arrays, run through the bounded process runner, recorded as durable evidence
 * before any verdict, and completion is only ever reached through the gate:
 * failed, denied and never-run checks can never be green. One end-to-end pass
 * drives the real CLI (`pluton verify --json`) against the real store.
 */

const BIN = fileURLToPath(new URL('../../bin/pluton.js', import.meta.url))
const NODE = JSON.stringify(process.execPath)
// The real CLI cannot inject a test executor. On hosts without proven
// verification confinement the gate must refuse, so the success-path CLI test
// only runs where the production executor is actually available.
const ISOLATION_AVAILABLE = createVerificationExecutor().availability?.available === true

let projectDir: string
let artifactsDir: string

const CONFIG = `version: 1
project:
  name: verify-it
  repository: .
  default_branch: main
  verification:
    - name: pass
      command: [${NODE}, "-e", "process.exit(0)"]
    - name: echo
      command: [${NODE}, "-e", "console.log('verified-output')"]
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
    approval_mode: ask-for-sensitive-actions
`

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pluton-verify-'))
  writeFileSync(join(projectDir, 'pluton.yaml'), CONFIG)
  artifactsDir = join(projectDir, '.pluton', 'state', 'artifacts')
})

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd: projectDir, encoding: 'utf8', timeout: 60_000 })
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr }
}

/** Fresh run + task walked to the requested state (and the run to `verifying` when asked). */
function seedRunWithTask(taskState: 'running' | 'verifying', runVerifying = false): { runId: string; taskId: string } {
  const loaded = loadConfig(projectDir)
  const { store, projectId } = bootstrapStore(loaded)
  try {
    const run = store.createRun({
      projectId,
      goal: 'verification gate integration goal',
      origin: 'cli',
      requestedBy: 'integration-test',
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
    const task = admitTask(
      store,
      {
        runId: run.id,
        parentTaskId: null,
        title: `verify task (${taskState})`,
        brief: 'produce work that must pass the gate',
        acceptanceCriteria: [],
        assigneeMuseId: 'worker-a',
      },
      { maxChildrenPerTask: 5 },
    )
    store.setRunState(run.id, 'active')
    store.setTaskState(task.id, 'admitted')
    store.setTaskState(task.id, 'running')
    if (taskState === 'verifying') {
      store.setTaskState(task.id, 'verifying', { result: { outcome: 'success', summary: 'mock:success' } })
      if (runVerifying) store.setRunState(run.id, 'verifying')
    }
    return { runId: run.id, taskId: task.id }
  } finally {
    store.close()
  }
}

describe('verification gate (pluton verify)', () => {
  it.runIf(ISOLATION_AVAILABLE)('CLI: all configured checks pass → task completed, run completed, evidence durable', () => {
    const { runId, taskId } = seedRunWithTask('verifying', true)
    const res = runCli(['verify', '--run', runId, '--json'])
    expect(res.status).toBe(0)
    const env = JSON.parse(res.stdout) as {
      ok: boolean
      data: {
        run: { id: string; state: string }
        tasks: { taskId: string; verdict: string; summary: string }[]
        runVerdict: { state: string; outcome: string } | null
      }
    }
    expect(env.ok).toBe(true)
    expect(env.data.tasks).toHaveLength(1)
    expect(env.data.tasks[0]?.taskId).toBe(taskId)
    expect(env.data.tasks[0]?.verdict).toBe('completed')
    expect(env.data.runVerdict).toMatchObject({ state: 'completed', outcome: 'success' })
    expect(env.data.run.state).toBe('completed')

    // Durable evidence checked through an independent store connection.
    const reopened = bootstrapStore(loadConfig(projectDir))
    try {
      const task = reopened.store.getTask(taskId)
      expect(task.state).toBe('completed')
      expect(task.failure).toBeNull()
      const result = task.result as { verifiedBy?: string[] }
      expect(result.verifiedBy).toHaveLength(2)
      const checks = reopened.store.listVerificationChecksByTask(taskId)
      expect(checks.map((c) => c.status)).toEqual(['passed', 'passed'])
      expect(checks.every((c) => c.exitCode === 0)).toBe(true)
      expect(reopened.store.getRun(runId).state).toBe('completed')
      const events = reopened.store.db
        .prepare("SELECT type FROM events WHERE run_id = ? AND type IN ('verification.run', 'run.finished')")
        .all(runId) as { type: string }[]
      expect(events.filter((e) => e.type === 'verification.run')).toHaveLength(2)
      expect(events.filter((e) => e.type === 'run.finished')).toHaveLength(1)
    } finally {
      reopened.store.close()
    }
  })

  it.runIf(!ISOLATION_AVAILABLE)('CLI: fails closed instead of executing checks on an unconfinable host', () => {
    const { runId, taskId } = seedRunWithTask('verifying', true)
    const res = runCli(['verify', '--run', runId, '--json'])
    expect(res.status).toBe(0)
    const env = JSON.parse(res.stdout) as {
      ok: boolean
      data: { tasks: { verdict: string; checks: { status: string; exitCode: number | null; note: string | null }[] }[] }
    }
    expect(env.ok).toBe(true)
    expect(env.data.tasks[0]?.verdict).toBe('failed')
    expect(env.data.tasks[0]?.checks.every((c) => c.status === 'failed')).toBe(true)
    expect(env.data.tasks[0]?.checks.every((c) => c.exitCode === null)).toBe(true)
    expect(env.data.tasks[0]?.checks[0]?.note).toMatch(/verification isolation is unavailable/)

    const reopened = bootstrapStore(loadConfig(projectDir))
    try {
      expect(reopened.store.getTask(taskId).state).toBe('failed')
      expect(reopened.store.getTask(taskId).failure).toMatchObject({ code: 'verification_failed' })
      expect(reopened.store.listVerificationChecksByTask(taskId).map((c) => c.status)).toEqual(['failed', 'failed'])
      const rows = reopened.store.db
        .prepare("SELECT payload_json AS payload FROM events WHERE run_id = ? AND type = 'verification.run'")
        .all(runId) as { payload: string }[]
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(JSON.parse(row.payload)).toMatchObject({ executor: expect.stringMatching(/^unavailable:/) })
      }
    } finally {
      reopened.store.close()
    }
  })

  it('CLI: a task that is not verifying is refused with a typed error', () => {
    const { runId, taskId } = seedRunWithTask('running')
    const res = runCli(['verify', '--run', runId, '--task', taskId, '--json'])
    expect(res.status).toBe(1)
    const env = JSON.parse(res.stdout) as { ok: boolean; error: { code: string; message: string } }
    expect(env.ok).toBe(false)
    expect(env.error.message).toMatch(/only a task in 'verifying'/)
    // Nothing was recorded for the refused task.
    const reopened = bootstrapStore(loadConfig(projectDir))
    try {
      expect(reopened.store.listVerificationChecksByTask(taskId)).toHaveLength(0)
      expect(reopened.store.getTask(taskId).state).toBe('running')
    } finally {
      reopened.store.close()
    }
  })

  it('a failing check fails the task even when other checks passed, and artifacts are written', async () => {
    const { runId, taskId } = seedRunWithTask('verifying')
    const loaded = loadConfig(projectDir)
    const { store, projectId } = bootstrapStore(loaded)
    try {
      const report = await runVerificationChecks({
        store,
        projectId,
        runId,
        taskId,
        checks: [
          { name: 'ok', command: [process.execPath, '-e', 'process.exit(0)'] },
          { name: 'bad', command: [process.execPath, '-e', 'process.exit(3)'] },
          { name: 'noisy', command: [process.execPath, '-e', "console.log('check-stdout'); console.error('check-stderr')"] },
        ],
        cwd: projectDir,
        workspaceId: null,
        artifactsDir,
        executor: hostTestExecutor(),
      })
      expect(report.allPassed).toBe(false)
      expect(report.results.map((r) => r.status)).toEqual(['passed', 'failed', 'passed'])
      expect(report.results[1]?.note).toBe('exit code 3')

      const verdict = applyTaskVerificationVerdict(store, taskId)
      expect(verdict.state).toBe('failed')
      expect(verdict.passed).toBe(false)
      const task = store.getTask(taskId)
      expect(task.state).toBe('failed')
      expect(task.failure).toMatchObject({ code: 'verification_failed' })

      const noisy = store.listVerificationChecksByTask(taskId).find((c) => c.name === 'noisy')
      expect(noisy?.stdoutArtifact).not.toBeNull()
      expect(readFileSync(noisy?.stdoutArtifact as string, 'utf8')).toContain('check-stdout')
      expect(readFileSync(noisy?.stderrArtifact as string, 'utf8')).toContain('check-stderr')
    } finally {
      store.close()
    }
  })

  it('a never-run (pending) check can never be green', () => {
    const { runId, taskId } = seedRunWithTask('verifying')
    const loaded = loadConfig(projectDir)
    const { store, projectId } = bootstrapStore(loaded)
    try {
      store.createVerificationCheck({
        projectId,
        runId,
        taskId,
        name: 'never-ran',
        command: [process.execPath, '-e', 'process.exit(0)'],
        cwd: projectDir,
        workspaceId: null,
      })
      const verdict = applyTaskVerificationVerdict(store, taskId)
      expect(verdict.state).toBe('failed')
      expect(store.getTask(taskId).failure).toMatchObject({ code: 'verification_failed' })
    } finally {
      store.close()
    }
  })

  it('refuses to complete a task on legacy rows that carry no evidence identity', () => {
    const { runId, taskId } = seedRunWithTask('verifying')
    const loaded = loadConfig(projectDir)
    const { store, projectId } = bootstrapStore(loaded)
    try {
      // Shape written before evidence identity existed: passed, but no kind,
      // revision, fingerprint, post state or executor.
      const legacy = store.createVerificationCheck({
        projectId,
        runId,
        taskId,
        name: 'legacy',
        command: [process.execPath, '-e', 'process.exit(0)'],
        cwd: projectDir,
        workspaceId: null,
      })
      store.setVerificationCheckResult(legacy.id, { status: 'passed', exitCode: 0 })
      expect(() => applyTaskVerificationVerdict(store, taskId)).toThrow(/no recorded kind/)
      // The task stays in verifying; no verdict was fabricated.
      expect(store.getTask(taskId).state).toBe('verifying')
    } finally {
      store.close()
    }
  })

  it('supersedes an interrupted same-attempt run instead of requiring an attempt bump', async () => {
    const { runId, taskId } = seedRunWithTask('verifying')
    const loaded = loadConfig(projectDir)
    const { store, projectId } = bootstrapStore(loaded)
    try {
      // A crash left a pending row behind for this attempt.
      const interrupted = store.createVerificationCheck({
        projectId,
        runId,
        taskId,
        name: 'interrupted',
        command: [process.execPath, '-e', 'process.exit(0)'],
        cwd: projectDir,
        workspaceId: null,
      })
      expect(interrupted.status).toBe('pending')

      const report = await runVerificationChecks({
        store,
        projectId,
        runId,
        taskId,
        checks: [{ name: 'fresh', command: [process.execPath, '-e', 'process.exit(0)'] }],
        cwd: projectDir,
        workspaceId: null,
        artifactsDir,
        executor: hostTestExecutor(),
      })
      expect(report.allPassed).toBe(true)
      expect(report.evidence.kind).toBe('non-git')
      expect(report.evidence.postKind).toBe('non-git')

      const history = store.listVerificationChecksByTask(taskId)
      expect(history).toHaveLength(2)
      expect(history.find((c) => c.id === interrupted.id)?.supersededAt).not.toBeNull()
      const current = store.listCurrentVerificationChecksByTaskAttempt(taskId, 0)
      expect(current).toHaveLength(1)
      expect(current[0]?.name).toBe('fresh')
      expect(current[0]?.executor).toBe('test:host')

      const verdict = applyTaskVerificationVerdict(store, taskId)
      expect(verdict.state).toBe('completed')
      // The retry did not bump the attempt.
      expect(store.getTask(taskId).attempt).toBe(0)
    } finally {
      store.close()
    }
  })

  it('deny-listed commands are refused before spawn and recorded as failed evidence', async () => {
    const { runId, taskId } = seedRunWithTask('verifying')
    const loaded = loadConfig(projectDir)
    const { store, projectId } = bootstrapStore(loaded)
    try {
      const report = await runVerificationChecks({
        store,
        projectId,
        runId,
        taskId,
        checks: [{ name: 'shell-string', command: ['sh', '-c', 'echo hi'] }],
        cwd: projectDir,
        workspaceId: null,
        artifactsDir,
      })
      expect(report.allPassed).toBe(false)
      expect(report.results[0]?.status).toBe('failed')
      expect(report.results[0]?.note).toMatch(/deny list/)
      const row = store.listVerificationChecksByTask(taskId)[0]
      expect(row?.status).toBe('failed')
      expect(row?.exitCode).toBeNull()
      const verdict = applyTaskVerificationVerdict(store, taskId)
      expect(verdict.state).toBe('failed')
    } finally {
      store.close()
    }
  })
})
