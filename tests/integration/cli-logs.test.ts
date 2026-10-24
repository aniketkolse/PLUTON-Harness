import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'

/**
 * Integration: seed durable events in-process, then run the real CLI entry
 * point (`bin/pluton.js` → src/cli/main.ts) as a child process. Asserts the
 * documented cursor contract end to end: JSON envelope, ascending pages, a
 * reconnect from `nextAfter` with no gaps/duplicates, SQL-side filters, and
 * typed failures for bad cursors.
 */

const BIN = fileURLToPath(new URL('../../bin/pluton.js', import.meta.url))

let projectDir: string
let runId: string
let otherRunId: string
let taskId: string
let firstSeq: number
let secondSeq: number
let thirdSeq: number
let foreignSeq: number

const CONFIG = `version: 1
project:
  name: cli-logs-it
  repository: .
  default_branch: main
  verification: []
runtime:
  max_concurrent_workers: 2
  max_team_size: 4
  max_delegation_depth: 3
  max_child_tasks_per_task: 5
  max_tasks_per_run: 10
  max_run_minutes: 30
  default_task_minutes: 10
sandbox:
  kind: local-process
  local_process_acknowledged: true
muses:
  manager:
    display_name: Manager
    role: supervisor
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: ask-for-sensitive-actions
  worker-a:
    display_name: Worker A
    role: coder
    engine: mock
    model: mock/model-a
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
`

interface RunView {
  ok: boolean
  data?: {
    events: Array<{ seq: number; id: string; type: string; runId: string | null }>
    nextAfter: number
    hasMore: boolean
    limit: number
    headSeq: number
    runId: string | null
  }
  error?: { code: string; message?: string }
}

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 }
  }
}

function logsJson(args: string[]): { env: RunView; exitCode: number; stdout: string } {
  const { stdout, exitCode } = runCli(['logs', ...args, '--json'])
  return { env: JSON.parse(stdout) as RunView, exitCode, stdout }
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pluton-cli-logs-it-'))
  writeFileSync(join(projectDir, 'pluton.yaml'), CONFIG)

  const loaded = loadConfig(projectDir)
  const { store, projectId } = bootstrapStore(loaded)
  const budget = {
    maxConcurrentWorkers: 2,
    maxTasks: 10,
    maxDelegationDepth: 3,
    maxRunMinutes: 30,
    defaultTaskMinutes: 10,
  }
  const run = store.createRun({
    projectId,
    goal: 'logs integration',
    origin: 'cli',
    requestedBy: 'integration-test',
    acceptanceCriteria: [],
    managerShipId: 'manager',
    budget,
  })
  runId = run.id
  const other = store.createRun({
    projectId,
    goal: 'other run',
    origin: 'cli',
    requestedBy: 'integration-test',
    acceptanceCriteria: [],
    managerShipId: 'manager',
    budget,
  })
  otherRunId = other.id

  const task = store.createTask({
    runId,
    title: 'logged task',
    brief: 'do the thing',
    acceptanceCriteria: [],
    assigneeShipId: 'worker-a',
  })
  taskId = task.id

  const first = store.appendEvent({
    projectId,
    runId,
    taskId,
    shipId: 'worker-a',
    type: 'task.admitted',
    payload: { title: 'logged task' },
  })
  const second = store.appendEvent({
    projectId,
    runId,
    taskId,
    shipId: 'worker-a',
    type: 'task.completed',
    payload: { verdict: 'pass' },
  })
  const third = store.appendEvent({
    projectId,
    runId,
    taskId,
    type: 'approval.requested',
    payload: { action: 'shell.exec' },
  })
  const foreign = store.appendEvent({
    projectId,
    runId: otherRunId,
    type: 'task.admitted',
    payload: { title: 'other' },
  })
  firstSeq = first.seq
  secondSeq = second.seq
  thirdSeq = third.seq
  foreignSeq = foreign.seq
  store.close()
})

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

describe('pluton logs (integration)', () => {
  it('returns the project log as one ascending JSON page with a head cursor', () => {
    const { env, exitCode } = logsJson(['--limit', '50'])
    expect(exitCode).toBe(0)
    expect(env.ok).toBe(true)
    expect(env.data?.runId).toBeNull()
    expect(env.data?.events.map((e) => e.seq)).toEqual([firstSeq, secondSeq, thirdSeq, foreignSeq])
    expect(env.data?.nextAfter).toBe(foreignSeq)
    expect(env.data?.headSeq).toBe(foreignSeq)
    expect(env.data?.hasMore).toBe(false)
    expect(env.data?.limit).toBe(50)
  })

  it('paginates with --after and never repeats or skips an event', () => {
    const page1 = logsJson(['--limit', '2'])
    expect(page1.env.data?.events.map((e) => e.seq)).toEqual([firstSeq, secondSeq])
    expect(page1.env.data?.hasMore).toBe(true)

    const page2 = logsJson(['--after', String(page1.env.data?.nextAfter), '--limit', '2'])
    expect(page2.env.data?.events.map((e) => e.seq)).toEqual([thirdSeq, foreignSeq])
    expect(page2.env.data?.hasMore).toBe(false)

    const page3 = logsJson(['--after', String(page2.env.data?.nextAfter), '--limit', '2'])
    expect(page3.env.data?.events).toEqual([])
    expect(page3.env.data?.nextAfter).toBe(foreignSeq)
  })

  it('scopes to a run by positional id or unique suffix and ignores other runs', () => {
    const byId = logsJson([runId])
    expect(byId.env.data?.runId).toBe(runId)
    expect(byId.env.data?.events.map((e) => e.seq)).toEqual([firstSeq, secondSeq, thirdSeq])

    const bySuffix = logsJson([runId.slice(-8)])
    expect(bySuffix.env.data?.runId).toBe(runId)
    expect(bySuffix.env.data?.events.map((e) => e.id)).toEqual(byId.env.data?.events.map((e) => e.id))

    const byOption = logsJson(['--run', runId.slice(-8)])
    expect(byOption.env.data?.events.map((e) => e.seq)).toEqual([firstSeq, secondSeq, thirdSeq])
  })

  it('filters in SQL by type, task and ship', () => {
    const byType = logsJson([runId, '--type', 'task.completed', '--type', 'approval.requested'])
    expect(byType.env.data?.events.map((e) => e.seq)).toEqual([secondSeq, thirdSeq])

    const byTask = logsJson(['--task', taskId])
    expect(byTask.env.data?.events.map((e) => e.seq)).toEqual([firstSeq, secondSeq, thirdSeq])

    const byShip = logsJson(['--ship', 'worker-a'])
    expect(byShip.env.data?.events.map((e) => e.seq)).toEqual([firstSeq, secondSeq])
  })

  it('renders a human log with refs and the cursor footer', () => {
    const { stdout, exitCode } = runCli(['logs', runId, '--limit', '10'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('task.admitted')
    expect(stdout).toContain('task.completed')
    expect(stdout).toContain(`run=${runId.slice(-8)}`)
    expect(stdout).toContain(`cursor #${thirdSeq}`)
    expect(stdout).toContain(`head #${thirdSeq}`)
    expect(stdout).not.toContain('other')
  })

  it('fails with a typed validation error for a malformed cursor', () => {
    const { env, exitCode, stdout } = logsJson(['--after', '-1'])
    expect(exitCode).toBe(1)
    expect(env.ok).toBe(false)
    expect(env.error?.code).toBe('validation_failed')
    expect(stdout.trim().startsWith('{')).toBe(true)
  })

  it('fails with not_found for an unknown run and validation for conflicting refs', () => {
    const missing = logsJson(['run_doesnotexist'])
    expect(missing.exitCode).toBe(1)
    expect(missing.env.error?.code).toBe('not_found')

    const conflict = logsJson([runId, '--run', otherRunId])
    expect(conflict.exitCode).toBe(1)
    expect(conflict.env.error?.code).toBe('validation_failed')
  })
})
