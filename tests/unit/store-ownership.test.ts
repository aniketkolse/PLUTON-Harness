import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnershipLostError, StateTransitionError } from '../../src/domain/errors.ts'
import type { RunBudget } from '../../src/domain/models.ts'
import { openDatabase, setUserVersion, type DatabaseSync } from '../../src/store/db.ts'
import { MIGRATIONS, migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'

/**
 * Durable run-ownership protocol at the persistence boundary: one atomic claim
 * per run (SQLite serializes writers on the single `runs` row), a heartbeat on
 * the fringe of expiry, and fence-gated run-owned mutations. Two real
 * connections on one database file — never a mock — because the guarantee is
 * the database's, not the process's.
 */

const TTL = 100
const T0 = 1000

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

function tmpDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pluton-ownership-${name}-`))
  tmpDirs.push(dir)
  return dir
}

/** Two independent Store connections on one database file. */
function twoConnections(name: string): { a: Store; b: Store; path: string } {
  const path = join(tmpDir(name), 'pluton.sqlite')
  const dbA = openDatabase(path)
  const dbB = openDatabase(path)
  openDbs.push(dbA, dbB)
  migrate(dbA)
  migrate(dbB)
  return { a: new Store(dbA), b: new Store(dbB), path }
}

const BUDGET: RunBudget = {
  maxConcurrentWorkers: 2,
  maxTasks: 10,
  maxDelegationDepth: 3,
  maxRunMinutes: 60,
  defaultTaskMinutes: 10,
}

function seedProject(store: Store): string {
  const project = store.ensureProject({
    name: 'test',
    rootPath: join(tmpdir(), 'pluton-ownership-root'),
    configPath: join(tmpdir(), 'pluton-ownership-root', 'pluton.yaml'),
    defaultBranch: 'main',
  })
  store.syncMuses(project.id, [
    {
      id: 'worker-a',
      slug: 'worker-a',
      displayName: 'Worker A',
      role: 'coder',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: ['project.read'],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/worker-a',
    },
  ])
  return project.id
}

function seedRun(store: Store, projectId: string, goal = 'g'): string {
  return store
    .createRun({
      projectId,
      goal,
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: [],
      managerMuseId: 'worker-a',
      budget: BUDGET,
    })
    .id
}

function seedTask(store: Store, runId: string, title: string, state: 'created' | 'queued' = 'created'): string {
  const task = store.createTask({
    runId,
    parentTaskId: null,
    title,
    brief: 'b',
    acceptanceCriteria: [],
    assigneeMuseId: 'worker-a',
  })
  if (state === 'queued') store.setTaskState(task.id, 'queued')
  return task.id
}

/** Owner A claims, then B takes over after the TTL expires — A's fence goes stale. */
function staleFence(storeA: Store, storeB: Store, runId: string): { runId: string; token: string } {
  const ownerA = storeA.claimRunSupervisor(runId, { pid: 101, ttlMs: TTL, nowMs: T0 })
  if (!ownerA) throw new Error('test setup: first claim must win')
  const ownerB = storeB.claimRunSupervisor(runId, { pid: 202, ttlMs: TTL, nowMs: T0 + TTL })
  if (!ownerB) throw new Error('test setup: takeover must win after the TTL')
  return { runId, token: ownerA.token }
}

function liveFence(store: Store, runId: string): { runId: string; token: string } {
  // Later than every heartbeat these tests write, so a live fence always wins.
  const claim = store.claimRunSupervisor(runId, { pid: 101, ttlMs: TTL, nowMs: T0 + 10_000 })
  if (!claim) throw new Error('test setup: claim must win')
  return { runId, token: claim.token }
}

/**
 * Deterministic two-connection window injection: when connection A prepares a
 * statement whose SQL matches, `concurrent` (a real write through connection B,
 * committed before A's statement runs) executes first — i.e. exactly between
 * A's pre-read and its UPDATE. Nothing is mocked; the race is real.
 */
function injectBeforePrepare(store: Store, match: (sql: string) => boolean, concurrent: () => void): void {
  const db = store.db
  const original = db.prepare.bind(db)
  let fired = false
  db.prepare = ((sql: string) => {
    if (!fired && match(sql)) {
      fired = true
      concurrent()
    }
    return original(sql)
  }) as typeof db.prepare
}

const countEvents = (store: Store): number =>
  Number((store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n)
const countApprovals = (store: Store): number =>
  Number((store.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n)
const countWorkspaces = (store: Store): number =>
  Number((store.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n)
const countLeases = (store: Store, state: 'active' | 'released' = 'active'): number =>
  Number((store.db.prepare('SELECT COUNT(*) AS n FROM file_leases WHERE state = ?').get(state) as { n: number }).n)
const countUsage = (store: Store): number =>
  Number((store.db.prepare('SELECT COUNT(*) AS n FROM run_usage').get() as { n: number }).n)
const rawRun = (store: Store, runId: string): Record<string, unknown> =>
  store.db
    .prepare('SELECT supervisor_pid, supervisor_token, supervisor_heartbeat_at FROM runs WHERE id = ?')
    .get(runId) as Record<string, unknown>

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed by the test
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows lock cleanup best effort
    }
  }
})

describe('run supervisor claim', () => {
  it('a fresh claim wins and a second claim on another connection is refused without mutating', () => {
    const { a, b } = twoConnections('claim')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)

    const first = a.claimRunSupervisor(runId, { pid: 101, ttlMs: TTL, nowMs: T0 })
    expect(first).not.toBeNull()
    expect(first?.tookOver).toBe(false)
    expect(first?.previousPid).toBeNull()
    expect(first?.token).toMatch(/^[0-9a-f]{32}$/)
    const afterFirst = rawRun(a, runId)
    expect(afterFirst['supervisor_pid']).toBe(101)
    expect(afterFirst['supervisor_token']).toBe(first?.token)
    expect(afterFirst['supervisor_heartbeat_at']).toBe(T0)

    // Same tick, other connection: a live owner holds the run — fail closed.
    expect(b.claimRunSupervisor(runId, { pid: 202, ttlMs: TTL, nowMs: T0 })).toBeNull()
    expect(rawRun(a, runId)).toEqual(afterFirst)
  })

  it('takes over only when the heartbeat has reached the cutoff', () => {
    const { a, b } = twoConnections('expiry')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)

    const first = a.claimRunSupervisor(runId, { pid: 101, ttlMs: TTL, nowMs: T0 })
    const token = first?.token

    // nowMs = 1099 < cutoff 1100: the heartbeat is still fresh.
    expect(b.claimRunSupervisor(runId, { pid: 202, ttlMs: TTL, nowMs: T0 + 99 })).toBeNull()
    expect(rawRun(b, runId)['supervisor_pid']).toBe(101)

    // nowMs = 1100 == cutoff: `<=` takes the expired claim over.
    const takeover = b.claimRunSupervisor(runId, { pid: 202, ttlMs: TTL, nowMs: T0 + TTL })
    expect(takeover).not.toBeNull()
    expect(takeover?.tookOver).toBe(true)
    expect(takeover?.previousPid).toBe(101)
    expect(takeover?.token).not.toBe(token)
    const after = rawRun(b, runId)
    expect(after['supervisor_pid']).toBe(202)
    expect(after['supervisor_token']).toBe(takeover?.token)
    expect(after['supervisor_heartbeat_at']).toBe(T0 + TTL)
  })

  it('takes over a token with a NULL heartbeat (crashed mid-claim counts as stale)', () => {
    const { a, b } = twoConnections('null-heartbeat')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    a.db
      .prepare('UPDATE runs SET supervisor_pid = ?, supervisor_token = ?, supervisor_heartbeat_at = NULL WHERE id = ?')
      .run(101, 'hand-built-token', runId)

    const takeover = b.claimRunSupervisor(runId, { pid: 202, ttlMs: TTL, nowMs: T0 })
    expect(takeover).not.toBeNull()
    expect(takeover?.tookOver).toBe(true)
    expect(takeover?.previousPid).toBe(101)
    expect(takeover?.token).not.toBe('hand-built-token')
  })

  it('claims a legacy run row (NULL token/heartbeat, as migrated v6 rows)', () => {
    const { a } = twoConnections('legacy')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    expect(rawRun(a, runId)).toEqual({ supervisor_pid: null, supervisor_token: null, supervisor_heartbeat_at: null })

    const claim = a.claimRunSupervisor(runId, { pid: 101, ttlMs: TTL, nowMs: T0 })
    expect(claim).not.toBeNull()
    expect(claim?.tookOver).toBe(false)
    expect(claim?.previousPid).toBeNull()
  })

  it('refuses to claim an unknown run with NotFoundError', () => {
    const { a } = twoConnections('missing')
    expect(() => a.claimRunSupervisor('run_missing', { pid: 101, ttlMs: TTL, nowMs: T0 })).toThrow(/not found/)
  })
})

describe('run supervisor renew', () => {
  it('advances the heartbeat for the matching token and refuses every other token', () => {
    const { a, b } = twoConnections('renew')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const claim = a.claimRunSupervisor(runId, { pid: 101, ttlMs: TTL, nowMs: T0 })
    if (!claim) throw new Error('test setup: claim must win')

    expect(b.renewRunSupervisor(runId, 'not-the-token', T0 + 50)).toBe(false)
    expect(rawRun(b, runId)['supervisor_heartbeat_at']).toBe(T0)

    expect(b.renewRunSupervisor(runId, claim.token, T0 + 50)).toBe(true)
    expect(rawRun(b, runId)['supervisor_heartbeat_at']).toBe(T0 + 50)
  })

  it('a renewed claim survives past the original cutoff', () => {
    const { a, b } = twoConnections('renew-survives')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const claim = a.claimRunSupervisor(runId, { pid: 101, ttlMs: TTL, nowMs: T0 })
    if (!claim) throw new Error('test setup: claim must win')

    expect(a.renewRunSupervisor(runId, claim.token, T0 + 50)).toBe(true)
    // The original window (heartbeat T0, cutoff T0+100) has passed, but the
    // renewed heartbeat keeps the claim alive.
    expect(b.claimRunSupervisor(runId, { pid: 202, ttlMs: TTL, nowMs: T0 + TTL })).toBeNull()
    expect(b.claimRunSupervisor(runId, { pid: 202, ttlMs: TTL, nowMs: T0 + 150 })).not.toBeNull()
  })
})

describe('run supervisor release', () => {
  it('clears the claim for the matching token only, and an immediate re-claim by the other connection wins', () => {
    const { a, b } = twoConnections('release')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const claim = a.claimRunSupervisor(runId, { pid: 101, ttlMs: TTL, nowMs: T0 })
    if (!claim) throw new Error('test setup: claim must win')

    expect(b.releaseRunSupervisor(runId, 'not-the-token')).toBe(false)
    expect(rawRun(b, runId)).toEqual({
      supervisor_pid: 101,
      supervisor_token: claim.token,
      supervisor_heartbeat_at: T0,
    })

    expect(b.releaseRunSupervisor(runId, claim.token)).toBe(true)
    expect(rawRun(b, runId)).toEqual({ supervisor_pid: null, supervisor_token: null, supervisor_heartbeat_at: null })
    expect(b.claimRunSupervisor(runId, { pid: 202, ttlMs: TTL, nowMs: T0 })).not.toBeNull()
  })
})

describe('fence-gated mutations throw OwnershipLostError and leave the database untouched', () => {
  it('setTaskState', () => {
    const { a, b } = twoConnections('fence-task')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const taskId = seedTask(a, runId, 't')
    const fence = staleFence(a, b, runId)

    expect(() => a.setTaskState(taskId, 'queued', {}, fence)).toThrow(OwnershipLostError)
    expect(a.getTask(taskId).state).toBe('created')
  })

  it('setTaskStateIf throws on a stale fence but returns null on a plain state-CAS miss', () => {
    const { a, b } = twoConnections('fence-task-cas')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const taskId = seedTask(a, runId, 't', 'queued')
    const fence = staleFence(a, b, runId)

    let thrown: unknown = null
    try {
      a.setTaskStateIf(taskId, 'queued', 'admitted', {}, fence)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(OwnershipLostError)
    expect((thrown as OwnershipLostError).code).toBe('ownership_lost')
    expect(a.getTask(taskId).state).toBe('queued')

    // The live fence wins the same CAS; a state mismatch stays a plain null.
    const live = liveFence(b, runId)
    expect(a.setTaskStateIf(taskId, 'queued', 'admitted', {}, live)?.state).toBe('admitted')
    expect(a.setTaskStateIf(taskId, 'queued', 'admitted', {}, live)).toBeNull()
  })

  it('classifies a pre-read state mismatch by the fence: stale owner throws, live owner gets null', () => {
    const { a, b } = twoConnections('fence-task-cas-preread')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const fence = staleFence(a, b, runId)

    // The task already moved on (the new owner's unfenced control-plane write).
    // A stale owner must not read that as an ordinary CAS miss.
    const movedTaskId = seedTask(a, runId, 'moved')
    a.setTaskState(movedTaskId, 'queued')
    expect(() => a.setTaskStateIf(movedTaskId, 'created', 'queued', {}, fence)).toThrow(OwnershipLostError)
    expect(a.getTask(movedTaskId).state).toBe('queued')

    // A live owner with a genuine state mismatch stays a plain null (no throw).
    const live = liveFence(b, runId)
    const otherTaskId = seedTask(a, runId, 'other', 'queued')
    expect(a.setTaskStateIf(otherTaskId, 'created', 'queued', {}, live)).toBeNull()
    expect(a.getTask(otherTaskId).state).toBe('queued')
  })

  it('setRunState', () => {
    const { a, b } = twoConnections('fence-run')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const fence = staleFence(a, b, runId)

    expect(() => a.setRunState(runId, 'active', {}, fence)).toThrow(OwnershipLostError)
    expect(a.getRun(runId).state).toBe('created')
  })

  it('appendEvent', () => {
    const { a, b } = twoConnections('fence-event')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const fence = staleFence(a, b, runId)

    expect(() => a.appendEvent({ projectId, runId, type: 'run.supervisor_claimed', payload: {} }, fence)).toThrow(
      OwnershipLostError,
    )
    expect(countEvents(a)).toBe(0)

    const live = liveFence(b, runId)
    expect(a.appendEvent({ projectId, runId, type: 'run.supervisor_claimed', payload: {} }, live).type).toBe(
      'run.supervisor_claimed',
    )
    expect(countEvents(a)).toBe(1)
  })

  it('createApproval', () => {
    const { a, b } = twoConnections('fence-approval')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const fence = staleFence(a, b, runId)
    const spec = {
      projectId,
      runId,
      taskId: null,
      requestedByMuseId: null,
      action: 'git.push',
      reason: 'r',
      scope: {},
    }

    expect(() => a.createApproval(spec, fence)).toThrow(OwnershipLostError)
    expect(countApprovals(a)).toBe(0)

    const live = liveFence(b, runId)
    expect(a.createApproval(spec, live).status).toBe('pending')
    expect(countApprovals(a)).toBe(1)
  })

  it('createWorkspace and updateWorkspace', () => {
    const { a, b } = twoConnections('fence-workspace')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const taskId = seedTask(a, runId, 't')
    const spec = {
      projectId,
      runId,
      taskId,
      museId: 'worker-a',
      kind: 'task-checkout' as const,
      path: join(tmpdir(), 'pluton-ownership-ws', taskId),
      branch: `pluton/${runId}/${taskId}`,
      baseCommit: 'a'.repeat(40),
    }
    const fence = staleFence(a, b, runId)

    expect(() => a.createWorkspace(spec, fence)).toThrow(OwnershipLostError)
    expect(countWorkspaces(a)).toBe(0)

    const live = liveFence(b, runId)
    const ws = a.createWorkspace(spec, live)
    expect(countWorkspaces(a)).toBe(1)

    // Re-establish a stale fence for the update half.
    b.releaseRunSupervisor(runId, live.token)
    const stale = staleFence(a, b, runId)
    expect(() => a.updateWorkspace(ws.id, { headCommit: 'b'.repeat(40) }, stale)).toThrow(OwnershipLostError)
    expect(a.getWorkspace(ws.id).headCommit).toBeNull()

    const liveAgain = liveFence(b, runId)
    expect(a.updateWorkspace(ws.id, { headCommit: 'b'.repeat(40) }, liveAgain).headCommit).toBe('b'.repeat(40))
  })
})

describe('fence-gated advisory writes silently skip', () => {
  it('recordLease, releaseLeasesForTask, reapOrphanedLeases and recordUsage skip stale fences without throwing', () => {
    const { a, b } = twoConnections('silent-skip')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const taskId = seedTask(a, runId, 't')
    a.recordLease({ id: 'lease_1', runId, taskId, museId: 'worker-a', path: 'src/a.ts' })
    const fence = staleFence(a, b, runId)
    const usage = { runId, museId: 'worker-a', taskId, inputTokens: 1, outputTokens: 2, costUsd: 0.5 }

    expect(() => a.recordLease({ id: 'lease_2', runId, taskId, museId: 'worker-a', path: 'src/b.ts' }, fence)).not.toThrow()
    expect(countLeases(a)).toBe(1)

    expect(a.releaseLeasesForTask(taskId, fence)).toEqual([])
    expect(countLeases(a)).toBe(1)

    expect(() => a.reapOrphanedLeases(new Set(), fence)).not.toThrow()
    expect(countLeases(a)).toBe(1)

    expect(() => a.recordUsage({ ...usage, id: 'usage_stale' }, fence)).not.toThrow()
    expect(countUsage(a)).toBe(0)

    // The live fence performs the same writes.
    const live = liveFence(b, runId)
    a.recordLease({ id: 'lease_2', runId, taskId, museId: 'worker-a', path: 'src/b.ts' }, live)
    expect(countLeases(a)).toBe(2)
    expect(a.releaseLeasesForTask(taskId, live)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(countLeases(a)).toBe(0)
    a.recordLease({ id: 'lease_3', runId, taskId, museId: 'worker-a', path: 'src/c.ts' }, live)
    a.reapOrphanedLeases(new Set(), live)
    expect(countLeases(a)).toBe(0)
    a.recordUsage({ ...usage, id: 'usage_live' }, live)
    expect(countUsage(a)).toBe(1)
  })

  it('reaps only the fenced run (cross-run safety), while the unfenced call keeps the legacy global behavior', () => {
    const { a, b } = twoConnections('reap-scope')
    const projectId = seedProject(a)
    const runA = seedRun(a, projectId, 'A')
    const runB = seedRun(a, projectId, 'B')
    const activeA = seedTask(a, runA, 'a-active')
    const orphanA = seedTask(a, runA, 'a-orphan')
    const untouchedB = seedTask(a, runB, 'b-active')
    a.recordLease({ id: 'lease_a_active', runId: runA, taskId: activeA, museId: 'worker-a', path: 'src/a-active.ts' })
    a.recordLease({ id: 'lease_a_orphan', runId: runA, taskId: orphanA, museId: 'worker-a', path: 'src/a-orphan.ts' })
    a.recordLease({ id: 'lease_b_active', runId: runB, taskId: untouchedB, museId: 'worker-a', path: 'src/b.ts' })

    const fence = liveFence(a, runA)
    a.reapOrphanedLeases(new Set([activeA]), fence)

    const stateOf = (id: string): string =>
      (a.db.prepare('SELECT state FROM file_leases WHERE id = ?').get(id) as { state: string }).state
    expect(stateOf('lease_a_active')).toBe('active')
    expect(stateOf('lease_a_orphan')).toBe('released')
    expect(stateOf('lease_b_active')).toBe('active')

    // Without a fence the reap keeps the pre-existing, intentionally global behavior.
    b.reapOrphanedLeases(new Set())
    expect(stateOf('lease_a_active')).toBe('released')
    expect(stateOf('lease_b_active')).toBe('released')
  })
})

describe('pre-read state CAS (a concurrent control-plane write is never resurrected)', () => {
  it('setTaskState: a cancel committed between pre-read and UPDATE loses with StateTransitionError', () => {
    const { a, b } = twoConnections('cas-task')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const taskId = seedTask(a, runId, 't', 'queued')
    a.setTaskState(taskId, 'admitted')
    a.setTaskState(taskId, 'running')

    injectBeforePrepare(a, (sql) => sql.includes('UPDATE tasks SET state = ?'), () => {
      // The control plane (another process) cancels while A is between its
      // pre-read and its UPDATE.
      b.setTaskState(taskId, 'cancelled')
    })

    let thrown: unknown = null
    try {
      a.setTaskState(taskId, 'verifying', { result: { ok: true } })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(StateTransitionError)
    const err = thrown as StateTransitionError
    expect(err.code).toBe('state_transition_invalid')
    expect(err.message).toContain(taskId)
    expect(err.message).toContain('durable state changed concurrently')
    // The winner is untouched — no `cancelled -> verifying` resurrection.
    const after = a.getTask(taskId)
    expect(after.state).toBe('cancelled')
    expect(after.result).toBeNull()
  })

  it('setRunState: a cancel committed between pre-read and UPDATE loses with StateTransitionError', () => {
    const { a, b } = twoConnections('cas-run')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    a.setRunState(runId, 'active')

    injectBeforePrepare(a, (sql) => sql.includes('UPDATE runs SET state = ?'), () => {
      b.setRunState(runId, 'cancelled')
    })

    let thrown: unknown = null
    try {
      a.setRunState(runId, 'completed')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(StateTransitionError)
    const err = thrown as StateTransitionError
    expect(err.code).toBe('state_transition_invalid')
    expect(err.message).toContain(runId)
    expect(err.message).toContain('durable state changed concurrently')
    expect(a.getRun(runId).state).toBe('cancelled')
  })

  it('classifies a stale owner first when the task also moved on (OwnershipLostError, not StateTransitionError)', () => {
    const { a, b } = twoConnections('cas-fence-order')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const taskId = seedTask(a, runId, 't')
    const fence = staleFence(a, b, runId)
    // The control plane cancels the task; the stale owner's next duty write is
    // both state-illegal and fence-stale. The durable loss must win (§5 matrix).
    a.setTaskState(taskId, 'cancelled')

    let thrown: unknown = null
    try {
      a.setTaskState(taskId, 'queued', {}, fence)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(OwnershipLostError)
    expect((thrown as OwnershipLostError).code).toBe('ownership_lost')
    expect(a.getTask(taskId).state).toBe('cancelled')
  })

  it('classifies a stale owner first on the 0-row CAS path (fence miss beats the concurrent state change)', () => {
    const { a, b } = twoConnections('cas-fence-order-0row')
    const projectId = seedProject(a)
    const runId = seedRun(a, projectId)
    const taskId = seedTask(a, runId, 't', 'queued')
    const fence = staleFence(a, b, runId)

    injectBeforePrepare(a, (sql) => sql.includes('UPDATE tasks SET state = ?'), () => {
      b.setTaskState(taskId, 'cancelled')
    })

    let thrown: unknown = null
    try {
      a.setTaskState(taskId, 'admitted', {}, fence)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(OwnershipLostError)
    expect((thrown as OwnershipLostError).code).toBe('ownership_lost')
    expect(a.getTask(taskId).state).toBe('cancelled')
  })
})

describe('migration v7', () => {
  it('adds supervisor_token and supervisor_heartbeat_at to a v6 database and reads them as null', () => {
    const path = join(tmpDir('mig-v7'), 'pluton.sqlite')
    const db = openDatabase(path)
    openDbs.push(db)
    // Build a v6 database (the schema shipped before the ownership columns).
    for (const migration of MIGRATIONS) {
      if (migration.version > 6) continue
      for (const sql of migration.statements) db.exec(sql)
    }
    setUserVersion(db, 6)
    const ts = '2024-01-01T00:00:00.000Z'
    db.prepare(
      `INSERT INTO projects (id, name, root_path, config_path, default_branch, created_at, updated_at)
       VALUES ('project_v6', 'v6', '/v6', '/v6/pluton.yaml', 'main', ?, ?)`,
    ).run(ts, ts)
    db.prepare(
      `INSERT INTO runs (id, project_id, goal, origin, requested_by, state, acceptance_json, manager_muse_id,
                         budget_json, supervisor_pid, created_at, started_at, completed_at, final_summary)
       VALUES ('run_v6', 'project_v6', 'g', 'cli', 'tester', 'created', '[]', 'worker-a', ?, 321, ?, NULL, NULL, NULL)`,
    ).run(JSON.stringify(BUDGET), ts)

    const result = migrate(db)
    expect(result.from).toBe(6)
    expect(result.to).toBe(10)
    expect(result.applied).toEqual([
      'v7:run-supervisor-ownership',
      'v8:muse-to-ship-terminology',
      'v9:session-workspaces',
      'v10:native-execution-sessions',
    ])

    const store = new Store(db)
    const run = store.getRun('run_v6')
    expect(run.supervisorToken).toBeNull()
    expect(run.supervisorHeartbeatAt).toBeNull()
    expect(run.supervisorPid).toBe(321)
    // A migrated legacy row is immediately claimable (NULL = unowned).
    expect(store.claimRunSupervisor('run_v6', { pid: 101, ttlMs: TTL, nowMs: T0 })).not.toBeNull()
  })
})
