import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { workspaceClean } from '../../src/cli/commands/workspace.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { loadConfig, stateDir, workspaceDir } from '../../src/config/load.ts'
import { ValidationError } from '../../src/domain/errors.ts'
import type { RunRecord, TaskRecord, WorkspaceRecord } from '../../src/domain/models.ts'
import type { DatabaseSync } from '../../src/store/db.ts'
import { Store } from '../../src/store/store.ts'
import { GitWorkspaceManager } from '../../src/workspace/manager.ts'

/**
 * Integration: `pluton workspace clean` against real git repositories and the
 * real store. A tmp project is seeded with runs whose Pluton-managed checkouts
 * are created by the real `GitWorkspaceManager`; `workspaceClean` then drives
 * the real removal primitive, flips the workspace rows to `removed` and records
 * the audit events. The only fake is nothing: git, SQLite and the filesystem
 * are the real implementations.
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

const CONFIG = `version: 1
project:
  name: cli-workspace-it
  repository: .
  default_branch: main
runtime:
  approval_timeout_minutes: 30
  max_concurrent_workers: 2
git:
  protected_paths:
    - secrets
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

interface Fixture {
  dir: string
  ctx: ProjectContext
  store: Store
  projectId: string
  run: RunRecord
  manager: GitWorkspaceManager
}

function createRun(fx: Pick<Fixture, 'store' | 'projectId'>, goal: string): RunRecord {
  return fx.store.createRun({
    projectId: fx.projectId,
    goal,
    origin: 'cli',
    requestedBy: 'integration-test',
    acceptanceCriteria: ['cleaned'],
    managerMuseId: 'manager',
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 20,
      maxDelegationDepth: 3,
      maxRunMinutes: 30,
      defaultTaskMinutes: 10,
    },
  })
}

function makeProject(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-cli-workspace-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), CONFIG)
  writeFileSync(join(dir, 'README.md'), '# cli-workspace project\n')
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 30_000 })
  }
  git(['init', '-b', 'main'])
  git(['add', '.'])
  git(['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'seed'])

  const loaded = loadConfig(dir)
  const { store, projectId } = bootstrapStore(loaded)
  openDbs.push(store.db)
  return {
    dir,
    ctx: { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded },
    store,
    projectId,
    run: createRun({ store, projectId }, 'clean the finished workspaces'),
    manager: new GitWorkspaceManager({ workspacesRoot: workspaceDir(dir) }),
  }
}

/** Walk a run to a terminal state through the legal transition path. */
function terminalizeRun(fx: Fixture): RunRecord {
  fx.store.setRunState(fx.run.id, 'active')
  return fx.store.setRunState(fx.run.id, 'completed')
}

interface SeededTask {
  task: TaskRecord
  workspace: WorkspaceRecord
  checkoutPath: string
}

/** Task with a Pluton-managed checkout; the caller decides how it ends. */
async function seedTaskWithCheckout(fx: Fixture, title: string, run: RunRecord = fx.run): Promise<SeededTask> {
  const task = fx.store.createTask({
    runId: run.id,
    parentTaskId: null,
    title,
    brief: `do ${title}`,
    acceptanceCriteria: [],
    assigneeMuseId: 'worker-a',
  })
  fx.store.setTaskState(task.id, 'queued')
  fx.store.setTaskState(task.id, 'admitted')
  const info = await fx.manager.createCheckout({
    repoPath: fx.dir,
    kind: 'task-checkout',
    runId: run.id,
    slug: title,
    destName: task.id,
  })
  const workspace = fx.store.createWorkspace({
    projectId: fx.projectId,
    runId: run.id,
    taskId: task.id,
    museId: 'worker-a',
    kind: 'task-checkout',
    path: info.path,
    branch: info.branch,
    baseCommit: info.baseCommit,
  })
  fx.store.setTaskState(task.id, 'running', { workspaceId: workspace.id })
  return { task, workspace, checkoutPath: info.path }
}

/** Completed task with a Pluton-managed checkout (created → … → completed). */
async function seedCompletedTask(fx: Fixture, title: string): Promise<SeededTask> {
  const seeded = await seedTaskWithCheckout(fx, title)
  return { ...seeded, task: fx.store.setTaskState(seeded.task.id, 'completed') }
}

/** Pluton-managed integration checkout for a run. */
async function seedIntegrationCheckout(fx: Fixture): Promise<WorkspaceRecord> {
  const info = await fx.manager.createCheckout({
    repoPath: fx.dir,
    kind: 'integration-checkout',
    runId: fx.run.id,
    destName: `integration-${fx.run.id}`,
  })
  return fx.store.createWorkspace({
    projectId: fx.projectId,
    runId: fx.run.id,
    taskId: null,
    museId: null,
    kind: 'integration-checkout',
    path: info.path,
    branch: info.branch,
    baseCommit: info.baseCommit,
  })
}

/** Capture (never throw) a rejection so the message can be asserted directly. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  )
}

describe('workspaceClean — removes only marker-owned checkouts (real git, real store)', () => {
  it('removes the terminal run\'s task and integration checkouts, flips the rows and leaves unmanaged directories alone', async () => {
    const fx = makeProject()
    const done = await seedCompletedTask(fx, 'completed task')
    const failed = await seedTaskWithCheckout(fx, 'failed task')
    fx.store.setTaskState(failed.task.id, 'failed')
    const integration = await seedIntegrationCheckout(fx)
    // A stray directory directly under the workspaces root, never created by the
    // manager: the run's cleanup must not see or touch it.
    const stray = join(workspaceDir(fx.dir), 'stray-user-dir')
    mkdirSync(stray, { recursive: true })
    writeFileSync(join(stray, 'keep.txt'), 'keep\n')
    terminalizeRun(fx)

    const report = await workspaceClean(fx.ctx, { runRef: fx.run.id })

    expect(report.refusedRuns).toEqual([])
    expect(report.skipped).toEqual([])
    expect(new Set(report.removed.map((r) => r.workspaceId))).toEqual(
      new Set([done.workspace.id, failed.workspace.id, integration.id]),
    )
    const byId = new Map(report.removed.map((r) => [r.workspaceId, r]))
    expect(byId.get(done.workspace.id)).toEqual({
      workspaceId: done.workspace.id,
      runId: fx.run.id,
      taskId: done.task.id,
      kind: 'task-checkout',
      path: done.checkoutPath,
    })
    expect(byId.get(failed.workspace.id)).toMatchObject({ taskId: failed.task.id, kind: 'task-checkout' })
    expect(byId.get(integration.id)).toMatchObject({ taskId: null, kind: 'integration-checkout' })

    // Directories gone from disk, rows flipped to `removed`, one audit event each.
    for (const path of [done.checkoutPath, failed.checkoutPath, integration.path]) {
      expect(existsSync(path)).toBe(false)
    }
    expect(fx.store.getWorkspace(done.workspace.id).state).toBe('removed')
    expect(fx.store.getWorkspace(failed.workspace.id).state).toBe('removed')
    expect(fx.store.getWorkspace(integration.id).state).toBe('removed')
    const events = fx.store.listEvents(fx.run.id, { type: 'workspace.removed' })
    expect(events).toHaveLength(3)
    expect(new Set(events.map((e) => e.taskId))).toEqual(new Set([done.task.id, failed.task.id, null]))
    for (const e of events) {
      expect(e.payload).toMatchObject({
        kind: expect.any(String),
        workspaceId: expect.any(String),
        path: expect.any(String),
      })
    }

    // The stray directory is intact, and the report never mentioned it.
    expect(existsSync(join(stray, 'keep.txt'))).toBe(true)
    for (const r of report.removed) expect(r.path).not.toBe(stray)
  })

  it('skips an active row whose directory lacks the Pluton marker and leaves the row active', async () => {
    const fx = makeProject()
    terminalizeRun(fx)
    // A row pointing at a hand-made directory: the row exists, the ownership
    // marker does not — removal must refuse, not force.
    const unmanagedPath = join(workspaceDir(fx.dir), 'not-a-pluton-checkout')
    mkdirSync(unmanagedPath, { recursive: true })
    writeFileSync(join(unmanagedPath, 'keep.txt'), 'keep\n')
    const row = fx.store.createWorkspace({
      projectId: fx.projectId,
      runId: fx.run.id,
      taskId: null,
      museId: null,
      kind: 'integration-checkout',
      path: unmanagedPath,
      branch: `pluton/integration/${fx.run.id}`,
      baseCommit: '0'.repeat(40),
    })

    const report = await workspaceClean(fx.ctx, { runRef: fx.run.id })

    expect(report.removed).toEqual([])
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0]).toMatchObject({ workspaceId: row.id, path: unmanagedPath })
    expect(report.skipped[0]?.reason).toContain('no Pluton workspace marker')
    expect(existsSync(join(unmanagedPath, 'keep.txt'))).toBe(true)
    expect(fx.store.getWorkspace(row.id).state).toBe('active')
    expect(fx.store.listEvents(fx.run.id, { type: 'workspace.removed' })).toHaveLength(0)
  })

  it('skips a stale active row whose checkout directory is already gone, with a distinct reason', async () => {
    const fx = makeProject()
    terminalizeRun(fx)
    // A row whose directory never existed (or was deleted out of band): the
    // skip reason must say so, not fall through to the misleading marker error.
    const missingPath = join(workspaceDir(fx.dir), 'deleted-long-ago')
    const row = fx.store.createWorkspace({
      projectId: fx.projectId,
      runId: fx.run.id,
      taskId: null,
      museId: null,
      kind: 'integration-checkout',
      path: missingPath,
      branch: `pluton/integration/${fx.run.id}`,
      baseCommit: '0'.repeat(40),
    })

    const report = await workspaceClean(fx.ctx, { runRef: fx.run.id })

    expect(report.removed).toEqual([])
    expect(report.skipped).toEqual([
      {
        workspaceId: row.id,
        path: missingPath,
        reason: 'checkout path is missing; nothing to remove (row left active)',
      },
    ])
    expect(existsSync(missingPath)).toBe(false)
    expect(fx.store.getWorkspace(row.id).state).toBe('active')
    expect(fx.store.listEvents(fx.run.id, { type: 'workspace.removed' })).toHaveLength(0)
  })
})

describe('workspaceClean — refuses runs still in use or not terminal', () => {
  it('refuses a terminal run whose task is still running and removes nothing', async () => {
    const fx = makeProject()
    const done = await seedCompletedTask(fx, 'done task')
    const live = await seedTaskWithCheckout(fx, 'still running')
    // Terminal run, live task: the fail-closed superset the operator must not
    // pull the checkout out from under.
    terminalizeRun(fx)

    const error = await rejection(workspaceClean(fx.ctx, { runRef: fx.run.id }))

    expect(error).toBeInstanceOf(ValidationError)
    const message = (error as Error).message
    expect(message).toContain(live.task.id)
    expect(message).toContain("'running'")
    // The refusal is total: not even the completed task's checkout was touched.
    for (const seeded of [done, live]) {
      expect(existsSync(seeded.checkoutPath)).toBe(true)
      expect(fx.store.getWorkspace(seeded.workspace.id).state).toBe('active')
    }
    expect(fx.store.listEvents(fx.run.id, { type: 'workspace.removed' })).toHaveLength(0)
  })

  it('refuses a terminal run whose task is in needs_input (the session-backed superset)', async () => {
    const fx = makeProject()
    const done = await seedCompletedTask(fx, 'done task')
    const live = await seedTaskWithCheckout(fx, 'waiting for input')
    fx.store.setTaskState(live.task.id, 'needs_input')
    terminalizeRun(fx)

    const error = await rejection(workspaceClean(fx.ctx, { runRef: fx.run.id }))

    expect(error).toBeInstanceOf(ValidationError)
    const message = (error as Error).message
    expect(message).toContain(live.task.id)
    expect(message).toContain("'needs_input'")
    for (const seeded of [done, live]) {
      expect(existsSync(seeded.checkoutPath)).toBe(true)
      expect(fx.store.getWorkspace(seeded.workspace.id).state).toBe('active')
    }
    expect(fx.store.listEvents(fx.run.id, { type: 'workspace.removed' })).toHaveLength(0)
  })

  it('refuses a terminal run whose task is verifying (its subprocess runs in the checkout)', async () => {
    const fx = makeProject()
    const done = await seedCompletedTask(fx, 'done task')
    const verifying = await seedTaskWithCheckout(fx, 'checking the work')
    fx.store.setTaskState(verifying.task.id, 'verifying')
    terminalizeRun(fx)

    const error = await rejection(workspaceClean(fx.ctx, { runRef: fx.run.id }))

    expect(error).toBeInstanceOf(ValidationError)
    const message = (error as Error).message
    expect(message).toContain(verifying.task.id)
    expect(message).toContain("'verifying'")
    for (const seeded of [done, verifying]) {
      expect(existsSync(seeded.checkoutPath)).toBe(true)
      expect(fx.store.getWorkspace(seeded.workspace.id).state).toBe('active')
    }
    expect(fx.store.listEvents(fx.run.id, { type: 'workspace.removed' })).toHaveLength(0)
  })

  it('refuses a run that is not terminal and removes nothing', async () => {
    const fx = makeProject()
    const done = await seedCompletedTask(fx, 'done task')
    fx.store.setRunState(fx.run.id, 'active') // still in flight

    const error = await rejection(workspaceClean(fx.ctx, { runRef: fx.run.id }))

    expect(error).toBeInstanceOf(ValidationError)
    const message = (error as Error).message
    expect(message).toContain(fx.run.id)
    expect(message).toContain("'active'")
    expect(existsSync(done.checkoutPath)).toBe(true)
    expect(fx.store.getWorkspace(done.workspace.id).state).toBe('active')
  })
})

describe('workspaceClean — --all-runs', () => {
  it('cleans the terminal runs and reports the in-flight ones without touching them', async () => {
    const fx = makeProject()
    const done = await seedCompletedTask(fx, 'done task')
    terminalizeRun(fx)

    const running = createRun(fx, 'still going')
    const live = await seedTaskWithCheckout(fx, 'live task', running)
    fx.store.setRunState(running.id, 'active')

    const report = await workspaceClean(fx.ctx, { allRuns: true })

    expect(report.removed.map((r) => [r.runId, r.workspaceId])).toEqual([[fx.run.id, done.workspace.id]])
    expect(report.refusedRuns).toHaveLength(1)
    expect(report.refusedRuns[0]?.runId).toBe(running.id)
    expect(report.refusedRuns[0]?.reason).toContain("'active'")

    expect(existsSync(done.checkoutPath)).toBe(false)
    expect(fx.store.getWorkspace(done.workspace.id).state).toBe('removed')
    expect(existsSync(live.checkoutPath)).toBe(true)
    expect(fx.store.getWorkspace(live.workspace.id).state).toBe('active')
    expect(fx.store.listEvents(running.id, { type: 'workspace.removed' })).toHaveLength(0)
  })
})

describe('workspaceClean — evidence preservation and idempotence', () => {
  it('preserves the run artifacts and changes nothing on a second clean', async () => {
    const fx = makeProject()
    const done = await seedCompletedTask(fx, 'done task')
    terminalizeRun(fx)
    const artifactsDir = join(stateDir(fx.dir), 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })
    const artifactPath = join(artifactsDir, `integration-${fx.run.id}.json`)
    writeFileSync(artifactPath, '{"integrated":[]}\n')

    const first = await workspaceClean(fx.ctx, { runRef: fx.run.id })

    expect(first.removed).toHaveLength(1)
    expect(existsSync(artifactPath)).toBe(true)
    expect(readFileSync(artifactPath, 'utf8')).toBe('{"integrated":[]}\n')

    const second = await workspaceClean(fx.ctx, { runRef: fx.run.id })

    expect(second.removed).toEqual([])
    expect(second.skipped).toEqual([])
    expect(fx.store.listEvents(fx.run.id, { type: 'workspace.removed' })).toHaveLength(1)
    expect(existsSync(artifactPath)).toBe(true)
  })
})

describe('workspaceClean — flag validation', () => {
  it('requires exactly one of --run and --all-runs', async () => {
    const fx = makeProject()

    await expect(workspaceClean(fx.ctx, {})).rejects.toThrowError(ValidationError)
    await expect(workspaceClean(fx.ctx, {})).rejects.toThrowError(
      /pass exactly one of --run <id> or --all-runs/,
    )
    await expect(
      workspaceClean(fx.ctx, { runRef: fx.run.id, allRuns: true }),
    ).rejects.toThrowError(ValidationError)
    await expect(
      workspaceClean(fx.ctx, { runRef: fx.run.id, allRuns: true }),
    ).rejects.toThrowError(/pass exactly one of --run <id> or --all-runs/)

    // Validation happens before anything is touched: no workspace rows exist yet.
    expect(fx.store.listWorkspaces(fx.projectId)).toEqual([])
  })
})
