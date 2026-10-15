import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { admitTask } from '../../src/orchestrator/task-graph.ts'

/**
 * Integration: seed durable state in-process, then exercise the real CLI
 * entry point (`bin/pluton.js` → src/cli/main.ts) as a child process and
 * assert on the JSON envelopes. This is the Phase-3 read path end to end.
 */

const BIN = fileURLToPath(new URL('../../bin/pluton.js', import.meta.url))

let projectDir: string
let runId: string
let rootTaskId: string
let childTaskId: string

const CONFIG = `version: 1
project:
  name: cli-it
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
    approval_mode: ask-for-sensitive-actions
  worker-a:
    display_name: Worker A
    role: coder
    engine: mock
    model: mock/model-a
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
`

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

function parseEnvelope(stdout: string): { ok: boolean; data?: Record<string, unknown>; error?: { code: string } } {
  // JSON mode guarantees exactly one JSON document on stdout.
  return JSON.parse(stdout) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string } }
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pluton-cli-it-'))
  writeFileSync(join(projectDir, 'pluton.yaml'), CONFIG)

  const loaded = loadConfig(projectDir)
  const { store, projectId } = bootstrapStore(loaded)
  const run = store.createRun({
    projectId,
    goal: 'integration goal',
    origin: 'cli',
    requestedBy: 'integration-test',
    acceptanceCriteria: ['tests pass'],
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
  const root = admitTask(
    store,
    {
      runId,
      parentTaskId: null,
      title: 'root task',
      brief: 'do the thing',
      acceptanceCriteria: ['done'],
      assigneeMuseId: 'worker-a',
    },
    { maxChildrenPerTask: 5 },
  )
  rootTaskId = root.id
  const child = admitTask(
    store,
    {
      runId,
      parentTaskId: root.id,
      title: 'child task',
      brief: 'do the child thing',
      acceptanceCriteria: [],
      assigneeMuseId: 'worker-a',
      dependsOn: [root.id],
    },
    { maxChildrenPerTask: 5 },
  )
  childTaskId = child.id
  store.close()
})

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

describe('pluton CLI read paths (integration)', () => {
  it('status lists the seeded run as JSON', () => {
    const { stdout, exitCode } = runCli(['status', '--json'])
    expect(exitCode).toBe(0)
    const env = parseEnvelope(stdout)
    expect(env.ok).toBe(true)
    const runs = (env.data as { runs: Array<{ run: { id: string; state: string }; totalTasks: number }> }).runs
    expect(runs.length).toBe(1)
    expect(runs[0]?.run.id).toBe(runId)
    expect(runs[0]?.run.state).toBe('created')
    expect(runs[0]?.totalTasks).toBe(2)
  })

  it('status --run resolves a unique suffix and counts task states', () => {
    const suffix = runId.slice(-8)
    const { stdout, exitCode } = runCli(['status', '--run', suffix, '--json'])
    expect(exitCode).toBe(0)
    const env = parseEnvelope(stdout)
    expect(env.ok).toBe(true)
    const summary = (env.data as { summary: { totalTasks: number; taskCounts: Record<string, number> } }).summary
    expect(summary.totalTasks).toBe(2)
    expect(summary.taskCounts['queued']).toBe(2)
  })

  it('task list shows both tasks with depth and parent linkage', () => {
    const { stdout, exitCode } = runCli(['task', 'list', runId, '--json'])
    expect(exitCode).toBe(0)
    const env = parseEnvelope(stdout)
    const tasks = (env.data as { tasks: Array<{ id: string; depth: number; parentTaskId: string | null }> }).tasks
    expect(tasks.length).toBe(2)
    const child = tasks.find((t) => t.id === childTaskId)
    expect(child?.depth).toBe(1)
    expect(child?.parentTaskId).toBe(rootTaskId)
  })

  it('task show resolves a suffix and includes dependency edges', () => {
    const { stdout, exitCode } = runCli(['task', 'show', rootTaskId.slice(-8), '--json'])
    expect(exitCode).toBe(0)
    const env = parseEnvelope(stdout)
    expect(env.ok).toBe(true)
    const data = env.data as { task: { id: string }; edges: Array<{ kind: string }> }
    expect(data.task.id).toBe(rootTaskId)
    expect(data.edges.some((e) => e.kind === 'depends_on')).toBe(true)
  })

  it('graph renders the delegation tree and dependency list', () => {
    const { stdout, exitCode } = runCli(['graph', runId.slice(-8)])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('[queued]')
    expect(stdout).toContain('depends_on:')
    expect(stdout).toContain(rootTaskId.slice(-8))
    expect(stdout).toContain(childTaskId.slice(-8))
  })

  it('machine mode keeps stdout clean: exactly one JSON document even on errors', () => {
    const { stdout, exitCode } = runCli(['task', 'show', 'task_doesnotexist', '--json'])
    expect(exitCode).toBe(1)
    const env = parseEnvelope(stdout)
    expect(env.ok).toBe(false)
    expect(env.error?.code).toBe('not_found')
  })

  it('planned commands fail with a stable not_implemented code', () => {
    const { stdout, exitCode } = runCli(['run', '--json'])
    expect(exitCode).toBe(1)
    const env = parseEnvelope(stdout)
    expect(env.ok).toBe(false)
    expect(env.error?.code).toBe('not_implemented')
  })

  it('migrated database is reused, not recreated, across CLI invocations', () => {
    runCli(['status', '--json'])
    runCli(['status', '--json'])
    const { stdout } = runCli(['status', '--json'])
    const env = parseEnvelope(stdout)
    const runs = (env.data as { runs: unknown[] }).runs
    expect(runs.length).toBe(1)
  })
})
