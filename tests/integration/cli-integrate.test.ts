import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { integrateRun } from '../../src/cli/commands/integrate.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { loadConfig, stateDir, workspaceDir } from '../../src/config/load.ts'
import { ValidationError } from '../../src/domain/errors.ts'
import type { RunRecord, TaskRecord, WorkspaceRecord } from '../../src/domain/models.ts'
import type { DatabaseSync } from '../../src/store/db.ts'
import { Store } from '../../src/store/store.ts'
import { GitWorkspaceManager } from '../../src/workspace/manager.ts'

/**
 * Integration: `pluton integrate` against real git repositories and the real
 * store. A tmp project is seeded with a run and completed tasks whose
 * Pluton-managed task checkouts carry per-task commits; `integrateRun` then
 * drives the real `GitWorkspaceManager` merge primitives into a Pluton-owned
 * integration checkout, runs the configured checks there and records events,
 * the workspace head and the report artifact. The only fake is nothing: git,
 * SQLite and the check processes are the real implementations.
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
  name: cli-integrate-it
  repository: .
  default_branch: main
  verification:
    - name: check-pass
      command: ["node", "-e", "console.log('inside:' + process.cwd())"]
    - name: check-fail
      command: ["node", "-e", "process.exit(3)"]
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

function makeProject(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-cli-integrate-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), CONFIG)
  writeFileSync(join(dir, 'README.md'), '# cli-integrate project\n')
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 30_000 })
  }
  git(['init', '-b', 'main'])
  git(['add', '.'])
  git(['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'seed'])

  const loaded = loadConfig(dir)
  const { store, projectId } = bootstrapStore(loaded)
  openDbs.push(store.db)
  const run = store.createRun({
    projectId,
    goal: 'integrate the verified tasks',
    origin: 'cli',
    requestedBy: 'integration-test',
    acceptanceCriteria: ['merged'],
    managerMuseId: 'manager',
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 20,
      maxDelegationDepth: 3,
      maxRunMinutes: 30,
      defaultTaskMinutes: 10,
    },
  })
  return {
    dir,
    ctx: { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded },
    store,
    projectId,
    run,
    manager: new GitWorkspaceManager({ workspacesRoot: workspaceDir(dir) }),
  }
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })
}

function write(checkoutPath: string, rel: string, content: string): void {
  const full = join(checkoutPath, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

interface SeededTask {
  task: TaskRecord
  workspace: WorkspaceRecord
  checkoutPath: string
  branch: string
}

/** Completed task (created → … → completed) with a Pluton-managed checkout carrying one commit. */
async function seedCompletedTask(
  fx: Fixture,
  title: string,
  mutate: (checkoutPath: string) => void,
): Promise<SeededTask> {
  const task = fx.store.createTask({
    runId: fx.run.id,
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
    runId: fx.run.id,
    slug: title,
    destName: task.id,
  })
  const workspace = fx.store.createWorkspace({
    projectId: fx.projectId,
    runId: fx.run.id,
    taskId: task.id,
    museId: 'worker-a',
    kind: 'task-checkout',
    path: info.path,
    branch: info.branch,
    baseCommit: info.baseCommit,
  })
  fx.store.setTaskState(task.id, 'running', { workspaceId: workspace.id })
  mutate(info.path)
  await fx.manager.commitAll(info.path, `pluton task: ${title}`)
  const done = fx.store.setTaskState(task.id, 'completed')
  return { task: done, workspace, checkoutPath: info.path, branch: info.branch }
}

/** Completed task with no workspace row — the integrate pre-flight must report it as failed, not crash. */
function seedCompletedTaskWithoutCheckout(fx: Fixture, title: string): TaskRecord {
  const task = fx.store.createTask({
    runId: fx.run.id,
    parentTaskId: null,
    title,
    brief: `do ${title}`,
    acceptanceCriteria: [],
    assigneeMuseId: 'worker-a',
  })
  fx.store.setTaskState(task.id, 'queued')
  fx.store.setTaskState(task.id, 'admitted')
  fx.store.setTaskState(task.id, 'running')
  return fx.store.setTaskState(task.id, 'completed')
}

function seedVerifyingTask(fx: Fixture, title: string): TaskRecord {
  const task = fx.store.createTask({
    runId: fx.run.id,
    parentTaskId: null,
    title,
    brief: `do ${title}`,
    acceptanceCriteria: [],
    assigneeMuseId: 'worker-a',
  })
  fx.store.setTaskState(task.id, 'queued')
  fx.store.setTaskState(task.id, 'admitted')
  fx.store.setTaskState(task.id, 'running')
  return fx.store.setTaskState(task.id, 'verifying')
}

describe('integrateRun — happy path (real git, real store)', () => {
  it('merges completed task branches with --no-ff, runs the checks in the integration checkout and writes the artifact', async () => {
    const fx = makeProject()
    const t1 = await seedCompletedTask(fx, 'one', (p) => write(p, 'src/a.ts', 'export const a = 1\n'))
    const t2 = await seedCompletedTask(fx, 'two', (p) => write(p, 'src/b.ts', 'export const b = 2\n'))

    const report = await integrateRun(fx.ctx, { runRef: fx.run.id })

    expect(report.runId).toBe(fx.run.id)
    expect(report.checkout.branch).toBe(`pluton/integration/${fx.run.id}`)
    expect(report.checkout.path).toBe(join(workspaceDir(fx.dir), `integration-${fx.run.id}`))

    expect(report.integrated).toHaveLength(2)
    const byTask = new Map(report.integrated.map((i) => [i.taskId, i]))
    expect(byTask.get(t1.task.id)).toMatchObject({ title: 'one', status: 'merged' })
    expect(byTask.get(t2.task.id)).toMatchObject({ title: 'two', status: 'merged' })
    for (const i of report.integrated) expect(i.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(report.conflicts).toEqual([])
    expect(report.blockedProtected).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.notAttempted).toEqual([])
    expect(report.stoppedAfterConflict).toBe(false)

    // Real git: two `--no-ff` merge commits, both task files on the branch.
    expect(gitOut(report.checkout.path, ['rev-list', '--merges', '--count', 'HEAD']).trim()).toBe('2')
    const logFiles = gitOut(report.checkout.path, ['log', '--name-only', '--format='])
    expect(logFiles).toContain('src/a.ts')
    expect(logFiles).toContain('src/b.ts')

    // The integration workspace row tracks the merged head.
    const ws = fx.store.getWorkspace(report.checkout.id)
    expect(ws.kind).toBe('integration-checkout')
    expect(ws.state).toBe('active')
    expect(ws.headCommit).toBe(gitOut(report.checkout.path, ['rev-parse', 'HEAD']).trim())

    // Checks: real exit codes, executed inside the integration checkout.
    expect(report.checks.map((c) => [c.name, c.status, c.exitCode])).toEqual([
      ['check-pass', 'passed', 0],
      ['check-fail', 'failed', 3],
    ])
    const passTail = report.checks[0]?.outputTail ?? ''
    expect(passTail.toLowerCase()).toContain(`inside:${report.checkout.path}`.toLowerCase())
    expect(report.checks[1]?.outputTail).toBeNull()

    // Events recorded.
    expect(fx.store.listEvents(fx.run.id, { type: 'integration.task_merged' })).toHaveLength(2)
    const checksEvents = fx.store.listEvents(fx.run.id, { type: 'integration.checks' })
    expect(checksEvents).toHaveLength(1)
    expect((checksEvents[0]?.payload as { checks: unknown[] }).checks).toHaveLength(2)

    // Artifact: the whole report on disk.
    expect(report.artifactPath).toBe(join(stateDir(fx.dir), 'artifacts', `integration-${fx.run.id}.json`))
    const artifactPath = report.artifactPath as string
    expect(existsSync(artifactPath)).toBe(true)
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      integrated: unknown[]
      checks: unknown[]
    }
    expect(artifact.integrated).toHaveLength(2)
    expect(artifact.checks).toHaveLength(2)
  })

  it('reruns idempotently: everything is already_integrated and no new commit appears', async () => {
    const fx = makeProject()
    await seedCompletedTask(fx, 'one', (p) => write(p, 'src/a.ts', 'export const a = 1\n'))
    await seedCompletedTask(fx, 'two', (p) => write(p, 'src/b.ts', 'export const b = 2\n'))

    const first = await integrateRun(fx.ctx, { runRef: fx.run.id })
    expect(first.integrated.every((i) => i.status === 'merged')).toBe(true)
    const countBefore = gitOut(first.checkout.path, ['rev-list', '--count', 'HEAD']).trim()

    const second = await integrateRun(fx.ctx, { runRef: fx.run.id })

    expect(second.checkout.id).toBe(first.checkout.id) // the checkout row is reused
    expect(second.integrated).toHaveLength(2)
    expect(second.integrated.every((i) => i.status === 'already_integrated')).toBe(true)
    for (const i of second.integrated) expect(i.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(second.conflicts).toEqual([])
    expect(second.failed).toEqual([])
    expect(gitOut(second.checkout.path, ['rev-list', '--count', 'HEAD']).trim()).toBe(countBefore)
  })
})

describe('integrateRun — conflicts stop the loop and are preserved', () => {
  it('keeps the mid-merge state, reports the conflict, names the skipped tasks, and refuses on rerun', async () => {
    const fx = makeProject()
    // Both branches add the same file with different content: add/add conflict.
    const t1 = await seedCompletedTask(fx, 'alpha', (p) => write(p, 'src/app.ts', 'export const value = "alpha"\n'))
    const t2 = await seedCompletedTask(fx, 'beta', (p) => write(p, 'src/app.ts', 'export const value = "beta"\n'))
    const t3 = await seedCompletedTask(fx, 'gamma', (p) => write(p, 'src/g.ts', 'export const g = 1\n'))

    const report = await integrateRun(fx.ctx, {
      runRef: fx.run.id,
      taskRefs: [t1.task.id, t2.task.id, t3.task.id],
    })

    expect(report.integrated.map((i) => [i.taskId, i.status])).toEqual([[t1.task.id, 'merged']])
    expect(report.conflicts).toEqual([{ taskId: t2.task.id, files: ['src/app.ts'] }])
    expect(report.failed).toEqual([])
    expect(report.stoppedAfterConflict).toBe(true)
    expect(report.notAttempted).toEqual([{ taskId: t3.task.id }])
    expect(report.checks).toEqual([])
    expect(report.artifactPath).toBeNull()

    // The merge state is PRESERVED: MERGE_HEAD is present, nothing was reset or aborted.
    const checkoutPath = report.checkout.path
    const headAfterConflict = gitOut(checkoutPath, ['rev-parse', 'HEAD']).trim()
    expect(existsSync(join(checkoutPath, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(fx.store.listEvents(fx.run.id, { type: 'integration.conflict' })).toHaveLength(1)

    // Rerun: the unresolved merge is refused before anything is fetched or merged.
    const rerun = await integrateRun(fx.ctx, { runRef: fx.run.id })
    const t2Failure = rerun.failed.find((f) => f.taskId === t2.task.id)
    expect(t2Failure?.detail).toContain('unresolved merge in progress')
    expect(rerun.integrated).toEqual([])
    expect(rerun.conflicts).toEqual([])
    expect(rerun.notAttempted).toEqual([])
    expect(rerun.stoppedAfterConflict).toBe(false)
    expect(gitOut(checkoutPath, ['rev-parse', 'HEAD']).trim()).toBe(headAfterConflict)
    expect(existsSync(join(checkoutPath, '.git', 'MERGE_HEAD'))).toBe(true)
  })
})

describe('integrateRun — protected paths gate', () => {
  it('blocks a protected-path task behind a pending approval, then merges it once approved', async () => {
    const fx = makeProject()
    const t1 = await seedCompletedTask(fx, 'touch secrets', (p) => write(p, 'secrets/prod.env', 'KEY=value\n'))

    const blocked = await integrateRun(fx.ctx, { runRef: fx.run.id })

    expect(blocked.integrated).toEqual([])
    expect(blocked.blockedProtected).toHaveLength(1)
    expect(blocked.blockedProtected[0]).toMatchObject({
      taskId: t1.task.id,
      files: ['secrets/prod.env'],
    })
    expect(blocked.artifactPath).toBeNull()

    // Nothing merged: the checkout still sits at its base commit.
    const checkoutPath = blocked.checkout.path
    const headBefore = gitOut(checkoutPath, ['rev-parse', 'HEAD']).trim()

    const approvalId = blocked.blockedProtected[0]?.approvalId as string
    const approval = fx.store.getApproval(approvalId)
    expect(approval.action).toBe('integration.apply')
    expect(approval.status).toBe('pending')
    expect(approval.runId).toBe(fx.run.id)
    expect(approval.taskId).toBe(t1.task.id)
    expect(approval.scope).toMatchObject({ taskId: t1.task.id, runId: fx.run.id, files: ['secrets/prod.env'] })
    // The expiry rides runtime.approval_timeout_minutes (30 in the fixture config).
    expect(approval.expiresAt).not.toBeNull()
    const remainingMinutes = (Date.parse(approval.expiresAt as string) - Date.now()) / 60_000
    expect(remainingMinutes).toBeGreaterThan(29)
    expect(remainingMinutes).toBeLessThan(31)
    expect(fx.store.listEvents(fx.run.id, { type: 'integration.blocked' })).toHaveLength(1)

    // Approve, rerun: now the same task merges through the gate.
    fx.store.setApprovalStatus(approvalId, 'approved', { decidedBy: 'operator' })
    const merged = await integrateRun(fx.ctx, { runRef: fx.run.id })

    expect(merged.blockedProtected).toEqual([])
    expect(merged.integrated.map((i) => [i.taskId, i.status])).toEqual([[t1.task.id, 'merged']])
    expect(gitOut(checkoutPath, ['rev-parse', 'HEAD']).trim()).not.toBe(headBefore)
    expect(merged.checks).toHaveLength(2)
  })
})

describe('integrateRun — task selection and pre-flight refusals', () => {
  it('integrates only the selected tasks and leaves the other completed tasks alone', async () => {
    const fx = makeProject()
    await seedCompletedTask(fx, 'one', (p) => write(p, 'src/a.ts', 'export const a = 1\n'))
    const t2 = await seedCompletedTask(fx, 'two', (p) => write(p, 'src/b.ts', 'export const b = 2\n'))
    await seedCompletedTask(fx, 'three', (p) => write(p, 'src/c.ts', 'export const c = 3\n'))

    const report = await integrateRun(fx.ctx, { runRef: fx.run.id, taskRefs: [t2.task.id] })

    expect(report.integrated.map((i) => i.taskId)).toEqual([t2.task.id])
    const logFiles = gitOut(report.checkout.path, ['log', '--name-only', '--format='])
    expect(logFiles).toContain('src/b.ts')
    expect(logFiles).not.toContain('src/a.ts')
    expect(logFiles).not.toContain('src/c.ts')
  })

  it('refuses task refs that are not completed', async () => {
    const fx = makeProject()
    const verifying = seedVerifyingTask(fx, 'still verifying')

    await expect(
      integrateRun(fx.ctx, { runRef: fx.run.id, taskRefs: [verifying.id] }),
    ).rejects.toThrowError(ValidationError)
    await expect(
      integrateRun(fx.ctx, { runRef: fx.run.id, taskRefs: [verifying.id] }),
    ).rejects.toThrowError(/only completed/)
  })

  it('refuses a run with no completed (verified) tasks', async () => {
    const fx = makeProject()
    seedVerifyingTask(fx, 'not done yet')

    await expect(integrateRun(fx.ctx, { runRef: fx.run.id })).rejects.toThrowError(/no completed/)
  })

  it('reports a completed task without an active checkout as failed and integrates the rest', async () => {
    const fx = makeProject()
    const orphan = seedCompletedTaskWithoutCheckout(fx, 'orphan')
    const t2 = await seedCompletedTask(fx, 'two', (p) => write(p, 'src/b.ts', 'export const b = 2\n'))

    const report = await integrateRun(fx.ctx, { runRef: fx.run.id, taskRefs: [orphan.id, t2.task.id] })

    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.taskId).toBe(orphan.id)
    expect(report.failed[0]?.detail).toContain('checkout')
    expect(report.integrated.map((i) => i.taskId)).toEqual([t2.task.id])
  })
})
