import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { decideApproval, listApprovals } from '../../src/cli/commands/approvals.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { engineHomesDir, loadConfig } from '../../src/config/load.ts'
import { ConflictError, NotFoundError, ValidationError } from '../../src/domain/errors.ts'
import type { ApprovalRecord, EventRecord, JsonValue, RunRecord } from '../../src/domain/models.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'
import { DEFAULT_WORKER_IMAGE_TAG, type WorkerImageProbe } from '../../src/sandbox/image.ts'
import { sandboxContainerName } from '../../src/sandbox/types.ts'
import type { DatabaseSync } from '../../src/store/db.ts'
import { Store } from '../../src/store/store.ts'
import { FakeSandbox } from '../helpers/fake-sandbox.ts'

/**
 * Integration: the operator approvals inbox (`listApprovals` / `decideApproval`)
 * against the real store and the real pluton.yaml. Approvals, runs and events
 * are seeded directly through the Store; config application goes through the
 * real `createMuse` + `loadConfig` + `syncMuses` path, and container
 * provisioning through the shared per-Muse helper with a fake sandbox manager
 * and a fake worker-image probe (the only fakes).
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

const BASE_CONFIG = `version: 1
project:
  name: cli-approvals-it
  repository: .
  default_branch: main
  verification: []
runtime:
  approval_timeout_minutes: 30
sandbox:
  kind: docker
muses:
  manager:
    display_name: Manager
    role: supervisor
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
`

/** sandbox.kind defaults to docker in BASE_CONFIG; this one is the acknowledged dev-only host mode. */
const HOST_CONFIG = BASE_CONFIG.replace(
  'sandbox:\n  kind: docker',
  'sandbox:\n  kind: local-process\n  local_process_acknowledged: true',
)

const ENGINE_IMAGE_ID = `sha256:${'a'.repeat(64)}`

function enginesImageProbe(): WorkerImageProbe {
  return {
    present: true,
    image: 'pluton-worker:local',
    imageId: ENGINE_IMAGE_ID,
    record: {
      image: 'pluton-worker:local',
      imageId: ENGINE_IMAGE_ID,
      profile: 'engines',
      tmuxVersion: 'tmux 3.3a',
      nodeVersion: 'v24.0.0',
      builtAt: '2026-01-01T00:00:00.000Z',
    },
    matchesRecord: true,
    detail: 'fixture: engines profile present',
  }
}

interface Fixture {
  dir: string
  ctx: ProjectContext
  store: Store
  projectId: string
}

function makeProject(config = BASE_CONFIG): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-cli-approvals-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), config)
  writeFileSync(join(dir, 'README.md'), '# cli-approvals project\n')
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 30_000 })
  }
  git(['init', '-b', 'main'])
  git(['add', '.'])
  git(['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'seed'])

  const loaded = loadConfig(dir)
  const { store, projectId } = bootstrapStore(loaded)
  openDbs.push(store.db)
  return { dir, ctx: { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }, store, projectId }
}

function seedRun(fx: Fixture, state: 'active' | 'awaiting_approval' = 'active'): RunRecord {
  const run = fx.store.createRun({
    projectId: fx.projectId,
    goal: 'seed run',
    origin: 'cli',
    requestedBy: 'integration-test',
    acceptanceCriteria: [],
    managerMuseId: 'manager',
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 20,
      maxDelegationDepth: 3,
      maxRunMinutes: 30,
      defaultTaskMinutes: 10,
    },
  })
  fx.store.setRunState(run.id, 'active')
  if (state === 'awaiting_approval') fx.store.setRunState(run.id, 'awaiting_approval')
  return fx.store.getRun(run.id)
}

function seedApproval(
  fx: Fixture,
  patch: {
    runId?: string | null
    action?: string
    reason?: string
    scope?: JsonValue
    expiresAt?: string | null
    requestedByMuseId?: string | null
  } = {},
): ApprovalRecord {
  return fx.store.createApproval({
    projectId: fx.projectId,
    runId: patch.runId ?? null,
    taskId: null,
    requestedByMuseId: patch.requestedByMuseId === undefined ? 'manager' : patch.requestedByMuseId,
    action: patch.action ?? 'net.egress',
    reason: patch.reason ?? 'the worker wants to reach the network',
    scope: patch.scope ?? {},
    ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
  })
}

/** Project-wide event lookup (approvals without a run still record events). */
function projectEvents(fx: Fixture, type: string): EventRecord[] {
  return fx.store.eventsSince(fx.projectId, 0, 500).filter((e) => e.type === type)
}

function pastIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

describe('approval text terminal boundary (raw CLI output)', () => {
  it('prints legacy rows without terminal control bytes', () => {
    const fx = makeProject()
    // Simulate a row persisted before the storage sanitizer existed: raw SQL,
    // bypassing createApproval. The CLI must still never emit driver bytes.
    fx.store.db
      .prepare(
        `INSERT INTO approvals (id, project_id, run_id, task_id, requested_by_muse_id, action, reason, scope_json,
                                 status, decided_by, decided_at, expires_at, created_at)
         VALUES ('approval_legacy_esc', ?, NULL, NULL, 'manager', ?, ?, '{}', 'pending', NULL, NULL, NULL, ?)`,
      )
      .run(fx.projectId, 'action\u001b[2Jspoof', 'reason \u001b[31mred\u202ereversed', new Date().toISOString())

    const stdout = execFileSync('node', [join(process.cwd(), 'src', 'cli', 'main.ts'), 'approvals', 'list'], {
      cwd: fx.dir,
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env },
    })

    // Readable text survives; escape/control bytes do not.
    expect(stdout).toContain('spoof')
    expect(stdout).toContain('reversed')
    expect(stdout.replace(/\n/g, '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/)
  }, 120_000)
})

describe('listApprovals — inbox listing and the expiry sweep', () => {
  it('lists pending only by default, --all includes decided, and counts span the project', async () => {
    const fx = makeProject()
    const p1 = seedApproval(fx, { action: 'a.one' })
    const p2 = seedApproval(fx, { action: 'a.two' })
    const decided = seedApproval(fx, { action: 'a.three' })
    fx.store.setApprovalStatus(decided.id, 'denied', { decidedBy: 'operator' })

    const view = await listApprovals(fx.ctx, {})

    expect(view.approvals.map((a) => a.id).sort()).toEqual([p1.id, p2.id].sort())
    expect(view.counts).toEqual({ pending: 2, approved: 0, denied: 1, expired: 0 })
    const row = view.approvals.find((a) => a.id === p1.id)
    expect(row).toMatchObject({
      action: 'a.one',
      status: 'pending',
      runId: null,
      requestedByMuseId: 'manager',
      decidedAt: null,
      decidedBy: null,
      expiresAt: null,
      expiresInMinutes: null,
    })
    expect(row?.ageMinutes).toBeGreaterThanOrEqual(0)

    const all = await listApprovals(fx.ctx, { all: true })
    expect(all.approvals).toHaveLength(3)
    expect(all.approvals.map((a) => a.status).sort()).toEqual(['denied', 'pending', 'pending'])
    expect(all.counts).toEqual({ pending: 2, approved: 0, denied: 1, expired: 0 })
  })

  it('sweeps overdue pendings to expired (fail-closed) once, records an event and hides them from the default list', async () => {
    const fx = makeProject()
    const overdue = seedApproval(fx, { action: 'timeout.me', expiresAt: pastIso(5) })
    const future = seedApproval(fx, { action: 'still.pending', expiresAt: futureIso(60) })
    const never = seedApproval(fx, { action: 'never.expires' })

    const view = await listApprovals(fx.ctx, {})

    expect(view.approvals.map((a) => a.id).sort()).toEqual([future.id, never.id].sort())
    expect(view.counts).toEqual({ pending: 2, approved: 0, denied: 0, expired: 1 })
    const pendingRow = view.approvals.find((a) => a.id === future.id)
    expect(pendingRow?.expiresInMinutes).not.toBeNull()
    expect(pendingRow?.expiresInMinutes ?? 0).toBeGreaterThanOrEqual(58)
    expect(pendingRow?.expiresInMinutes ?? 0).toBeLessThanOrEqual(60)

    const swept = fx.store.getApproval(overdue.id)
    expect(swept.status).toBe('expired')
    expect(swept.decidedBy).toBe('pluton:timeout')
    expect(swept.decidedAt).not.toBeNull()

    const events = projectEvents(fx, 'approval.expired')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ approvalId: overdue.id, action: 'timeout.me' })
    expect(events[0]?.runId).toBeNull()

    // Idempotent: a second pass sweeps nothing and records no second event.
    const again = await listApprovals(fx.ctx, { all: true })
    expect(again.counts).toEqual({ pending: 2, approved: 0, denied: 0, expired: 1 })
    expect(projectEvents(fx, 'approval.expired')).toHaveLength(1)
  })

  it('filters by run when --run is given', async () => {
    const fx = makeProject()
    const run1 = seedRun(fx)
    const run2 = seedRun(fx)
    const a1 = seedApproval(fx, { runId: run1.id })
    seedApproval(fx, { runId: run2.id })

    const view = await listApprovals(fx.ctx, { runRef: run1.id })

    expect(view.approvals.map((a) => a.id)).toEqual([a1.id])
    // Counts stay project-wide even when the list is filtered.
    expect(view.counts.pending).toBe(2)
  })
})

describe('decideApproval — approve and deny', () => {
  it('approves, stamps the operator, records the event and resolves unique id suffixes', async () => {
    const fx = makeProject()
    const approval = seedApproval(fx, { action: 'net.egress' })

    const report = await decideApproval(fx.ctx, { approvalRef: approval.id.slice(-8), decision: 'approve' })

    expect(report.approval).toMatchObject({
      id: approval.id,
      action: 'net.egress',
      status: 'approved',
      decidedBy: 'operator',
    })
    expect(report.approval.decidedAt).toBe(fx.store.getApproval(approval.id).decidedAt)
    expect(report.applied).toBeNull()
    expect(report.run).toBeNull()
    expect(report.expiredSwept).toEqual([])

    const row = fx.store.getApproval(approval.id)
    expect(row.status).toBe('approved')
    expect(row.decidedBy).toBe('operator')
    expect(row.decidedAt).not.toBeNull()

    const events = projectEvents(fx, 'approval.decided')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ approvalId: approval.id, action: 'net.egress', status: 'approved' })
  })

  it('denies without inventing anything, and a second decide on the same approval conflicts', async () => {
    const fx = makeProject()
    const approval = seedApproval(fx, { action: 'destructive.op' })

    const report = await decideApproval(fx.ctx, { approvalRef: approval.id, decision: 'deny' })
    expect(report.approval.status).toBe('denied')
    expect(fx.store.getApproval(approval.id).status).toBe('denied')

    await expect(decideApproval(fx.ctx, { approvalRef: approval.id, decision: 'approve' })).rejects.toThrowError(
      ConflictError,
    )
    await expect(decideApproval(fx.ctx, { approvalRef: approval.id, decision: 'approve' })).rejects.toThrowError(
      /already denied/,
    )
  })

  it('sweeps an overdue target to expired first, then refuses to decide it with a ConflictError', async () => {
    const fx = makeProject()
    const overdue = seedApproval(fx, { action: 'too.slow', expiresAt: pastIso(1) })

    await expect(decideApproval(fx.ctx, { approvalRef: overdue.id, decision: 'approve' })).rejects.toThrowError(
      ConflictError,
    )
    await expect(decideApproval(fx.ctx, { approvalRef: overdue.id, decision: 'approve' })).rejects.toThrowError(
      /already expired/,
    )

    expect(fx.store.getApproval(overdue.id).status).toBe('expired')
    expect(projectEvents(fx, 'approval.expired')).toHaveLength(1)
    expect(projectEvents(fx, 'approval.decided')).toHaveLength(0)
  })

  it('refuses an unknown approval ref with NotFoundError', async () => {
    const fx = makeProject()
    await expect(decideApproval(fx.ctx, { approvalRef: 'approval_nope', decision: 'approve' })).rejects.toThrowError(
      NotFoundError,
    )
  })
})

describe('decideApproval — approved muse.create proposals are applied', () => {
  it('host mode without a live run: pluton.yaml gains the Muse, the store syncs it, nothing is provisioned', async () => {
    registerBuiltinEngines()
    const fx = makeProject(HOST_CONFIG)
    const approval = seedApproval(fx, {
      action: 'muse.create',
      reason: 'need a database specialist',
      scope: {
        museId: 'db-expert',
        displayName: 'DB Expert',
        role: 'coder',
        engine: 'mock',
        model: 'mock/model-a',
      },
    })

    const report = await decideApproval(fx.ctx, { approvalRef: approval.id, decision: 'approve' })

    expect(report.approval.status).toBe('approved')
    expect(report.applied).toMatchObject({
      museId: 'db-expert',
      configPath: fx.ctx.configPath,
      container: null,
      containerWarning: null,
    })

    const reloaded = loadConfig(fx.dir)
    expect(reloaded.config.muses['db-expert']).toMatchObject({
      display_name: 'DB Expert',
      role: 'coder',
      engine: 'mock',
      model: 'mock/model-a',
      workspace_policy: 'isolated-task-checkout',
    })
    const museRow = fx.store.getMuse('db-expert')
    expect(museRow?.enabled).toBe(true)
    expect(museRow?.engineHome).toBe(join(engineHomesDir(fx.dir), 'db-expert'))

    const events = projectEvents(fx, 'muse.applied_from_proposal')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ approvalId: approval.id, museId: 'db-expert' })
  })

  it('denying a muse.create proposal leaves the config and the store untouched', async () => {
    registerBuiltinEngines()
    const fx = makeProject(HOST_CONFIG)
    const approval = seedApproval(fx, {
      action: 'muse.create',
      scope: {
        museId: 'ghost',
        displayName: 'Ghost',
        role: 'researcher',
        engine: 'mock',
        model: 'mock/model-a',
      },
    })

    const report = await decideApproval(fx.ctx, { approvalRef: approval.id, decision: 'deny' })

    expect(report.applied).toBeNull()
    expect(loadConfig(fx.dir).config.muses['ghost']).toBeUndefined()
    expect(fx.store.getMuse('ghost')).toBeNull()
    expect(projectEvents(fx, 'muse.applied_from_proposal')).toHaveLength(0)
  })

  it('a malformed muse.create scope fails loudly after the decision (apply failures are never silent)', async () => {
    registerBuiltinEngines()
    const fx = makeProject(HOST_CONFIG)
    const approval = seedApproval(fx, { action: 'muse.create', scope: { museId: 'broken' } })

    await expect(decideApproval(fx.ctx, { approvalRef: approval.id, decision: 'approve' })).rejects.toThrowError(
      ValidationError,
    )
    // The decision itself stands; the apply failure is loud and leaves no half-made muse.
    expect(fx.store.getApproval(approval.id).status).toBe('approved')
    expect(loadConfig(fx.dir).config.muses['broken']).toBeUndefined()
  })

  it('docker mode with a live run provisions the specialist container through the shared helper', async () => {
    registerBuiltinEngines()
    const fx = makeProject()
    const run = seedRun(fx, 'active')
    const approval = seedApproval(fx, {
      runId: run.id,
      action: 'muse.create',
      scope: {
        museId: 'db-expert',
        displayName: 'DB Expert',
        role: 'coder',
        engine: 'mock',
        model: 'mock/model-a',
      },
    })
    const fakeSandbox = new FakeSandbox()
    fakeSandbox.statusResult = 'missing'

    const report = await decideApproval(
      fx.ctx,
      { approvalRef: approval.id, decision: 'approve' },
      { sandboxManager: fakeSandbox, workerImageProbe: () => Promise.resolve(enginesImageProbe()) },
    )

    const containerName = sandboxContainerName(fx.projectId, 'db-expert')
    expect(report.applied?.container).toEqual({ containerName, created: true })
    expect(report.applied?.containerWarning).toBeNull()
    expect(fakeSandbox.created).toHaveLength(1)
    expect(fakeSandbox.created[0]?.containerName).toBe(containerName)
    expect(fakeSandbox.created[0]?.image).toBe(DEFAULT_WORKER_IMAGE_TAG)
    const sandboxRow = fx.store.getSandboxForMuse(fx.projectId, 'db-expert')
    expect(sandboxRow?.state).toBe('running')
    expect(sandboxRow?.containerName).toBe(containerName)
    expect(report.run).toMatchObject({
      id: run.id,
      stateBefore: 'active',
      stateAfter: 'active',
      resumed: false,
      parked: false,
      recordedOutcome: null,
    })
    // The muse itself is durable either way.
    expect(fx.store.getMuse('db-expert')?.enabled).toBe(true)
  })

  it('an unreachable sandbox surfaces a container warning, never a failed decision', async () => {
    registerBuiltinEngines()
    const fx = makeProject()
    const run = seedRun(fx, 'awaiting_approval')
    const approval = seedApproval(fx, {
      runId: run.id,
      action: 'muse.create',
      scope: {
        museId: 'db-expert',
        displayName: 'DB Expert',
        role: 'coder',
        engine: 'mock',
        model: 'mock/model-a',
      },
    })
    const fakeSandbox = new FakeSandbox()
    fakeSandbox.probeResult = {
      available: false,
      kind: 'docker',
      detail: 'docker daemon not reachable: fixture',
      fix: 'start Docker Desktop',
    }

    const report = await decideApproval(
      fx.ctx,
      { approvalRef: approval.id, decision: 'approve' },
      { sandboxManager: fakeSandbox, workerImageProbe: () => Promise.resolve(enginesImageProbe()) },
    )

    expect(report.approval.status).toBe('approved')
    expect(report.applied?.container).toBeNull()
    expect(report.applied?.containerWarning).toContain('daemon not reachable')
    expect(fakeSandbox.created).toHaveLength(0)
    expect(fx.store.getMuse('db-expert')?.enabled).toBe(true)
  })
})

describe('decideApproval — run un-parking', () => {
  it('keeps the run parked while other approvals are pending, then resumes it after the last one', async () => {
    const fx = makeProject()
    const run = seedRun(fx, 'awaiting_approval')
    const a1 = seedApproval(fx, { runId: run.id, action: 'first' })
    const a2 = seedApproval(fx, { runId: run.id, action: 'second' })

    const first = await decideApproval(fx.ctx, { approvalRef: a1.id, decision: 'approve' })
    expect(first.run).toMatchObject({
      id: run.id,
      stateBefore: 'awaiting_approval',
      stateAfter: 'awaiting_approval',
      resumed: false,
      parked: false,
      recordedOutcome: null,
    })
    expect(fx.store.getRun(run.id).state).toBe('awaiting_approval')

    const second = await decideApproval(fx.ctx, { approvalRef: a2.id, decision: 'deny' })
    expect(second.run).toMatchObject({ stateBefore: 'awaiting_approval', stateAfter: 'active', resumed: true, parked: false })
    expect(fx.store.getRun(run.id).state).toBe('active')
    expect(fx.store.listEvents(run.id, { type: 'run.resumed_after_approval' })).toHaveLength(1)
  })

  it('never re-drives an exited supervisor: a recorded run.finished parks the run and surfaces its outcome', async () => {
    const fx = makeProject()
    const run = seedRun(fx, 'awaiting_approval')
    fx.store.appendEvent({
      projectId: fx.projectId,
      runId: run.id,
      type: 'run.finished',
      payload: { outcome: 'pending_verification', state: 'awaiting_approval' },
    })
    const approval = seedApproval(fx, { runId: run.id, action: 'sensitive.op' })

    const report = await decideApproval(fx.ctx, { approvalRef: approval.id, decision: 'approve' })

    expect(report.run).toMatchObject({
      id: run.id,
      stateBefore: 'awaiting_approval',
      stateAfter: 'awaiting_approval',
      resumed: false,
      parked: true,
      recordedOutcome: 'pending_verification',
    })
    expect(fx.store.getRun(run.id).state).toBe('awaiting_approval')
    expect(fx.store.listEvents(run.id, { type: 'run.resumed_after_approval' })).toHaveLength(0)
  })
})

describe('decideApproval — --request-id idempotency', () => {
  it('an identical retry returns the settled report without a second decision or event', async () => {
    const fx = makeProject()
    const approval = seedApproval(fx, { action: 'net.egress' })

    const first = await decideApproval(fx.ctx, {
      approvalRef: approval.id,
      decision: 'approve',
      requestId: 'req-approvals-1',
    })
    const retry = await decideApproval(fx.ctx, {
      approvalRef: approval.id,
      decision: 'approve',
      requestId: 'req-approvals-1',
    })

    expect(first.approval.status).toBe('approved')
    expect(retry.approval).toMatchObject({ id: approval.id, status: 'approved', decidedBy: 'operator' })
    expect(retry.approval.decidedAt).toBe(first.approval.decidedAt)
    expect(projectEvents(fx, 'approval.decided')).toHaveLength(1)
    expect(fx.store.getApproval(approval.id).status).toBe('approved')
  })

  it('reusing the same request id with a different decision conflicts', async () => {
    const fx = makeProject()
    const approval = seedApproval(fx, { action: 'net.egress' })

    await decideApproval(fx.ctx, { approvalRef: approval.id, decision: 'approve', requestId: 'req-approvals-2' })

    await expect(
      decideApproval(fx.ctx, { approvalRef: approval.id, decision: 'deny', requestId: 'req-approvals-2' }),
    ).rejects.toThrowError(ConflictError)
    expect(projectEvents(fx, 'approval.decided')).toHaveLength(1)
  })
})
