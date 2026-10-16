import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import { allowedTransitions } from '../../src/domain/state.ts'
import type { RunRecord } from '../../src/domain/models.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { notifyTaskSettled, taskAncestorIds, WakeupRegistry } from '../../src/orchestrator/wakeups.ts'
import { PlutonToolBridge, type ToolBridgeLimits } from '../../src/tools/bridge.ts'
import { wakeupChannelFor } from '../../src/tools/handlers.ts'
import { McpStdioServer } from '../../src/tools/mcp-server.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'pluton-bridge-'))
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
}

function makeBridge(
  fx: Fixture,
  callerMuseId: string,
  callerTaskId: string | null = null,
  overrides: Partial<ToolBridgeLimits> = {},
  wakeups?: WakeupRegistry,
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('PlutonToolBridge — identity and permissions', () => {
  it('exposes only the tools the caller has permission for', () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    expect(manager.listTools().map((t) => t.name)).toEqual([
      'task.create',
      'task.delegate',
      'task.inspect',
      'task.wait',
      'task.get_result',
      'task.cancel',
      'muse.propose_create',
      'approval.request',
      'diff.inspect',
      'project.read',
      'run.stop',
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
    expect(() => makeBridge(fx, 'ghost')).toThrowError(/not an enabled Muse/)
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

  it('task.cancel refuses a terminal task with request_conflict', async () => {
    const fx = makeFixture()
    const manager = makeBridge(fx, 'manager')
    const taskId = await createTask(manager)
    const first = await manager.call('task.cancel', { taskId, reason: 'no longer needed' })
    expect(first.ok).toBe(true)
    expect((first.data as { task: { state: string } }).task.state).toBe('cancelled')
    const second = await manager.call('task.cancel', { taskId, reason: 'again' })
    expect(second).toMatchObject({ ok: false, error: { code: 'request_conflict' } })
    expect(eventTypes(fx.store, fx.run.id, 'task.cancelled_by_tool')).toBe(1)
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

  it('approval.request parks the run; run.stop cancels it; repeats conflict', async () => {
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

    const again = await manager.call('run.stop', { reason: 'operator decision' })
    expect(again).toMatchObject({ ok: false, error: { code: 'request_conflict' } })
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
})
