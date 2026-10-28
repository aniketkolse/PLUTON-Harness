import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConflictError } from '../../src/domain/errors.ts'
import type { Permission } from '../../src/domain/permissions.ts'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
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
  createEngineApprovalChannel,
  pendingApprovalWaiterCount,
  settleApprovalWaiter,
  type EnginePermissionChannel,
} from '../../src/engines/interactive-approval.ts'
import { RunSupervisor } from '../../src/orchestrator/supervisor.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import type { PlutonToolBridge, ToolBridgeLimits } from '../../src/tools/bridge.ts'
import { GitWorkspaceManager } from '../../src/workspace/manager.ts'
import { requestRunCancel } from '../../src/cli/commands/run.ts'

/**
 * Supervisor ownership (change set A2 — supervisor/integration half).
 *
 * The durable claim lives in the store (change set A1); this suite drives the
 * integration half: `RunSupervisor.runToCompletion` claims BEFORE any state
 * write, refuses to double-drive a live run (ConflictError), renews its
 * heartbeat, fast-detects a takeover on its next loop tick, returns the
 * read-only `superseded` outcome WITHOUT a single write, and releases the claim
 * on every normal path. Two real Store connections on one database file play
 * the two processes, exactly as in `tests/unit/store-ownership.test.ts`.
 */

const TTL_MS = 500
const LOOP_POLL_MS = 20

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

const WORKER_PERMISSIONS: Permission[] = ['task.delegate', 'task.inspect', 'result.collect', 'diff.inspect']

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

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

// ---------------------------------------------------------------------------
// A controlled engine adapter: deterministic timing + observable interrupts.
// ---------------------------------------------------------------------------

interface SessionRecord {
  museId: string
  sessionId: string
}

class ControlledSession implements EngineSession {
  readonly info: EngineSessionInfo
  private readonly owner: ControlledEngineAdapter
  private readonly museId: string
  private readonly waiters: (() => void)[] = []

  constructor(owner: ControlledEngineAdapter, museId: string, id: string) {
    this.owner = owner
    this.museId = museId
    this.info = { id, nativeSessionId: `ctl-${id}`, resumeToken: null }
  }

  private release(): void {
    for (const wake of this.waiters.splice(0)) wake()
  }

  async *sendPrompt(_req: PromptRequest): AsyncIterable<EngineEvent> {
    this.owner.onPromptStart?.(this.museId)
    yield { kind: 'status', status: 'busy' }
    if (this.owner.isBlocking(this.museId)) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
    if (this.owner.interrupted.has(this.info.id)) {
      yield { kind: 'result', outcome: 'cancelled', summary: 'interrupted' }
      return
    }
    yield { kind: 'result', outcome: 'success', summary: `controlled:${this.museId}` }
  }

  async interrupt(): Promise<void> {
    this.owner.interrupts.push({ museId: this.museId, sessionId: this.info.id })
    this.owner.interrupted.add(this.info.id)
    this.release()
  }

  async close(): Promise<void> {
    this.release()
    this.owner.closed.push({ museId: this.museId, sessionId: this.info.id })
  }

  /** End this session's blocked turn without marking it interrupted. */
  forceRelease(): void {
    this.release()
  }
}

class ControlledEngineAdapter implements EngineAdapter {
  readonly kind = 'controlled'
  /** Sessions the supervisor interrupted, in order. */
  readonly interrupts: SessionRecord[] = []
  /** Sessions closed by the supervisor, in order. */
  readonly closed: SessionRecord[] = []
  /** Sessions created, in order. */
  readonly sessionRefs: { record: SessionRecord; session: ControlledSession }[] = []
  /** Approval channels handed to sessions, by Muse id (fenced-channel tests). */
  readonly channels = new Map<string, EnginePermissionChannel>()
  readonly interrupted = new Set<string>()
  /** Test hook: fired when a session's prompt begins (manager tool scheduling). */
  onPromptStart?: (museId: string) => void
  /** Muses whose prompt blocks until interrupted or force-released. */
  private readonly blockers: Set<string>
  private nextId = 1

  constructor(blockingMuses: string[] = []) {
    this.blockers = new Set(blockingMuses)
  }

  isBlocking(museId: string): boolean {
    return this.blockers.has(museId)
  }

  capabilities(): EngineCapabilities {
    return { ...defaultCapabilities(), interrupt: true }
  }

  discover(): Promise<EngineDiscovery> {
    return Promise.resolve({
      engineKind: this.kind,
      installed: true,
      binaryPath: '<controlled>',
      version: 'ctl-1.0.0',
      fix: 'nothing to install — controlled test engine',
    })
  }

  listModels(): Promise<EngineModel[]> {
    return Promise.resolve([])
  }

  authStatus(_configDir: string): Promise<EngineAuthStatus> {
    return Promise.resolve({ configured: true, hint: 'controlled test engine needs no auth' })
  }

  startSession(req: StartSessionRequest): Promise<EngineSession> {
    const id = `ctl-session-${String(this.nextId)}`
    this.nextId += 1
    const ship = req.ship ?? req.muse!
    const record: SessionRecord = { museId: ship.id, sessionId: id }
    const session = new ControlledSession(this, ship.id, id)
    this.sessionRefs.push({ record, session })
    if (req.approvals !== undefined && req.approvals !== null) this.channels.set(ship.id, req.approvals)
    return Promise.resolve(session)
  }

  /** End every blocked turn (test cleanup, so nothing lingers past the test). */
  releaseBlocked(museId?: string): void {
    for (const ref of this.sessionRefs) {
      if (museId === undefined || ref.record.museId === museId) ref.session.forceRelease()
    }
  }

  interruptCountFor(museId: string): number {
    return this.interrupts.filter((r) => r.museId === museId).length
  }
}

// ---------------------------------------------------------------------------
// World: a temp project and one real database (second connection on demand).
// ---------------------------------------------------------------------------

interface SupervisorOverrides {
  skipManager?: boolean
  adapter?: EngineAdapter
  /** Drive a different run on the same store (independent-runs test). */
  runId?: string
}

interface World {
  dir: string
  store: Store
  projectId: string
  runId: string
  adapter: ControlledEngineAdapter
  diagnostics: string[]
  supervisor: RunSupervisor
  makeSupervisor: (overrides?: SupervisorOverrides) => RunSupervisor
  /** Await the manager's scheduled tool hook; surfaces any failure. */
  settleTools: () => Promise<void>
}

interface MakeWorldOptions {
  runGoal?: string
  blockingMuses?: string[]
  /** Manager-side tool hook (the way tasks enter the run). */
  managerTools?: (bridge: PlutonToolBridge) => Promise<void>
}

function makeWorld(opts: MakeWorldOptions = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-ownership-int-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, '.pluton', 'state'), { recursive: true })

  const db = openDatabase(join(dir, '.pluton', 'state', 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)

  const project = store.ensureProject({
    name: 'supervisor-ownership',
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
      engineKind: 'controlled',
      model: 'controlled/model-a',
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
      engineKind: 'controlled',
      model: 'controlled/model-a',
      instructionsFile: null,
      workspacePolicy: 'coordinator-read-only',
      permissions: WORKER_PERMISSIONS,
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/worker-a',
    },
  ])
  const run = store.createRun({
    projectId: project.id,
    goal: opts.runGoal ?? 'prove supervisor ownership',
    origin: 'cli',
    requestedBy: 'tester',
    acceptanceCriteria: ['single supervisor per run'],
    managerMuseId: 'manager',
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 20,
      maxDelegationDepth: 3,
      maxRunMinutes: 30,
      defaultTaskMinutes: 10,
    },
  })

  const adapter = new ControlledEngineAdapter(opts.blockingMuses ?? [])
  const workspacesRoot = join(dir, '.pluton', 'workspaces')
  const diagnostics: string[] = []
  const ref: { supervisor: RunSupervisor | null; toolsError: unknown } = { supervisor: null, toolsError: null }
  let toolsPromise: Promise<void> = Promise.resolve()
  if (opts.managerTools !== undefined) {
    const hook = opts.managerTools
    adapter.onPromptStart = (museId) => {
      if (museId !== 'manager') return
      const sup = ref.supervisor
      if (sup === null) return
      toolsPromise = (async () => {
        try {
          await hook(sup.managerBridge())
        } catch (e) {
          ref.toolsError = e
        }
      })()
    }
  }
  const makeSupervisor = (overrides: SupervisorOverrides = {}): RunSupervisor =>
    new RunSupervisor({
      store,
      projectId: project.id,
      rootDir: dir,
      workspacesRoot,
      runId: overrides.runId ?? run.id,
      limits: LIMITS,
      maxConcurrentWorkers: 2,
      defaultTaskTimeoutMs: 30_000,
      runDeadlineMs: 60_000,
      verificationConfigured: false,
      loopPollMs: LOOP_POLL_MS,
      ownershipTtlMs: TTL_MS,
      adapterFor: () => overrides.adapter ?? adapter,
      workspaceManager: new GitWorkspaceManager({ workspacesRoot }),
      diagnostic: (line) => {
        diagnostics.push(line)
      },
    })

  const supervisor = makeSupervisor()
  ref.supervisor = supervisor
  return {
    dir,
    store,
    projectId: project.id,
    runId: run.id,
    adapter,
    diagnostics,
    supervisor,
    makeSupervisor,
    settleTools: async () => {
      await toolsPromise
      if (ref.toolsError !== null) throw ref.toolsError
    },
  }
}

/** The second "process": an independent Store connection on the same file. */
function otherConnection(world: World): Store {
  const db = openDatabase(join(world.dir, '.pluton', 'state', 'pluton.sqlite'))
  openDbs.push(db)
  return new Store(db)
}

async function waitForDurable(label: string, predicate: () => boolean, attempts = 2_000, stepMs = 5): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Deterministic two-connection window injection: when this supervisor's store
 * prepares a statement whose SQL matches, `concurrent` (a real write through
 * the second connection) commits first — i.e. exactly between the supervisor's
 * pre-read and its UPDATE. Nothing is mocked; the race is real and scheduled.
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

/** The manager's way in: create one worker task through the restricted bridge. */
async function createTaskViaBridge(
  bridge: PlutonToolBridge,
  title: string,
  assigneeMuseId: string,
): Promise<string> {
  const res = await bridge.call('task.create', {
    title,
    brief: 'do it well',
    acceptanceCriteria: ['done'],
    assigneeMuseId,
  })
  if (!res.ok) throw new Error(`task.create failed: ${JSON.stringify(res)}`)
  return (res.data as { task: { id: string } }).task.id
}

function rawRun(store: Store, runId: string): Record<string, unknown> {
  return store.db
    .prepare('SELECT supervisor_pid, supervisor_token, supervisor_heartbeat_at FROM runs WHERE id = ?')
    .get(runId) as Record<string, unknown>
}

function eventCount(store: Store, runId: string, type: string): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ?')
    .get(runId, type) as { n: number }
  return Number(row.n)
}

function eventTypes(store: Store, runId: string): string[] {
  const rows = store.db
    .prepare('SELECT type FROM events WHERE run_id = ? ORDER BY seq ASC')
    .all(runId) as { type: string }[]
  return rows.map((r) => r.type)
}

// ---------------------------------------------------------------------------

describe('RunSupervisor ownership — a single live owner', () => {
  it('claims before driving, refuses a second supervisor, and releases on completion', async () => {
    const world = makeWorld()
    const other = otherConnection(world)
    try {
      const running = world.supervisor.runToCompletion()
      await waitForDurable('the first supervisor to claim the run', () => rawRun(world.store, world.runId)['supervisor_token'] !== null)
      const claimed = rawRun(world.store, world.runId)
      expect(claimed['supervisor_pid']).toBe(process.pid)
      expect(typeof claimed['supervisor_token']).toBe('string')
      expect(claimed['supervisor_heartbeat_at']).not.toBeNull()

      // The second supervisor must fail closed AND write nothing: no second
      // claim event, no run-state mutation, no other artifact.
      const second = world.makeSupervisor()
      const claimedEventsBefore = eventCount(world.store, world.runId, 'run.supervisor_claimed')
      const eventsBefore = world.store.listEvents(world.runId, { limit: 500 }).length
      let thrown: unknown = null
      try {
        await second.runToCompletion()
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(ConflictError)
      const conflict = thrown as ConflictError
      expect(conflict.code).toBe('request_conflict')
      expect((conflict.details as { supervisorPid?: number }).supervisorPid).toBe(process.pid)
      expect(rawRun(other, world.runId)).toEqual(claimed)
      expect(eventCount(world.store, world.runId, 'run.supervisor_claimed')).toBe(claimedEventsBefore)
      expect(world.store.listEvents(world.runId, { limit: 500 }).length).toBe(eventsBefore)

      const out = await running
      expect(out.state).toBe('completed')
      expect(out.outcome).toBe('success')
      // After the run: claim cleared, exactly one claim + release event.
      expect(rawRun(world.store, world.runId)).toEqual({
        supervisor_pid: null,
        supervisor_token: null,
        supervisor_heartbeat_at: null,
      })
      expect(eventCount(world.store, world.runId, 'run.supervisor_claimed')).toBe(1)
      expect(eventCount(world.store, world.runId, 'run.supervisor_released')).toBe(1)
      expect(eventCount(world.store, world.runId, 'run.finished')).toBe(1)
    } finally {
      other.close()
    }
  }, 20_000)

  it('renews the heartbeat while it owns the run', async () => {
    const world = makeWorld({ blockingMuses: ['manager'] })
    const other = otherConnection(world)
    try {
      const running = world.supervisor.runToCompletion()
      await waitForDurable('the first supervisor to claim the run', () => rawRun(world.store, world.runId)['supervisor_token'] !== null)
      const token = rawRun(world.store, world.runId)['supervisor_token'] as string
      const heartbeat = rawRun(world.store, world.runId)['supervisor_heartbeat_at'] as number
      // Detection is bounded by the loop tick; correctness is bounded by the
      // atomic fence. An advancing heartbeat proves renew is wired into the
      // loop (not only on the claim path).
      await waitForDurable('the supervisor heartbeat to advance', () => {
        const row = rawRun(other, world.runId)
        return row['supervisor_token'] === token && (row['supervisor_heartbeat_at'] as number) > heartbeat
      })
      world.adapter.releaseBlocked('manager')
      const out = await running
      expect(out.outcome).toBe('success')
      expect(rawRun(world.store, world.runId)['supervisor_token']).toBeNull()
      expect(eventCount(world.store, world.runId, 'run.supervisor_released')).toBe(1)
    } finally {
      other.close()
    }
  }, 20_000)
})

describe('RunSupervisor ownership — superseded without finalizing', () => {
  it('a stale owner stops with a read-only superseded outcome and interrupts its engines', async () => {
    const world = makeWorld({ blockingMuses: ['manager'] })
    const other = otherConnection(world)
    try {
      const running = world.supervisor.runToCompletion()
      await waitForDurable('the first supervisor to claim the run', () => rawRun(world.store, world.runId)['supervisor_token'] !== null)
      const claimedToken = rawRun(world.store, world.runId)['supervisor_token'] as string

      // The "other process" legitimately takes the run over: past the TTL.
      const takeover = other.claimRunSupervisor(world.runId, {
        pid: 7777,
        ttlMs: TTL_MS,
        nowMs: Date.now() + TTL_MS * 2,
      })
      expect(takeover).not.toBeNull()
      expect(takeover?.tookOver).toBe(true)

      const out = await running
      // Read-only outcome computed from durable rows; no finalize, no event.
      expect(out.outcome).toBe('superseded')
      expect(out.state).toBe('active')
      expect(out.managerSummary).toBeNull()
      const after = rawRun(other, world.runId)
      expect(after['supervisor_token']).toBe(takeover?.token)
      expect(after['supervisor_token']).not.toBe(claimedToken)
      expect(eventCount(world.store, world.runId, 'run.finished')).toBe(0)
      expect(eventCount(world.store, world.runId, 'run.uncertain')).toBe(0)
      expect(eventCount(world.store, world.runId, 'run.supervisor_released')).toBe(0)
      // The stale owner interrupted its live manager session before going quiet.
      expect(world.adapter.interruptCountFor('manager')).toBeGreaterThanOrEqual(1)
    } finally {
      other.close()
    }
  }, 20_000)

  it('a stale owner cannot settle a task after the takeover', async () => {
    const world = makeWorld({
      blockingMuses: ['worker-a'],
      managerTools: async (bridge) => {
        await createTaskViaBridge(bridge, 'W1', 'worker-a')
      },
    })
    const other = otherConnection(world)
    let taskId = ''
    try {
      const running = world.supervisor.runToCompletion()
      // The worker blocks inside its prompt; the manager prompt settles quickly.
      await waitForDurable('the worker task to run', () => {
        const task = world.store.listTasks(world.runId).find((t) => t.state === 'running')
        if (task !== undefined) taskId = task.id
        return task !== undefined
      })
      await world.settleTools()

      const takeover = other.claimRunSupervisor(world.runId, {
        pid: 8888,
        ttlMs: TTL_MS,
        nowMs: Date.now() + TTL_MS * 2,
      })
      expect(takeover).not.toBeNull()
      const out = await running
      expect(out.outcome).toBe('superseded')
      // No fabricated completion from the superseded process; no release write.
      expect(world.store.getTask(taskId).state).not.toBe('completed')
      expect(world.adapter.interruptCountFor('worker-a')).toBeGreaterThanOrEqual(1)
      expect(rawRun(other, world.runId)['supervisor_token']).toBe(takeover?.token)
      expect(eventCount(world.store, world.runId, 'run.supervisor_released')).toBe(0)
      expect(eventCount(world.store, world.runId, 'run.finished')).toBe(0)
    } finally {
      other.close()
    }
  }, 20_000)
})

describe('RunSupervisor ownership — loss recorded inside a swallowed callback', () => {
  it('exits superseded on the next tick when the loss was first seen by an approval callback', async () => {
    const world = makeWorld({
      blockingMuses: ['worker-a'],
      managerTools: async (bridge) => {
        await createTaskViaBridge(bridge, 'guarded work', 'worker-a')
      },
    })
    const other = otherConnection(world)
    try {
      const running = world.supervisor.runToCompletion()
      // Keep the promise handled: under the old flag-only behavior it outlives
      // this test (it churns until the world's 60s run deadline).
      void running.catch(() => {})
      await waitForDurable('the worker session and its approval channel', () => world.adapter.channels.has('worker-a'))
      await waitForDurable('the worker task to reach running', () =>
        world.store.listTasks(world.runId).some((t) => t.state === 'running'),
      )
      await world.settleTools()
      const channel = world.adapter.channels.get('worker-a')
      if (channel === undefined) throw new Error('worker approval channel missing')

      // A task-scoped ask parks the task in needs_approval while the claim is live.
      const ask = channel.requestPermission({
        requestId: 'req-lost',
        description: 'read a sensitive file',
        scope: { toolKind: 'read', path: '.env' },
      })
      await waitForDurable('the durable pending approval', () =>
        world.store.listApprovals(world.runId).some((a) => a.status === 'pending'),
      )
      const pending = world.store.listApprovals(world.runId).find((a) => a.status === 'pending')
      if (pending === undefined) throw new Error('pending approval missing')

      // No await between the takeover and the settle: the fenced task flip in
      // `onSettled` records the loss before the next loop tick can run, so that
      // next tick is the only thing that can end this process's wait.
      const takeover = other.claimRunSupervisor(world.runId, {
        pid: 9999,
        ttlMs: TTL_MS,
        nowMs: Date.now() + TTL_MS * 2,
      })
      expect(takeover).not.toBeNull()
      world.store.setApprovalStatus(pending.id, 'approved', { decidedBy: 'operator' })
      expect(settleApprovalWaiter(pending.id, 'approved')).toBe(true)

      // Bounded well under the 60s run deadline: a tick-bounded exit lands in
      // milliseconds, while the old behavior churned until the deadline.
      const out = await Promise.race([
        running,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('superseded owner kept polling instead of exiting on its next tick'))
          }, 10_000).unref()
        }),
      ])
      expect(out.outcome).toBe('superseded')
      expect(out.state).toBe('active')
      // The loss was recorded by the swallowed callback, not by the fast-check.
      expect(world.diagnostics.some((d) => d.includes('approval wait was being settled'))).toBe(true)
      expect(world.adapter.interruptCountFor('worker-a')).toBeGreaterThanOrEqual(1)
      expect(rawRun(other, world.runId)['supervisor_token']).toBe(takeover?.token)
      expect(eventCount(world.store, world.runId, 'run.supervisor_released')).toBe(0)
      expect(eventCount(world.store, world.runId, 'run.finished')).toBe(0)
      await expect(ask).resolves.toBe('allow')
    } finally {
      world.adapter.releaseBlocked()
      other.close()
    }
  }, 20_000)
})

describe('RunSupervisor ownership — claim lifecycle around cancellation and restart', () => {
  it('cancellation while the claim is held finalizes the run and releases the claim', async () => {
    const world = makeWorld({
      blockingMuses: ['manager', 'worker-a'],
      managerTools: async (bridge) => {
        await createTaskViaBridge(bridge, 'C1', 'worker-a')
      },
    })
    const other = otherConnection(world)
    let taskId = ''
    try {
      const running = world.supervisor.runToCompletion()
      await waitForDurable('the worker task to run', () => {
        const task = world.store.listTasks(world.runId).find((t) => t.state === 'running')
        if (task !== undefined) taskId = task.id
        return task !== undefined
      })

      // CS-9: the operator's durable cancel path, from the other process,
      // while both the manager and the worker turn are in flight.
      expect(requestRunCancel(other, world.runId, 'test')).toBe(true)

      const out = await running
      expect(out.state).toBe('cancelled')
      expect(out.outcome).toBe('cancelled')
      const types = eventTypes(world.store, world.runId)
      expect(types).toContain('run.cancel_requested')
      expect(types).toContain('run.supervisor_claimed')
      expect(types).toContain('run.supervisor_released')
      expect(eventCount(world.store, world.runId, 'run.supervisor_claimed')).toBe(1)
      expect(eventCount(world.store, world.runId, 'run.supervisor_released')).toBe(1)
      expect(eventCount(world.store, world.runId, 'run.finished')).toBe(1)
      expect(world.store.getTask(taskId).state).toBe('cancelled')
      expect(rawRun(other, world.runId)).toEqual({
        supervisor_pid: null,
        supervisor_token: null,
        supervisor_heartbeat_at: null,
      })
    } finally {
      other.close()
    }
  }, 20_000)

  it('restart reconciliation takes over a stale ownership record and completes cleanly', async () => {
    const world = makeWorld()
    const other = otherConnection(world)
    try {
      // A dead process left the run `active` (a session-backed task stranded)
      // and a stale claim behind.
      world.store.setRunState(world.runId, 'active', { supervisorPid: 12345 })
      const stale = other.claimRunSupervisor(world.runId, { pid: 12345, ttlMs: TTL_MS, nowMs: 1 })
      expect(stale).not.toBeNull()
      const task = world.store.createTask({
        runId: world.runId,
        parentTaskId: null,
        title: 'stranded',
        brief: 'will be recovered',
        acceptanceCriteria: ['recovered'],
        assigneeMuseId: 'worker-a',
      })
      world.store.setTaskState(task.id, 'queued')
      world.store.setTaskState(task.id, 'admitted')
      world.store.setTaskState(task.id, 'running', { engineSessionId: 'engine-session-dead' })

      const supervisor = world.makeSupervisor({ skipManager: true })
      const out = await supervisor.runToCompletion()
      expect(out.outcome).toBe('success')
      expect(out.state).toBe('completed')

      // The takeover is recorded with the previous owner's pid.
      const claimed = world.store
        .listEvents(world.runId, { type: 'run.supervisor_claimed', limit: 1 })
        .map((e) => e.payload as { tookOver?: boolean; previousPid?: number })
      expect(claimed[0]?.tookOver).toBe(true)
      expect(claimed[0]?.previousPid).toBe(12345)

      // The stranded task was requeued by recovery, then settled.
      expect(eventCount(world.store, world.runId, 'task.recovered')).toBe(1)
      const settled = world.store.getTask(task.id)
      expect(settled.state).toBe('completed')
      expect(settled.attempt).toBe(1)
      expect(rawRun(world.store, world.runId)).toEqual({
        supervisor_pid: null,
        supervisor_token: null,
        supervisor_heartbeat_at: null,
      })
    } finally {
      other.close()
    }
  }, 20_000)
})

describe('RunSupervisor ownership — concurrent control-plane terminal writes', () => {
  it('a cancel committed before the created -> active write exits cleanly as cancelled', async () => {
    const world = makeWorld()
    const other = otherConnection(world)
    try {
      // The operator cancel commits exactly when the supervisor prepares its
      // claim write: the run is already `cancelled` when its startup
      // `created -> active` transition runs. No crash, no active resurrection.
      injectBeforePrepare(
        world.store,
        (sql) => sql.includes('UPDATE runs SET supervisor_pid = ?, supervisor_token = ?'),
        () => {
          requestRunCancel(other, world.runId, 'test:startup-window')
        },
      )

      const out = await world.supervisor.runToCompletion()
      expect(out.state).toBe('cancelled')
      expect(out.outcome).toBe('cancelled')

      // The durable row stays cancelled; the start event of a run that never
      // became active is never minted.
      expect(world.store.getRun(world.runId).state).toBe('cancelled')
      expect(eventCount(world.store, world.runId, 'run.started')).toBe(0)
      expect(eventCount(world.store, world.runId, 'run.cancel_requested')).toBe(1)
      expect(eventCount(world.store, world.runId, 'run.finished')).toBe(1)
      const payload = world.store.listEvents(world.runId, { type: 'run.finished' })[0]?.payload as {
        outcome?: string
        state?: string
      }
      expect(payload.outcome).toBe('cancelled')
      expect(payload.state).toBe('cancelled')
      // The new exit path still releases the claim.
      expect(eventCount(world.store, world.runId, 'run.supervisor_released')).toBe(1)
      expect(rawRun(world.store, world.runId)).toEqual({
        supervisor_pid: null,
        supervisor_token: null,
        supervisor_heartbeat_at: null,
      })
    } finally {
      other.close()
    }
  }, 20_000)

  it('a cancel landing between finalize read and write is adopted: cancelled outcome, honest run.finished', async () => {
    const world = makeWorld({ blockingMuses: ['manager'] })
    const other = otherConnection(world)
    // The run turns active BEFORE the manager session starts blocking, and a
    // release only wakes waiters that are already parked — keep issuing it
    // until the prompt actually unblocks.
    const release = setInterval(() => {
      world.adapter.releaseBlocked('manager')
    }, LOOP_POLL_MS)
    try {
      const running = world.supervisor.runToCompletion()
      await waitForDurable('the run to become active', () => world.store.getRun(world.runId).state === 'active')
      await waitForDurable('the manager session to start', () =>
        world.adapter.sessionRefs.some((r) => r.record.museId === 'manager'),
      )
      // After startup, the first `UPDATE runs SET state = ?` belongs to
      // finalize. The cancel commits exactly between finalize's decision read
      // and its write.
      injectBeforePrepare(world.store, (sql) => sql.includes('UPDATE runs SET state = ?'), () => {
        expect(requestRunCancel(other, world.runId, 'test:finalize-window')).toBe(true)
      })

      const out = await running
      expect(out.state).toBe('cancelled')
      expect(out.outcome).toBe('cancelled')
      expect(world.store.getRun(world.runId).state).toBe('cancelled')
      expect(eventCount(world.store, world.runId, 'run.finished')).toBe(1)
      const payload = world.store.listEvents(world.runId, { type: 'run.finished' })[0]?.payload as {
        outcome?: string
        state?: string
      }
      // No `{state:'cancelled', outcome:'success'}` contradiction.
      expect(payload.outcome).toBe('cancelled')
      expect(payload.state).toBe('cancelled')
      expect(eventCount(world.store, world.runId, 'run.supervisor_released')).toBe(1)
      expect(rawRun(world.store, world.runId)).toEqual({
        supervisor_pid: null,
        supervisor_token: null,
        supervisor_heartbeat_at: null,
      })
    } finally {
      clearInterval(release)
      world.adapter.releaseBlocked()
      other.close()
    }
  }, 20_000)

  it('a task cancel in the settle window discards the late result without fabricating a failure', async () => {
    let taskId = ''
    const world = makeWorld({
      blockingMuses: ['worker-a'],
      managerTools: async (bridge) => {
        taskId = await createTaskViaBridge(bridge, 'S1', 'worker-a')
      },
    })
    const other = otherConnection(world)
    try {
      const running = world.supervisor.runToCompletion()
      await waitForDurable('the worker task to run', () =>
        world.store.listTasks(world.runId).some((t) => t.id === taskId && t.state === 'running'),
      )
      await world.settleTools()
      // The control plane cancels the task exactly when the supervisor prepares
      // its settle write (`running -> verifying`): the late success must be
      // recorded as discarded, never applied over the winner.
      injectBeforePrepare(world.store, (sql) => sql.includes('UPDATE tasks SET state = ?'), () => {
        other.setTaskState(taskId, 'cancelled')
      })
      world.adapter.releaseBlocked('worker-a')

      const out = await running
      expect(world.store.getTask(taskId).state).toBe('cancelled')
      expect(eventCount(world.store, world.runId, 'task.late_result_discarded')).toBe(1)
      const discarded = world.store.listEvents(world.runId, { type: 'task.late_result_discarded' })[0]
      expect(discarded?.taskId).toBe(taskId)
      expect(discarded?.payload).toEqual({ taskId, outcome: 'success', currentState: 'cancelled' })
      expect(eventCount(world.store, world.runId, 'task.completed')).toBe(0)
      expect(eventCount(world.store, world.runId, 'task.failed')).toBe(0)
      expect(out.state).toBe('completed')
      expect(out.outcome).toBe('success')
    } finally {
      world.adapter.releaseBlocked()
      other.close()
    }
  }, 20_000)
})

describe('RunSupervisor ownership — task session teardown on the post-start writes', () => {
  it('closes the task session when a control-plane cancel wins between the running write pre-read and UPDATE', async () => {
    let taskId = ''
    const world = makeWorld({
      managerTools: async (bridge) => {
        taskId = await createTaskViaBridge(bridge, 'L1', 'worker-a')
      },
    })
    const other = otherConnection(world)
    try {
      // Arm the window before dispatch: the first `UPDATE tasks SET state = ?`
      // prepared while the task is `admitted` is the supervisor's
      // `admitted -> running` write. The control-plane cancel commits between
      // that write's pre-read and its UPDATE, so the write loses the CAS.
      injectBeforePrepare(
        world.store,
        (sql) =>
          sql.includes('UPDATE tasks SET state = ?') &&
          taskId !== '' &&
          world.store.getTask(taskId).state === 'admitted',
        () => {
          other.setTaskState(taskId, 'cancelled')
          requestRunCancel(other, world.runId, 'test:post-start-window')
        },
      )

      const out = await world.supervisor.runToCompletion()

      // The control-plane winner stands; the supervisor exits cleanly (nothing
      // escapes) and the durable task/run rows stay cancelled.
      expect(out.state).toBe('cancelled')
      expect(out.outcome).toBe('cancelled')
      expect(world.store.getRun(world.runId).state).toBe('cancelled')
      expect(world.store.getTask(taskId).state).toBe('cancelled')
      // The session that started before the losing write is closed exactly
      // once, even though the prompt `finally` is never reached.
      expect(world.adapter.closed.filter((s) => s.museId === 'worker-a')).toHaveLength(1)
      // No start/failure was fabricated for a task that never ran.
      expect(eventCount(world.store, world.runId, 'task.started')).toBe(0)
      expect(eventCount(world.store, world.runId, 'task.failed')).toBe(0)
    } finally {
      other.close()
    }
  }, 20_000)

  it('still starts and closes a healthy task session exactly once', async () => {
    const world = makeWorld({
      managerTools: async (bridge) => {
        await createTaskViaBridge(bridge, 'L2', 'worker-a')
      },
    })
    try {
      const out = await world.supervisor.runToCompletion()
      await world.settleTools()

      expect(out.outcome).toBe('success')
      expect(eventCount(world.store, world.runId, 'task.started')).toBe(1)
      expect(world.adapter.closed.filter((s) => s.museId === 'worker-a')).toHaveLength(1)
    } finally {
      world.adapter.releaseBlocked()
    }
  }, 20_000)
})

describe('RunSupervisor ownership — independent runs', () => {
  it('two runs on the same store proceed concurrently with their own claims', async () => {
    // ONE world, ONE store, ONE project: run A comes from the world builder,
    // run B is created beside it, and each run gets its own supervisor over the
    // shared store — the real "two runs, one database" shape.
    const world = makeWorld({ runGoal: 'run A' })
    const runB = world.store.createRun({
      projectId: world.projectId,
      goal: 'run B',
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: ['single supervisor per run'],
      managerMuseId: 'manager',
      budget: {
        maxConcurrentWorkers: 2,
        maxTasks: 20,
        maxDelegationDepth: 3,
        maxRunMinutes: 30,
        defaultTaskMinutes: 10,
      },
    })
    const supervisorB = world.makeSupervisor({ runId: runB.id })
    const [outA, outB] = await Promise.all([
      world.supervisor.runToCompletion(),
      supervisorB.runToCompletion(),
    ])
    expect(outA.outcome).toBe('success')
    expect(outB.outcome).toBe('success')
    expect(outA.state).toBe('completed')
    expect(outB.state).toBe('completed')

    // Per run: exactly one claim and one release on its own stream, its own
    // finished run, and both claims cleared.
    for (const runId of [world.runId, runB.id]) {
      expect(eventCount(world.store, runId, 'run.supervisor_claimed')).toBe(1)
      expect(eventCount(world.store, runId, 'run.supervisor_released')).toBe(1)
      expect(eventCount(world.store, runId, 'run.finished')).toBe(1)
      expect(rawRun(world.store, runId)['supervisor_token']).toBeNull()
    }
    // No event from one run references the other run's id (task, muse, payload).
    const mentions = (runId: string, otherRunId: string): number =>
      world.store
        .listEvents(runId)
        .filter((e) =>
          JSON.stringify({ taskId: e.taskId, museId: e.museId, payload: e.payload }).includes(otherRunId),
        ).length
    expect(mentions(world.runId, runB.id)).toBe(0)
    expect(mentions(runB.id, world.runId)).toBe(0)
  }, 20_000)
})

describe('engine approval channel with a fenced supervisor', () => {
  it('a stale channel resolves deny without minting an approval row', async () => {
    const world = makeWorld()
    const other = otherConnection(world)
    try {
      const first = other.claimRunSupervisor(world.runId, { pid: 4242, ttlMs: TTL_MS, nowMs: 1 })
      expect(first).not.toBeNull()
      // Take over: the first fence is now stale.
      const fresher = other.claimRunSupervisor(world.runId, { pid: 4243, ttlMs: TTL_MS, nowMs: 1 + TTL_MS })
      expect(fresher).not.toBeNull()

      const before = world.store.listApprovals(world.runId).length
      const channel = createEngineApprovalChannel({
        store: world.store,
        projectId: world.projectId,
        runId: world.runId,
        taskId: null,
        museId: 'manager',
        fence: { runId: world.runId, token: first?.token ?? '' },
      })
      const decision = await channel.requestPermission({
        requestId: 'req-1',
        description: 'write a protected file',
        scope: { path: 'src/sensitive/x.ts' },
      })
      expect(decision).toBe('deny')
      expect(world.store.listApprovals(world.runId)).toHaveLength(before)
      expect(pendingApprovalWaiterCount()).toBe(0)
      channel.abort('test over')
    } finally {
      other.close()
    }
  }, 20_000)
})
