import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import type { MuseRecord } from '../../src/domain/models.ts'
import { MockEngineAdapter, type MockScriptStep } from '../../src/engines/mock/adapter.ts'
import { QwenEngineAdapter } from '../../src/engines/qwen/adapter.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'
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
}

interface World {
  dir: string
  store: Store
  projectId: string
  runId: string
  supervisor: RunSupervisor
  workerPrompts: { muse: string; at: number }[]
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
  /** Skip the injected adapterFor seam: exercises the supervisor's own default factory. */
  useDefaultAdapters?: boolean
}

const WORKER_PERMISSIONS = ['task.delegate', 'task.inspect', 'result.collect', 'diff.inspect']

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
  const workerPrompts: { muse: string; at: number }[] = []
  const closedSessions: { muse: string; sessionId: string }[] = []
  const adapters = new Map<string, MockEngineAdapter>()
  for (const id of ['worker-a', 'worker-b'] as const) {
    adapters.set(
      id,
      new MockEngineAdapter({
        script: opts.workerScripts?.[id] ?? [{ delayMs: 5, outcome: 'success' }],
        onPrompt: () => {
          workerPrompts.push({ muse: id, at: Date.now() })
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
    runDeadlineMs: 20_000,
    verificationConfigured: opts.verificationConfigured ?? false,
    loopPollMs: 20,
    ...(opts.useDefaultAdapters === true
      ? {}
      : {
          adapterFor: (muse: MuseRecord) => {
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

  it('the default per-Muse factory routes through the approval-aware wiring (no injected seam)', () => {
    // Pin for the smoke regression: reverting `adapterFor`'s default to a bare
    // registry lookup must fail this test, not just the unit mapping tests.
    const world = makeWorld({ useDefaultAdapters: true })

    const bounded = world.supervisor.adapterFor({
      engineKind: 'qwen',
      approvalMode: 'autonomous-bounded',
    } as unknown as MuseRecord)
    expect(bounded).toBeInstanceOf(QwenEngineAdapter)
    expect((bounded as QwenEngineAdapter).sessionApproval).toEqual({ mode: 'auto', policy: 'allow_once' })

    const askAlways = world.supervisor.adapterFor({
      engineKind: 'qwen',
      approvalMode: 'ask-always',
    } as unknown as MuseRecord)
    expect((askAlways as QwenEngineAdapter).sessionApproval).toEqual({ mode: 'default', policy: 'deny' })

    // Non-qwen kinds still resolve through the engine registry.
    expect(
      world.supervisor.adapterFor({ engineKind: 'mock', approvalMode: 'ask-always' } as unknown as MuseRecord),
    ).toBeInstanceOf(MockEngineAdapter)
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
})
