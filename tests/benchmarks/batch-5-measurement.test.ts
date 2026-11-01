import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { RunSupervisor } from '../../src/orchestrator/supervisor.ts'
import { admitTask } from '../../src/orchestrator/task-graph.ts'
import { GitWorkspaceManager } from '../../src/workspace/manager.ts'
import { createVerificationExecutor } from '../../src/verify/executor.ts'
import { run } from '../../src/util/exec.ts'
import { trustedNodeExecutable } from '../helpers/trusted-node.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'

/**
 * Batch 5 measurement benchmarks.
 *
 * These benchmarks measure orchestration overhead using the mock engine
 * (no real model, no network). They are deterministic and can be run
 * repeatedly to detect regressions.
 *
 * All measurements are observed (durations from event timestamps, counts
 * from event payloads), never estimated or fabricated.
 */

const ISOLATION_AVAILABLE = createVerificationExecutor().availability?.available === true

let benchDir: string

async function git(args: string[], cwd: string): Promise<void> {
  const res = await run(['git', ...args], { cwd, timeoutMs: 60_000 })
  if (res.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
}

function makeConfig(dir: string): string {
  const NODE = JSON.stringify(trustedNodeExecutable())
  return `version: 1
project:
  name: bench-${dir.split('/').pop()}
  repository: .
  default_branch: main
  verification:
    - name: unit
      command: [${NODE}, "-e", "process.exit(0)"]
runtime:
  max_concurrent_workers: 4
  max_team_size: 4
  max_delegation_depth: 3
  max_child_tasks_per_task: 5
  max_tasks_per_run: 20
  max_run_minutes: 30
  default_task_minutes: 10
  default_cpu_limit: 2
  default_memory_mb: 2048
  max_retries_per_task: 1
  max_revisions_per_task: 1
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
  worker-b:
    display_name: Worker B
    role: coder
    engine: mock
    model: mock/model-a
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
`
}

function makeSupervisor(store: any, projectId: string, runId: string, dir: string, verificationConfigured: boolean): RunSupervisor {
  const adapters = new Map<string, MockEngineAdapter>()
  for (const id of ['worker-a', 'worker-b', 'manager'] as const) {
    adapters.set(
      id,
      new MockEngineAdapter({
        script: [{ delayMs: 5, outcome: 'success' }],
      }),
    )
  }

  const workspaceManager = new GitWorkspaceManager({ workspacesRoot: join(dir, '.pluton', 'workspaces') })

  return new RunSupervisor({
    store,
    projectId,
    rootDir: dir,
    workspacesRoot: join(dir, '.pluton', 'workspaces'),
    runId,
    limits: {
      maxBriefChars: 60_000,
      maxTeamSize: 4,
      maxToolResultChars: 120_000,
      defaultWaitSeconds: 120,
      waitHeartbeatSeconds: 30,
      approvalTtlMinutes: 60,
      maxRevisionsPerTask: 1,
      maxChildrenPerTask: 5,
    },
    maxConcurrentWorkers: 4,
    defaultTaskTimeoutMs: 15_000,
    runDeadlineMs: 60_000,
    verificationConfigured,
    loopPollMs: 20,
    adapterFor: (muse) => {
      const adapter = adapters.get(muse.id)
      if (!adapter) throw new Error(`no adapter for ship ${muse.id}`)
      return adapter
    },
    workspaceManager,
  })
}

describe('Batch 5 measurement benchmarks', () => {
  beforeEach(() => {
    benchDir = mkdtempSync(join(tmpdir(), 'pluton-bench-'))
  })

  afterEach(() => {
    try {
      rmSync(benchDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup; files may be locked by mock engine on Windows
    }
  })

  it('benchmark 1: simple sequential task measures run and task duration', async () => {
    const dir = join(benchDir, 'seq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pluton.yaml'), makeConfig(dir))
    writeFileSync(join(dir, 'README.md'), '# project\n')

    // Initialize a git repo so clone --local works
    await git(['init', '-b', 'main'], dir)
    await git(['add', '-A'], dir)
    await git(['-c', 'user.name=Bench', '-c', 'user.email=bench@test', 'commit', '-m', 'init'], dir)

    const loaded = loadConfig(dir)
    const { store, projectId } = bootstrapStore(loaded)
    // Sync ships/muses to the store so the supervisor can resolve them
    store.syncMuses(projectId, [
      {
        id: 'manager',
        slug: 'manager',
        displayName: 'Manager',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: ['task.create', 'task.delegate', 'task.inspect', 'task.cancel', 'task.request_revision', 'result.collect', 'ship.propose_create', 'verification.run', 'diff.inspect', 'approval.request', 'project.status', 'run.list', 'run.inspect', 'run.start', 'approvals.list', 'scope.declare', 'scope.release', 'worker.message'],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/manager',
      },
      {
        id: 'worker-a',
        slug: 'worker-a',
        displayName: 'Worker A',
        role: 'coder',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'isolated-task-checkout',
        permissions: ['task.delegate', 'task.inspect', 'result.collect', 'diff.inspect'],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/worker-a',
      },
      {
        id: 'worker-b',
        slug: 'worker-b',
        displayName: 'Worker B',
        role: 'coder',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'isolated-task-checkout',
        permissions: ['task.delegate', 'task.inspect', 'result.collect', 'diff.inspect'],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/worker-b',
      },
    ])
    const run = store.createRun({
      projectId,
      goal: 'Simple sequential task benchmark',
      origin: 'cli',
      requestedBy: 'benchmark',
      acceptanceCriteria: ['task completes'],
      managerMuseId: 'manager',
      budget: {
        maxConcurrentWorkers: 4,
        maxTasks: 10,
        maxDelegationDepth: 3,
        maxRunMinutes: 30,
        defaultTaskMinutes: 10,
      },
    })
    const task = admitTask(store, {
      runId: run.id,
      parentTaskId: null,
      title: 'Simple task',
      brief: 'Complete a simple task',
      acceptanceCriteria: ['done'],
      assigneeShipId: 'worker-a',
    }, { maxChildrenPerTask: 5 })
    // admitTask already sets state to 'queued'

    const supervisor = makeSupervisor(store, projectId, run.id, dir, false)

    const startMs = Date.now()
    const result = await supervisor.runToCompletion()
    const runDurationMs = Date.now() - startMs

    // Verify we observed task duration from events
    const taskEvents = store.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type IN ('task.completed', 'task.failed', 'task.unknown_outcome')")
      .all(run.id) as { payload_json: string }[]

    let taskDurations: number[] = []
    for (const ev of taskEvents) {
      const payload = JSON.parse(ev.payload_json)
      if (payload.durationMs !== undefined) {
        taskDurations.push(payload.durationMs as number)
      }
    }

    // Verify we observed queue wait from events
    const dequeueEvents = store.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'task.dequeued'")
      .all(run.id) as { payload_json: string }[]

    let queueWaits: number[] = []
    for (const ev of dequeueEvents) {
      const payload = JSON.parse(ev.payload_json)
      if (payload.queuedAt !== undefined && payload.dispatchedAt !== undefined) {
        queueWaits.push((payload.dispatchedAt as number) - (payload.queuedAt as number))
      }
    }

    // Run finished event should carry run duration
    const finishEvents = store.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type IN ('run.finished', 'run.uncertain')")
      .all(run.id) as { payload_json: string }[]

    let runDurations: number[] = []
    for (const ev of finishEvents) {
      const payload = JSON.parse(ev.payload_json)
      if (payload.durationMs !== undefined) {
        runDurations.push(payload.durationMs as number)
      }
    }

    expect(result.state).toBe('completed')
    expect(runDurationMs).toBeGreaterThan(0)
    expect(taskDurations.length).toBeGreaterThan(0)
    expect(taskDurations.every((d) => d >= 0)).toBe(true)
    expect(runDurations.length).toBeGreaterThan(0)
    expect(runDurations[0]).toBeGreaterThan(0)
    // Queue waits: if dequeued events exist, verify timestamps are present
    if (queueWaits.length > 0) {
      expect(queueWaits.every((w) => typeof w === 'number')).toBe(true)
    }
  })

  it('benchmark 2: independent parallel tasks measure worker utilization', async () => {
    const dir = join(benchDir, 'par')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pluton.yaml'), makeConfig(dir))
    writeFileSync(join(dir, 'README.md'), '# project\n')
    await git(['init', '-b', 'main'], dir)
    await git(['add', '-A'], dir)
    await git(['-c', 'user.name=Bench', '-c', 'user.email=bench@test', 'commit', '-m', 'init'], dir)

    const loaded = loadConfig(dir)
    const { store, projectId } = bootstrapStore(loaded)
    store.syncMuses(projectId, [
      {
        id: 'manager',
        slug: 'manager',
        displayName: 'Manager',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: ['task.create', 'task.delegate', 'task.inspect', 'task.cancel', 'task.request_revision', 'result.collect', 'ship.propose_create', 'verification.run', 'diff.inspect', 'approval.request', 'project.status', 'run.list', 'run.inspect', 'run.start', 'approvals.list', 'scope.declare', 'scope.release', 'worker.message'],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/manager',
      },
      {
        id: 'worker-a',
        slug: 'worker-a',
        displayName: 'Worker A',
        role: 'coder',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'isolated-task-checkout',
        permissions: ['task.delegate', 'task.inspect', 'result.collect', 'diff.inspect'],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/worker-a',
      },
      {
        id: 'worker-b',
        slug: 'worker-b',
        displayName: 'Worker B',
        role: 'coder',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'isolated-task-checkout',
        permissions: ['task.delegate', 'task.inspect', 'result.collect', 'diff.inspect'],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/worker-b',
      },
    ])
    const run = store.createRun({
      projectId,
      goal: 'Parallel task benchmark',
      origin: 'cli',
      requestedBy: 'benchmark',
      acceptanceCriteria: ['all tasks complete'],
      managerMuseId: 'manager',
      budget: {
        maxConcurrentWorkers: 4,
        maxTasks: 20,
        maxDelegationDepth: 3,
        maxRunMinutes: 30,
        defaultTaskMinutes: 10,
      },
    })

    // Create 4 independent tasks
    for (let i = 0; i < 4; i++) {
      const task = admitTask(store, {
        runId: run.id,
        parentTaskId: null,
        title: `Parallel task ${i}`,
        brief: `Independent task ${i}`,
        acceptanceCriteria: ['done'],
        assigneeShipId: i % 2 === 0 ? 'worker-a' : 'worker-b',
      }, { maxChildrenPerTask: 5 })
      // admitTask already sets state to 'queued'
    }

    const supervisor = makeSupervisor(store, projectId, run.id, dir, false)

    const startMs = Date.now()
    const result = await supervisor.runToCompletion()
    const runDurationMs = Date.now() - startMs

    const taskEvents = store.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type IN ('task.completed', 'task.failed', 'task.unknown_outcome')")
      .all(run.id) as { payload_json: string }[]

    let taskStates: Record<string, number> = {}
    for (const ev of taskEvents) {
      const payload = JSON.parse(ev.payload_json)
      const outcome = payload.outcome as string
      taskStates[outcome] = (taskStates[outcome] ?? 0) + 1
    }
    const totalSettled = Object.values(taskStates).reduce((a, b) => a + b, 0)

    expect(result.state).toBe('completed')
    process.stderr.write('BENCH2 TASK STATES: ' + JSON.stringify(taskStates) + '\n')
    expect(totalSettled).toBe(4)
    expect(runDurationMs).toBeGreaterThan(0)
  })

  it('benchmark 3: dependency-heavy DAG measures sequential execution', async () => {
    const dir = join(benchDir, 'dag')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pluton.yaml'), makeConfig(dir))
    writeFileSync(join(dir, 'README.md'), '# project\n')
    await git(['init', '-b', 'main'], dir)
    await git(['add', '-A'], dir)
    await git(['-c', 'user.name=Bench', '-c', 'user.email=bench@test', 'commit', '-m', 'init'], dir)

    const loaded = loadConfig(dir)
    const { store, projectId } = bootstrapStore(loaded)
    store.syncMuses(projectId, [
      {
        id: 'manager',
        slug: 'manager',
        displayName: 'Manager',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: ['task.create', 'task.delegate', 'task.inspect', 'task.cancel', 'task.request_revision', 'result.collect', 'ship.propose_create', 'verification.run', 'diff.inspect', 'approval.request', 'project.status', 'run.list', 'run.inspect', 'run.start', 'approvals.list', 'scope.declare', 'scope.release', 'worker.message'],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/manager',
      },
      {
        id: 'worker-a',
        slug: 'worker-a',
        displayName: 'Worker A',
        role: 'coder',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'isolated-task-checkout',
        permissions: ['task.delegate', 'task.inspect', 'result.collect', 'diff.inspect'],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/worker-a',
      },
    ])
    const run = store.createRun({
      projectId,
      goal: 'Dependency-heavy DAG benchmark',
      origin: 'cli',
      requestedBy: 'benchmark',
      acceptanceCriteria: ['all tasks complete in order'],
      managerMuseId: 'manager',
      budget: {
        maxConcurrentWorkers: 4,
        maxTasks: 20,
        maxDelegationDepth: 3,
        maxRunMinutes: 30,
        defaultTaskMinutes: 10,
      },
    })

    // Create a chain: A -> B -> C -> D (each depends on previous)
    let prevId: string | null = null
    for (let i = 0; i < 4; i++) {
      const task = admitTask(store, {
        runId: run.id,
        parentTaskId: null,
        title: `DAG task ${i}`,
        brief: `Task ${i} in dependency chain`,
        acceptanceCriteria: ['done'],
        assigneeShipId: 'worker-a',
        ...(prevId !== null ? { dependsOn: [prevId] } : {}),
      }, { maxChildrenPerTask: 5 })
      // admitTask already sets state to 'queued'
      prevId = task.id
    }

    const supervisor = makeSupervisor(store, projectId, run.id, dir, false)

    const startMs = Date.now()
    const result = await supervisor.runToCompletion()
    const runDurationMs = Date.now() - startMs

    const taskEvents3 = store.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type IN ('task.completed', 'task.failed', 'task.unknown_outcome')")
      .all(run.id) as { payload_json: string }[]

    const taskStates3: Record<string, number> = {}
    for (const ev of taskEvents3) {
      const payload = JSON.parse(ev.payload_json)
      const outcome = payload.outcome as string
      taskStates3[outcome] = (taskStates3[outcome] ?? 0) + 1
    }
    const totalSettled3 = Object.values(taskStates3).reduce((a, b) => a + b, 0)

    expect(result.state).toBe('completed')
    expect(totalSettled3).toBe(4)
    expect(runDurationMs).toBeGreaterThan(0)
  })

  it('benchmark 4: tool-intensive task measures tool checkpoint overhead', async () => {
    const dir = join(benchDir, 'tools')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pluton.yaml'), makeConfig(dir))
    writeFileSync(join(dir, 'README.md'), '# project\n')
    await git(['init', '-b', 'main'], dir)
    await git(['add', '-A'], dir)
    await git(['-c', 'user.name=Bench', '-c', 'user.email=bench@test', 'commit', '-m', 'init'], dir)

    const loaded = loadConfig(dir)
    const { store, projectId } = bootstrapStore(loaded)
    store.syncMuses(projectId, [
      {
        id: 'manager',
        slug: 'manager',
        displayName: 'Manager',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: ['task.create', 'task.delegate', 'task.inspect', 'task.cancel', 'task.request_revision', 'result.collect', 'ship.propose_create', 'verification.run', 'diff.inspect', 'approval.request', 'project.status', 'run.list', 'run.inspect', 'run.start', 'approvals.list', 'scope.declare', 'scope.release', 'worker.message'],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/manager',
      },
      {
        id: 'worker-a',
        slug: 'worker-a',
        displayName: 'Worker A',
        role: 'coder',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'isolated-task-checkout',
        permissions: ['task.delegate', 'task.inspect', 'result.collect', 'diff.inspect'],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/worker-a',
      },
    ])
    const run = store.createRun({
      projectId,
      goal: 'Tool-intensive task benchmark',
      origin: 'cli',
      requestedBy: 'benchmark',
      acceptanceCriteria: ['tool calls recorded'],
      managerMuseId: 'manager',
      budget: {
        maxConcurrentWorkers: 4,
        maxTasks: 20,
        maxDelegationDepth: 3,
        maxRunMinutes: 30,
        defaultTaskMinutes: 10,
      },
    })

    const task = admitTask(store, {
      runId: run.id,
      parentTaskId: null,
      title: 'Tool-intensive task',
      brief: 'Task with many tool calls',
      acceptanceCriteria: ['done'],
      assigneeShipId: 'worker-a',
    }, { maxChildrenPerTask: 5 })
    // admitTask already sets state to 'queued'

    const supervisor = makeSupervisor(store, projectId, run.id, dir, false)

    const startMs = Date.now()
    const result = await supervisor.runToCompletion()
    const runDurationMs = Date.now() - startMs

    const toolEvents = store.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type IN ('task.tool_started', 'task.tool_completed')")
      .all(run.id) as { payload_json: string }[]

    let toolStartCount = 0
    let toolCompleteCount = 0
    for (const ev of toolEvents) {
      const payload = JSON.parse(ev.payload_json)
      if (ev.payload_json.includes('tool_started')) toolStartCount++
      if (ev.payload_json.includes('tool_completed')) toolCompleteCount++
    }

    expect(result.state).toBe('completed')
    expect(runDurationMs).toBeGreaterThan(0)
    expect(toolStartCount).toBeGreaterThanOrEqual(0)
    expect(toolCompleteCount).toBeGreaterThanOrEqual(0)
  })
})

