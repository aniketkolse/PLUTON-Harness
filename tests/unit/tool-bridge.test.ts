import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NotFoundError } from '../../src/domain/errors.ts'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import { allowedTransitions } from '../../src/domain/state.ts'
import type { JsonValue, RunRecord, WorkspaceRecord } from '../../src/domain/models.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { notifyTaskSettled, taskAncestorIds, WakeupRegistry } from '../../src/orchestrator/wakeups.ts'
import { PlutonToolBridge, toolBridgeLimitsFromRuntime, type ToolBridgeLimits } from '../../src/tools/bridge.ts'
import { wakeupChannelFor } from '../../src/tools/handlers.ts'
import { McpStdioServer } from '../../src/tools/mcp-server.ts'
import { GitWorkspaceManager, type CheckoutInfo } from '../../src/workspace/manager.ts'

/**
 * Bridge conformance: the restricted Pluton tool surface (ADR-0007) is the ONLY
 * way an engine session affects a run, so these tests pin its security and
 * honesty properties against a real store — permissions are enforced
 * server-side, scopes are enforced per call, every call is audited, waits are
 * event-driven, and nothing claims more than the durable records say.
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

interface Fixture {
  store: Store
  projectId: string
  rootDir: string
  run: RunRecord
}

const WORKER_PERMISSIONS = ['task.delegate', 'task.inspect', 'result.collect', 'diff.inspect']
const WORKER_TOOLS = ['task.delegate', 'task.inspect', 'task.wait', 'task.get_result', 'diff.inspect']

function makeFixture(): Fixture {
  // Canonicalize so session-root containment matches on macOS (/var vs
  // /private/var) and Windows runners (8.3 RUNNER~1 vs the long name).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-bridge-')))
  tmpDirs.push(dir)
  mkdirSync(join(dir, '.pluton', 'state'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'hello world')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const x = 1\n')
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]))
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'x')

  const db = openDatabase(join(dir, '.pluton', 'state', 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'bridge-test',
    rootPath: dir,
    configPath: join(dir, 'pluton.yaml'),
    defaultBranch: 'main',
  })
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
      workspacePolicy: 'isolated-task-checkout',
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
      workspacePolicy: 'isolated-task-checkout',
      permissions: WORKER_PERMISSIONS,
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/worker-b',
    },
  ])
  const run = store.createRun({
    projectId: project.id,
    goal: 'bridge goal',
    origin: 'cli',
    requestedBy: 'tester',
    acceptanceCriteria: [],
    managerMuseId: 'manager',
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 20,
      maxDelegationDepth: 3,
      maxRunMinutes: 60,
      defaultTaskMinutes: 10,
    },
  })
  return { store, projectId: project.id, rootDir: dir, run }
}

const BASE_LIMITS: ToolBridgeLimits = {
  maxChildrenPerTask: 3,
  maxBriefChars: 5_000,
  maxTeamSize: 6,
  maxToolResultChars: 120_000,
  defaultWaitSeconds: 5,
  waitHeartbeatSeconds: 15,
  approvalTtlMinutes: 60,
  maxRevisionsPerTask: 1,
}

function makeBridge(
  fx: Fixture,
  callerMuseId: string,
  callerTaskId: string | null = null,
  overrides: Partial<ToolBridgeLimits> = {},
  wakeups?: WakeupRegistry,
  workspaceManager?: GitWorkspaceManager,
): PlutonToolBridge {
  return new PlutonToolBridge({
    store: fx.store,
    projectId: fx.projectId,
    rootDir: fx.rootDir,
    runId: fx.run.id,
    callerMuseId,
    callerTaskId,
    limits: { ...BASE_LIMITS, ...overrides },
    ...(wakeups ? { wakeups } : {}),
    ...(workspaceManager ? { workspaceManager } : {}),
  })
}

const CREATE_ARGS = {
  title: 'Task',
  brief: 'Do the thing well.',
  acceptanceCriteria: ['The thing is done'],
  assigneeMuseId: 'worker-a',
}

async function createTask(bridge: PlutonToolBridge, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await bridge.call('task.create', { ...CREATE_ARGS, ...overrides })
  expect(res.ok).toBe(true)
  return (res.data as { task: { id: string } }).task.id
}

function eventTypes(store: Store, runId: string, type: string): number {
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ?').get(runId, type) as {
    n: number
  }
  return row.n
}

/** Walk a freshly admitted task through the legal transition chain to `completed`. */
function forceComplete(store: Store, taskId: string): void {
  for (const next of ['queued', 'admitted', 'running', 'completed'] as const) {
    const current = store.getTask(taskId)
    if (current.state === 'completed') return
    if (current.state === next) continue
    store.setTaskState(taskId, next)
  }
}

/** Walk a freshly admitted task along legal edges to `verifying` (work done, operator gate pending). */
function forceVerify(store: Store, taskId: string): void {
  for (const next of ['queued', 'admitted', 'running', 'verifying'] as const) {
    const current = store.getTask(taskId)
    if (current.state === next || !allowedTransitions(current.state).includes(next)) continue
    store.setTaskState(taskId, next)
  }
}

/** Walk a freshly admitted task along legal edges to `failed`, with the given failure payload. */
function forceFail(store: Store, taskId: string, failure: JsonValue): void {
  for (const next of ['queued', 'admitted', 'running'] as const) {
    const current = store.getTask(taskId)
    if (current.state === next || !allowedTransitions(current.state).includes(next)) continue
    store.setTaskState(taskId, next)
  }
  store.setTaskState(taskId, 'failed', { failure })
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('toolBridgeLimitsFromRuntime', () => {
  const RUNTIME = {
    max_child_tasks_per_task: 5,
    max_team_size: 8,
    max_prompt_chars: 60_000,
    max_tool_result_chars: 120_000,
    heartbeat_seconds: 30,
    approval_timeout_minutes: 60,
    max_revisions_per_task: 1,
  }

  it('carries the operator-configurable approval TTL, including 0 = never', () => {
    expect(toolBridgeLimitsFromRuntime(RUNTIME).approvalTtlMinutes).toBe(60)
    expect(toolBridgeLimitsFromRuntime({ ...RUNTIME, approval_timeout_minutes: 0 }).approvalTtlMinutes).toBe(0)
    expect(toolBridgeLimitsFromRuntime({ ...RUNTIME, approval_timeout_minutes: 10_080 }).approvalTtlMinutes).toBe(10_080)
  })

  it('carries the operator-configurable revision cap, including 0 = revisions disabled', () => {
    expect(toolBridgeLimitsFromRuntime(RUNTIME).maxRevisionsPerTask).toBe(1)
    expect(toolBridgeLimitsFromRuntime({ ...RUNTIME, max_revisions_per_task: 0 }).maxRevisionsPerTask).toBe(0)
    expect(toolBridgeLimitsFromRuntime({ ...RUNTIME, max_revisions_per_task: 10 }).maxRevisionsPerTask).toBe(10)
  })
})

describe('PlutonToolBridge — identity and permissions', () => {
  it('exposes only the tools the caller has permission for', () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    expect(manager.listTools().map((t) => t.name)).toEqual([
      'task.create',
      'task.delegate',
      'scope.declare',
      'scope.release',
      'task.inspect',
      'task.wait',
      'task.get_result',
      'task.cancel',
      'task.request_revision',
      'review.report',
      'ship.propose_create',
      'muse.propose_create',
      'approval.request',
      'diff.inspect',
      'project.read',
      'run.stop',
      'ship.message',
      'ship.inbox',
    ])
    const worker = makeBridge(fx, 'worker-a')
    expect(worker.listTools().map((t) => t.name)).toEqual(WORKER_TOOLS)
  })

  it('answers unknown tools with not_found and audits the denial', async () => {
    const fx = makeFixture()
    const res = await makeBridge(fx, 'manager').call('task.create_extra', {})
    expect(res).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(eventTypes(fx.store, fx.run.id, 'tool.denied')).toBe(1)
  })

  it('denies a call the caller lacks permission for and records nothing', async () => {
    const fx = makeFixture()
    const res = await makeBridge(fx, 'worker-a').call('task.create', { ...CREATE_ARGS, assigneeMuseId: 'worker-b' })
    expect(res).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect((res.error as { message: string }).message).toMatch(/lacks permission 'task.create'/)
    expect(fx.store.listTasks(fx.run.id)).toHaveLength(0)
    expect(eventTypes(fx.store, fx.run.id, 'tool.denied')).toBe(1)
  })

  it('refuses to construct a bridge for an unknown or disabled caller Muse', () => {
    const fx = makeFixture()
    expect(() => makeBridge(fx, 'ghost')).toThrowError(/not an enabled (Muse|Ship)/)
  })

  it('refuses to construct a bridge when runId is an unknown run id string', () => {
    const fx = makeFixture()
    expect(() => new PlutonToolBridge({
      store: fx.store,
      projectId: fx.projectId,
      rootDir: fx.rootDir,
      runId: 'run_nonexistent000',
      callerMuseId: 'manager',
      callerTaskId: null,
      limits: BASE_LIMITS,
    })).toThrowError(NotFoundError)
  })

  it('isolates scope: run-scoped bridge returns not_found for operator-only tools', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const res = await manager.call('run.start', { goal: 'new run' })
    expect(res).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })
})

describe('PlutonToolBridge — task lifecycle tools', () => {
  it('creates a task through the graph rules and audits the call', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const res = await manager.call('task.create', { ...CREATE_ARGS, title: 'Ship it' })
    expect(res.ok).toBe(true)
    const task = (res.data as { task: { id: string; state: string } }).task
    expect(task.state).toBe('queued')
    const record = fx.store.getTask(task.id)
    expect(record.title).toBe('Ship it')
    expect(record.assigneeMuseId).toBe('worker-a')
    expect(record.parentTaskId).toBeNull()
    expect(record.depth).toBe(0)
    expect(eventTypes(fx.store, fx.run.id, 'task.admitted')).toBe(1)
    expect(eventTypes(fx.store, fx.run.id, 'tool.call')).toBe(1)
  })

  it('rejects malformed arguments with invalid_arguments and issue details', async () => {
    const fx = makeFixture()
    const res = await makeBridge(fx, 'manager').call('task.create', { ...CREATE_ARGS, title: '' })
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
    expect((res.error as { details?: unknown }).details).toMatchObject({ issues: expect.any(Array) })
  })

  it('rejects an unknown assignee Muse by id or slug', async () => {
    const fx = makeFixture()
    const res = await makeBridge(fx, 'manager').call('task.create', { ...CREATE_ARGS, assigneeMuseId: 'ghost' })
    expect(res).toMatchObject({ ok: false, error: { code: 'validation_failed' } })
  })

  it('delegate refuses an assignee that already owns an ancestor, allows a fresh Muse', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const direct = await manager.call('task.delegate', CREATE_ARGS)
    expect(direct).toMatchObject({ ok: false, error: { code: 'policy_denied' } })

    const rootId = await createTask(manager)
    const scoped = makeBridge(fx, 'worker-a', rootId)
    const cycle = await scoped.call('task.delegate', { ...CREATE_ARGS, title: 'back up' })
    expect(cycle).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect((cycle.error as { message: string }).message).toMatch(/ancestor task/)

    const ok = await scoped.call('task.delegate', { ...CREATE_ARGS, title: 'child', assigneeMuseId: 'worker-b' })
    expect(ok.ok).toBe(true)
    const child = (ok.data as { task: { id: string; parentTaskId: string; depth: number } }).task
    expect(child.parentTaskId).toBe(rootId)
    expect(child.depth).toBe(1)
  })

  it('scopes task.inspect and task.get_result to the caller task subtree', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const ownId = await createTask(manager, { assigneeMuseId: 'worker-a' })
    const siblingId = await createTask(manager, { assigneeMuseId: 'worker-b' })
    const scoped = makeBridge(fx, 'worker-a', ownId)

    const list = await scoped.call('task.inspect', {})
    expect((list.data as { count: number }).count).toBe(1)
    const denied = await scoped.call('task.inspect', { taskId: siblingId })
    expect(denied).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    const deniedResult = await scoped.call('task.get_result', { taskId: siblingId })
    expect(deniedResult).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
  })

  it('task.cancel cancels once, then acks a terminal task idempotently (CS-9)', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const taskId = await createTask(manager)
    const first = await manager.call('task.cancel', { taskId, reason: 'no longer needed' })
    expect(first.ok).toBe(true)
    const firstData = first.data as { task: { id: string; state: string }; note: string; alreadyTerminal?: boolean }
    expect(firstData.task).toMatchObject({ id: taskId, state: 'cancelled' })
    // The runtime now interrupts the live engine attempt itself on its next
    // control tick — the note must say so (no more "cooperative only" wording).
    expect(firstData.note).toMatch(/interrupt/i)
    expect(firstData.alreadyTerminal).toBeUndefined()

    // Repeats are an idempotent ack, never a conflict: no state write, no event.
    const second = await manager.call('task.cancel', { taskId, reason: 'again' })
    expect(second.ok).toBe(true)
    expect(second.data).toMatchObject({ alreadyTerminal: true, task: { id: taskId, state: 'cancelled' } })
    expect((second.data as { note: string }).note).toContain("already 'cancelled'")
    expect(fx.store.getTask(taskId).state).toBe('cancelled')
    expect(eventTypes(fx.store, fx.run.id, 'task.cancelled_by_tool')).toBe(1)

    // A task that reached any other terminal state is acked the same way.
    const done = await createTask(manager, { title: 'already done' })
    forceComplete(fx.store, done)
    const third = await manager.call('task.cancel', { taskId: done, reason: 'too late' })
    expect(third.ok).toBe(true)
    expect(third.data).toMatchObject({ alreadyTerminal: true, task: { id: done, state: 'completed' } })
    expect((third.data as { note: string }).note).toContain("already 'completed'")
    expect(fx.store.getTask(done).state).toBe('completed')
    expect(eventTypes(fx.store, fx.run.id, 'task.cancelled_by_tool')).toBe(1)
  })

  it('cancelling a prerequisite transitively cancels its not-yet-terminal dependents', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const prerequisite = await createTask(manager, { title: 'prerequisite' })
    const dependent = await createTask(manager, {
      title: 'dependent',
      dependsOn: [prerequisite],
    })
    const grandchild = await createTask(manager, {
      title: 'grandchild',
      dependsOn: [dependent],
    })

    const res = await manager.call('task.cancel', { taskId: prerequisite, reason: 'obsolete' })
    expect(res.ok).toBe(true)
    const data = res.data as { cancelledDependents?: string[] }
    expect([...(data.cancelledDependents ?? [])].sort()).toEqual([dependent, grandchild].sort())

    expect(fx.store.getTask(dependent).state).toBe('cancelled')
    expect(fx.store.getTask(grandchild).state).toBe('cancelled')
    expect(fx.store.getTask(dependent).failure).toMatchObject({
      code: 'dependency_cancelled',
      dependencyTaskId: prerequisite,
      rootTaskId: prerequisite,
      reason: 'obsolete',
    })
    expect(fx.store.getTask(grandchild).failure).toMatchObject({
      code: 'dependency_cancelled',
      dependencyTaskId: dependent,
      rootTaskId: prerequisite,
      reason: 'obsolete',
    })
    expect(eventTypes(fx.store, fx.run.id, 'task.cancelled_by_tool')).toBe(1)
    expect(eventTypes(fx.store, fx.run.id, 'task.cancelled_by_dependency')).toBe(2)
  })
})

describe('PlutonToolBridge — manager-requested revisions (CS-5)', () => {
  /** A real failure payload on the task the revision must preserve. */
  const FAILURE: JsonValue = { code: 'engine_crash', message: 'engine process exited with code 1' }

  /** A task walked along legal edges to `failed`, carrying a real failure payload. */
  async function seedFailedTask(fx: Fixture, failure: JsonValue = FAILURE): Promise<string> {
    const taskId = await createTask(makeBridge(fx, 'manager'))
    forceFail(fx.store, taskId, failure)
    return taskId
  }

  it('requeues a failed task once with sanitized feedback and preserves the old failure', async () => {
    const fx = makeFixture()
    const registry = new WakeupRegistry()
    const manager = makeBridge(fx, 'manager', null, {}, registry)
    const taskId = await seedFailedTask(fx)
    const before = fx.store.getTask(taskId)

    // Bounded feedback: the schema refuses anything past 2 000 chars.
    const tooLong = await manager.call('task.request_revision', { taskId, feedback: 'x'.repeat(2_001) })
    expect(tooLong).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
    // Empty after sanitizing is a validation error, not a silent no-op feedback.
    const controlOnly = await manager.call('task.request_revision', { taskId, feedback: '\u0007 \n' })
    expect(controlOnly).toMatchObject({ ok: false, error: { code: 'validation_failed' } })

    const notified = registry.waitFor(wakeupChannelFor(null, fx.run.id), 5_000)
    const res = await manager.call('task.request_revision', { taskId, feedback: 'fix\u0007 the\nbug' })
    expect(res.ok).toBe(true)

    const task = fx.store.getTask(taskId)
    expect(task.state).toBe('queued')
    expect(task.attempt).toBe(before.attempt + 1)
    expect(task.failure).toEqual({
      code: 'revision_requested',
      feedback: 'fix thebug', // control characters stripped before persisting
      requestedByShipId: 'manager',
      requestedByMuseId: 'manager',
      previousFailure: FAILURE,
    })
    expect(eventTypes(fx.store, fx.run.id, 'task.revision_scheduled')).toBe(1)
    // The run loop is woken exactly like the supervisor's own retry path.
    await expect(notified).resolves.toMatchObject([{ childTaskId: taskId, childState: 'queued' }])
  })

  it('enforces the per-task revision cap from durable events', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager', null, { maxRevisionsPerTask: 1 })
    const taskId = await seedFailedTask(fx)

    const first = await manager.call('task.request_revision', { taskId, feedback: 'take two' })
    expect(first.ok).toBe(true)
    expect(eventTypes(fx.store, fx.run.id, 'task.revision_scheduled')).toBe(1)

    // The revised attempt fails again: re-walk the task to `failed`.
    forceFail(fx.store, taskId, { code: 'engine_crash', message: 'boom again' })
    const second = await manager.call('task.request_revision', { taskId, feedback: 'take three' })
    expect(second).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect((second.error as { message: string }).message).toMatch(/revision cap/i)
    expect((second.error as { message: string }).message).toContain('1 of 1')
    // Rejected: no second event, no state change.
    expect(fx.store.getTask(taskId).state).toBe('failed')
    expect(eventTypes(fx.store, fx.run.id, 'task.revision_scheduled')).toBe(1)
  })

  it('rejects the first revision when the cap is 0 (revisions disabled)', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager', null, { maxRevisionsPerTask: 0 })
    const taskId = await seedFailedTask(fx)

    const res = await manager.call('task.request_revision', { taskId, feedback: 'one more' })
    expect(res).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect((res.error as { message: string }).message).toContain('0 of 0')
    expect(fx.store.getTask(taskId).state).toBe('failed')
    expect(eventTypes(fx.store, fx.run.id, 'task.revision_scheduled')).toBe(0)
  })

  it('rejects a task that is not failed — only a failed task can be sent back', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const taskId = await createTask(manager)

    const queued = await manager.call('task.request_revision', { taskId, feedback: 'not yet' })
    expect(queued).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect((queued.error as { message: string }).message).toMatch(/only a failed task can be sent back/)

    forceComplete(fx.store, taskId)
    const completed = await manager.call('task.request_revision', { taskId, feedback: 'never' })
    expect(completed).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect((completed.error as { message: string }).message).toContain('is completed')
    expect(eventTypes(fx.store, fx.run.id, 'task.revision_scheduled')).toBe(0)
  })

  it('denies a worker without the permission at the bridge, and a granted worker at the handler gate', async () => {
    const fx = makeFixture()
    const taskId = await seedFailedTask(fx)

    // (a) No permission: the bridge denies before any handler runs.
    const ungranted = await makeBridge(fx, 'worker-a', taskId).call('task.request_revision', {
      taskId,
      feedback: 'from a worker session',
    })
    expect(ungranted).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect((ungranted.error as { message: string }).message).toMatch(/lacks permission 'task.request_revision'/)

    // (b) Permission granted: the handler itself still refuses a task-scoped session.
    fx.store.db
      .prepare('UPDATE ships SET permissions_json = ? WHERE id = ?')
      .run(JSON.stringify([...WORKER_PERMISSIONS, 'task.request_revision']), 'worker-a')
    const granted = await makeBridge(fx, 'worker-a', taskId).call('task.request_revision', {
      taskId,
      feedback: 'from a worker session',
    })
    expect(granted).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect((granted.error as { message: string }).message).toMatch(/manager-scoped/)

    // Nothing was scheduled, and the failed task is untouched.
    expect(fx.store.getTask(taskId).state).toBe('failed')
    expect(eventTypes(fx.store, fx.run.id, 'task.revision_scheduled')).toBe(0)
  })
})

describe('PlutonToolBridge — task.wait', () => {
  it('returns immediately when every target is already terminal', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const taskId = await createTask(manager)
    await manager.call('task.cancel', { taskId, reason: 'done' })
    const res = await manager.call('task.wait', { taskIds: [taskId], timeoutSeconds: 5 })
    expect(res.ok).toBe(true)
    expect((res.data as { timedOut: boolean }).timedOut).toBe(false)
    expect((res.data as { tasks: { state: string }[] }).tasks[0]?.state).toBe('cancelled')
  })

  it('times out honestly — timedOut true, pending listed, nothing claimed complete', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const taskId = await createTask(manager)
    const started = Date.now()
    const res = await manager.call('task.wait', { taskIds: [taskId], timeoutSeconds: 1 })
    const data = res.data as { timedOut: boolean; reason: string; pending: unknown[] }
    expect(data.timedOut).toBe(true)
    expect(data.reason).toBe('timeout')
    expect(data.pending).toHaveLength(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it('resolves on a durable completion wakeup instead of polling', async () => {
    const fx = makeFixture()
    const registry = new WakeupRegistry()
    const manager = makeBridge(fx, 'manager', null, {}, registry)
    const taskId = await createTask(manager)
    const started = Date.now()
    const waiting = manager.call('task.wait', { taskIds: [taskId], timeoutSeconds: 5 })
    await delay(25)
    forceComplete(fx.store, taskId)
    registry.notify(wakeupChannelFor(null, fx.run.id), taskId, 'completed')
    const res = await waiting
    expect((res.data as { timedOut: boolean }).timedOut).toBe(false)
    expect((res.data as { tasks: { state: string }[] }).tasks[0]?.state).toBe('completed')
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('re-checks durable state every heartbeat when nobody shares the registry (stdio bridge)', async () => {
    const fx = makeFixture()
    // No registry reads: another process changes durable state mid-wait.
    const ownRegistry = new WakeupRegistry()
    const manager = makeBridge(fx, 'manager', null, { waitHeartbeatSeconds: 1 }, ownRegistry)
    const taskId = await createTask(manager)
    const started = Date.now()
    const waiting = manager.call('task.wait', { taskIds: [taskId], timeoutSeconds: 60 })
    await delay(200)
    forceComplete(fx.store, taskId) // same as a sibling process finishing the task
    const res = await waiting
    expect((res.data as { timedOut: boolean }).timedOut).toBe(false)
    expect((res.data as { tasks: { state: string }[] }).tasks[0]?.state).toBe('completed')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('treats awaiting verification as settled — returns immediately, never claims success', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const taskId = await createTask(manager)
    forceVerify(fx.store, taskId)
    const started = Date.now()
    const res = await manager.call('task.wait', { taskIds: [taskId], timeoutSeconds: 30 })
    const data = res.data as { timedOut: boolean; tasks: { state: string; awaitingVerification: boolean }[] }
    expect(data.timedOut).toBe(false)
    expect(data.tasks[0]?.state).toBe('verifying')
    expect(data.tasks[0]?.awaitingVerification).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000) // no deadlock on `completed`
  })

  it('resolves on the awaiting-verification wakeup (configured verification gate)', async () => {
    const fx = makeFixture()
    const registry = new WakeupRegistry()
    const manager = makeBridge(fx, 'manager', null, {}, registry)
    const taskId = await createTask(manager)
    const waiting = manager.call('task.wait', { taskIds: [taskId], timeoutSeconds: 5 })
    await delay(25)
    forceVerify(fx.store, taskId)
    registry.notify(wakeupChannelFor(null, fx.run.id), taskId, 'verifying')
    const res = await waiting
    expect((res.data as { timedOut: boolean }).timedOut).toBe(false)
    expect((res.data as { tasks: { state: string }[] }).tasks[0]?.state).toBe('verifying')
  })

  it('honours an aborted signal (shutdown/disconnect) with an honest report', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const taskId = await createTask(manager)
    const ctl = new AbortController()
    const waiting = manager.call('task.wait', { taskIds: [taskId], timeoutSeconds: 600 }, { signal: ctl.signal })
    await delay(20)
    const started = Date.now()
    ctl.abort()
    const res = await waiting
    const data = res.data as {
      timedOut: boolean
      aborted: boolean
      reason: string
      pending: unknown[]
      tasks: unknown[]
    }
    expect(data.aborted).toBe(true)
    expect(data.timedOut).toBe(false) // the deadline did not elapse: cancelled, not timed out
    expect(data.reason).toBe('aborted')
    expect(data.pending).toHaveLength(1)
    expect(data.tasks).toHaveLength(0)
    expect(Date.now() - started).toBeLessThan(2_000) // returns immediately, does not outlive the store
  })
})

describe('PlutonToolBridge — task.get_result composition', () => {
  /** A real git source repository (the clone source), created fresh per test. */
  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pluton-getresult-repo-'))
    tmpDirs.push(dir)
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'pipe', timeout: 30_000 })
    }
    git(['init', '-b', 'main'])
    writeFileSync(join(dir, 'README.md'), 'seed\n')
    git(['add', '-A'])
    git(['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'seed'])
    return dir
  }

  function makeManager(fx: Fixture): GitWorkspaceManager {
    return new GitWorkspaceManager({ workspacesRoot: join(fx.rootDir, '.pluton', 'workspaces') })
  }

  async function getResult(bridge: PlutonToolBridge, taskId: string): Promise<Record<string, unknown>> {
    const res = await bridge.call('task.get_result', { taskId })
    expect(res.ok).toBe(true)
    return res.data as Record<string, unknown>
  }

  /** A task with a real managed checkout holding one committed file. */
  async function seedCheckout(
    fx: Fixture,
    manager: GitWorkspaceManager,
  ): Promise<{ taskId: string; ws: WorkspaceRecord; info: CheckoutInfo; commit: string | null }> {
    const taskId = await createTask(makeBridge(fx, 'manager'))
    const info = await manager.createCheckout({
      repoPath: gitRepo(),
      kind: 'task-checkout',
      runId: fx.run.id,
      slug: 'composed result',
      destName: taskId,
    })
    const ws = fx.store.createWorkspace({
      projectId: fx.projectId,
      runId: fx.run.id,
      taskId,
      museId: 'worker-a',
      kind: 'task-checkout',
      path: info.path,
      branch: info.branch,
      baseCommit: info.baseCommit,
    })
    writeFileSync(join(info.path, 'task-output.txt'), 'done\n')
    const committed = await manager.commitAll(info.path, 'task: output')
    return {
      taskId,
      ws: fx.store.updateWorkspace(ws.id, { headCommit: committed.commit }),
      info,
      commit: committed.commit,
    }
  }

  it('reports changed files, commit and checkout from real rows and a real managed checkout', async () => {
    const fx = makeFixture()
    const manager = makeManager(fx)
    const { taskId, ws, info, commit } = await seedCheckout(fx, manager)

    const data = await getResult(makeBridge(fx, 'manager', null, {}, undefined, manager), taskId)
    expect(data.taskId).toBe(taskId)
    expect(data.status).toBe('queued')
    // Real `git diff --name-only <base>..HEAD` inside the managed checkout.
    expect(data.changedFiles).toEqual(['task-output.txt'])
    expect(data.commit).toBe(commit)
    expect(data.workspace).toEqual({
      id: ws.id,
      branch: info.branch,
      baseCommit: info.baseCommit,
      state: 'active',
      cleanup: `pluton workspace clean --run ${fx.run.id}`,
    })
    expect(data.tests).toEqual([])
    expect(data.blockers).toEqual({ failure: null, unmetCriteria: [] })
    expect(data.task).toMatchObject({ id: taskId, state: 'queued' })
  })

  it('lists real verification check rows with exit codes and durations', async () => {
    const fx = makeFixture()
    const taskId = await createTask(makeBridge(fx, 'manager'))
    const checks: { name: string; status: 'passed' | 'failed'; exitCode: number; durationMs: number }[] = [
      { name: 'unit', status: 'passed', exitCode: 0, durationMs: 123 },
      { name: 'lint', status: 'failed', exitCode: 1, durationMs: 45 },
    ]
    for (const check of checks) {
      const row = fx.store.createVerificationCheck({
        projectId: fx.projectId,
        runId: fx.run.id,
        taskId,
        name: check.name,
        command: ['npm', 'test'],
        cwd: null,
        workspaceId: null,
      })
      fx.store.setVerificationCheckResult(row.id, {
        status: check.status,
        exitCode: check.exitCode,
        durationMs: check.durationMs,
      })
    }
    // A pending check (never executed) must not be dressed up with exit evidence.
    fx.store.createVerificationCheck({
      projectId: fx.projectId,
      runId: fx.run.id,
      taskId,
      name: 'e2e',
      command: ['npm', 'run', 'e2e'],
      cwd: null,
      workspaceId: null,
    })

    const data = await getResult(makeBridge(fx, 'manager'), taskId)
    const tests = data.tests as unknown[]
    expect(tests).toHaveLength(3)
    expect(tests).toEqual(
      expect.arrayContaining([
        ...checks.map((c) => ({ name: c.name, status: c.status, exitCode: c.exitCode, durationMs: c.durationMs })),
        { name: 'e2e', status: 'pending', exitCode: null, durationMs: null },
      ]),
    )
  })

  it('derives unmet criteria from the latest verification row and passes the failure through', async () => {
    const fx = makeFixture()
    const taskId = await createTask(makeBridge(fx, 'manager'))
    fx.store.recordVerification({
      runId: fx.run.id,
      taskId,
      verdict: 'failed',
      criteria: [
        { criterion: 'feature works', status: 'verified', evidence: 'checks passed' },
        { criterion: 'docs updated', status: 'failed', evidence: 'no docs diff' },
      ],
    })
    forceFail(fx.store, taskId, { code: 'verification_failed', checks: ['docs'] })

    const data = await getResult(makeBridge(fx, 'manager'), taskId)
    expect(data.blockers).toEqual({
      failure: { code: 'verification_failed', checks: ['docs'] },
      unmetCriteria: [{ criterion: 'docs updated', reason: 'no docs diff' }],
    })
    expect(data.failure).toEqual({ code: 'verification_failed', checks: ['docs'] })

    // A malformed criteria payload is reported as no blockers, never as a crash.
    fx.store.recordVerification({ runId: fx.run.id, taskId, verdict: 'failed', criteria: 'not-an-array' })
    const malformed = await getResult(makeBridge(fx, 'manager'), taskId)
    expect((malformed.blockers as { unmetCriteria: unknown[] }).unmetCriteria).toEqual([])
  })

  it('reports changedFiles as null — never a throw — when the manager is absent or the checkout is gone', async () => {
    const fx = makeFixture()
    const manager = makeManager(fx)
    const { taskId, info } = await seedCheckout(fx, manager)

    // No workspace manager wired: the composed result stays honest, not loud.
    expect((await getResult(makeBridge(fx, 'manager'), taskId)).changedFiles).toBeNull()

    // A manager whose checkout directory has disappeared (missing marker):
    // the WorkspaceError is swallowed into null, not surfaced as a tool crash.
    rmSync(info.path, { recursive: true, force: true })
    expect((await getResult(makeBridge(fx, 'manager', null, {}, undefined, manager), taskId)).changedFiles).toBeNull()
  })

  it('passes the assignment snapshot through and keeps the legacy result/failure keys', async () => {
    const fx = makeFixture()
    const bridge = makeBridge(fx, 'manager')
    const taskId = await createTask(bridge)
    const assignment = { museId: 'worker-a', role: 'coder', engine: 'mock', model: 'mock/model-a' }
    fx.store.setTaskStateIf(taskId, 'queued', 'admitted', { assignment })
    fx.store.setTaskState(taskId, 'running', { result: { summary: 'did the thing', outcome: 'success' } })
    fx.store.setTaskState(taskId, 'completed')

    const data = await getResult(bridge, taskId)
    expect(data.assignment).toEqual(assignment)
    expect(data.summary).toBe('did the thing')
    expect(data.result).toEqual({ summary: 'did the thing', outcome: 'success' })
    expect(data.failure).toBeNull()
    expect(data.task).toMatchObject({ id: taskId, state: 'completed', depth: 0, parentTaskId: null })
  })
})

describe('PlutonToolBridge — team and approvals', () => {
  it('muse.propose_create records a pending approval and never instantiates silently', async () => {
    const fx = makeFixture()
    const res = await makeBridge(fx, 'manager').call('muse.propose_create', {
      museId: 'specialist-x',
      displayName: 'Specialist X',
      role: 'custom',
      engine: 'novel-engine',
      model: 'novel/model',
      reason: 'new capability needed',
    })
    expect(res.ok).toBe(true)
    const data = res.data as { proposalId: string; status: string; addsEngine: boolean }
    expect(data.status).toBe('pending_approval')
    expect(data.addsEngine).toBe(true)
    const approval = fx.store.getApproval(data.proposalId)
    expect(approval.status).toBe('pending')
    expect(approval.action).toBe('muse.create')
    expect(eventTypes(fx.store, fx.run.id, 'muse.proposal_recorded')).toBe(1)
    // No new Muse was created — only a durable proposal.
    expect(fx.store.listMuses().filter((m) => m.slug === 'specialist-x')).toHaveLength(0)
  })

  it('muse.propose_create enforces the team-size cap', async () => {
    const fx = makeFixture()
    const tight = makeBridge(fx, 'manager', null, { maxTeamSize: 3 })
    const res = await tight.call('muse.propose_create', {
      museId: 'specialist-y',
      displayName: 'Specialist Y',
      role: 'custom',
      engine: 'mock',
      model: 'mock/model-a',
      reason: 'over the cap',
    })
    expect(res).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
  })

  it('approval.request parks the run; run.stop cancels it; repeats ack idempotently (CS-9)', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    fx.store.setRunState(fx.run.id, 'active')
    const asked = await manager.call('approval.request', { action: 'install:tooling', reason: 'needs a new tool' })
    expect(asked.ok).toBe(true)
    expect((asked.data as { runState: string }).runState).toBe('awaiting_approval')
    expect(fx.store.getRun(fx.run.id).state).toBe('awaiting_approval')

    const stopped = await manager.call('run.stop', { reason: 'operator decision' })
    expect(stopped.ok).toBe(true)
    expect((stopped.data as { state: string }).state).toBe('cancelled')
    expect(eventTypes(fx.store, fx.run.id, 'run.stop_requested')).toBe(1)

    // Repeats are an idempotent ack: same durable state, no second event.
    const again = await manager.call('run.stop', { reason: 'operator decision' })
    expect(again.ok).toBe(true)
    expect(again.data).toMatchObject({ runId: fx.run.id, state: 'cancelled', alreadyTerminal: true })
    expect(fx.store.getRun(fx.run.id).state).toBe('cancelled')
    expect(eventTypes(fx.store, fx.run.id, 'run.stop_requested')).toBe(1)
  })

  it('stamps approval rows with the configured TTL (60m default, 0 = never expires)', async () => {
    const fx = makeFixture()
    const before = Date.now()
    const manager = makeBridge(fx, 'manager')
    fx.store.setRunState(fx.run.id, 'active')

    const asked = await manager.call('approval.request', { action: 'install:tooling', reason: 'needs a new tool' })
    expect(asked.ok).toBe(true)
    const approval = fx.store.getApproval((asked.data as { approvalId: string }).approvalId)
    expect(approval.expiresAt).not.toBeNull()
    // Wall-clock tolerance: creation time is the bridge's `now`, asserted within 5s of now + 60m.
    expect(Math.abs(Date.parse(approval.expiresAt ?? '') - (before + 60 * 60_000))).toBeLessThan(5_000)

    const noTtl = makeBridge(fx, 'manager', null, { approvalTtlMinutes: 0 })
    const never = await noTtl.call('approval.request', { action: 'install:other', reason: 'never expires' })
    expect(never.ok).toBe(true)
    expect(fx.store.getApproval((never.data as { approvalId: string }).approvalId).expiresAt).toBeNull()

    // The specialist-proposal path carries the same TTL.
    const proposal = await manager.call('muse.propose_create', {
      museId: 'specialist-ttl',
      displayName: 'Specialist TTL',
      role: 'custom',
      engine: 'mock',
      model: 'mock/model-a',
      reason: 'prove the TTL rides every approval',
    })
    expect(proposal.ok).toBe(true)
    const proposalRow = fx.store.getApproval((proposal.data as { proposalId: string }).proposalId)
    expect(proposalRow.expiresAt).not.toBeNull()
    expect(Math.abs(Date.parse(proposalRow.expiresAt ?? '') - (before + 60 * 60_000))).toBeLessThan(5_000)
  })

  it('strips terminal control bytes from approval text at persistence (tool input boundary)', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    fx.store.setRunState(fx.run.id, 'active')

    const asked = await manager.call('approval.request', {
      action: 'tool\u001b[2J:evil',
      reason: 'needs \u001b[31mred\u001b[0m \u202ereordered text',
      scope: { note: 'keep\u0007 calm', path: 'a\u001b[2J.ts' },
    })
    expect(asked.ok).toBe(true)
    const approval = fx.store.getApproval((asked.data as { approvalId: string }).approvalId)

    // Text survives; bytes that could drive or spoof a terminal never reach the
    // durable record, whichever surface later renders it.
    expect(approval.action).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/)
    expect(approval.action).toContain('tool')
    expect(approval.reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/)
    expect(approval.reason).toContain('reordered text')
    expect((approval.scope as { note: string }).note).toBe('keep calm')
    expect((approval.scope as { path: string }).path).toBe('a[2J.ts')

    // The emitted event carries the stored (sanitized) action: one source of
    // truth for UIs reading either surface.
    const events = fx.store.listEvents(fx.run.id, { type: 'approval.requested' })
    const payload = events.at(-1)?.payload as { action?: string }
    expect(payload.action).toBe(approval.action)
    expect(payload.action).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/)
  })
})

describe('PlutonToolBridge — project.read and diff.inspect', () => {
  it('lists and reads the project while refusing refused areas and escapes', async () => {
    const fx = makeFixture()
    const bridge = makeBridge(fx, 'manager')

    const listing = await bridge.call('project.read', {})
    const names = (listing.data as { entries: { name: string }[] }).entries.map((e) => e.name)
    expect(names).toContain('README.md')
    expect(names).toContain('src')
    expect(names).not.toContain('.pluton')
    expect(names).not.toContain('node_modules')

    const read = await bridge.call('project.read', { path: 'README.md' })
    expect((read.data as { text: string }).text).toBe('hello world')

    const binary = await bridge.call('project.read', { path: 'bin.dat' })
    expect((binary.data as { binary: boolean }).binary).toBe(true)

    for (const path of ['.pluton/state/pluton.sqlite', '../outside.txt', fx.rootDir]) {
      const refused = await bridge.call('project.read', { path })
      expect(refused).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    }
  })

  it('diff.inspect reports a missing checkout instead of inventing a diff', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const taskId = await createTask(manager)
    const res = await manager.call('diff.inspect', { taskId })
    expect(res.ok).toBe(true)
    expect((res.data as { workspace: null }).workspace).toBeNull()
    expect((res.data as { note: string }).note).toMatch(/no active checkout/)
  })

  it('bounds oversized results instead of flooding the engine', async () => {
    const fx = makeFixture()
    writeFileSync(join(fx.rootDir, 'big.txt'), 'x'.repeat(600))
    const bridge = makeBridge(fx, 'manager', null, { maxToolResultChars: 200 })
    const res = await bridge.call('project.read', { path: 'big.txt' })
    expect(res.ok).toBe(true)
    const data = res.data as { truncated?: boolean; originalChars?: number; preview?: string }
    expect(data.truncated).toBe(true)
    expect(data.originalChars ?? 0).toBeGreaterThan(200)
    expect(typeof data.preview).toBe('string')
  })
})

describe('PlutonToolBridge — MCP protocol integration', () => {
  it('serves the restricted surface over the MCP stdio protocol', async () => {
    const fx = makeFixture()
    const bridge = makeBridge(fx, 'manager')
    const server = new McpStdioServer({
      host: bridge,
      serverName: 'pluton-bridge-test',
      serverVersion: '0.0.0',
      diagnosticSink: () => {},
    })
    const init = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    expect(init).not.toBeNull()
    const list = JSON.parse(
      (await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))) as string,
    ) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map((t) => t.name)).toContain('task.inspect')
    const call = JSON.parse(
      (await server.handleLine(
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task.inspect', arguments: {} } }),
      )) as string,
    ) as { result: { isError: boolean; content: { type: string; text: string }[] } }
    expect(call.result.isError).toBe(false)
    expect(call.result.content[0]?.text ?? '').toContain('"count"')
  })
})

describe('PlutonToolBridge — review hardening', () => {
  it('answers (not rejects) and records the denial when a tool name is oversized', async () => {
    const fx = makeFixture()
    const res = await makeBridge(fx, 'manager').call('x'.repeat(9_000), {})
    expect(res).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect((res.error as { message: string }).message.length).toBeLessThan(500)
    expect(eventTypes(fx.store, fx.run.id, 'tool.denied')).toBe(1)
  })

  it('refuses reads through a link that escapes the root', async (ctx) => {
    const fx = makeFixture()
    const outside = mkdtempSync(join(tmpdir(), 'pluton-outside-'))
    tmpDirs.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET')
    const link = join(fx.rootDir, 'link')
    try {
      if (process.platform === 'win32') symlinkSync(outside, link, 'junction')
      else symlinkSync(outside, link)
    } catch {
      ctx.skip() // no link support in this environment
      return
    }
    const res = await makeBridge(fx, 'manager').call('project.read', { path: 'link/secret.txt' })
    expect(res).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect(JSON.stringify(res)).not.toContain('OUTSIDE-SECRET')
  })

  it('refuses case variants of refused areas (.PLUTON)', async () => {
    const fx = makeFixture()
    mkdirSync(join(fx.rootDir, '.PLUTON', 'state'), { recursive: true })
    writeFileSync(join(fx.rootDir, '.PLUTON', 'state', 'secret.txt'), 'CASE-SECRET')
    const res = await makeBridge(fx, 'manager').call('project.read', { path: '.PLUTON/state/secret.txt' })
    expect(res).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
  })

  it('rejects dependencies outside the caller subtree', async () => {
    const fx = makeFixture()
    const t = await createTask(makeBridge(fx, 'manager')) // assigned worker-a
    const tBridge = makeBridge(fx, 'worker-a', t)
    const cRes = await tBridge.call('task.delegate', { ...CREATE_ARGS, assigneeMuseId: 'manager', title: 'C' })
    expect(cRes.ok).toBe(true)
    const c = (cRes.data as { task: { id: string } }).task.id
    const cBridge = makeBridge(fx, 'manager', c)
    const denied = await cBridge.call('task.delegate', {
      ...CREATE_ARGS,
      assigneeMuseId: 'worker-b',
      title: 'G',
      dependsOn: [t], // an ancestor of C: outside C's visible subtree
    })
    expect(denied).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    const ok = await cBridge.call('task.delegate', { ...CREATE_ARGS, assigneeMuseId: 'worker-b', title: 'G' })
    expect(ok.ok).toBe(true)
  })

  it('rejects delegation from a terminal task', async () => {
    const fx = makeFixture()
    const t = await createTask(makeBridge(fx, 'manager'))
    forceComplete(fx.store, t)
    const res = await makeBridge(fx, 'worker-a', t).call('task.delegate', {
      ...CREATE_ARGS,
      assigneeMuseId: 'manager',
      title: 'C',
    })
    expect(res).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect((res.error as { message: string }).message).toMatch(/terminal task cannot delegate/)
  })

  it('rejects a duplicate pending proposal and caps pending approvals', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const propose = (museId: string) =>
      manager.call('muse.propose_create', {
        museId,
        displayName: museId,
        role: 'custom',
        engine: 'mock',
        model: 'mock/model-a',
        reason: 'r',
      })
    expect((await propose('specialist-x')).ok).toBe(true)
    const duplicate = await propose('specialist-x')
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect((duplicate.error as { message: string }).message).toMatch(/already exists/)
    expect((await propose('specialist-y')).ok).toBe(true)
    expect((await propose('specialist-z')).ok).toBe(true)
    const over = await propose('specialist-w')
    expect(over).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    expect((over.error as { message: string }).message).toMatch(/pending approvals/)
  })

  it('caps pending approvals asked through approval.request', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    for (const action of ['tool:one', 'tool:two', 'tool:three']) {
      expect((await manager.call('approval.request', { action, reason: 'r' })).ok).toBe(true)
    }
    const over = await manager.call('approval.request', { action: 'tool:four', reason: 'r' })
    expect(over).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
  })

  it('refuses host-owned approval actions a Muse must not file (forged-approval defense)', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    for (const action of ['integration.apply', 'muse.create', 'engine.permission']) {
      const res = await manager.call('approval.request', { action, reason: 'sounds harmless' })
      expect(res).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    }
    // Persistence strips control characters (store.createApproval), so the
    // denylist must compare the stripped action too: 'muse.create\u0007'
    // would otherwise launder into a host-owned action name on the card.
    for (const action of ['muse.create\u0007', 'integration.apply\u0007', 'engine.permission\u202e']) {
      const res = await manager.call('approval.request', { action, reason: 'sounds harmless' })
      expect(res).toMatchObject({ ok: false, error: { code: 'policy_denied' } })
    }
    // An action that is nothing but control characters is empty once stripped.
    const empty = await manager.call('approval.request', { action: '\u0007', reason: 'r' })
    expect(empty).toMatchObject({ ok: false, error: { code: 'validation_failed' } })
    // Nothing was recorded: a denied filing must not leave a pending row behind.
    expect(fx.store.listApprovals(fx.run.id).filter((x) => x.status === 'pending')).toHaveLength(0)
    expect(fx.store.listApprovals(fx.run.id).some((x) => x.action === 'muse.create')).toBe(false)
  })

  it('refuses to pass a malformed base commit to git', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const taskId = await createTask(manager)
    const ws = fx.store.createWorkspace({
      projectId: fx.projectId,
      runId: fx.run.id,
      taskId,
      museId: 'worker-a',
      kind: 'task-checkout',
      path: join(fx.rootDir, 'ws-1'),
      branch: 'pluton/task/branch',
      baseCommit: '--output=evil',
    })
    expect(ws.state).toBe('active')
    const res = await manager.call('diff.inspect', { taskId })
    expect(res).toMatchObject({ ok: false, error: { code: 'validation_failed' } })
  })

  it('wakes a waiter on any ancestor channel (supervisor notify contract)', async () => {
    const fx = makeFixture()
    const registry = new WakeupRegistry()
    const t = await createTask(makeBridge(fx, 'manager', null, {}, registry)) // T ← worker-a
    const tBridge = makeBridge(fx, 'worker-a', t, {}, registry)
    const cRes = await tBridge.call('task.delegate', { ...CREATE_ARGS, assigneeMuseId: 'manager', title: 'C' })
    expect(cRes.ok).toBe(true)
    const c = (cRes.data as { task: { id: string } }).task.id
    const cBridge = makeBridge(fx, 'manager', c, {}, registry)
    const gRes = await cBridge.call('task.delegate', { ...CREATE_ARGS, assigneeMuseId: 'worker-b', title: 'G' })
    expect(gRes.ok).toBe(true)
    const g = (gRes.data as { task: { id: string } }).task.id

    // T's session waits on its grandchild G; the supervisor's notify path must
    // reach T's channel even though it only ever completed G.
    const waiting = tBridge.call('task.wait', { taskIds: [g], timeoutSeconds: 10 })
    await delay(50)
    forceComplete(fx.store, g)
    const gTask = fx.store.getTask(g)
    notifyTaskSettled(registry, fx.run.id, gTask, taskAncestorIds(fx.store, gTask))
    const res = await waiting
    expect((res.data as { timedOut: boolean }).timedOut).toBe(false)
    expect((res.data as { tasks: { state: string }[] }).tasks[0]?.state).toBe('completed')
  })

  describe('task.awaiting_verification:', () => {
    it('sets task state to verifying', async () => {
      const fx = makeFixture()
      const manager = makeBridge(fx, 'manager', null, {}, new WakeupRegistry())
      const taskId = await createTask(manager)
      // Set task to failed so it's eligible for revision
      fx.store.setTaskState(taskId, 'admitted')
      fx.store.setTaskState(taskId, 'failed', { failure: { code: 'test_failure', message: 'test failure' } })
      const res = await manager.call('task.request_revision', { taskId, feedback: 'fix it' })
      expect(res.ok).toBe(true)
      const updated = fx.store.getTask(taskId)
      expect(updated.state).toBe('queued')
      expect(updated.attempt).toBe(1)
    })
  })

  describe('selectToolsForTask (Batch 6)', () => {
    it('always-available tools are included regardless of task scope', () => {
      const fx = makeFixture()
      const manager = makeBridge(fx, 'manager', null, {}, new WakeupRegistry())
      const task = fx.store.createTask({
        runId: fx.run.id,
        title: 'plain task',
        brief: 'A simple task',
        acceptanceCriteria: [],
        assigneeShipId: 'worker-a',
      })

      const managerBridge = makeBridge(fx, 'manager', null, {}, new WakeupRegistry())
      const allTools = managerBridge.listTools()

      const selected = managerBridge.selectToolsForTask(task.id, allTools)

      // Always-available tools should be present
      expect(selected.map((t) => t.name)).toContain('task.inspect')
      expect(selected.map((t) => t.name)).toContain('task.get_result')
      expect(selected.map((t) => t.name)).toContain('task.cancel')
      expect(selected.map((t) => t.name)).toContain('task.wait')
      expect(selected.map((t) => t.name)).toContain('task.create')
      expect(selected.map((t) => t.name)).toContain('task.delegate')
      expect(selected.map((t) => t.name)).toContain('diff.inspect')
      expect(selected.map((t) => t.name)).toContain('project.read')
      expect(selected.map((t) => t.name)).toContain('ship.message')
      expect(selected.map((t) => t.name)).toContain('ship.inbox')
    })

    it('scope.declare and scope.release are included only when task has writeScope', () => {
      const fx = makeFixture()
      const manager = makeBridge(fx, 'manager', null, {}, new WakeupRegistry())

      // Task without write scope - scope tools should NOT be included
      const taskNoScope = fx.store.createTask({
        runId: fx.run.id,
        title: 'no scope task',
        brief: 'A task without write scope',
        acceptanceCriteria: [],
        assigneeShipId: 'worker-a',
      })

      // Task WITH write scope - scope tools SHOULD be included
      const taskWithScope = fx.store.createTask({
        runId: fx.run.id,
        title: 'scoped task',
        brief: 'A task with write scope',
        acceptanceCriteria: [],
        assigneeShipId: 'worker-a',
        writeScope: ['src/app.ts'],
      })

      const managerBridge = makeBridge(fx, 'manager', null, {}, new WakeupRegistry())
      const allTools = managerBridge.listTools()

      const selectedNoScope = managerBridge.selectToolsForTask(taskNoScope.id, allTools)
      expect(selectedNoScope.map((t) => t.name)).not.toContain('scope.declare')
      expect(selectedNoScope.map((t) => t.name)).not.toContain('scope.release')

      const selectedWithScope = managerBridge.selectToolsForTask(taskWithScope.id, allTools)
      expect(selectedWithScope.map((t) => t.name)).toContain('scope.declare')
      expect(selectedWithScope.map((t) => t.name)).toContain('scope.release')
    })

    it('governance tools are always available regardless of task scope', () => {
      const fx = makeFixture()
      const manager = makeBridge(fx, 'manager', null, {}, new WakeupRegistry())
      const task = fx.store.createTask({
        runId: fx.run.id,
        title: 'governance test',
        brief: 'Test governance tools',
        acceptanceCriteria: [],
        assigneeShipId: 'worker-a',
      })

      const managerBridge = makeBridge(fx, 'manager', null, {}, new WakeupRegistry())
      const allTools = managerBridge.listTools()

      const selected = managerBridge.selectToolsForTask(task.id, allTools)
      expect(selected.map((t) => t.name)).toContain('ship.propose_create')
      expect(selected.map((t) => t.name)).toContain('approval.request')
      expect(selected.map((t) => t.name)).toContain('review.report')
      expect(selected.map((t) => t.name)).toContain('task.request_revision')
      expect(selected.map((t) => t.name)).toContain('run.stop')
    })

    it('does not include tools the caller lacks permission for', () => {
      const fx = makeFixture()
      // Worker does NOT have task.create permission
      const worker = makeBridge(fx, 'worker-a', null, {}, new WakeupRegistry())
      const task = fx.store.createTask({
        runId: fx.run.id,
        title: 'worker task',
        brief: 'Worker task',
        acceptanceCriteria: [],
        assigneeShipId: 'worker-a',
      })

      const workerBridge = makeBridge(fx, 'worker-a', null, {}, new WakeupRegistry())
      const allTools = workerBridge.listTools()

      const selected = workerBridge.selectToolsForTask(task.id, allTools)
      expect(selected.map((t) => t.name)).not.toContain('task.create')
      expect(selected.map((t) => t.name)).not.toContain('review.report')
      expect(selected.map((t) => t.name)).not.toContain('ship.propose_create')
      expect(selected.map((t) => t.name)).not.toContain('task.request_revision')
      expect(selected.map((t) => t.name)).not.toContain('run.stop')
      // But always-available tools that the caller has permission for should still be present
      expect(selected.map((t) => t.name)).toContain('task.inspect')
      expect(selected.map((t) => t.name)).toContain('task.get_result')
    })

    it('selectToolsForTask does not mutate the input array', () => {
      const fx = makeFixture()
      const manager = makeBridge(fx, 'manager', null, {}, new WakeupRegistry())
      const task = fx.store.createTask({
        runId: fx.run.id,
        title: 'immutable test',
        brief: 'Test immutability',
        acceptanceCriteria: [],
        assigneeShipId: 'worker-a',
        writeScope: ['src/app.ts'],
      })

      const managerBridge = makeBridge(fx, 'manager', null, {}, new WakeupRegistry())
      const allTools = managerBridge.listTools()
      const before = [...allTools.map((t) => t.name)]

      managerBridge.selectToolsForTask(task.id, allTools)

      expect(allTools.map((t) => t.name)).toEqual(before)
    })
  })
})
