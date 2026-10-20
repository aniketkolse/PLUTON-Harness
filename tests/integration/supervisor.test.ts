import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decideApproval, sweepExpiredApprovals } from '../../src/cli/commands/approvals.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import type { LoadedConfig } from '../../src/config/load.ts'
import { PERMISSIONS, type Permission } from '../../src/domain/permissions.ts'
import type { ApprovalRecord, MuseRecord, TaskRecord } from '../../src/domain/models.ts'
import { defaultCapabilities } from '../../src/engines/contract/types.ts'
import type {
  EngineAdapter,
  EngineAuthStatus,
  EngineCapabilities,
  EngineDiscovery,
  EngineEvent,
  EngineModel,
  EngineSession,
  EngineSessionInfo,
  PromptRequest,
  StartSessionRequest,
} from '../../src/engines/contract/types.ts'
import {
  pendingApprovalWaiterCount,
  settleApprovalWaiter,
  type EnginePermissionChannel,
  type EnginePermissionDecision,
  type EnginePermissionRequest,
} from '../../src/engines/interactive-approval.ts'
import { MockEngineAdapter, type MockScriptStep } from '../../src/engines/mock/adapter.ts'
import { QwenEngineAdapter } from '../../src/engines/qwen/adapter.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'
import type { FileLeaseManager } from '../../src/orchestrator/lease-manager.ts'
import { RunSupervisor } from '../../src/orchestrator/supervisor.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import type { PlutonToolBridge, ToolBridgeLimits } from '../../src/tools/bridge.ts'
import { applyTaskVerificationVerdict, finalizeRunVerdict, runVerificationChecks } from '../../src/verify/runner.ts'
import { GitWorkspaceManager } from '../../src/workspace/manager.ts'

/**
 * Supervisor integration (Phase 6): one supervisor drives one run with the
 * deterministic mock engine and a real store — manager plans through the
 * restricted bridge, ready tasks are dispatched to per-Muse engines under the
 * per-Muse lock, dependency order is honored from durable records, failed work
 * fails the run without fabricating anything, and completion only comes from
 * the state machine (verifying → completed) with isolated checkouts on disk.
 */

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

// The default-adapter test below resolves non-qwen kinds through the registry.
registerBuiltinEngines()

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const LIMITS: ToolBridgeLimits = {
  maxChildrenPerTask: 5,
  maxBriefChars: 10_000,
  maxTeamSize: 8,
  maxToolResultChars: 120_000,
  defaultWaitSeconds: 5,
  waitHeartbeatSeconds: 15,
  approvalTtlMinutes: 60,
  maxRevisionsPerTask: 1,
}

interface World {
  dir: string
  store: Store
  projectId: string
  runId: string
  supervisor: RunSupervisor
  workerPrompts: { muse: string; at: number; text: string }[]
  /** Per-Muse isolation fact handed to the adapter factory, in call order. */
  adapterIsolation: { muse: string; isolatedCheckout: boolean }[]
  /** Sessions closed by the supervisor, in close order (leak assertions). */
  closedSessions: { muse: string; sessionId: string }[]
  /** Await the manager's tool hook (already try/caught) and surface any failure. */
  settleTools: () => Promise<void>
}

interface MakeWorldOptions {
  managerScript?: MockScriptStep[]
  managerTools?: (bridge: PlutonToolBridge) => Promise<void>
  workerScripts?: Record<string, MockScriptStep[]>
  isolatedMuses?: string[]
  repoGit?: boolean
  verificationConfigured?: boolean
  maxConcurrentWorkers?: number
  defaultTaskTimeoutMs?: number
  /** Run deadline; keep restart-reconciliation tests SHORT so a stranded task fails fast. */
  runDeadlineMs?: number
  /** Recovery budget per task (default 2). */
  maxRetriesPerTask?: number
  /** CS-9 bounded-shutdown window for the post-loop drain (default 5000 in the supervisor). */
  drainBoundMs?: number
  /** Per-Muse adapter override (e.g. the CS-9 hanging engine); `undefined` uses the mock. */
  adapterOverrideFor?: (museId: string) => EngineAdapter | undefined
  /** Skip the injected adapterFor seam: exercises the supervisor's own default factory. */
  useDefaultAdapters?: boolean
  /** Capture every engine session request (approval-channel wiring assertions). */
  onStartSession?: (museId: string, req: StartSessionRequest) => void
  /** Observe a mock-scripted permission request's answer (read task state synchronously in-hook). */
  onPermissionDecision?: (
    museId: string,
    decision: EnginePermissionDecision,
    request: EnginePermissionRequest,
  ) => void
}

/** The single source for a worker's tool permissions, in-harness and in the operator-funnel context. */
const WORKER_PERMISSIONS: Permission[] = ['task.delegate', 'task.inspect', 'result.collect', 'diff.inspect']

function makeWorld(opts: MakeWorldOptions = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-supervisor-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, '.pluton', 'state'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# project\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const x = 1\n')
  if (opts.repoGit === true) {
    const git = (args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000 })
    git(['init', '-b', 'main'])
    git(['add', '.'])
    git(['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'seed'])
  }

  const db = openDatabase(join(dir, '.pluton', 'state', 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'supervisor-test',
    rootPath: dir,
    configPath: join(dir, 'pluton.yaml'),
    defaultBranch: 'main',
  })
  const isolated = new Set(opts.isolatedMuses ?? [])
  store.syncMuses(project.id, [
    {
      id: 'manager',
      slug: 'manager',
      displayName: 'Manager',
      role: 'supervisor',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'coordinator-read-only',
      permissions: [...PERMISSIONS],
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
      workspacePolicy: isolated.has('worker-a') ? 'isolated-task-checkout' : 'coordinator-read-only',
      permissions: WORKER_PERMISSIONS,
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
      workspacePolicy: isolated.has('worker-b') ? 'isolated-task-checkout' : 'coordinator-read-only',
      permissions: WORKER_PERMISSIONS,
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/worker-b',
    },
  ])
  const run = store.createRun({
    projectId: project.id,
    goal: 'ship the supervisor',
    origin: 'cli',
    requestedBy: 'tester',
    acceptanceCriteria: ['everything is recorded'],
    managerMuseId: 'manager',
    budget: {
      maxConcurrentWorkers: opts.maxConcurrentWorkers ?? 2,
      maxTasks: 20,
      maxDelegationDepth: 3,
      maxRunMinutes: 30,
      defaultTaskMinutes: 10,
    },
  })

  const ref: { supervisor: RunSupervisor | null; toolsError: unknown } = { supervisor: null, toolsError: null }
  const workerPrompts: { muse: string; at: number; text: string }[] = []
  const adapterIsolation: { muse: string; isolatedCheckout: boolean }[] = []
  const closedSessions: { muse: string; sessionId: string }[] = []
  const adapters = new Map<string, MockEngineAdapter>()
  for (const id of ['worker-a', 'worker-b'] as const) {
    adapters.set(
      id,
      new MockEngineAdapter({
        script: opts.workerScripts?.[id] ?? [{ delayMs: 5, outcome: 'success' }],
        onPrompt: (req) => {
          workerPrompts.push({ muse: id, at: Date.now(), text: req.text })
        },
        onStartSession: (req) => {
          opts.onStartSession?.(id, req)
        },
        onPermissionDecision: (decision, request) => {
          opts.onPermissionDecision?.(id, decision, request)
        },
        onSessionClose: (s) => {
          closedSessions.push({ muse: id, sessionId: s.id })
        },
      }),
    )
  }
  let toolsPromise: Promise<void> = Promise.resolve()
  adapters.set(
    'manager',
    new MockEngineAdapter({
      script: opts.managerScript ?? [{ delayMs: 150, text: 'plan', outcome: 'success' }],
      onPrompt: () => {
        const sup = ref.supervisor
        const hook = opts.managerTools
        if (hook && sup) {
          toolsPromise = (async () => {
            try {
              await hook(sup.managerBridge())
            } catch (e) {
              ref.toolsError = e
            }
          })()
        }
      },
      onStartSession: (req) => {
        opts.onStartSession?.('manager', req)
      },
      onPermissionDecision: (decision, request) => {
        opts.onPermissionDecision?.('manager', decision, request)
      },
      onSessionClose: (s) => {
        closedSessions.push({ muse: 'manager', sessionId: s.id })
      },
    }),
  )

  const workspacesRoot = join(dir, '.pluton', 'workspaces')
  const supervisor = new RunSupervisor({
    store,
    projectId: project.id,
    rootDir: dir,
    workspacesRoot,
    runId: run.id,
    limits: LIMITS,
    maxConcurrentWorkers: opts.maxConcurrentWorkers ?? 2,
    defaultTaskTimeoutMs: opts.defaultTaskTimeoutMs ?? 15_000,
    runDeadlineMs: opts.runDeadlineMs ?? 20_000,
    verificationConfigured: opts.verificationConfigured ?? false,
    loopPollMs: 20,
    maxRetriesPerTask: opts.maxRetriesPerTask ?? 2,
    ...(opts.drainBoundMs !== undefined ? { drainBoundMs: opts.drainBoundMs } : {}),
    ...(opts.useDefaultAdapters === true
      ? {}
      : {
          adapterFor: (muse: MuseRecord, session) => {
            adapterIsolation.push({ muse: muse.id, isolatedCheckout: session.isolatedCheckout })
            const override = opts.adapterOverrideFor?.(muse.id)
            if (override !== undefined) return override
            const adapter = adapters.get(muse.id)
            if (!adapter) throw new Error(`no mock adapter for muse ${muse.id}`)
            return adapter
          },
        }),
    workspaceManager: new GitWorkspaceManager({ workspacesRoot }),
    diagnostic: () => {},
  })
  ref.supervisor = supervisor

  return {
    dir,
    store,
    projectId: project.id,
    runId: run.id,
    supervisor,
    workerPrompts,
    adapterIsolation,
    closedSessions,
    settleTools: async () => {
      await toolsPromise
      if (ref.toolsError !== null) throw ref.toolsError
    },
  }
}

async function createViaBridge(
  bridge: PlutonToolBridge,
  args: { title: string; assigneeMuseId: string; dependsOn?: string[] },
): Promise<{ id: string; state: string }> {
  const res = await bridge.call('task.create', {
    title: args.title,
    brief: 'do it well',
    acceptanceCriteria: ['done'],
    assigneeMuseId: args.assigneeMuseId,
    ...(args.dependsOn ? { dependsOn: args.dependsOn } : {}),
  })
  expect(res.ok).toBe(true)
  return (res.data as { task: { id: string; state: string } }).task
}

function eventCount(store: Store, runId: string, type: string): number {
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ?').get(runId, type) as {
    n: number
  }
  return row.n
}

describe('RunSupervisor — plan, dispatch, collect', () => {
  it('runs the manager plan on real engines order and completes the run', async () => {
    const created: string[] = []
    const world = makeWorld({
      managerScript: [{ delayMs: 200, text: 'manager report', outcome: 'success' }],
      managerTools: async (bridge) => {
        const t1 = await createViaBridge(bridge, { title: 'T1', assigneeMuseId: 'worker-a' })
        created.push(t1.id)
        expect(t1.state).toBe('queued')
        const t2 = await createViaBridge(bridge, {
          title: 'T2',
          assigneeMuseId: 'worker-b',
          dependsOn: [t1.id],
        })
        created.push(t2.id)
      },
      workerScripts: {
        'worker-a': [{ delayMs: 30, outcome: 'success' }],
        'worker-b': [{ delayMs: 10, outcome: 'success' }],
      },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(out.state).toBe('completed')
    expect(out.outcome).toBe('success')
    expect(out.unfinishedTasks).toEqual([])
    expect(out.taskCounts).toMatchObject({ completed: 2 })
    expect(out.managerSummary).toBe('mock:success')

    const [t1id, t2id] = created
    const t1 = world.store.getTask(t1id as string)
    const t2 = world.store.getTask(t2id as string)
    expect(t1.state).toBe('completed')
    expect(t2.state).toBe('completed')
    // Dependency order read from durable records: T2 never started before T1 finished.
    expect(new Date(t2.startedAt as string).getTime()).toBeGreaterThanOrEqual(
      new Date(t1.completedAt as string).getTime(),
    )
    expect(t1.result).toMatchObject({ outcome: 'success', engine: 'mock' })
    expect(t1.engineSessionId).not.toBeNull()

    expect(eventCount(world.store, world.runId, 'run.started')).toBe(1)
    expect(eventCount(world.store, world.runId, 'task.started')).toBe(2)
    expect(eventCount(world.store, world.runId, 'task.completed')).toBe(2)
    expect(eventCount(world.store, world.runId, 'run.finished')).toBe(1)
    expect(world.store.getRun(world.runId).finalSummary).toBe('mock:success')
  })

  it('fails the run when a task fails, leaving dependents visibly queued', async () => {
    const created: string[] = []
    const world = makeWorld({
      managerTools: async (bridge) => {
        const t1 = await createViaBridge(bridge, { title: 'T1', assigneeMuseId: 'worker-a' })
        created.push(t1.id)
        const t2 = await createViaBridge(bridge, {
          title: 'T2',
          assigneeMuseId: 'worker-b',
          dependsOn: [t1.id],
        })
        created.push(t2.id)
      },
      workerScripts: {
        'worker-a': [{ delayMs: 10, outcome: 'failure', text: 'boom' }],
        'worker-b': [{ delayMs: 10, outcome: 'success' }],
      },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(out.state).toBe('failed')
    expect(out.outcome).toBe('failure')
    const [t1id, t2id] = created
    expect(world.store.getTask(t1id as string).state).toBe('failed')
    expect(world.store.getTask(t1id as string).failure).toMatchObject({ outcome: 'failure' })
    expect(world.store.getTask(t2id as string).state).toBe('queued') // never silently skipped
    expect(out.unfinishedTasks).toEqual([t2id])
    expect(eventCount(world.store, world.runId, 'task.failed')).toBe(1)
    // The dependent's engine never ran.
    expect(world.workerPrompts.filter((p) => p.muse === 'worker-b')).toHaveLength(0)
  })

  it('serializes tasks assigned to the same Muse', async () => {
    const world = makeWorld({
      managerTools: async (bridge) => {
        await createViaBridge(bridge, { title: 'S1', assigneeMuseId: 'worker-a' })
        await createViaBridge(bridge, { title: 'S2', assigneeMuseId: 'worker-a' })
      },
      workerScripts: {
        'worker-a': [{ delayMs: 200, outcome: 'success' }],
      },
      maxConcurrentWorkers: 2,
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(out.state).toBe('completed')
    expect(out.taskCounts).toMatchObject({ completed: 2 })
    const prompts = world.workerPrompts.filter((p) => p.muse === 'worker-a')
    expect(prompts).toHaveLength(2)
    // The second prompt starts only after the first 200 ms turn finished.
    expect((prompts[1] as { at: number }).at - (prompts[0] as { at: number }).at).toBeGreaterThanOrEqual(150)
  })

  it('creates an isolated checkout on a run branch for isolated Muses (real git)', async () => {
    const created: string[] = []
    const world = makeWorld({
      repoGit: true,
      isolatedMuses: ['worker-a'],
      managerTools: async (bridge) => {
        const t = await createViaBridge(bridge, { title: 'checkout task', assigneeMuseId: 'worker-a' })
        created.push(t.id)
      },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()
    expect(out.state).toBe('completed')

    const task = world.store.getTask(created[0] as string)
    const ws = world.store.getWorkspaceByTask(task.id)
    expect(ws).not.toBeNull()
    expect(task.workspaceId).toBe(ws?.id)
    expect(ws?.branch).toContain(world.runId)
    const head = execFileSync('git', ['-C', ws?.path as string, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim()
    expect(head).toBe(ws?.branch)
    // The user's repository keeps its own branch untouched.
    const rootHead = execFileSync('git', ['-C', world.dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim()
    expect(rootHead).toBe('main')
  })

  it('snapshots the worker assignment at claim time — history survives later muse config edits', async () => {
    const created: string[] = []
    const world = makeWorld({
      managerScript: [{ delayMs: 100, text: 'plan', outcome: 'success' }],
      managerTools: async (bridge) => {
        const t1 = await createViaBridge(bridge, { title: 'T1', assigneeMuseId: 'worker-a' })
        created.push(t1.id)
      },
      workerScripts: { 'worker-a': [{ delayMs: 5, outcome: 'success' }] },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()
    expect(out.state).toBe('completed')

    const taskId = created[0] as string
    const snapshot = { museId: 'worker-a', role: 'coder', engine: 'mock', model: 'mock/model-a' }
    expect(world.store.getTask(taskId).assignment).toEqual(snapshot)

    // A later config edit changes future assignments, never recorded history.
    world.store.updateMuseModel('worker-a', 'mock/model-b')
    expect(world.store.getMuse('worker-a')?.model).toBe('mock/model-b')
    expect(world.store.getTask(taskId).assignment).toEqual(snapshot)

    const res = await world.supervisor.managerBridge().call('task.get_result', { taskId })
    expect(res.ok).toBe(true)
    expect((res.data as { assignment: unknown }).assignment).toEqual(snapshot)
  })

  it('proves checkout isolation to the adapter factory, per session, from workspace facts', async () => {
    // The qwen allow_once grant is only permitted when the runtime can prove a
    // throwaway checkout; this pins the proof: a real workspace row marks the
    // task session isolated, while project-root sessions (manager, and tasks of
    // non-checkout Muses) are explicitly not.
    const world = makeWorld({
      repoGit: true,
      isolatedMuses: ['worker-a'],
      managerTools: async (bridge) => {
        await createViaBridge(bridge, { title: 'isolated', assigneeMuseId: 'worker-a' })
        await createViaBridge(bridge, { title: 'shared-root', assigneeMuseId: 'worker-b' })
      },
      workerScripts: {
        'worker-a': [{ delayMs: 5, outcome: 'success' }],
        'worker-b': [{ delayMs: 5, outcome: 'success' }],
      },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()
    expect(out.state).toBe('completed')

    const seen = new Map(world.adapterIsolation.map((entry) => [entry.muse, entry.isolatedCheckout]))
    expect(seen.get('worker-a')).toBe(true) // real checkout on a run branch
    expect(seen.get('worker-b')).toBe(false) // coordinator-read-only Muse, project root
    expect(seen.get('manager')).toBe(false) // manager session, project root
  }, 20_000)

  it('stops successful tasks in verifying when verification checks exist', async () => {
    const world = makeWorld({
      verificationConfigured: true,
      managerTools: async (bridge) => {
        await createViaBridge(bridge, { title: 'V1', assigneeMuseId: 'worker-a' })
      },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(out.state).toBe('verifying')
    expect(out.outcome).toBe('pending_verification')
    const tasks = world.store.listTasks(world.runId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.state).toBe('verifying')
    expect(tasks[0]?.result).toMatchObject({ outcome: 'success' })
    expect(eventCount(world.store, world.runId, 'task.awaiting_verification')).toBe(1)
    expect(eventCount(world.store, world.runId, 'task.completed')).toBe(0)
  })

  it('work-settled: task.wait returns when a verification-gated task reaches verifying', async () => {
    // Regression pin (host-mode smoke, 2026-10-16): the manager waited the whole
    // run deadline for `completed` while its worker sat in `verifying` — that is
    // settled work and only the operator's gate can close it.
    const waited: { timedOut?: boolean; state?: string; awaitingVerification?: boolean } = {}
    const world = makeWorld({
      verificationConfigured: true,
      managerTools: async (bridge) => {
        const t = await createViaBridge(bridge, { title: 'V3', assigneeMuseId: 'worker-a' })
        const res = await bridge.call('task.wait', { taskIds: [t.id], timeoutSeconds: 5 })
        const data = res.data as { timedOut: boolean; tasks: { state: string; awaitingVerification: boolean }[] }
        waited.timedOut = data.timedOut
        waited.state = data.tasks[0]?.state
        waited.awaitingVerification = data.tasks[0]?.awaitingVerification
      },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(waited.timedOut).toBe(false)
    expect(waited.state).toBe('verifying')
    expect(waited.awaitingVerification).toBe(true)
    expect(out.state).toBe('verifying') // still not a success claim
  }, 20_000)

  it('records engine approval requests durably (never silently drops a denial)', async () => {
    // Regression pin (host-mode smoke, 2026-10-16): the qwen worker's edit was
    // denied fail-closed, the approval event was dropped by the supervisor, and
    // the task still claimed success. Every engine ask must leave a record.
    const created: string[] = []
    const world = makeWorld({
      managerTools: async (bridge) => {
        const t = await createViaBridge(bridge, { title: 'A1', assigneeMuseId: 'worker-a' })
        created.push(t.id)
      },
      workerScripts: {
        'worker-a': [
          {
            events: [{ kind: 'approval_request', requestId: 'req-1', description: 'edit denied (approvalPolicy=deny)' }],
            delayMs: 5,
            outcome: 'success',
          },
        ],
      },
    })

    await world.supervisor.runToCompletion()
    await world.settleTools()

    const row = world.store.db
      .prepare(
        "SELECT task_id, muse_id, payload_json FROM events WHERE run_id = ? AND type = 'approval.engine_decision'",
      )
      .get(world.runId) as { task_id: string | null; muse_id: string | null; payload_json: string } | undefined
    expect(row?.task_id).toBe(created[0])
    expect(row?.muse_id).toBe('worker-a')
    expect(JSON.parse(row?.payload_json as string)).toMatchObject({
      requestId: 'req-1',
      description: 'edit denied (approvalPolicy=deny)',
    })
  })

  it('sanitizes engine-provided approval descriptions before they reach the store', async () => {
    const created: string[] = []
    const world = makeWorld({
      managerTools: async (bridge) => {
        const t = await createViaBridge(bridge, { title: 'A1', assigneeMuseId: 'worker-a' })
        created.push(t.id)
      },
      workerScripts: {
        'worker-a': [
          {
            events: [
              { kind: 'approval_request', requestId: 'req-esc', description: 'deny\u001b[2Jspoof\u202ereversed text' },
            ],
            delayMs: 5,
            outcome: 'success',
          },
        ],
      },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()
    expect(created).toHaveLength(1)

    const row = world.store.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'approval.engine_decision'")
      .get(world.runId) as { payload_json: string } | undefined
    const payload = JSON.parse(row?.payload_json as string) as { description?: string }
    expect(payload.description).toContain('reversed text')
    expect(payload.description).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/)
    expect(out.state).toBe('completed')
  }, 20_000)

  it('the default per-Muse factory routes through the approval-aware wiring (no injected seam)', () => {
    // Pin for the smoke regression: reverting `adapterFor`'s default to a bare
    // registry lookup must fail this test, not just the unit mapping tests.
    const world = makeWorld({ useDefaultAdapters: true })

    const bounded = world.supervisor.adapterFor(
      {
        engineKind: 'qwen',
        approvalMode: 'autonomous-bounded',
      } as unknown as MuseRecord,
      { isolatedCheckout: true },
    )
    expect(bounded).toBeInstanceOf(QwenEngineAdapter)
    expect((bounded as QwenEngineAdapter).sessionApproval).toEqual({ mode: 'auto', policy: 'allow_once' })

    // Without the proven-checkout fact the same Muse must go interactive:
    // allow_once is reserved for sessions bounded by a throwaway checkout.
    const projectRoot = world.supervisor.adapterFor(
      {
        engineKind: 'qwen',
        approvalMode: 'autonomous-bounded',
      } as unknown as MuseRecord,
      { isolatedCheckout: false },
    )
    expect((projectRoot as QwenEngineAdapter).sessionApproval).toEqual({ mode: 'auto', policy: 'interactive' })

    const askAlways = world.supervisor.adapterFor(
      {
        engineKind: 'qwen',
        approvalMode: 'ask-always',
      } as unknown as MuseRecord,
      { isolatedCheckout: false },
    )
    expect((askAlways as QwenEngineAdapter).sessionApproval).toEqual({ mode: 'default', policy: 'interactive' })

    // Non-qwen kinds still resolve through the engine registry.
    expect(
      world.supervisor.adapterFor({ engineKind: 'mock', approvalMode: 'ask-always' } as unknown as MuseRecord, {
        isolatedCheckout: true,
      }),
    ).toBeInstanceOf(MockEngineAdapter)
  })

  it('wires a durable operator approval channel into every engine session', async () => {
    const captured: Array<{ muse: string; req: StartSessionRequest }> = []
    let taskId = ''
    const world = makeWorld({
      onStartSession: (muse, req) => captured.push({ muse, req }),
      managerTools: async (bridge) => {
        taskId = (await createViaBridge(bridge, { title: 'A1', assigneeMuseId: 'worker-a' })).id
      },
      // The asks below ride the channels of the LIVE run. Under run ownership
      // (A2) every channel write is fence-gated, and the claim is released
      // when the run ends — so the asks belong in the run's lifetime, not
      // after it. Long sessions keep that window comfortably open.
      managerScript: [{ delayMs: 2_000, text: 'plan', outcome: 'success' }],
      workerScripts: { 'worker-a': [{ delayMs: 2_000, outcome: 'success' }] },
    })

    const run = world.supervisor.runToCompletion()
    await waitForDurable(
      'both engine sessions',
      () => captured.some((c) => c.muse === 'worker-a') && captured.some((c) => c.muse === 'manager'),
    )
    await world.settleTools()

    const worker = captured.find((c) => c.muse === 'worker-a')
    const manager = captured.find((c) => c.muse === 'manager')
    expect(worker?.req.approvals).toBeTruthy()
    expect(manager?.req.approvals).toBeTruthy()

    // An engine ask becomes a durable approval bound to this run/task/Muse …
    const request = worker!.req.approvals!.requestPermission({
      requestId: 'call_w1',
      description: 'engine requested permission: write src/app.ts',
      scope: { toolKind: 'edit' },
    })
    const mine = world.store
      .listApprovals(world.runId)
      .filter((a) => a.action === 'engine.permission' && a.status === 'pending')
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      runId: world.runId,
      taskId,
      requestedByMuseId: 'worker-a',
    })
    expect(mine[0]!.expiresAt).not.toBeNull()

    // … and the engine only proceeds once the operator approves that record.
    world.store.setApprovalStatus(mine[0]!.id, 'approved', { decidedBy: 'operator' })
    expect(settleApprovalWaiter(mine[0]!.id, 'approved')).toBe(true)
    await expect(request).resolves.toBe('allow')
    expect(pendingApprovalWaiterCount()).toBe(0)

    // The manager session gets its own channel, bound to the manager Muse.
    const ask = manager!.req.approvals!.requestPermission({
      requestId: 'call_m1',
      description: 'engine requested permission: run a shell command',
      scope: {},
    })
    const managerPending = world.store
      .listApprovals(world.runId)
      .filter((a) => a.action === 'engine.permission' && a.status === 'pending')
    expect(managerPending).toHaveLength(1)
    expect(managerPending[0]).toMatchObject({ taskId: null, requestedByMuseId: 'manager' })

    // Run teardown (engine shutdown/cancel) settles fail-closed, never hangs.
    manager!.req.approvals!.abort('test teardown')
    await expect(ask).resolves.toBe('deny')
    expect(pendingApprovalWaiterCount()).toBe(0)

    const out = await run
    expect(out.state).toBe('completed')
  })

  it('fails the run when the manager itself fails, without inventing tasks', async () => {
    const world = makeWorld({
      managerScript: [{ delayMs: 10, outcome: 'failure', text: 'cannot plan' }],
    })

    const out = await world.supervisor.runToCompletion()

    expect(out.state).toBe('failed')
    expect(out.outcome).toBe('failure')
    expect(out.taskCounts).toEqual({})
    expect(out.unfinishedTasks).toEqual([])
    expect(world.store.listTasks(world.runId)).toHaveLength(0)
    expect(world.store.getRun(world.runId).finalSummary).toBe('mock:failure')
  })

  it('verification closes the run through the gate (supervisor → verify → completed)', async () => {
    const world = makeWorld({
      verificationConfigured: true,
      managerTools: async (bridge) => {
        await createViaBridge(bridge, { title: 'V2', assigneeMuseId: 'worker-a' })
      },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()
    expect(out.state).toBe('verifying')

    const task = world.store.listTasks(world.runId)[0]
    const report = await runVerificationChecks({
      store: world.store,
      projectId: world.projectId,
      runId: world.runId,
      taskId: task?.id as string,
      checks: [{ name: 'ok', command: [process.execPath, '-e', 'process.exit(0)'] }],
      cwd: world.dir,
      workspaceId: null,
      artifactsDir: join(world.dir, '.pluton', 'state', 'artifacts'),
    })
    expect(report.allPassed).toBe(true)
    const verdict = applyTaskVerificationVerdict(world.store, task?.id as string)
    expect(verdict.state).toBe('completed')
    const runVerdict = finalizeRunVerdict(world.store, world.runId)
    expect(runVerdict).toMatchObject({ state: 'completed', outcome: 'success' })
    expect(world.store.getRun(world.runId).state).toBe('completed')
  })

  it('a prompt that exceeds its bound becomes unknown_outcome — never success, never replayed', async () => {
    const world = makeWorld({
      defaultTaskTimeoutMs: 150,
      managerTools: async (bridge) => {
        await createViaBridge(bridge, { title: 'slow task', assigneeMuseId: 'worker-a' })
      },
      workerScripts: { 'worker-a': [{ delayMs: 2_000, outcome: 'success' }] },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(out.state).toBe('failed')
    expect(out.outcome).toBe('failure')
    expect(out.taskCounts).toMatchObject({ unknown_outcome: 1 })
    const task = world.store.listTasks(world.runId)[0]
    expect(task?.state).toBe('unknown_outcome')
    expect(task?.failure).toMatchObject({ outcome: 'unknown', error: 'prompt_timeout' })
    expect(eventCount(world.store, world.runId, 'task.unknown_outcome')).toBe(1)
    expect(eventCount(world.store, world.runId, 'task.completed')).toBe(0)
  })

  it('an engine protocol crash is recorded as unknown_outcome, not as a failure or success', async () => {
    const world = makeWorld({
      managerTools: async (bridge) => {
        await createViaBridge(bridge, { title: 'crashy task', assigneeMuseId: 'worker-a' })
      },
      workerScripts: { 'worker-a': [{ protocolCrash: true }] },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(out.state).toBe('failed')
    expect(out.outcome).toBe('failure')
    const task = world.store.listTasks(world.runId)[0]
    expect(task?.state).toBe('unknown_outcome')
    expect(task?.failure).toMatchObject({ outcome: 'unknown' })
    expect(JSON.stringify(task?.failure)).toContain('mock_protocol_crash')
    expect(eventCount(world.store, world.runId, 'task.unknown_outcome')).toBe(1)
  })

  it('closes the manager session when the run settles (container-smoke leak finding)', async () => {
    const world = makeWorld({
      managerTools: async (bridge) => {
        await createViaBridge(bridge, { title: 'work', assigneeMuseId: 'worker-a' })
      },
      workerScripts: { 'worker-a': [{ delayMs: 5, outcome: 'success' }] },
    })

    await world.supervisor.runToCompletion()
    await world.settleTools()

    const managerCloses = world.closedSessions.filter((s) => s.muse === 'manager')
    expect(managerCloses).toHaveLength(1)
    // Both task and manager sessions are closed exactly once each.
    expect(world.closedSessions.filter((s) => s.muse === 'worker-a')).toHaveLength(1)
  })

  it('closes a task session even when the prompt throws (no leak on transport failure)', async () => {
    const world = makeWorld({
      managerTools: async (bridge) => {
        await createViaBridge(bridge, { title: 'throwing task', assigneeMuseId: 'worker-a' })
      },
      workerScripts: { 'worker-a': [{ throw: 'engine transport exploded' }] },
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(out.state).toBe('failed')
    const task = world.store.listTasks(world.runId)[0]
    // A transport throw is `unknown` (never replayed, never claimed as failure)…
    expect(task?.state).toBe('unknown_outcome')
    expect(task?.failure).toMatchObject({ outcome: 'unknown' })
    expect(JSON.stringify(task?.failure)).toContain('engine transport exploded')
    // …and the session must still be closed on that path.
    expect(world.closedSessions.filter((s) => s.muse === 'worker-a')).toHaveLength(1)
    expect(world.closedSessions.filter((s) => s.muse === 'manager')).toHaveLength(1)
  })

  it('a repeated dispatch in the same tick cannot start a queued task twice', async () => {
    const workerSessions: string[] = []
    const world = makeWorld({
      verificationConfigured: true,
      // Two concurrent workers: the second pass is only stopped by the in-flight
      // guard, not by the concurrency cap.
      maxConcurrentWorkers: 2,
      onStartSession: (muse) => {
        if (muse === 'worker-a') workerSessions.push(muse)
      },
      workerScripts: { 'worker-a': [{ delayMs: 5, outcome: 'success' }] },
    })
    const task = world.store.createTask({
      runId: world.runId,
      title: 'D1',
      brief: 'do it well',
      acceptanceCriteria: ['done'],
      assigneeMuseId: 'worker-a',
    })
    world.store.setTaskState(task.id, 'queued')

    // Two dispatch passes in the same synchronous tick — the repeated
    // tick/wakeup a scheduler can produce before the first executor has claimed.
    // `dispatchReadyTasks` is private: the narrowest seam that expresses a
    // same-tick repeat with no timing race (the store CAS is the hard guarantee).
    const sup = world.supervisor as unknown as {
      dispatchReadyTasks(): void
      inFlight: Map<string, Promise<void>>
    }
    sup.dispatchReadyTasks()
    sup.dispatchReadyTasks()

    // Drain every executor the passes spawned.
    for (let i = 0; i < 5; i++) {
      const pending = [...sup.inFlight.values()]
      if (pending.length === 0) break
      await Promise.all(pending)
    }

    expect(workerSessions).toHaveLength(1)
    expect(world.workerPrompts.filter((p) => p.muse === 'worker-a')).toHaveLength(1)
    expect(world.closedSessions.filter((s) => s.muse === 'worker-a')).toHaveLength(1)
    expect(eventCount(world.store, world.runId, 'task.started')).toBe(1)
    // The single worker stops at the verification gate; a second executor would
    // claim from `verifying`, throw, and fail the task through the outer catch.
    expect(world.store.getTask(task.id).state).toBe('verifying')
    expect(eventCount(world.store, world.runId, 'task.failed')).toBe(0)
  })

  it('records a late worker result as discarded when the task already settled', async () => {
    let world!: World
    let taskId = ''
    const cancels: string[] = []
    world = makeWorld({
      managerTools: async (bridge) => {
        taskId = (await createViaBridge(bridge, { title: 'L1', assigneeMuseId: 'worker-a' })).id
      },
      // The scripted turn is long enough that it can only ever end through CS-9's
      // state-driven interrupt (a broken interrupt would wait out the prompt bound).
      workerScripts: { 'worker-a': [{ delayMs: 5_000, outcome: 'success' }] },
      onStartSession: (muse) => {
        if (muse !== 'worker-a') return
        // Simulated operator cancel, arranged without polling: this 0 ms timer is
        // armed while the session starts, BEFORE the mock prompt arms its own
        // 5 s delay, and the running-state write happens in microtasks — so the
        // cancel always lands while the prompt is still in flight.
        setTimeout(() => {
          const task = world.store.getTask(taskId)
          world.store.setTaskState(task.id, 'cancelled', { failure: { code: 'operator_cancelled' } })
          cancels.push(task.id)
        }, 0)
      },
    })

    await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(cancels).toEqual([taskId])
    expect(world.workerPrompts.filter((p) => p.muse === 'worker-a')).toHaveLength(1)

    // CS-9: the loop's next tick interrupted the session, so the late arrival is
    // the interrupt's `cancelled` result — never the scripted success; it never
    // applies: the task stays cancelled and the result survives durably as a
    // discarded event.
    expect(world.store.getTask(taskId).state).toBe('cancelled')
    expect(eventCount(world.store, world.runId, 'task.late_result_discarded')).toBe(1)
    const row = world.store.db
      .prepare("SELECT task_id, payload_json FROM events WHERE run_id = ? AND type = 'task.late_result_discarded'")
      .get(world.runId) as { task_id: string | null; payload_json: string } | undefined
    expect(row?.task_id).toBe(taskId)
    expect(JSON.parse(row?.payload_json as string)).toEqual({
      taskId,
      outcome: 'cancelled',
      currentState: 'cancelled',
    })
    expect(eventCount(world.store, world.runId, 'task.failed')).toBe(0)
    expect(world.closedSessions.filter((s) => s.muse === 'worker-a')).toHaveLength(1)
  }, 20_000)

  it('a lost claim stays silent and never releases the winner lease rows', async () => {
    const startedSessions: string[] = []
    const world = makeWorld({
      onStartSession: (muse) => {
        startedSessions.push(muse)
      },
    })
    const task = world.store.createTask({
      runId: world.runId,
      title: 'L2',
      brief: 'do it well',
      acceptanceCriteria: ['done'],
      assigneeMuseId: 'worker-a',
      writeScope: ['src/a.ts'],
    })
    world.store.setTaskState(task.id, 'queued')
    // Another claimant already won: the task is no longer `queued` when this
    // process's executor runs.
    world.store.setTaskState(task.id, 'admitted')

    // The losing instance had already declared + recorded the task's scope
    // during its dispatch, exactly as `dispatchReadyTasks` does.
    const sup = world.supervisor as unknown as {
      executeTask(task: TaskRecord): Promise<void>
      leaseManager: FileLeaseManager
    }
    const declared = sup.leaseManager.declareScope(world.runId, task.id, 'worker-a', ['src/a.ts'])
    expect(declared.acquired).toEqual(['src/a.ts'])
    world.store.recordLease({
      id: 'lease_lost_claim',
      runId: world.runId,
      taskId: task.id,
      museId: 'worker-a',
      path: 'src/a.ts',
    })

    // `executeTask` is private: the narrowest seam that runs the executor for an
    // already-claimed task (a cross-instance lost claim, with no timing race).
    await sup.executeTask(world.store.getTask(task.id))

    // Lost claim: silent, event-free — and above all, the winner's DB rows stay
    // active for the winner to release when its own executor finishes.
    expect(world.store.getTask(task.id).state).toBe('admitted')
    expect(startedSessions).toHaveLength(0)
    expect(eventCount(world.store, world.runId, 'scope.released')).toBe(0)
    expect(eventCount(world.store, world.runId, 'task.failed')).toBe(0)
    expect(eventCount(world.store, world.runId, 'task.late_result_discarded')).toBe(0)
    expect(world.store.listActiveLeases(world.runId).map((l) => l.path)).toEqual(['src/a.ts'])
    // …while this process's own in-memory hold is still dropped.
    expect(sup.leaseManager.getTaskLeases(task.id)).toEqual([])
  })
})

/**
 * Restart reconciliation (CS-2). A process that died cannot resume any engine
 * session: session-backed tasks must be requeued (or terminalized honestly),
 * stale per-task checkouts reattached or archived — never overwritten or
 * deleted — and dead sessions abandoned explicitly.
 */
type StrandedState = 'admitted' | 'running' | 'waiting_for_children' | 'needs_input' | 'needs_approval'

function seedTask(world: World, title: string): TaskRecord {
  return world.store.createTask({
    runId: world.runId,
    title,
    brief: 'do it well',
    acceptanceCriteria: ['done'],
    assigneeMuseId: 'worker-a',
  })
}

/** Walk legal edges to leave a task in a state only a dead process could have written. */
function strandTask(
  world: World,
  task: TaskRecord,
  state: StrandedState,
  patch: { attempt?: number; engineSessionId?: string; workspaceId?: string } = {},
): TaskRecord {
  world.store.setTaskState(task.id, 'queued')
  world.store.setTaskState(task.id, 'admitted', state === 'admitted' ? patch : {})
  if (state !== 'admitted') {
    world.store.setTaskState(task.id, 'running', patch)
    if (state !== 'running') world.store.setTaskState(task.id, state)
  }
  return world.store.getTask(task.id)
}

function eventsOfType(world: World, type: string): { taskId: string | null; payload: Record<string, unknown> }[] {
  const rows = world.store.db
    .prepare('SELECT task_id, payload_json FROM events WHERE run_id = ? AND type = ? ORDER BY seq ASC')
    .all(world.runId, type) as { task_id: string | null; payload_json: string }[]
  return rows.map((r) => ({ taskId: r.task_id, payload: JSON.parse(r.payload_json) as Record<string, unknown> }))
}

/** One isolated task whose checkout predates the restart, with a dirty file inside it. */
async function makeIsolatedWorld(
  title: string,
  opts: { corruptMarker?: boolean; deleteCheckout?: boolean } = {},
) {
  const world = makeWorld({ repoGit: true, isolatedMuses: ['worker-a'], runDeadlineMs: 6_000 })
  const task = seedTask(world, title)
  // The checkout a previous process created for this task, exactly as the
  // supervisor creates it (real git, real marker).
  const manager = new GitWorkspaceManager({ workspacesRoot: join(world.dir, '.pluton', 'workspaces') })
  const info = await manager.createCheckout({
    repoPath: world.dir,
    kind: 'task-checkout',
    runId: world.runId,
    slug: task.title,
    destName: task.id,
  })
  const ws = world.store.createWorkspace({
    projectId: world.projectId,
    runId: world.runId,
    taskId: task.id,
    museId: 'worker-a',
    kind: 'task-checkout',
    path: info.path,
    branch: info.branch,
    baseCommit: info.baseCommit,
  })
  writeFileSync(join(info.path, 'dirty.txt'), 'uncommitted work\n')
  if (opts.corruptMarker === true) rmSync(join(info.path, '.git', 'pluton-workspace.json'))
  if (opts.deleteCheckout === true) rmSync(info.path, { recursive: true, force: true })
  strandTask(world, task, 'running', { engineSessionId: 'sess-dead', workspaceId: ws.id })
  return { world, task, manager, info, ws }
}

describe('RunSupervisor — restart reconciliation', () => {
  it('T1 recovers a running task: requeue, abandon the dead session, clear the session id', async () => {
    let world!: World
    let taskId = ''
    const sessionIdsSeenAtStart: (string | null)[] = []
    world = makeWorld({
      runDeadlineMs: 2_000,
      onStartSession: (muse) => {
        if (muse !== 'worker-a') return
        // The new attempt must not inherit the dead process's session id.
        sessionIdsSeenAtStart.push(world.store.getTask(taskId).engineSessionId)
      },
    })
    const seeded = seedTask(world, 'R1')
    taskId = seeded.id
    strandTask(world, seeded, 'running', { engineSessionId: 'sess-old' })

    const out = await world.supervisor.runToCompletion()

    const settled = world.store.getTask(taskId)
    expect(settled.state).toBe('completed')
    expect(out.state).toBe('completed')
    expect(world.workerPrompts.filter((p) => p.muse === 'worker-a')).toHaveLength(1)
    expect(sessionIdsSeenAtStart).toEqual([null])
    expect(settled.engineSessionId).not.toBe('sess-old')
    expect(settled.engineSessionId).not.toBeNull()
    expect(eventsOfType(world, 'task.recovered')).toEqual([
      { taskId, payload: { taskId, priorState: 'running', attempt: 1 } },
    ])
    expect(eventsOfType(world, 'task.session_abandoned')).toEqual([
      { taskId, payload: { sessionId: 'sess-old' } },
    ])
  })

  it('T2 recovers an admitted task (claimed, no session yet) after a restart', async () => {
    const world = makeWorld({ runDeadlineMs: 2_000 })
    const seeded = strandTask(world, seedTask(world, 'R2'), 'admitted')

    const out = await world.supervisor.runToCompletion()

    expect(out.state).toBe('completed')
    expect(world.store.getTask(seeded.id).state).toBe('completed')
    expect(world.workerPrompts.filter((p) => p.muse === 'worker-a')).toHaveLength(1)
    expect(eventsOfType(world, 'task.recovered')).toEqual([
      { taskId: seeded.id, payload: { taskId: seeded.id, priorState: 'admitted', attempt: 1 } },
    ])
    // No engine session existed yet, so nothing can be abandoned.
    expect(eventsOfType(world, 'task.session_abandoned')).toEqual([])
  })

  it('T3 recovers a task stranded in needs_approval (defensive, seeded) after a restart', async () => {
    const world = makeWorld({ runDeadlineMs: 2_000 })
    const seeded = strandTask(world, seedTask(world, 'R3'), 'needs_approval')

    const out = await world.supervisor.runToCompletion()

    expect(out.state).toBe('completed')
    expect(world.store.getTask(seeded.id).state).toBe('completed')
    expect(eventsOfType(world, 'task.recovered')).toEqual([
      { taskId: seeded.id, payload: { taskId: seeded.id, priorState: 'needs_approval', attempt: 1 } },
    ])
  })

  it('T4 caps recovery: an exhausted attempt terminalizes as unknown_outcome, never a rerun or a fabricated success', async () => {
    const world = makeWorld({ runDeadlineMs: 2_000, maxRetriesPerTask: 2 })
    const seeded = strandTask(world, seedTask(world, 'R4'), 'running', {
      attempt: 2,
      engineSessionId: 'sess-dead',
    })

    const out = await world.supervisor.runToCompletion()

    const task = world.store.getTask(seeded.id)
    expect(task.state).toBe('unknown_outcome')
    expect(task.failure).toMatchObject({ code: 'recovery_exhausted' })
    expect(JSON.stringify(task.failure)).toContain("state 'running'")
    expect(JSON.stringify(task.failure)).toContain('attempt 2 of 2')
    // No engine ever ran for this task after the restart.
    expect(world.workerPrompts.filter((p) => p.muse === 'worker-a')).toHaveLength(0)
    expect(eventsOfType(world, 'task.recovery_exhausted')).toEqual([
      { taskId: seeded.id, payload: { taskId: seeded.id, priorState: 'running', attempt: 2 } },
    ])
    expect(eventsOfType(world, 'task.recovered')).toEqual([])
    // The run never claims success for work whose outcome is unknown.
    expect(out.outcome).not.toBe('success')
    expect(out.state).toBe('failed')
  })

  it('T5 reattaches the SAME checkout after a restart, preserving dirty state (real git)', async () => {
    const { world, task, manager, info, ws } = await makeIsolatedWorld('reattach me')

    const out = await world.supervisor.runToCompletion()

    expect(out.state).toBe('completed')
    const settled = world.store.getTask(task.id)
    expect(settled.state).toBe('completed')
    expect(world.workerPrompts.filter((p) => p.muse === 'worker-a')).toHaveLength(1)
    // The worker continued in the SAME checkout: the dirty file survives…
    expect(readFileSync(join(info.path, 'dirty.txt'), 'utf8')).toBe('uncommitted work\n')
    // …and the same workspace row stays active: no archive, no replacement.
    expect(world.store.getWorkspace(ws.id).state).toBe('active')
    expect(world.store.getWorkspaceByTask(task.id)?.id).toBe(ws.id)
    expect(settled.workspaceId).toBe(ws.id)
    expect(world.store.listWorkspaces(world.projectId)).toHaveLength(1)
    expect(existsSync(join(world.dir, '.pluton', 'workspaces-attic'))).toBe(false)
    expect(manager.readCheckoutMarker(info.path)).not.toBeNull()

    expect(eventsOfType(world, 'task.workspace_reattached')).toEqual([
      { taskId: task.id, payload: { workspaceId: ws.id, branch: info.branch } },
    ])
    expect(eventsOfType(world, 'task.workspace_archived')).toEqual([])
  })

  it('T6 archives a stale checkout with an invalid marker, then provisions a fresh one (real git)', async () => {
    const { world, task, manager, info, ws } = await makeIsolatedWorld('archive me', { corruptMarker: true })

    const out = await world.supervisor.runToCompletion()

    expect(out.state).toBe('completed')
    expect(world.store.getTask(task.id).state).toBe('completed')
    const atticRoot = join(world.dir, '.pluton', 'workspaces-attic')
    const entries = readdirSync(atticRoot).filter((name) => name.startsWith(`${task.id}-`))
    expect(entries).toHaveLength(1)
    const archivedPath = join(atticRoot, entries[0] as string)
    // The stale checkout was ARCHIVED — dirty content included — never deleted.
    expect(readFileSync(join(archivedPath, 'dirty.txt'), 'utf8')).toBe('uncommitted work\n')
    // The task's dest now hosts a fresh, marked checkout.
    expect(existsSync(join(info.path, 'README.md'))).toBe(true)
    expect(existsSync(join(info.path, 'dirty.txt'))).toBe(false)
    expect(manager.readCheckoutMarker(info.path)).not.toBeNull()
    // The old row is archived; a new row is active for the fresh checkout.
    expect(world.store.getWorkspace(ws.id).state).toBe('archived')
    const fresh = world.store.getWorkspaceByTask(task.id)
    expect(fresh?.id).not.toBe(ws.id)
    expect(fresh?.path).toBe(info.path)
    expect(world.store.getTask(task.id).workspaceId).toBe(fresh?.id)

    expect(eventsOfType(world, 'task.workspace_archived')).toEqual([
      { taskId: task.id, payload: { path: info.path, archivePath: archivedPath, workspaceId: ws.id } },
    ])
    expect(eventsOfType(world, 'task.workspace_reattached')).toEqual([])
  })

  it('T7 records a live row as removed when its checkout is gone, then provisions a fresh one (real git)', async () => {
    const { world, task, manager, info, ws } = await makeIsolatedWorld('missing path', {
      deleteCheckout: true,
    })

    const out = await world.supervisor.runToCompletion()

    expect(out.state).toBe('completed')
    expect(world.store.getTask(task.id).state).toBe('completed')
    expect(world.store.getWorkspace(ws.id).state).toBe('removed')
    const fresh = world.store.getWorkspaceByTask(task.id)
    expect(fresh?.id).not.toBe(ws.id)
    expect(fresh?.path).toBe(info.path)
    expect(existsSync(join(info.path, 'README.md'))).toBe(true)
    expect(manager.readCheckoutMarker(info.path)).not.toBeNull()
    // Nothing was archived: the path was already gone before this process ran.
    expect(existsSync(join(world.dir, '.pluton', 'workspaces-attic'))).toBe(false)
    expect(eventsOfType(world, 'task.workspace_archived')).toEqual([])
  })
})

/**
 * Waiting-for-approval worker state (CS-4): a task-scoped engine permission
 * request is real state — `running → needs_approval` while the engine waits,
 * back to `running` only while the task is still waiting (`decision`/`expiry`),
 * and never a fabricated `running` on session abort (the prompt outcome owns
 * the task from there). Manager-session channels stay state-neutral.
 *
 * The mock adapter plays the engine: its scripted `requestPermission` rides the
 * channel the supervisor wired, like a real engine's ask. Task state is read
 * synchronously INSIDE the adapter's decision hook — it fires after the
 * channel's `onSettled`, so the flip is already applied and there is no timing
 * dependence — while durable rows are observed with a bounded poll.
 */
interface PermissionObservation {
  muse: string
  decision: EnginePermissionDecision
  request: EnginePermissionRequest
  /** Task state read synchronously in the hook, after the settle's flip. */
  taskState: string | null
}

/** Bounded poll for a durable row a live supervisor/driver will write. */
async function waitForDurable(label: string, predicate: () => boolean, attempts = 600, stepMs = 5): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Pending engine-permission approvals of the world's run. */
function pendingEngineApprovals(world: World): ApprovalRecord[] {
  return world.store
    .listApprovals(world.runId)
    .filter((a) => a.action === 'engine.permission' && a.status === 'pending')
}

/** The world's single task (these tests delegate exactly one). */
function onlyTask(world: World): TaskRecord {
  const tasks = world.store.listTasks(world.runId)
  expect(tasks).toHaveLength(1)
  return tasks[0] as TaskRecord
}

/**
 * The real operator funnel's context for a world: same root and the same
 * `pluton.sqlite` (`decideApproval` bootstraps its own connection, exactly like
 * the CLI). The declared muses mirror what `makeWorld` synced, so the funnel's
 * `syncMuses` disables nothing the live run uses.
 */
function approvalContext(world: World): ProjectContext {
  const loaded: LoadedConfig = {
    rootDir: world.dir,
    configPath: join(world.dir, 'pluton.yaml'),
    config: {
      version: 1,
      project: { name: 'supervisor-test', repository: '.', default_branch: 'main', verification: [] },
      runtime: {
        max_concurrent_workers: 2,
        max_team_size: 8,
        max_delegation_depth: 3,
        max_child_tasks_per_task: 5,
        max_tasks_per_run: 20,
        max_run_minutes: 30,
        default_task_minutes: 10,
        default_cpu_limit: 1,
        default_memory_mb: 512,
        max_retries_per_task: 2,
        max_revisions_per_task: 1,
        network_policy: 'restricted',
        max_prompt_chars: 10_000,
        max_event_payload_chars: 8_000,
        max_tool_result_chars: 120_000,
        heartbeat_seconds: 30,
        approval_timeout_minutes: 60,
      },
      sandbox: { kind: 'local-process', local_process_acknowledged: true },
      git: { protected_paths: [], require_approval_for_main_branch_integration: false },
      muses: {
        manager: {
          display_name: 'Manager',
          role: 'supervisor',
          engine: 'mock',
          model: 'mock/model-a',
          workspace_policy: 'coordinator-read-only',
          permissions: [...PERMISSIONS],
          approval_mode: 'autonomous-bounded',
        },
        'worker-a': {
          display_name: 'Worker A',
          role: 'coder',
          engine: 'mock',
          model: 'mock/model-a',
          workspace_policy: 'coordinator-read-only',
          permissions: [...WORKER_PERMISSIONS],
          approval_mode: 'ask-for-sensitive-actions',
        },
      },
    },
  }
  return { rootDir: world.dir, configPath: loaded.configPath, loaded }
}

/** The manager bridge's one delegation: a single worker-a task. */
async function delegateOneTask(bridge: PlutonToolBridge): Promise<void> {
  await createViaBridge(bridge, { title: 'W1', assigneeMuseId: 'worker-a' })
}

/**
 * A world whose single worker-a task asks for engine permission on its first
 * prompt (default success outcome), observed through the adapter's hook.
 */
function makeAskingWorld(opts: {
  managerTools?: (bridge: PlutonToolBridge) => Promise<void>
  workerScript?: MockScriptStep[]
  onStartSession?: MakeWorldOptions['onStartSession']
}): { world: World; observations: PermissionObservation[] } {
  const observations: PermissionObservation[] = []
  let world!: World
  world = makeWorld({
    managerTools: opts.managerTools ?? delegateOneTask,
    workerScripts: {
      'worker-a': opts.workerScript ?? [
        { requestPermission: { description: 'engine requested permission: write src/app.ts' } },
      ],
    },
    ...(opts.onStartSession !== undefined ? { onStartSession: opts.onStartSession } : {}),
    onPermissionDecision: (museId, decision, request) => {
      observations.push({
        muse: museId,
        decision,
        request,
        taskState: world.store.listTasks(world.runId)[0]?.state ?? null,
      })
    },
  })
  return { world, observations }
}

describe('RunSupervisor — waiting-for-approval worker state (CS-4)', () => {
  it('T1 flips running → needs_approval on a task-scoped ask and back to running on approval', async () => {
    const { world, observations } = makeAskingWorld({})

    const run = world.supervisor.runToCompletion()
    await waitForDurable('the durable pending engine approval', () => pendingEngineApprovals(world).length === 1)
    const approval = pendingEngineApprovals(world)[0] as ApprovalRecord
    const task = onlyTask(world)
    expect(approval).toMatchObject({ taskId: task.id, requestedByMuseId: 'worker-a' })
    expect(approval.reason).toContain('write src/app.ts')
    // The engine is waiting on the operator: the task says so, not "running".
    expect(task.state).toBe('needs_approval')

    const report = await decideApproval(approvalContext(world), { approvalRef: approval.id, decision: 'approve' })
    expect(report.approval.status).toBe('approved')

    await waitForDurable('the adapter to observe the grant', () => observations.length === 1)
    // Read INSIDE the hook: it fires after onSettled's flip, so the task was
    // already back to running when the engine received its answer.
    expect(observations[0]).toMatchObject({ muse: 'worker-a', decision: 'allow', taskState: 'running' })
    expect(observations[0]?.request.description).toContain('write src/app.ts')

    const out = await run
    expect(out.state).toBe('completed')
    expect(world.store.getTask(task.id).state).toBe('completed')
    expect(world.store.getApproval(approval.id).status).toBe('approved')
    expect(pendingApprovalWaiterCount()).toBe(0)

    // CS-8 visibility: each successful flip is a durable transition, so it
    // appends exactly one event naming the approval it mirrors — this is what
    // the SSE derivation turns into a live `needs_approval` frame.
    expect(eventsOfType(world, 'task.approval_waiting')).toEqual([
      { taskId: task.id, payload: { approvalId: approval.id } },
    ])
    expect(eventsOfType(world, 'task.approval_settled')).toEqual([
      { taskId: task.id, payload: { approvalId: approval.id } },
    ])
  }, 20_000)

  it('T2 returns the task to running on a denial and the engine observes deny', async () => {
    const { world, observations } = makeAskingWorld({})

    const run = world.supervisor.runToCompletion()
    await waitForDurable('the durable pending engine approval', () => pendingEngineApprovals(world).length === 1)
    const approval = pendingEngineApprovals(world)[0] as ApprovalRecord
    const task = onlyTask(world)
    expect(task.state).toBe('needs_approval')

    const report = await decideApproval(approvalContext(world), { approvalRef: approval.id, decision: 'deny' })
    expect(report.approval.status).toBe('denied')

    await waitForDurable('the adapter to observe the denial', () => observations.length === 1)
    expect(observations[0]).toMatchObject({ muse: 'worker-a', decision: 'deny', taskState: 'running' })

    const out = await run
    expect(out.state).toBe('completed')
    expect(world.store.getTask(task.id).state).toBe('completed')
    expect(world.store.getApproval(approval.id).status).toBe('denied')
  }, 20_000)

  it('T3 expiry settles fail-closed, returns the task to running, and never grants', async () => {
    const { world, observations } = makeAskingWorld({})

    const run = world.supervisor.runToCompletion()
    await waitForDurable('the durable pending engine approval', () => pendingEngineApprovals(world).length === 1)
    const approval = pendingEngineApprovals(world)[0] as ApprovalRecord
    const task = onlyTask(world)
    expect(task.state).toBe('needs_approval')

    // The CLI expiry sweep: the overdue row expires, then its waiter settles via
    // `settleApprovalWaiter(id, 'expired', 'expiry')` — fail-closed.
    const swept = sweepExpiredApprovals(
      world.store,
      world.projectId,
      new Date(Date.now() + 2 * 3_600_000).toISOString(),
    )
    expect(swept.map((a) => a.id)).toEqual([approval.id])

    await waitForDurable('the adapter to observe the expiry', () => observations.length === 1)
    expect(observations[0]).toMatchObject({ muse: 'worker-a', decision: 'deny', taskState: 'running' })

    const out = await run
    expect(out.state).toBe('completed')
    expect(world.store.getApproval(approval.id).status).toBe('expired')
    expect(world.store.getTask(task.id).state).toBe('completed')
  }, 20_000)

  it('T4 abort settles fail-closed and never fabricates a running turn', async () => {
    const workerChannels: EnginePermissionChannel[] = []
    const { world, observations } = makeAskingWorld({
      workerScript: [
        {
          requestPermission: { description: 'engine requested permission: write src/app.ts' },
          outcome: 'cancelled',
        },
      ],
      onStartSession: (museId, req) => {
        if (museId === 'worker-a' && req.approvals) workerChannels.push(req.approvals)
      },
    })

    const run = world.supervisor.runToCompletion()
    await waitForDurable('the durable pending engine approval', () => pendingEngineApprovals(world).length === 1)
    const approval = pendingEngineApprovals(world)[0] as ApprovalRecord
    const task = onlyTask(world)
    expect(task.state).toBe('needs_approval')

    // Session teardown (engine shutdown / run cancellation) — not a decision.
    expect(workerChannels).toHaveLength(1)
    const channel = workerChannels[0] as EnginePermissionChannel
    channel.abort('test teardown')
    // No fabricated live turn: the prompt outcome owns the task from here.
    expect(world.store.getTask(task.id).state).toBe('needs_approval')

    await waitForDurable('the adapter to observe the aborted ask', () => observations.length === 1)
    expect(observations[0]).toMatchObject({ muse: 'worker-a', decision: 'deny', taskState: 'needs_approval' })

    const out = await run
    expect(out.state).toBe('completed')
    expect(out.taskCounts['cancelled']).toBe(1)
    // The outcome path settles from needs_approval (a legal edge): cancelled —
    // never a fabricated running or completed.
    expect(world.store.getTask(task.id).state).toBe('cancelled')
    expect(world.store.getApproval(approval.id).status).toBe('expired')
    expect(pendingApprovalWaiterCount()).toBe(0)
    // Abort is deliberately NOT mirrored: the park is durable (the waiting
    // event proves the request flip), but no settled event may exist — the
    // prompt outcome owns the task from here.
    expect(eventsOfType(world, 'task.approval_waiting')).toEqual([
      { taskId: task.id, payload: { approvalId: approval.id } },
    ])
    expect(eventsOfType(world, 'task.approval_settled')).toEqual([])
  }, 20_000)

  it('T4b a success outcome survives a teardown-aborted ask parked in needs_approval', async () => {
    const workerChannels: EnginePermissionChannel[] = []
    const { world } = makeAskingWorld({
      workerScript: [
        {
          requestPermission: { description: 'engine requested permission: write src/app.ts' },
          outcome: 'success',
        },
      ],
      onStartSession: (museId, req) => {
        if (museId === 'worker-a' && req.approvals) workerChannels.push(req.approvals)
      },
    })

    const run = world.supervisor.runToCompletion()
    await waitForDurable('the durable pending engine approval', () => pendingEngineApprovals(world).length === 1)
    const approval = pendingEngineApprovals(world)[0] as ApprovalRecord
    const task = onlyTask(world)
    expect(task.state).toBe('needs_approval')

    // Session teardown (engine shutdown / run cancellation) — not a decision,
    // so the park is NOT mirrored back before the outcome arrives.
    expect(workerChannels).toHaveLength(1)
    const channel = workerChannels[0] as EnginePermissionChannel
    channel.abort('test teardown')
    expect(world.store.getTask(task.id).state).toBe('needs_approval')

    const out = await run
    expect(out.state).toBe('completed')
    // The successful attempt lands on this fixture's normal success terminal
    // (no verification configured): the outcome writer reconciled the parked
    // state first instead of dying on the illegal `needs_approval` → `verifying`
    // edge and recording a setup failure.
    expect(world.store.getTask(task.id).state).toBe('completed')
    expect(world.store.getApproval(approval.id).status).toBe('expired')
    // …and the reconcile is NOT a decision: no settle event, and above all no
    // fabricated failure for a successful worker attempt.
    expect(eventsOfType(world, 'task.approval_settled')).toEqual([])
    expect(eventCount(world.store, world.runId, 'task.failed')).toBe(0)
    expect(eventCount(world.store, world.runId, 'task_setup_failed')).toBe(0)
  }, 20_000)

  it('T5 a manager-session ask is state-neutral while a worker task is live', async () => {
    const managerChannels: EnginePermissionChannel[] = []
    let ask!: Promise<EnginePermissionDecision>
    const world = makeWorld({
      // The adapter's delayMs is the engine's own work (not a test sleep): the
      // manager's prompt must outlive the decision below, because closing the
      // manager session settles its pending asks fail-closed, and the worker's
      // delay holds its task in `running` while the manager's ask is decided.
      managerScript: [{ delayMs: 2_000, text: 'plan', outcome: 'success' }],
      workerScripts: { 'worker-a': [{ delayMs: 1_000, outcome: 'success' }] },
      managerTools: async (bridge) => {
        await createViaBridge(bridge, { title: 'M1', assigneeMuseId: 'worker-a' })
        await waitForDurable('the worker task to run', () =>
          world.store.listTasks(world.runId).some((t) => t.state === 'running'),
        )
        ask = (managerChannels[0] as EnginePermissionChannel).requestPermission({
          requestId: 'mgr_1',
          description: 'engine requested permission: run a shell command',
          scope: {},
        })
      },
      onStartSession: (museId, req) => {
        if (museId === 'manager' && req.approvals) managerChannels.push(req.approvals)
      },
    })

    const run = world.supervisor.runToCompletion()
    await waitForDurable('the manager session approval row', () => pendingEngineApprovals(world).length === 1)

    // A manager ask is session-scoped (`taskId: null`) and must never move task
    // state: the live worker task stays running, nothing waits for approval.
    const approval = pendingEngineApprovals(world)[0] as ApprovalRecord
    expect(managerChannels).toHaveLength(1)
    expect(approval).toMatchObject({ taskId: null, requestedByMuseId: 'manager' })
    const tasks = world.store.listTasks(world.runId)
    expect(tasks.filter((t) => t.state === 'running')).toHaveLength(1)
    expect(tasks.some((t) => t.state === 'needs_approval')).toBe(false)

    const report = await decideApproval(approvalContext(world), { approvalRef: approval.id, decision: 'approve' })
    expect(report.approval.status).toBe('approved')
    await expect(ask).resolves.toBe('allow')
    await world.settleTools()

    const out = await run
    expect(out.state).toBe('completed')
    expect(onlyTask(world).state).toBe('completed')
  }, 20_000)
})

/**
 * Manager-requested revisions (CS-5): a `failed` task can be sent back ONCE
 * (runtime.max_revisions_per_task) with bounded, sanitized manager feedback that
 * reaches the next attempt's prompt; the previous failure is preserved.
 */
describe('RunSupervisor — manager-requested revisions (CS-5)', () => {
  it('re-dispatches a failed task once with the manager feedback in the next prompt', async () => {
    // Two scripted failures exhaust the world's retry budget
    // (maxRetriesPerTask: 1), so the task reaches `failed` — and, with the
    // production DEFAULT breaker, the two identical failures also trip it
    // (2 consecutive identical failures). The manager then requests one
    // revision, and the third attempt is scripted to succeed: this exercises
    // the full default path, where an accepted revision must un-trip the
    // breaker (automatic-retry guard vs. explicit, capped revision override)
    // or the requeued task would stall invisible forever.
    // The mock adapter hands EVERY new session a fresh copy of the script and
    // every attempt opens a new session, so the trailing success step is
    // consumed explicitly below, right before the revision is requested.
    const workerScript: MockScriptStep[] = [{ outcome: 'failure' }, { outcome: 'failure' }, {}]
    const world = makeWorld({
      // Hold the manager session open (and the run loop polling) until the
      // revision attempt has been dispatched and settled.
      managerScript: [{ delayMs: 2_000, text: 'plan', outcome: 'success' }],
      maxRetriesPerTask: 1,
      workerScripts: { 'worker-a': workerScript },
      managerTools: async (bridge) => {
        await createViaBridge(bridge, { title: 'revise me', assigneeMuseId: 'worker-a' })
      },
    })

    const run = world.supervisor.runToCompletion()
    await waitForDurable('the task to fail after its retry budget', () =>
      world.store.listTasks(world.runId).some((t) => t.state === 'failed'),
    )
    const taskId = onlyTask(world).id
    workerScript.splice(0, 2) // the two failure steps are spent; the revision attempt gets `{}`

    const res = await world.supervisor.managerBridge().call('task.request_revision', {
      taskId,
      feedback: 'Fix the parser edge case',
    })
    expect(res.ok).toBe(true)
    await waitForDurable('the revision attempt to complete', () => world.store.getTask(taskId).state === 'completed')

    const out = await run
    await world.settleTools()

    expect(out.state).toBe('completed')
    expect(out.outcome).toBe('success')
    const task = world.store.getTask(taskId)
    expect(task.state).toBe('completed')
    expect(task.attempt).toBe(2) // one automatic retry + one manager revision
    // The THIRD prompt is the revision attempt, and it carries the feedback.
    const prompts = world.workerPrompts.filter((p) => p.muse === 'worker-a')
    expect(prompts).toHaveLength(3)
    expect(prompts[2]!.text).toContain('Fix the parser edge case')
    // …while the two pre-revision attempts never saw it.
    expect(prompts[0]!.text).not.toContain('Fix the parser edge case')
    expect(prompts[1]!.text).not.toContain('Fix the parser edge case')
    // One durable revision event, recorded with the requeued attempt number.
    expect(eventsOfType(world, 'task.revision_scheduled')).toEqual([{ taskId, payload: { attempt: 2 } }])
    // The real failure is preserved under the revision payload, never erased.
    expect(task.failure).toMatchObject({
      code: 'revision_requested',
      feedback: 'Fix the parser edge case',
      requestedByMuseId: 'manager',
      previousFailure: { outcome: 'failure' },
    })
  }, 20_000)
})

/**
 * Cancellation semantics + bounded shutdown (CS-9).
 *
 * A cancel — from the manager tool, another process, or an operator signal —
 * is only a durable state flip. The supervisor's next control tick (≤
 * `loopPollMs`) notices it and interrupts the live engine session of the
 * cancelled task (or of every session, once the run itself is terminal); after
 * the loop it drains the task executors + the manager prompt with a bound, so a
 * run can never be held open by an engine that will not stop.
 *
 * The engine below is the deterministic proof vehicle: `sendPrompt` never ends
 * on its own, and ends with a `cancelled` result only when the supervisor
 * interrupts it (or the test releases it). `ignoreInterrupt` models an engine
 * that cannot be stopped mid-turn: only the bounded drain gets the run out.
 */
class HangingEngineSession implements EngineSession {
  readonly info: EngineSessionInfo
  private readonly owner: HangingEngineAdapter
  private readonly waiters: (() => void)[] = []

  constructor(owner: HangingEngineAdapter, id: string) {
    this.owner = owner
    this.info = { id, nativeSessionId: `hang-${id}`, resumeToken: null }
  }

  /** End the hung turn (idempotent): the next pull yields a cancelled result. */
  release(): void {
    for (const wake of this.waiters.splice(0)) wake()
  }

  async *sendPrompt(_req: PromptRequest): AsyncIterable<EngineEvent> {
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
    yield { kind: 'result', outcome: 'cancelled', summary: 'released without a result' }
  }

  async interrupt(): Promise<void> {
    this.owner.interrupts.push(this.info.id)
    if (!this.owner.ignoreInterrupt) this.release()
  }

  async close(): Promise<void> {
    this.release()
    this.owner.closed.push(this.info.id)
  }
}

class HangingEngineAdapter implements EngineAdapter {
  readonly kind = 'hanging'
  /** Session ids the supervisor interrupted, in order. */
  readonly interrupts: string[] = []
  /** Session ids closed by the supervisor, in order. */
  readonly closed: string[] = []
  readonly ignoreInterrupt: boolean
  private readonly sessions: HangingEngineSession[] = []
  private nextId = 1

  constructor(ignoreInterrupt = false) {
    this.ignoreInterrupt = ignoreInterrupt
  }

  capabilities(): EngineCapabilities {
    return { ...defaultCapabilities(), interrupt: true }
  }

  discover(): Promise<EngineDiscovery> {
    return Promise.resolve({
      engineKind: 'hanging',
      installed: true,
      binaryPath: null,
      version: 'hang-1.0.0',
      fix: 'nothing to install — hanging test engine',
    })
  }

  listModels(): Promise<EngineModel[]> {
    return Promise.resolve([])
  }

  authStatus(): Promise<EngineAuthStatus> {
    return Promise.resolve({ configured: true, hint: 'hanging test engine needs no auth' })
  }

  startSession(_req: StartSessionRequest): Promise<EngineSession> {
    const session = new HangingEngineSession(this, `hang-session-${String(this.nextId)}`)
    this.nextId += 1
    this.sessions.push(session)
    return Promise.resolve(session)
  }

  /** Release every hung turn (test cleanup, so nothing lingers past the test). */
  releaseAll(): void {
    for (const session of this.sessions) session.release()
  }
}

describe('RunSupervisor — cancellation interrupts live sessions (CS-9)', () => {
  it('interrupts the live session of a cancelled task on the next tick, discarding its late result', async () => {
    const hanging = new HangingEngineAdapter()
    let taskId = ''
    const world = makeWorld({
      managerTools: async (bridge) => {
        taskId = (await createViaBridge(bridge, { title: 'C1', assigneeMuseId: 'worker-a' })).id
      },
      adapterOverrideFor: (museId) => (museId === 'worker-a' ? hanging : undefined),
    })

    const run = world.supervisor.runToCompletion()
    await waitForDurable('the worker task to run', () =>
      world.store.listTasks(world.runId).some((t) => t.state === 'running'),
    )

    // Flip exactly as the `task.cancel` tool does — durable state + audit event,
    // no session handle involved: the interrupt is state-driven, because ANY
    // cancel source (another process included) only has the store.
    world.store.setTaskState(taskId, 'cancelled')
    world.store.appendEvent({
      projectId: world.projectId,
      runId: world.runId,
      taskId,
      museId: 'manager',
      type: 'task.cancelled_by_tool',
      payload: { reason: 'no longer needed', cancelledBy: 'manager' },
    })
    const flippedAt = Date.now()

    await waitForDurable('the supervisor to interrupt the hung session', () => hanging.interrupts.length === 1)

    const out = await run
    expect(Date.now() - flippedAt).toBeLessThan(3_000)
    expect(out.runId).toBe(world.runId)

    // The engine's late result arrived after the task settled: discarded, never
    // applied — the interrupt's `cancelled` outcome is what the executor saw.
    expect(world.store.getTask(taskId).state).toBe('cancelled')
    expect(eventsOfType(world, 'task.late_result_discarded')).toEqual([
      { taskId, payload: { taskId, outcome: 'cancelled', currentState: 'cancelled' } },
    ])
    // Exactly one interrupt: the task's own session. The manager session settles
    // on its own — the run never went terminal here.
    expect(hanging.interrupts).toHaveLength(1)
    // The hung session was closed by the executor's finally path (quiescence
    // already proves it: `runToCompletion` only returned once no executor was
    // in flight, and the close is awaited inside that executor).
    expect(hanging.closed).toHaveLength(1)
  }, 20_000)

  it('bounds the post-loop drain: an uninterruptible engine cannot hold the run open', async () => {
    const hanging = new HangingEngineAdapter(true) // ignores interrupt() entirely
    let taskId = ''
    const world = makeWorld({
      drainBoundMs: 100,
      managerTools: async (bridge) => {
        taskId = (await createViaBridge(bridge, { title: 'C2', assigneeMuseId: 'worker-a' })).id
      },
      adapterOverrideFor: (museId) => (museId === 'worker-a' ? hanging : undefined),
    })

    const run = world.supervisor.runToCompletion()
    await waitForDurable('the worker task to run', () =>
      world.store.listTasks(world.runId).some((t) => t.state === 'running'),
    )

    // Terminal-run flip: the loop's next tick interrupts what it can, flips every
    // non-terminal task to `cancelled`, and breaks — then the bounded drain
    // decides how long the detached, uninterruptible prompt may hold the run.
    const flippedAt = Date.now()
    world.store.setRunState(world.runId, 'cancelled')

    const out = await run
    const elapsed = Date.now() - flippedAt
    expect(elapsed).toBeLessThan(4_000) // ≪ the 5 s default bound; drainBoundMs is 100 ms
    expect(out.state).toBe('cancelled')
    // The interrupt was attempted (and ignored by this engine)…
    expect(hanging.interrupts.length).toBeGreaterThanOrEqual(1)
    // …while the terminal-run branch still flipped the hung task to cancelled.
    expect(world.store.getTask(taskId).state).toBe('cancelled')

    // Cleanup: release the hung turn, then await the detached executor's own
    // in-flight promise, so nothing lingers past the test.
    const sup = world.supervisor as unknown as { inFlight: Map<string, Promise<void>> }
    hanging.releaseAll()
    await Promise.all([...sup.inFlight.values()].map((p) => p.catch(() => {})))
  }, 20_000)
})
