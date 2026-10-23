import { mkdirSync } from 'node:fs'
import { bootstrapStore, shipSpecs } from '../../bootstrap.ts'
import { loadConfig, workspaceDir } from '../../config/load.ts'
import {
  ConflictError,
  InternalError,
  NotFoundError,
  SandboxUnavailableError,
  StateTransitionError,
  ValidationError,
} from '../../domain/errors.ts'
import type {
  ApprovalRecord,
  ApprovalStatus,
  EventRecord,
  JsonValue,
  ShipRecord,
  RunRecord,
} from '../../domain/models.ts'
import { isTerminalRunState, type RunState } from '../../domain/state.ts'
import { settleApprovalWaiter } from '../../engines/interactive-approval.ts'
import { createSandboxManager } from '../../sandbox/factory.ts'
import {
  DEFAULT_WORKER_IMAGE_TAG,
  dispatchReadiness,
  WorkerImageManager,
  type WorkerImageProbe,
} from '../../sandbox/image.ts'
import type { SandboxManager } from '../../sandbox/types.ts'
import type { Store } from '../../store/store.ts'
import type { ProjectContext } from '../context.ts'
import { createShip } from './muse.ts'
import { provisionShipContainer } from './muse-provision.ts'
import { runByRef } from './status.ts'
import { approvalScopeTaskId, integrateRun, type IntegrateCommandOptions, type IntegrateReport } from './integrate.ts'
import { resumeRun, type ResumeRunOptions, type RunSummary } from './run.ts'

/**
 * The operator approvals inbox (Phase 3): `list` (pending by default, project
 * scoped) and `approve`/`deny` decisions.
 *
 * Fail-closed expiry: every invocation sweeps overdue pendings to `expired`
 * (decided_by `pluton:timeout`) before reading or deciding, so a timeout can
 * never be mistaken for an approval and an expired row is refused with a
 * ConflictError. Decisions are recorded as events; approving a `ship.create`
 * proposal actually instantiates the specialist (pluton.yaml + store sync +
 * container provisioning against a live docker-mode run — a sandbox that
 * cannot come up is surfaced as a warning, never as a failed decision). When a
 * run parked in `awaiting_approval` loses its last pending approval it is
 * resumed only while its supervisor is still driving (no `run.finished`
 * recorded); otherwise it stays parked and the recorded outcome is surfaced.
 */

export interface ApprovalListOptions {
  /** Include decided (approved/denied/expired) rows; default = pending only. */
  all?: boolean
  /** Only approvals of this run (full id or unique suffix). */
  runRef?: string
}

export interface ApprovalListView {
  approvals: {
    id: string
    action: string
    status: ApprovalStatus
    runId: string | null
    taskId: string | null
    requestedByShipId: string | null
    /** @deprecated Use `requestedByShipId`; kept for backward compatibility. */
    requestedByMuseId?: string | null
    reason: string
    scope: JsonValue
    createdAt: string
    expiresAt: string | null
    decidedAt: string | null
    decidedBy: string | null
    ageMinutes: number
    expiresInMinutes: number | null
  }[]
  counts: Record<ApprovalStatus, number>
}

export interface ApprovalDecideOptions {
  /** Full approval id or a unique id suffix. */
  approvalRef: string
  decision: 'approve' | 'deny'
  /** Idempotency key: retrying with the same id never decides twice. */
  requestId?: string
  /** Automatically continue execution (e.g. run integration for integration.apply, or resume unparked run). */
  autoContinue?: boolean
}

export interface ApprovalDecideDeps {
  /** Test seam: replaces the Docker sandbox manager in docker mode. */
  sandboxManager?: SandboxManager
  /** Test seam: replaces the worker-image probe in docker mode. */
  workerImageProbe?: (rootDir: string) => Promise<WorkerImageProbe>
  /** Test seam: replaces integrateRun for auto-continue integration.apply. */
  integrateRunFn?: (ctx: ProjectContext, opts: IntegrateCommandOptions) => Promise<IntegrateReport>
  /** Test seam: replaces resumeRun for auto-continue run resume. */
  resumeRunFn?: (ctx: ProjectContext, runId: string, opts?: ResumeRunOptions) => Promise<RunSummary>
}

export interface ApprovalDecideReport {
  approval: { id: string; action: string; status: 'approved' | 'denied'; decidedBy: string; decidedAt: string }
  applied: {
    shipId: string
    /** @deprecated Use `shipId`; kept for backward compatibility. */
    museId?: string
    configPath: string
    container: { containerName: string; created: boolean } | null
    containerWarning: string | null
  } | null
  integrationReport: IntegrateReport | null
  run: {
    id: string
    stateBefore: RunState
    stateAfter: RunState
    resumed: boolean
    parked: boolean
    recordedOutcome: string | null
    resumeSummary?: RunSummary | null
  } | null
  expiredSwept: string[]
}

/** The project's pending approvals whose expiry has arrived, flipped + evented. */
export function sweepExpiredApprovals(store: Store, projectId: string, nowIso: string): ApprovalRecord[] {
  const swept = store.expirePendingApprovals(nowIso, projectId)
  for (const row of swept) {
    store.appendEvent({
      projectId,
      runId: row.runId,
      taskId: row.taskId,
      type: 'approval.expired',
      payload: { approvalId: row.id, action: row.action, expiresAt: row.expiresAt },
    })
    // An engine session may be waiting on this request; expiry is fail-closed.
    settleApprovalWaiter(row.id, 'expired', 'expiry')
  }
  return swept
}

function toView(record: ApprovalRecord, nowMs: number): ApprovalListView['approvals'][number] {
  return {
    id: record.id,
    action: record.action,
    status: record.status,
    runId: record.runId,
    taskId: record.taskId,
    requestedByShipId: record.requestedByShipId,
    requestedByMuseId: record.requestedByShipId,
    reason: record.reason,
    scope: record.scope,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    decidedAt: record.decidedAt,
    decidedBy: record.decidedBy,
    ageMinutes: Math.max(0, Math.floor((nowMs - Date.parse(record.createdAt)) / 60_000)),
    expiresInMinutes:
      record.expiresAt === null ? null : Math.round((Date.parse(record.expiresAt) - nowMs) / 60_000),
  }
}

export async function listApprovals(ctx: ProjectContext, opts: ApprovalListOptions): Promise<ApprovalListView> {
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const now = new Date().toISOString()
    sweepExpiredApprovals(store, projectId, now)

    let runId: string | null = null
    if (opts.runRef !== undefined) runId = runByRef(store, opts.runRef).id

    const rows = store.listApprovalsByProject(
      projectId,
      opts.all === true ? { limit: 1_000 } : { status: 'pending', limit: 1_000 },
    )
    const counts: Record<ApprovalStatus, number> = { pending: 0, approved: 0, denied: 0, expired: 0 }
    for (const record of store.listApprovalsByProject(projectId, { limit: 1_000 })) counts[record.status] += 1

    const nowMs = Date.parse(now)
    return {
      approvals: rows
        .filter((record) => runId === null || record.runId === runId)
        .map((record) => toView(record, nowMs)),
      counts,
    }
  } finally {
    store.close()
  }
}

function resolveApprovalByRef(store: Store, projectId: string, ref: string): ApprovalRecord {
  const exact = store.getApprovalOrNull(ref)
  if (exact !== null) {
    if (exact.projectId !== projectId) throw new NotFoundError('approval', ref)
    return exact
  }
  const matches = store.listApprovalsByProject(projectId, { limit: 1_000 }).filter((a) => a.id.endsWith(ref))
  if (matches.length === 1) return matches[0] as ApprovalRecord
  if (matches.length === 0) throw new NotFoundError('approval', ref)
  throw new ConflictError(`ambiguous approval id: ${matches.length} approvals end with '${ref}'; use the full id`, {
    ref,
  })
}

/** Strict `ship.create` scope reader — the key set the `ship.propose_create` (or deprecated `muse.propose_create`) handler records. */
function parseShipCreateScope(approval: ApprovalRecord): {
  shipId: string
  displayName: string
  role: string
  engine: string
  model: string
} {
  const record =
    approval.scope !== null && typeof approval.scope === 'object' && !Array.isArray(approval.scope)
      ? (approval.scope as Record<string, JsonValue>)
      : null
  if (record === null) {
    throw new ValidationError(
      `approval ${approval.id} has a malformed ship.create scope: expected an object with shipId (or legacy museId), displayName, role, engine, model`,
    )
  }
  const field = (key: string): string => {
    const value = record[key]
    if (typeof value !== 'string' || value.length === 0) {
      throw new ValidationError(
        `approval ${approval.id} has a malformed ship.create scope: '${key}' must be a non-empty string`,
      )
    }
    return value
  }
  // Accept both shipId and the deprecated museId for backward compatibility
  const shipId = (record['shipId'] as string | undefined) ?? field('museId')
  return {
    shipId,
    displayName: field('displayName'),
    role: field('role'),
    engine: field('engine'),
    model: field('model'),
  }
}

/** Outcome recorded on the run's `run.finished` event, string-coerced (may be absent). */
function recordedOutcomeFrom(event: EventRecord | undefined): string | null {
  if (event === undefined) return null
  const payload = event.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const outcome = (payload as Record<string, JsonValue>)['outcome']
  return outcome === undefined || outcome === null ? null : String(outcome)
}

/**
 * Container readiness for an approved specialist, mirroring `prepareContainerMode`
 * (daemon probe → worker-image probe → `dispatchReadiness` with the engines
 * profile required → shared `provisionShipContainer`). Only ever called for a
 * live docker-mode run; callers turn `SandboxUnavailableError` into a warning.
 */
const CONTAINER_PIDS_LIMIT = 512

async function provisionApprovedShip(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  ship: ShipRecord,
  deps: ApprovalDecideDeps,
): Promise<{ containerName: string; created: boolean }> {
  const config = ctx.loaded.config
  const manager = deps.sandboxManager ?? createSandboxManager(config)
  const probe = await manager.probe()
  if (!probe.available) {
    throw new SandboxUnavailableError(
      `container-mode provisioning needs a reachable sandbox: ${probe.detail}`,
      { fix: probe.fix },
    )
  }
  const imageTag = config.sandbox.image ?? DEFAULT_WORKER_IMAGE_TAG
  const imageProbe =
    deps.workerImageProbe !== undefined
      ? await deps.workerImageProbe(ctx.rootDir)
      : await new WorkerImageManager().probe(ctx.rootDir, imageTag)
  const readiness = dispatchReadiness(true, imageProbe, { requireEngines: true })
  if (!readiness.ready) {
    throw new SandboxUnavailableError(
      `worker image '${imageTag}' is not ready for container-mode runs:\n  - ${readiness.warnings.join('\n  - ')}`,
    )
  }
  const runtime = config.runtime
  const shipConfig = config.ships[ship.id]
  const networkPolicy = shipConfig?.network_policy ?? runtime.network_policy
  const customNetwork =
    networkPolicy === 'restricted' && runtime.internal_network_name !== undefined
      ? runtime.internal_network_name
      : undefined
  return provisionShipContainer({
    manager,
    store,
    projectId,
    ship,
    image: imageTag,
    ...(imageProbe.imageId !== null ? { imageId: imageProbe.imageId } : {}),
    limits: {
      cpus: runtime.default_cpu_limit,
      memoryMb: runtime.default_memory_mb,
      pids: CONTAINER_PIDS_LIMIT,
    },
    network: networkPolicy,
    ...(customNetwork !== undefined ? { customNetwork } : {}),
    rootDir: ctx.rootDir,
    workspacesRoot: workspaceDir(ctx.rootDir),
  })
}

/**
 * Instantiate an approved `ship.create` proposal: pluton.yaml first (validated
 * before the file is touched), then the store sync, then — only for a live
 * docker-mode run — the specialist's container.
 */
async function applyShipCreate(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  approval: ApprovalRecord,
  runBefore: RunRecord | null,
  deps: ApprovalDecideDeps,
): Promise<NonNullable<ApprovalDecideReport['applied']>> {
  const scope = parseShipCreateScope(approval)
  const created = createShip(ctx, {
    id: scope.shipId,
    displayName: scope.displayName,
    role: scope.role,
    engine: scope.engine,
    model: scope.model,
  })
  const reloaded = loadConfig(ctx.rootDir)
  store.syncShips(projectId, shipSpecs(reloaded))
  const ship = store.getShip(scope.shipId)
  if (ship === null) {
    throw new InternalError(`approved ship '${scope.shipId}' disappeared after syncing the store`)
  }
  // Engine homes are computed, never created, by the bootstrap/config path:
  // materialize the directory so the container mount has a real host path.
  mkdirSync(ship.engineHome, { recursive: true })
  const isLegacyMuse = approval.action === 'muse.create'
  store.appendEvent({
    projectId,
    runId: approval.runId,
    type: isLegacyMuse ? 'muse.applied_from_proposal' : 'ship.applied_from_proposal',
    payload: {
      approvalId: approval.id,
      shipId: scope.shipId,
      museId: scope.shipId,
      engine: scope.engine,
      configPath: created.configPath,
    },
  })

  let container: { containerName: string; created: boolean } | null = null
  let containerWarning: string | null = null
  const runState = runBefore?.state ?? null
  const liveRun =
    runState === 'active' || runState === 'awaiting_approval' || runState === 'awaiting_input'
  if (approval.runId !== null && ctx.loaded.config.sandbox.kind === 'docker' && liveRun) {
    try {
      container = await provisionApprovedShip(ctx, store, projectId, ship, deps)
    } catch (e) {
      if (!(e instanceof SandboxUnavailableError)) throw e
      // The decision stands; the next `pluton run` provisions enabled config
      // ships anyway, so a down sandbox is a warning here, not a failure.
      containerWarning = e.message
    }
  }
  return { shipId: scope.shipId, museId: scope.shipId, configPath: created.configPath, container, containerWarning }
}

/** Un-park a run whose last pending approval was just decided (never re-drives an exited supervisor). */
function unParkRun(
  store: Store,
  projectId: string,
  approval: ApprovalRecord,
  runBefore: RunRecord,
): NonNullable<ApprovalDecideReport['run']> {
  const stateBefore = runBefore.state
  let stateAfter = stateBefore
  let resumed = false
  let parked = false
  let recordedOutcome: string | null = null
  if (stateBefore === 'awaiting_approval') {
    const stillPending = store.listApprovals(runBefore.id).some((a) => a.status === 'pending')
    if (!stillPending) {
      const finished = store.listEvents(runBefore.id, { type: 'run.finished', limit: 1 })
      if (finished.length === 0) {
        try {
          stateAfter = store.setRunState(runBefore.id, 'active').state
          resumed = true
          store.appendEvent({
            projectId,
            runId: runBefore.id,
            type: 'run.resumed_after_approval',
            payload: { approvalId: approval.id },
          })
        } catch (e) {
          // A concurrent terminal write (e.g. a cancel) won the un-park CAS:
          // adopt the durable winner — the run did not resume, and no
          // `run.resumed_after_approval` is minted for a run that is over.
          if (!(e instanceof StateTransitionError)) throw e
          const fresh = store.getRun(runBefore.id)
          if (!isTerminalRunState(fresh.state)) throw e
          stateAfter = fresh.state
          const lateFinished = store.listEvents(runBefore.id, { type: 'run.finished', limit: 1 })
          if (lateFinished.length > 0) {
            parked = true
            recordedOutcome = recordedOutcomeFrom(lateFinished[0])
          }
        }
      } else {
        parked = true
        recordedOutcome = recordedOutcomeFrom(finished[0])
      }
    }
  }
  return { id: runBefore.id, stateBefore, stateAfter, resumed, parked, recordedOutcome }
}

/**
 * Rebuild a report from durable rows for a duplicate `--request-id` retry:
 * no mutation, no second event. Refuses loudly when the recorded request never
 * settled its approval.
 */
function reportFromCurrentRows(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  approvalId: string,
  expiredSwept: string[],
): ApprovalDecideReport {
  const current = store.getApproval(approvalId)
  if (current.status !== 'approved' && current.status !== 'denied') {
    throw new ConflictError(
      `approval ${current.id} is ${current.status}; the recorded decision request did not settle it`,
      { approvalId: current.id, status: current.status },
    )
  }
  let applied: ApprovalDecideReport['applied'] = null
  if ((current.action === 'ship.create' || current.action === 'muse.create') && current.status === 'approved') {
    const scope = parseShipCreateScope(current)
    const sandbox = store.getSandboxForShip(projectId, scope.shipId)
    applied = {
      shipId: scope.shipId,
      configPath: ctx.configPath,
      container:
        sandbox !== null && sandbox.containerName !== null
          ? { containerName: sandbox.containerName, created: false }
          : null,
      containerWarning: null,
    }
  }
  let run: ApprovalDecideReport['run'] = null
  if (current.runId !== null) {
    const record = store.getRun(current.runId)
    const stillPending = store.listApprovals(record.id).some((a) => a.status === 'pending')
    const finished = store.listEvents(record.id, { type: 'run.finished', limit: 1 })
    run = {
      id: record.id,
      stateBefore: record.state,
      stateAfter: record.state,
      resumed: false,
      parked: record.state === 'awaiting_approval' && !stillPending,
      recordedOutcome: recordedOutcomeFrom(finished[0]),
    }
  }
  return {
    approval: {
      id: current.id,
      action: current.action,
      status: current.status,
      decidedBy: current.decidedBy ?? 'operator',
      decidedAt: current.decidedAt ?? current.createdAt,
    },
    applied,
    integrationReport: null,
    run,
    expiredSwept,
  }
}

export async function decideApproval(
  ctx: ProjectContext,
  opts: ApprovalDecideOptions,
  deps: ApprovalDecideDeps = {},
): Promise<ApprovalDecideReport> {
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const now = new Date().toISOString()
    const expiredSwept = sweepExpiredApprovals(store, projectId, now).map((row) => row.id)

    const approval = resolveApprovalByRef(store, projectId, opts.approvalRef)

    // Admission runs before the pending check so an identical retry after a
    // successful decision returns the settled report instead of conflicting.
    if (opts.requestId !== undefined) {
      const admitted = store.admitRequest({
        requestId: opts.requestId,
        projectId,
        targetKind: 'approval.decide',
        payload: { approvalId: approval.id, decision: opts.decision },
        create: () => ({
          targetId: approval.id,
          result: { approvalId: approval.id, decision: opts.decision },
        }),
      })
      if (admitted.duplicate) {
        return reportFromCurrentRows(ctx, store, projectId, approval.id, expiredSwept)
      }
    }

    if (approval.status !== 'pending') {
      throw new ConflictError(`approval ${approval.id} is already ${approval.status}`, {
        approvalId: approval.id,
        status: approval.status,
      })
    }

    // Captured before the decision: the run state the decision applies against.
    const runBefore = approval.runId !== null ? store.getRun(approval.runId) : null

    const decided = store.setApprovalStatus(approval.id, opts.decision === 'approve' ? 'approved' : 'denied', {
      decidedBy: 'operator',
    })
    store.appendEvent({
      projectId,
      runId: approval.runId,
      taskId: approval.taskId,
      type: 'approval.decided',
      payload: { approvalId: approval.id, action: approval.action, status: decided.status },
    })
    // The durable decision is written; wake the engine session (if any) that
    // is waiting on this exact request. Exactly once, correlated by id.
    settleApprovalWaiter(decided.id, decided.status, 'decision')

    let applied: ApprovalDecideReport['applied'] = null
    if (decided.status === 'approved' && (decided.action === 'ship.create' || decided.action === 'muse.create')) {
      applied = await applyShipCreate(ctx, store, projectId, decided, runBefore, deps)
    }

    const run = runBefore !== null ? unParkRun(store, projectId, decided, runBefore) : null

    let integrationReport: IntegrateReport | null = null
    if (decided.status === 'approved' && decided.action === 'integration.apply' && opts.autoContinue) {
      const scopeTaskId = approvalScopeTaskId(decided.scope)
      if (decided.runId !== null && scopeTaskId !== null) {
        store.close()
        const integrateFn = deps.integrateRunFn ?? integrateRun
        integrationReport = await integrateFn(ctx, { runRef: decided.runId, taskRefs: [scopeTaskId] })
      }
    }

    if (run !== null && run.resumed && opts.autoContinue) {
      store.close()
      const resumeFn = deps.resumeRunFn ?? resumeRun
      try {
        run.resumeSummary = await resumeFn(ctx, run.id, { skipManager: true })
      } catch (e) {
        // A live supervisor may still own the run (the boundary case: the
        // process is alive but the operator decision un-parked the row). The
        // owner keeps driving; resume exists only for parked runs whose
        // process exited. A claim refusal is not an operator-facing error.
        if (e instanceof ConflictError && e.code === 'request_conflict') {
          run.resumeSummary = null
        } else {
          throw e
        }
      }
    }

    return {
      approval: {
        id: decided.id,
        action: decided.action,
        status: decided.status === 'approved' ? 'approved' : 'denied',
        decidedBy: decided.decidedBy ?? 'operator',
        decidedAt: decided.decidedAt ?? now,
      },
      applied,
      integrationReport,
      run,
      expiredSwept,
    }
  } finally {
    store.close()
  }
}
