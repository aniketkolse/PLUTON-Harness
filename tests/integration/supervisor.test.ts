import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import type { MuseRecord } from '../../src/domain/models.ts'
import { MockEngineAdapter, type MockScriptStep } from '../../src/engines/mock/adapter.ts'
import { RunSupervisor } from '../../src/orchestrator/supervisor.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import type { PlutonToolBridge, ToolBridgeLimits } from '../../src/tools/bridge.ts'
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
  const adapters = new Map<string, MockEngineAdapter>()
  for (const id of ['worker-a', 'worker-b'] as const) {
    adapters.set(
      id,
      new MockEngineAdapter({
        script: opts.workerScripts?.[id] ?? [{ delayMs: 5, outcome: 'success' }],
        onPrompt: () => {
          workerPrompts.push({ muse: id, at: Date.now() })
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
    defaultTaskTimeoutMs: 15_000,
    runDeadlineMs: 20_000,
    verificationConfigured: opts.verificationConfigured ?? false,
    loopPollMs: 20,
    adapterFor: (muse: MuseRecord) => {
      const adapter = adapters.get(muse.id)
      if (!adapter) throw new Error(`no mock adapter for muse ${muse.id}`)
      return adapter
    },
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
})
