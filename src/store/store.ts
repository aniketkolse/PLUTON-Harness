import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { ConflictError, InternalError, NotFoundError, OwnershipLostError, StateTransitionError, ValidationError } from '../domain/errors.ts'
import { newId } from '../domain/ids.ts'
import { type PlanRecord, type PlanState, type PlanTask, transitionPlanState } from '../domain/plan.ts'
import {
  assertRunTransition,
  assertTransition,
  isRunState,
  isTaskState,
  isTerminalRunState,
  SANDBOX_STATES,
  TERMINAL_TASK_STATES,
  type RunState,
  type SandboxState,
  type TaskState,
} from '../domain/state.ts'
import {
  APPROVAL_STATUSES,
  CHAT_MESSAGE_ROLES,
  CHAT_SESSION_STATES,
  EXECUTION_MODES,
  EXECUTION_NETWORK_POLICIES,
  SANDBOX_KINDS,
  SANDBOX_SESSION_STATES,
  type ApprovalRecord,
  type ApprovalStatus,
  type ChatMessageRecord,
  type ChatMessageRole,
  type ChatSessionRecord,
  type ChatSessionState,
  type EventRecord,
  type ExecutionMode,
  type ExecutionNetworkPolicy,
  type JsonValue,
  type ShipRecord,
  type ProjectRecord,
  type RequestReceiptRecord,
  type RequestTargetKind,
  type RunBudget,
  type RunRecord,
  type SandboxRecord,
  type SandboxSessionState,
  type TaskEdgeRecord,
  type TaskRecord,
  type TerminalRecord,
  type VerificationCheckRecord,
  type WorkspaceRecord,
} from '../domain/models.ts'
import { canonicalJson, payloadHash } from '../util/canonical.ts'
import { redactDeep } from '../util/redact.ts'
import { stripControlChars, stripControlDeep } from '../util/sanitize.ts'
import { withTx } from './db.ts'

/**
 * Durable store (ADR-0002/ADR-0006). All multi-write operations run inside one
 * BEGIN IMMEDIATE transaction, so receipts, state and events are committed
 * atomically: a crash either leaves everything or nothing.
 *
 * Rule enforced here (prompt Â§5): the store never invents success. Transitions
 * go through the domain state machine; unknown strings from the database are
 * `InternalError`, not silently coerced.
 */

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function str(row: Row, key: string): string {
  const v = row[key]
  if (typeof v !== 'string') throw new InternalError(`db row: expected string at '${key}', got ${typeof v}`)
  return v
}

function nstr(row: Row, key: string): string | null {
  const v = row[key]
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw new InternalError(`db row: expected string|null at '${key}', got ${typeof v}`)
  return v
}

function num(row: Row, key: string): number {
  const v = row[key]
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  throw new InternalError(`db row: expected number at '${key}', got ${typeof v}`)
}

function nnum(row: Row, key: string): number | null {
  const v = row[key]
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  throw new InternalError(`db row: expected number|null at '${key}', got ${typeof v}`)
}

function parseJsonText<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback
  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new InternalError(`db row: invalid JSON stored: ${(e as Error).message}`)
  }
}

function bool01(row: Row, key: string): boolean {
  const v = row[key]
  if (v === 0 || v === 0n) return false
  if (v === 1 || v === 1n) return true
  throw new InternalError(`db row: expected 0|1 at '${key}', got ${typeof v}`)
}

function nenum<T extends string>(row: Row, key: string, allowed: readonly T[], label: string): T | null {
  const value = nstr(row, key)
  if (value === null) return null
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InternalError(`db row: invalid ${label} '${value}'`)
  }
  return value as T
}

function stringifyJson(v: unknown): string {
  const text = JSON.stringify(v)
  if (text === undefined) throw new InternalError('cannot serialize undefined to JSON')
  return text
}

const nowIso = (): string => new Date().toISOString()

/**
 * `EXISTS` fragment appended to a fenced statement's WHERE (or used as an
 * INSERT ... SELECT's WHERE): it proves, inside the same statement, that the
 * `runs` row still carries the fence's supervisor token. A statement that
 * matches no row is therefore the durable proof that this process lost
 * ownership â€” no separate check, no read-modify-write window.
 */
function fenceClause(fence: SupervisorFence): { sql: string; params: [string, string] } {
  return {
    sql: 'EXISTS (SELECT 1 FROM runs WHERE id = ? AND supervisor_token = ?)',
    params: [fence.runId, fence.token],
  }
}

// ---------------------------------------------------------------------------
// Input specs
// ---------------------------------------------------------------------------

export interface NewProjectSpec {
  name: string
  rootPath: string
  configPath: string
  defaultBranch: string
}

export interface ShipSyncSpec {
  id: string
  slug: string
  displayName: string
  role: string
  engineKind: string
  model: string
  instructionsFile: string | null
  workspacePolicy: string
  permissions: string[]
  approvalMode: string
  engineHome: string
}

/** @deprecated Use `ShipSyncSpec`; kept for backward compatibility. */
export type MuseSyncSpec = ShipSyncSpec

export interface NewRunSpec {
  projectId: string
  goal: string
  origin: 'cli' | 'api'
  requestedBy: string
  acceptanceCriteria: string[]
  managerShipId?: string
  /** @deprecated Use `managerShipId`; kept for backward compatibility. */
  managerMuseId?: string
  budget: RunBudget
  /** Workspace the run operates on; omitted/NULL means the server project root. */
  workspaceRoot?: string | null
  /** Chat session that started the run (background work stays bound to it). */
  originSessionId?: string | null
}

export interface NewTaskSpec {
  id?: string
  runId: string
  parentTaskId?: string | null
  title: string
  brief: string
  acceptanceCriteria: string[]
  assigneeShipId?: string | null
  /** @deprecated Use `assigneeShipId`; kept for backward compatibility. */
  assigneeMuseId?: string | null
  writeScope?: string[]
}

export interface AppendEventInput {
  projectId: string
  runId?: string | null
  taskId?: string | null
  shipId?: string | null
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string | null
  type: string
  payload?: JsonValue
  /** Hard cap for the serialized payload (prompt Â§2.4 bounded payloads). */
  maxChars?: number
}

export interface AdmitRequestInput {
  requestId: string
  projectId: string
  targetKind: RequestTargetKind
  payload: JsonValue
  /** Runs inside the same transaction; returns the created target and bound result. */
  create: () => { targetId: string | null; result: JsonValue }
}

export interface AdmitResult {
  receipt: RequestReceiptRecord
  /** True when the same request id + identical payload was seen before. */
  duplicate: boolean
}

export interface NewWorkspaceSpec {
  projectId: string
  runId: string | null
  taskId: string | null
  shipId?: string | null
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string | null
  kind: WorkspaceRecord['kind']
  path: string
  branch: string
  baseCommit: string
}

export interface NewVerificationCheckSpec {
  projectId: string
  runId: string
  taskId: string | null
  name: string
  /** argv array â€” never a shell string. */
  command: string[]
  cwd: string | null
  workspaceId: string | null
}

export interface UpsertSandboxSpec {
  projectId: string
  shipId?: string | null
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string | null
  kind: SandboxRecord['kind']
  containerName: string | null
  containerId: string | null
  image: string | null
  state: SandboxState
  createdBy: string
  /** Defaults to true; a history row is inserted with `false` explicitly. */
  active?: boolean
  legacy?: boolean
  executionMode?: ExecutionMode | null
  networkPolicy?: ExecutionNetworkPolicy | null
  helperVersion?: string | null
  policy?: JsonValue | null
  sessionState?: SandboxSessionState | null
  lastSeenAt?: string | null
  exitCode?: number | null
  startedAt?: string | null
  endedAt?: string | null
}

export interface StartSandboxSessionSpec
  extends Omit<
    UpsertSandboxSpec,
    'active' | 'legacy' | 'executionMode' | 'networkPolicy' | 'sessionState' | 'startedAt'
  > {
  executionMode: ExecutionMode
  networkPolicy: ExecutionNetworkPolicy
  sessionState?: SandboxSessionState
  startedAt?: string
}

export interface UpsertTerminalSpec {
  projectId: string
  shipId?: string | null
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string | null
  sandboxId: string | null
  tmuxSessionName: string
  state: TerminalRecord['state']
}

export interface NewApprovalSpec {
  projectId: string
  runId: string | null
  taskId: string | null
  requestedByShipId?: string | null
  /** @deprecated Use `requestedByShipId`; kept for backward compatibility. */
  requestedByMuseId?: string | null
  action: string
  reason: string
  /** Bounded JSON scope: what exactly would happen if approved. */
  scope: JsonValue
  /** When the pending approval stops being actionable (null = never expires). */
  expiresAt?: string | null
}

const DEFAULT_MAX_EVENT_CHARS = 8_000

/** Hard cap for one persisted chat message; the tail is replaced by a marker. */
export const MAX_CHAT_MESSAGE_CHARS = 32_000

/**
 * A supervisor's run-ownership proof: `supervisor_token` on the run row must
 * still equal `token` or the fenced mutation is a no-op (throw or skip).
 */
export interface SupervisorFence {
  runId: string
  token: string
}

export interface SupervisorClaim {
  token: string
  /** True when this claim replaced an expired or NULL-heartbeat owner. */
  tookOver: boolean
  /** PID recorded before this claim (observability); null when previously unowned. */
  previousPid: number | null
}

/**
 * Patch shared by `setTaskState`/`setTaskStateIf`: `undefined` keeps the current
 * value, an explicit `null` clears it, anything else replaces it.
 */
export type TaskStatePatch = {
  attempt?: number
  result?: JsonValue | null
  failure?: JsonValue | null
  assignment?: JsonValue | null
  workspaceId?: string | null
  engineSessionId?: string | null
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  readonly db: DatabaseSync
  private closed = false

  constructor(db: DatabaseSync) {
    this.db = db
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  // -- project / ships -------------------------------------------------------

  ensureProject(spec: NewProjectSpec): ProjectRecord {
    const existing = this.db.prepare('SELECT * FROM projects WHERE root_path = ?').get(spec.rootPath) as Row | undefined
    if (existing) return rowToProject(existing)
    const now = nowIso()
    const id = newId('project')
    this.db
      .prepare(
        'INSERT INTO projects (id, name, root_path, config_path, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, spec.name, spec.rootPath, spec.configPath, spec.defaultBranch, now, now)
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new InternalError('project insert disappeared')
    return rowToProject(row)
  }

  getProjectByRoot(rootPath: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as Row | undefined
    return row ? rowToProject(row) : null
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return row ? rowToProject(row) : null
  }

  listShips(): ShipRecord[] {
    return (this.db.prepare('SELECT * FROM ships ORDER BY id').all() as Row[]).map(rowToShip)
  }

  getShip(id: string): ShipRecord | null {
    const row = this.db.prepare('SELECT * FROM ships WHERE id = ?').get(id) as Row | undefined
    return row ? rowToShip(row) : null
  }

  updateShipModel(id: string, model: string): void {
    const now = nowIso()
    const res = this.db.prepare('UPDATE ships SET model = ?, updated_at = ? WHERE id = ?').run(model, now, id)
    if (res.changes === 0) {
      throw new NotFoundError('ship', id)
    }
  }

  /** Upsert all configured ships; rows absent from the config are disabled (never deleted). */
  syncShips(projectId: string, specs: ShipSyncSpec[]): { upserted: number; disabled: number } {
    return withTx(this.db, () => {
      const now = nowIso()
      const upsert = this.db.prepare(
        `INSERT INTO ships (id, project_id, slug, display_name, role, engine_kind, model, instructions_file,
                            workspace_policy, permissions_json, approval_mode, engine_home, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           slug = excluded.slug,
           display_name = excluded.display_name,
           role = excluded.role,
           engine_kind = excluded.engine_kind,
           model = excluded.model,
           instructions_file = excluded.instructions_file,
           workspace_policy = excluded.workspace_policy,
           permissions_json = excluded.permissions_json,
           approval_mode = excluded.approval_mode,
           engine_home = excluded.engine_home,
           enabled = 1,
           updated_at = excluded.updated_at`,
      )
      for (const s of specs) {
        upsert.run(
          s.id,
          projectId,
          s.slug,
          s.displayName,
          s.role,
          s.engineKind,
          s.model,
          s.instructionsFile,
          s.workspacePolicy,
          stringifyJson(s.permissions),
          s.approvalMode,
          s.engineHome,
          now,
          now,
        )
      }
      let disabled = 0
      if (specs.length === 0) {
        const r = this.db.prepare('UPDATE ships SET enabled = 0, updated_at = ? WHERE enabled = 1').run(now)
        disabled = Number(r.changes)
      } else {
        const placeholders = specs.map(() => '?').join(',')
        const r = this.db
          .prepare(`UPDATE ships SET enabled = 0, updated_at = ? WHERE enabled = 1 AND id NOT IN (${placeholders})`)
          .run(now, ...specs.map((s) => s.id))
        disabled = Number(r.changes)
      }
      return { upserted: specs.length, disabled }
    })
  }

  /** @deprecated Use `listShips`; kept for backward compatibility. */
  listMuses(): ShipRecord[] {
    return this.listShips()
  }

  /** @deprecated Use `getShip`; kept for backward compatibility. */
  getMuse(id: string): ShipRecord | null {
    return this.getShip(id)
  }

  /** @deprecated Use `updateShipModel`; kept for backward compatibility. */
  updateMuseModel(id: string, model: string): void {
    this.updateShipModel(id, model)
  }

  /** @deprecated Use `syncShips`; kept for backward compatibility. */
  syncMuses(projectId: string, specs: ShipSyncSpec[]): { upserted: number; disabled: number } {
    return this.syncShips(projectId, specs)
  }

  /** @deprecated Use `getSandboxForShip`; kept for backward compatibility. */
  getSandboxForMuse(projectId: string, shipId: string | null): SandboxRecord | null {
    return this.getSandboxForShip(projectId, shipId)
  }

  /** @deprecated Use `getTerminalForShip`; kept for backward compatibility. */
  getTerminalForMuse(projectId: string, shipId: string): TerminalRecord | null {
    return this.getTerminalForShip(projectId, shipId)
  }

  // -- runs ------------------------------------------------------------------

  createRun(spec: NewRunSpec): RunRecord {
    const id = newId('run')
    const now = nowIso()
    const managerShipId = spec.managerShipId ?? spec.managerMuseId
    if (!managerShipId) throw new ValidationError('run requires managerShipId')
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, goal, origin, requested_by, state, acceptance_json, manager_ship_id,
                           budget_json, supervisor_pid, created_at, started_at, completed_at, final_summary,
                           workspace_root, origin_session_id)
         VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        spec.projectId,
        spec.goal,
        spec.origin,
        spec.requestedBy,
        stringifyJson(spec.acceptanceCriteria),
        managerShipId,
        stringifyJson(spec.budget),
        now,
        spec.workspaceRoot ?? null,
        spec.originSessionId ?? null,
      )
    return this.getRun(id)
  }

  getRun(id: string): RunRecord {
    const run = this.getRunOrNull(id)
    if (!run) throw new NotFoundError('run', id)
    return run
  }

  getRunOrNull(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined
    return row ? rowToRun(row) : null
  }

  listRuns(limit = 20): RunRecord[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as Row[]
    return rows.map(rowToRun)
  }

  // -- run supervisor ownership (fencing) ------------------------------------

  /**
   * Durable ownership of one run, enforced at the mutation boundary:
   * - Each claim/renew/release is ONE statement, so SQLite's writer
   *   serialization makes it atomic: two supervisors racing on the same run row
   *   can never both win, and a suspended owner cannot write after takeover.
   * - The `runs` row is the only authority. `supervisor_token` is the fencing
   *   token; the only way in is heartbeat expiry (or a NULL heartbeat).
   * - The boundary is intentional: unfenced writes are the control plane
   *   (operator/tool actions, routes, chat) â€” state-driven by design. Only
   *   supervisor duty paths pass a fence. On any doubt the claim fails closed.
   */

  /**
   * Claim the run for `pid`. Returns null â€” no waiting, no queueing â€” when a
   * live owner holds it: takeover is possible only once the previous heartbeat
   * is at or before `nowMs - ttlMs` (a NULL heartbeat counts as expired).
   */
  claimRunSupervisor(runId: string, opts: { pid: number; ttlMs: number; nowMs?: number }): SupervisorClaim | null {
    const previous = this.getRun(runId) // NotFoundError before any write
    const now = opts.nowMs ?? Date.now()
    const cutoff = now - opts.ttlMs
    const token = randomBytes(16).toString('hex')
    const res = this.db
      .prepare(
        `UPDATE runs SET supervisor_pid = ?, supervisor_token = ?, supervisor_heartbeat_at = ?
         WHERE id = ? AND (supervisor_token IS NULL OR supervisor_heartbeat_at IS NULL OR supervisor_heartbeat_at <= ?)`,
      )
      .run(opts.pid, token, now, runId, cutoff)
    if (Number(res.changes) !== 1) return null
    return { token, tookOver: previous.supervisorToken !== null, previousPid: previous.supervisorPid }
  }

  /** Heartbeat CAS: only the current token may advance its own heartbeat. */
  renewRunSupervisor(runId: string, token: string, nowMs?: number): boolean {
    const res = this.db
      .prepare('UPDATE runs SET supervisor_heartbeat_at = ? WHERE id = ? AND supervisor_token = ?')
      .run(nowMs ?? Date.now(), runId, token)
    return Number(res.changes) === 1
  }

  /** Clear the claim; an old owner's release can never clear the new owner's. */
  releaseRunSupervisor(runId: string, token: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE runs SET supervisor_pid = NULL, supervisor_token = NULL, supervisor_heartbeat_at = NULL
         WHERE id = ? AND supervisor_token = ?`,
      )
      .run(runId, token)
    return Number(res.changes) === 1
  }

  /**
   * Classification for the error path of a 0-row fenced CAS: the mutation was
   * atomically gated already, this re-read only decides throw-vs-null.
   */
  private assertFenceAtEnd(fence: SupervisorFence | undefined): void {
    if (!fence) return
    const row = this.db.prepare('SELECT supervisor_token FROM runs WHERE id = ?').get(fence.runId) as Row | undefined
    if (!row || nstr(row, 'supervisor_token') !== fence.token) throw new OwnershipLostError(fence.runId)
  }

  setRunState(
    id: string,
    to: RunState,
    patch: { supervisorPid?: number | null; finalSummary?: string | null } = {},
    fence?: SupervisorFence,
  ): RunRecord {
    const run = this.getRun(id)
    try {
      assertRunTransition(run.state, to)
    } catch (e) {
      // Fence-first classification (A-F4): a stale owner still reads its loss
      // when the pre-read also makes the requested transition illegal.
      this.assertFenceAtEnd(fence)
      throw e
    }
    const now = nowIso()
    const startedAt = run.startedAt ?? (to === 'active' ? now : null)
    const completedAt = isTerminalRunState(to) ? (run.completedAt ?? now) : run.completedAt
    const guard = fence ? fenceClause(fence) : null
    const res = this.db
      .prepare(
        `UPDATE runs SET state = ?, supervisor_pid = ?, started_at = ?, completed_at = ?, final_summary = ?
         WHERE id = ? AND state = ?${guard ? ` AND ${guard.sql}` : ''}`,
      )
      .run(
        to,
        patch.supervisorPid !== undefined ? patch.supervisorPid : run.supervisorPid,
        startedAt,
        completedAt,
        patch.finalSummary !== undefined ? patch.finalSummary : run.finalSummary,
        id,
        run.state,
        ...(guard ? guard.params : []),
      )
    if (Number(res.changes) !== 1) {
      // The pre-read state is repeated in the WHERE clause, so a control-plane
      // write that committed in between can never be resurrected. Fence first:
      // a stale owner's miss is ownership loss, not a state conflict.
      this.assertFenceAtEnd(fence)
      throw new StateTransitionError(run.state, to, 'run', `run '${id}': durable state changed concurrently`)
    }
    return this.getRun(id)
  }

  // -- tasks -----------------------------------------------------------------

  createTask(spec: NewTaskSpec): TaskRecord {
    const parent = spec.parentTaskId ? this.getTask(spec.parentTaskId) : null
    if (spec.parentTaskId && !parent) throw new NotFoundError('parent task', spec.parentTaskId)
    if (parent && parent.runId !== spec.runId) {
      throw new ValidationError(`parent task ${parent.id} belongs to run ${parent.runId}, not ${spec.runId}`)
    }
    const id = spec.id ?? newId('task')
    const now = nowIso()
    const assigneeShipId = spec.assigneeShipId !== undefined ? spec.assigneeShipId : (spec.assigneeMuseId ?? null)
    try {
      this.db
        .prepare(
          `INSERT INTO tasks (id, run_id, parent_task_id, root_task_id, depth, title, brief, acceptance_json,
                              write_scope_json, assignee_ship_id, state, attempt, workspace_id, engine_session_id,
                              result_json, failure_json, created_at, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', 0, NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
        )
        .run(
          id,
          spec.runId,
          spec.parentTaskId ?? null,
          parent ? parent.rootTaskId : id,
          parent ? parent.depth + 1 : 0,
          spec.title,
          spec.brief,
          stringifyJson(spec.acceptanceCriteria),
          stringifyJson(spec.writeScope ?? []),
          assigneeShipId,
          now,
        )
    } catch (e) {
      throw new ValidationError(`could not create task: ${(e as Error).message}`, { cause: e })
    }
    return this.getTask(id)
  }

  getTask(id: string): TaskRecord {
    const t = this.getTaskOrNull(id)
    if (!t) throw new NotFoundError('task', id)
    return t
  }

  getTaskOrNull(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined
    return row ? rowToTask(row) : null
  }

  listTasks(runId: string): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at ASC, id ASC')
      .all(runId) as Row[]
    return rows.map(rowToTask)
  }

  childCount(parentTaskId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?').get(parentTaskId) as Row
    return num(row, 'n')
  }

  setTaskState(id: string, to: TaskState, patch: TaskStatePatch = {}, fence?: SupervisorFence): TaskRecord {
    const task = this.getTask(id)
    try {
      assertTransition(task.state, to)
    } catch (e) {
      // Fence-first classification (A-F4): a stale owner still reads its loss
      // when the pre-read also makes the requested transition illegal.
      this.assertFenceAtEnd(fence)
      throw e
    }
    const now = nowIso()
    const startedAt = task.startedAt ?? (to === 'running' ? now : null)
    const completedAt = TERMINAL_TASK_STATES.has(to) ? (task.completedAt ?? now) : task.completedAt
    const guard = fence ? fenceClause(fence) : null
    const res = this.db
      .prepare(
        `UPDATE tasks SET state = ?, attempt = ?, workspace_id = ?, engine_session_id = ?,
                          result_json = ?, failure_json = ?, assignment_json = ?, started_at = ?, completed_at = ?
         WHERE id = ? AND state = ?${guard ? ` AND ${guard.sql}` : ''}`,
      )
      .run(
        to,
        patch.attempt !== undefined ? patch.attempt : task.attempt,
        patch.workspaceId !== undefined ? patch.workspaceId : task.workspaceId,
        patch.engineSessionId !== undefined ? patch.engineSessionId : task.engineSessionId,
        patch.result !== undefined ? (patch.result === null ? null : stringifyJson(patch.result)) : task.result === null ? null : stringifyJson(task.result),
        patch.failure !== undefined ? (patch.failure === null ? null : stringifyJson(patch.failure)) : task.failure === null ? null : stringifyJson(task.failure),
        patch.assignment !== undefined ? (patch.assignment === null ? null : stringifyJson(patch.assignment)) : task.assignment === null ? null : stringifyJson(task.assignment),
        startedAt,
        completedAt,
        id,
        task.state,
        ...(guard ? guard.params : []),
      )
    if (Number(res.changes) !== 1) {
      // The pre-read state is repeated in the WHERE clause, so a control-plane
      // write that committed in between can never be resurrected. Fence first:
      // a stale owner's miss is ownership loss, not a state conflict.
      this.assertFenceAtEnd(fence)
      throw new StateTransitionError(task.state, to, 'task', `task '${id}': durable state changed concurrently`)
    }
    return this.getTask(id)
  }

  /**
   * Compare-and-swap task transition: only moves when the task is currently in
   * `from`. A mismatch (a lost race â€” e.g. a repeated dispatch, or another
   * supervisor) returns null without throwing or mutating; an illegal `to`
   * transition from the matching state still throws. The UPDATE repeats the
   * expected state in its WHERE clause, so two claimants can never both win.
   * The CAS covers the state column only: timestamps and patch defaults are
   * still derived from the pre-update snapshot read above. With a fence, every
   * miss â€” pre-read mismatch or 0-row CAS â€” is classified against the run's
   * current token, so a stale owner throws instead of reading a silent null.
   */
  setTaskStateIf(
    id: string,
    from: TaskState,
    to: TaskState,
    patch: TaskStatePatch = {},
    fence?: SupervisorFence,
  ): TaskRecord | null {
    const task = this.getTask(id)
    if (task.state !== from) {
      // A pre-read mismatch is an ordinary CAS miss only while this process is
      // still the owner; a stale owner gets the durable loss signal.
      this.assertFenceAtEnd(fence)
      return null
    }
    assertTransition(from, to)
    const now = nowIso()
    const startedAt = task.startedAt ?? (to === 'running' ? now : null)
    const completedAt = TERMINAL_TASK_STATES.has(to) ? (task.completedAt ?? now) : task.completedAt
    const guard = fence ? fenceClause(fence) : null
    const res = this.db
      .prepare(
        `UPDATE tasks SET state = ?, attempt = ?, workspace_id = ?, engine_session_id = ?,
                          result_json = ?, failure_json = ?, assignment_json = ?, started_at = ?, completed_at = ?
         WHERE id = ? AND state = ?${guard ? ` AND ${guard.sql}` : ''}`,
      )
      .run(
        to,
        patch.attempt !== undefined ? patch.attempt : task.attempt,
        patch.workspaceId !== undefined ? patch.workspaceId : task.workspaceId,
        patch.engineSessionId !== undefined ? patch.engineSessionId : task.engineSessionId,
        patch.result !== undefined ? (patch.result === null ? null : stringifyJson(patch.result)) : task.result === null ? null : stringifyJson(task.result),
        patch.failure !== undefined ? (patch.failure === null ? null : stringifyJson(patch.failure)) : task.failure === null ? null : stringifyJson(task.failure),
        patch.assignment !== undefined ? (patch.assignment === null ? null : stringifyJson(patch.assignment)) : task.assignment === null ? null : stringifyJson(task.assignment),
        startedAt,
        completedAt,
        id,
        from,
        ...(guard ? guard.params : []),
      )
    if (Number(res.changes) !== 1) {
      // A state-CAS miss stays a plain null; only a missed fence throws â€” the
      // two losses must remain distinguishable to the caller.
      this.assertFenceAtEnd(fence)
      return null
    }
    return this.getTask(id)
  }

  addEdge(runId: string, fromTaskId: string, toTaskId: string, kind: 'depends_on' = 'depends_on'): void {
    if (fromTaskId === toTaskId) {
      throw new ValidationError(`task ${fromTaskId} cannot depend on itself`)
    }
    this.db
      .prepare('INSERT OR IGNORE INTO task_edges (run_id, from_task_id, to_task_id, kind) VALUES (?, ?, ?, ?)')
      .run(runId, fromTaskId, toTaskId, kind)
  }

  listEdges(runId: string): TaskEdgeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM task_edges WHERE run_id = ? ORDER BY from_task_id, to_task_id')
      .all(runId) as Row[]
    return rows.map((r) => ({
      runId: str(r, 'run_id'),
      fromTaskId: str(r, 'from_task_id'),
      toTaskId: str(r, 'to_task_id'),
      kind: 'depends_on' as const,
    }))
  }

  /** Queued tasks whose every depends_on target is completed. */
  listReadyTasks(runId: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         WHERE t.run_id = ? AND t.state = 'queued'
           AND NOT EXISTS (
             SELECT 1 FROM task_edges e
             JOIN tasks dep ON dep.id = e.to_task_id
             WHERE e.from_task_id = t.id AND e.kind = 'depends_on' AND dep.state <> 'completed'
           )
         ORDER BY t.created_at ASC, t.id ASC`,
      )
      .all(runId) as Row[]
    return rows.map(rowToTask)
  }

  // -- workspaces (per-task / integration checkouts, ADR-0005) ---------------

  createWorkspace(spec: NewWorkspaceSpec, fence?: SupervisorFence): WorkspaceRecord {
    const id = newId('workspace')
    const now = nowIso()
    const guard = fence ? fenceClause(fence) : null
    const shipId = spec.shipId !== undefined ? spec.shipId : (spec.museId ?? null)
    // INSERT ... SELECT + fence: zero rows inserted is a missed fence (the
    // columns always carry a value), never a legitimate no-op.
    const res = this.db
      .prepare(
        `INSERT INTO workspaces (id, project_id, run_id, task_id, ship_id, kind, path, branch, base_commit,
                                 head_commit, state, created_at, updated_at)
         ${guard ? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ? WHERE ${guard.sql}` : `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?)`}`,
      )
      .run(
        id,
        spec.projectId,
        spec.runId,
        spec.taskId,
        shipId,
        spec.kind,
        spec.path,
        spec.branch,
        spec.baseCommit,
        now,
        now,
        ...(guard ? guard.params : []),
      )
    if (fence && Number(res.changes) !== 1) throw new OwnershipLostError(fence.runId)
    return this.getWorkspace(id)
  }

  getWorkspace(id: string): WorkspaceRecord {
    const ws = this.getWorkspaceOrNull(id)
    if (!ws) throw new NotFoundError('workspace', id)
    return ws
  }

  getWorkspaceOrNull(id: string): WorkspaceRecord | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined
    return row ? rowToWorkspace(row) : null
  }

  getWorkspaceByTask(taskId: string): WorkspaceRecord | null {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE task_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as Row | undefined
    return row ? rowToWorkspace(row) : null
  }

  listWorkspaces(projectId: string, state?: WorkspaceRecord['state']): WorkspaceRecord[] {
    const rows = (
      state
        ? this.db
            .prepare('SELECT * FROM workspaces WHERE project_id = ? AND state = ? ORDER BY created_at DESC, id DESC')
            .all(projectId, state)
        : this.db
            .prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at DESC, id DESC')
            .all(projectId)
    ) as Row[]
    return rows.map(rowToWorkspace)
  }

  updateWorkspace(
    id: string,
    patch: { headCommit?: string | null; state?: WorkspaceRecord['state'] } = {},
    fence?: SupervisorFence,
  ): WorkspaceRecord {
    const ws = this.getWorkspace(id)
    const now = nowIso()
    const guard = fence ? fenceClause(fence) : null
    const res = this.db
      .prepare(`UPDATE workspaces SET head_commit = ?, state = ?, updated_at = ? WHERE id = ?${guard ? ` AND ${guard.sql}` : ''}`)
      .run(
        patch.headCommit !== undefined ? patch.headCommit : ws.headCommit,
        patch.state ?? ws.state,
        now,
        id,
        ...(guard ? guard.params : []),
      )
    if (fence && Number(res.changes) !== 1) throw new OwnershipLostError(fence.runId)
    return this.getWorkspace(id)
  }

  // -- sandboxes (execution sessions, ADR-0004/ADR-0013) --------------------

  /**
   * Upsert the current sandbox row for (project, ship), keeping its id stable.
   *
   * v10 replaced the table-wide unique index with the partial unique index
   * `idx_sandboxes_active_ship(project_id, IFNULL(ship_id,'')) WHERE active = 1`,
   * so legacy Docker rows and a new native session for the same Ship can
   * coexist. The conflict target names that partial index explicitly; a history
   * row (`active: false`) never conflicts with the live session.
   */
  upsertSandbox(spec: UpsertSandboxSpec): SandboxRecord {
    const now = nowIso()
    const shipId = spec.shipId !== undefined ? spec.shipId : (spec.museId ?? null)
    const inserted = this.db
      .prepare(
        `INSERT INTO sandboxes (id, project_id, ship_id, kind, container_name, container_id, image, state,
                                created_by, created_at, updated_at, active, legacy, execution_mode,
                                network_policy, helper_version, policy_json, session_state, last_seen_at,
                                exit_code, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, IFNULL(ship_id,'')) WHERE active = 1 DO UPDATE SET
           kind = excluded.kind,
           container_name = excluded.container_name,
           container_id = excluded.container_id,
           image = excluded.image,
           state = excluded.state,
           active = excluded.active,
           legacy = excluded.legacy,
           execution_mode = excluded.execution_mode,
           network_policy = excluded.network_policy,
           helper_version = excluded.helper_version,
           policy_json = excluded.policy_json,
           session_state = excluded.session_state,
           last_seen_at = excluded.last_seen_at,
           exit_code = excluded.exit_code,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(
        newId('sandbox'),
        spec.projectId,
        shipId,
        spec.kind,
        spec.containerName,
        spec.containerId,
        spec.image,
        spec.state,
        spec.createdBy,
        now,
        now,
        spec.active === false ? 0 : 1,
        spec.legacy === true ? 1 : 0,
        spec.executionMode ?? null,
        spec.networkPolicy ?? null,
        spec.helperVersion ?? null,
        spec.policy !== undefined && spec.policy !== null ? stringifyJson(spec.policy) : null,
        spec.sessionState ?? null,
        spec.lastSeenAt ?? null,
        spec.exitCode ?? null,
        spec.startedAt ?? null,
        spec.endedAt ?? null,
      ) as { id: string } | undefined
    if (inserted === undefined) throw new InternalError('sandbox row disappeared inside upsert')
    return this.getSandbox(inserted.id)
  }

  /**
   * Start a new execution session for (project, ship): deactivate the previous
   * active row and insert the new session row in one transaction. The partial
   * unique index makes a concurrent second active row impossible.
   */
  startSandboxSession(spec: StartSandboxSessionSpec): SandboxRecord {
    const now = nowIso()
    const shipId = spec.shipId !== undefined ? spec.shipId : (spec.museId ?? null)
    const id = newId('sandbox')
    withTx(this.db, () => {
      this.db
        .prepare(
          `UPDATE sandboxes
           SET active = 0,
               session_state = CASE
                 WHEN session_state IN ('starting', 'running') THEN 'exited'
                 ELSE session_state
               END,
               ended_at = COALESCE(ended_at, ?),
               updated_at = ?
           WHERE project_id = ? AND ship_id IS ? AND active = 1`,
        )
        .run(now, now, spec.projectId, shipId)
      this.db
        .prepare(
          `INSERT INTO sandboxes (id, project_id, ship_id, kind, container_name, container_id, image, state,
                                  created_by, created_at, updated_at, active, legacy, execution_mode,
                                  network_policy, helper_version, policy_json, session_state, last_seen_at,
                                  exit_code, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          spec.projectId,
          shipId,
          spec.kind,
          spec.containerName,
          spec.containerId,
          spec.image,
          spec.state,
          spec.createdBy,
          now,
          now,
          spec.executionMode,
          spec.networkPolicy,
          spec.helperVersion ?? null,
          spec.policy !== undefined && spec.policy !== null ? stringifyJson(spec.policy) : null,
          spec.sessionState ?? 'starting',
          spec.lastSeenAt ?? now,
          spec.exitCode ?? null,
          spec.startedAt ?? now,
          spec.endedAt ?? null,
        )
    })
    return this.getSandbox(id)
  }

  getSandbox(id: string): SandboxRecord {
    const sb = this.getSandboxOrNull(id)
    if (!sb) throw new NotFoundError('sandbox', id)
    return sb
  }

  getSandboxOrNull(id: string): SandboxRecord | null {
    const row = this.db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(id) as Row | undefined
    return row ? rowToSandbox(row) : null
  }

  /**
   * The Ship's live session. Legacy rows (`active = 0`) are history and are
   * never returned here, even when no new session exists yet.
   */
  getSandboxForShip(projectId: string, shipId: string | null): SandboxRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sandboxes
         WHERE project_id = ? AND ship_id IS ? AND active = 1
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, shipId) as Row | undefined
    return row ? rowToSandbox(row) : null
  }

  listSandboxes(projectId: string): SandboxRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sandboxes WHERE project_id = ? ORDER BY created_at DESC, id DESC')
      .all(projectId) as Row[]
    return rows.map(rowToSandbox)
  }

  listActiveSandboxes(projectId: string): SandboxRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM sandboxes WHERE project_id = ? AND active = 1 ORDER BY created_at DESC, id DESC',
      )
      .all(projectId) as Row[]
    return rows.map(rowToSandbox)
  }

  touchSandbox(id: string, at: string = nowIso()): void {
    this.db.prepare('UPDATE sandboxes SET last_seen_at = ?, updated_at = ? WHERE id = ? AND active = 1').run(at, at, id)
  }

  setSandboxState(
    id: string,
    state: SandboxState,
    patch: {
      containerId?: string | null
      containerName?: string | null
      image?: string | null
      active?: boolean
      sessionState?: SandboxSessionState | null
      lastSeenAt?: string | null
      exitCode?: number | null
      startedAt?: string | null
      endedAt?: string | null
    } = {},
  ): SandboxRecord {
    const sb = this.getSandbox(id)
    this.db
      .prepare(
        `UPDATE sandboxes SET state = ?, container_id = ?, container_name = ?, image = ?,
                             active = ?, session_state = ?, last_seen_at = ?, exit_code = ?,
                             started_at = ?, ended_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        patch.containerId !== undefined ? patch.containerId : sb.containerId,
        patch.containerName !== undefined ? patch.containerName : sb.containerName,
        patch.image !== undefined ? patch.image : sb.image,
        patch.active !== undefined ? (patch.active ? 1 : 0) : sb.active ? 1 : 0,
        patch.sessionState !== undefined ? patch.sessionState : sb.sessionState,
        patch.lastSeenAt !== undefined ? patch.lastSeenAt : sb.lastSeenAt,
        patch.exitCode !== undefined ? patch.exitCode : sb.exitCode,
        patch.startedAt !== undefined ? patch.startedAt : sb.startedAt,
        patch.endedAt !== undefined ? patch.endedAt : sb.endedAt,
        nowIso(),
        id,
      )
    return this.getSandbox(id)
  }

  // -- terminals (tmux per Ship, ADR-0005) -----------------------------------

  /**
   * One terminal row per (project, ship), re-upserting keeps the same record id.
   * Same atomic single-statement upsert shape as upsertSandbox, backed by the
   * NULL-safe unique index `idx_terminals_project_ship` (v2, renamed from `idx_terminals_project_muse` in v8).
   */
  upsertTerminal(spec: UpsertTerminalSpec): TerminalRecord {
    const now = nowIso()
    const shipId = spec.shipId ?? spec.museId ?? 'unknown'
    this.db
      .prepare(
        `INSERT INTO terminals (id, project_id, ship_id, sandbox_id, tmux_session_name, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, IFNULL(ship_id,'')) DO UPDATE SET
           sandbox_id = excluded.sandbox_id,
           tmux_session_name = excluded.tmux_session_name,
           state = excluded.state,
           updated_at = excluded.updated_at`,
      )
      .run(
        newId('terminal'),
        spec.projectId,
        shipId,
        spec.sandboxId,
        spec.tmuxSessionName,
        spec.state,
        now,
        now,
      )
    const saved = this.getTerminalForShip(spec.projectId, shipId)
    if (!saved) throw new InternalError('terminal row disappeared inside upsert')
    return saved
  }

  getTerminal(id: string): TerminalRecord {
    const t = this.getTerminalForId(id)
    if (!t) throw new NotFoundError('terminal', id)
    return t
  }

  private getTerminalForId(id: string): TerminalRecord | null {
    const row = this.db.prepare('SELECT * FROM terminals WHERE id = ?').get(id) as Row | undefined
    return row ? rowToTerminal(row) : null
  }

  getTerminalForShip(projectId: string, shipId: string): TerminalRecord | null {
    const row = this.db
      .prepare('SELECT * FROM terminals WHERE project_id = ? AND ship_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(projectId, shipId) as Row | undefined
    return row ? rowToTerminal(row) : null
  }

  listTerminals(projectId: string): TerminalRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM terminals WHERE project_id = ? ORDER BY created_at ASC, id ASC')
      .all(projectId) as Row[]
    return rows.map(rowToTerminal)
  }

  setTerminalState(id: string, state: TerminalRecord['state']): TerminalRecord {
    this.db.prepare('UPDATE terminals SET state = ?, updated_at = ? WHERE id = ?').run(state, nowIso(), id)
    return this.getTerminal(id)
  }

  // -- approvals (human gate, prompt Â§4/Â§7) ----------------------------------

  createApproval(spec: NewApprovalSpec, fence?: SupervisorFence): ApprovalRecord {
    const id = newId('approval')
    const now = nowIso()
    const guard = fence ? fenceClause(fence) : null
    const requestedByShipId = spec.requestedByShipId !== undefined ? spec.requestedByShipId : (spec.requestedByMuseId ?? null)
    // Persistence boundary: approval text is model/engine-authored. Strip
    // terminal control bytes and bidi controls here â€” the single choke point
    // every writer (tool bridge, engine channel, gate) goes through â€” so no
    // stored string can drive a terminal when a CLI/TUI/SPA later renders it.
    const res = this.db
      .prepare(
        `INSERT INTO approvals (id, project_id, run_id, task_id, requested_by_ship_id, action, reason, scope_json,
                                 status, decided_by, decided_at, expires_at, created_at)
         ${guard ? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ? WHERE ${guard.sql}` : `VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`}`,
      )
      .run(
        id,
        spec.projectId,
        spec.runId,
        spec.taskId,
        requestedByShipId,
        stripControlChars(spec.action),
        stripControlChars(spec.reason),
        stringifyJson(stripControlDeep(spec.scope)),
        spec.expiresAt ?? null,
        now,
        ...(guard ? guard.params : []),
      )
    if (fence && Number(res.changes) !== 1) throw new OwnershipLostError(fence.runId)
    return this.getApproval(id)
  }

  getApproval(id: string): ApprovalRecord {
    const approval = this.getApprovalOrNull(id)
    if (!approval) throw new NotFoundError('approval', id)
    return approval
  }

  getApprovalOrNull(id: string): ApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined
    return row ? rowToApproval(row) : null
  }

  listApprovals(runId: string): ApprovalRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at DESC, id DESC')
      .all(runId) as Row[]
    return rows.map(rowToApproval)
  }

  /** Project-scoped inbox listing, newest first. */
  listApprovalsByProject(projectId: string, opts: { status?: ApprovalStatus; limit?: number } = {}): ApprovalRecord[] {
    const limit = opts.limit ?? 100
    const rows =
      opts.status === undefined
        ? (this.db
            .prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
            .all(projectId, limit) as Row[])
        : (this.db
            .prepare(
              'SELECT * FROM approvals WHERE project_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT ?',
            )
            .all(projectId, opts.status, limit) as Row[])
    return rows.map(rowToApproval)
  }

  /**
   * Timeout-to-denied sweep: every `pending` approval whose `expires_at` has
   * arrived is flipped to `expired` (fail-closed â€” it can never be approved),
   * stamped `decided_by: 'pluton:timeout'` at the given time. Rows without an
   * expiry never move, and a second sweep returns nothing.
   */
  expirePendingApprovals(nowIso: string, projectId?: string): ApprovalRecord[] {
    const selectSql =
      `SELECT id FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?` +
      (projectId === undefined ? '' : ' AND project_id = ?') +
      ' ORDER BY created_at ASC, id ASC'
    const ids = (
      this.db.prepare(selectSql).all(nowIso, ...(projectId === undefined ? [] : [projectId])) as Row[]
    ).map((r) => str(r, 'id'))
    if (ids.length === 0) return []
    const update = this.db.prepare(
      "UPDATE approvals SET status = 'expired', decided_by = 'pluton:timeout', decided_at = ? WHERE id = ? AND status = 'pending'",
    )
    return withTx(this.db, () => {
      const updated: ApprovalRecord[] = []
      for (const id of ids) {
        const res = update.run(nowIso, id)
        if (Number(res.changes) > 0) updated.push(this.getApproval(id))
      }
      return updated
    })
  }

  // -- verification checks (Phase 7 gates) -----------------------------------

  /** Record a pending verification check. Executing it is the caller's job. */
  createVerificationCheck(spec: NewVerificationCheckSpec): VerificationCheckRecord {
    const id = newId('verification')
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO verification_checks (id, project_id, run_id, task_id, name, command_json, cwd, workspace_id,
                                          status, exit_code, stdout_artifact, stderr_artifact, duration_ms,
                                          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        spec.projectId,
        spec.runId,
        spec.taskId,
        spec.name,
        stringifyJson(spec.command),
        spec.cwd,
        spec.workspaceId,
        now,
        now,
      )
    return this.getVerificationCheck(id)
  }

  getVerificationCheck(id: string): VerificationCheckRecord {
    const check = this.getVerificationCheckOrNull(id)
    if (!check) throw new NotFoundError('verification check', id)
    return check
  }

  getVerificationCheckOrNull(id: string): VerificationCheckRecord | null {
    const row = this.db.prepare('SELECT * FROM verification_checks WHERE id = ?').get(id) as Row | undefined
    return row ? rowToVerificationCheck(row) : null
  }

  listVerificationChecks(runId: string): VerificationCheckRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM verification_checks WHERE run_id = ? ORDER BY created_at ASC, id ASC')
      .all(runId) as Row[]
    return rows.map(rowToVerificationCheck)
  }

  listVerificationChecksByTask(taskId: string): VerificationCheckRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM verification_checks WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all(taskId) as Row[]
    return rows.map(rowToVerificationCheck)
  }

  /**
   * Record a check's outcome. Only `pending` may move to a final status; a
   * re-set of the same status is an idempotent no-op, and a decided check is
   * final â€” the evidence must not be rewritten.
   */
  setVerificationCheckResult(
    id: string,
    patch: {
      status: VerificationCheckRecord['status']
      exitCode?: number | null
      stdoutArtifact?: string | null
      stderrArtifact?: string | null
      durationMs?: number | null
    },
  ): VerificationCheckRecord {
    const check = this.getVerificationCheck(id)
    if (check.status === patch.status) return check
    if (check.status !== 'pending') {
      throw new ValidationError(
        `verification check ${id} is already ${check.status}; ${check.status} -> ${patch.status} is not a legal transition`,
      )
    }
    const now = nowIso()
    this.db
      .prepare(
        `UPDATE verification_checks SET status = ?, exit_code = ?, stdout_artifact = ?, stderr_artifact = ?,
                                        duration_ms = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.exitCode ?? null,
        patch.stdoutArtifact ?? null,
        patch.stderrArtifact ?? null,
        patch.durationMs ?? null,
        now,
        id,
      )
    return this.getVerificationCheck(id)
  }

  /**
   * Decide an approval. Only `pending` may move to `approved|denied|expired`;
   * a decided approval is final. Re-setting the current status is an idempotent
   * no-op (the record is returned unchanged, the patch is ignored).
   */
  setApprovalStatus(
    id: string,
    status: ApprovalStatus,
    patch: { decidedBy?: string | null; selectedOption?: string | null; answer?: string | null } = {},
  ): ApprovalRecord {
    const approval = this.getApproval(id)
    if (approval.status === status) return approval
    if (approval.status !== 'pending') {
      throw new ValidationError(
        `approval ${id} is already ${approval.status}; ${approval.status} -> ${status} is not a legal transition (only pending approvals can be decided)`,
      )
    }
    const now = nowIso()
    let scopeJson: string | null = null
    if (patch.selectedOption !== undefined || patch.answer !== undefined) {
      const scopeObj: Record<string, unknown> =
        approval.scope !== null && typeof approval.scope === 'object' && !Array.isArray(approval.scope)
          ? { ...(approval.scope as Record<string, unknown>) }
          : { value: approval.scope }
      if (patch.selectedOption !== undefined) scopeObj.selectedOption = patch.selectedOption
      if (patch.answer !== undefined) scopeObj.answer = patch.answer
      scopeJson = JSON.stringify(scopeObj)
    }

    if (scopeJson !== null) {
      this.db
        .prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, scope_json = ? WHERE id = ?')
        .run(status, patch.decidedBy ?? null, now, scopeJson, id)
    } else {
      this.db
        .prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
        .run(status, patch.decidedBy ?? null, now, id)
    }
    return this.getApproval(id)
  }

  // -- events ----------------------------------------------------------------

  appendEvent(input: AppendEventInput, fence?: SupervisorFence): EventRecord {
    const payload = redactDeep(input.payload ?? {})
    const payloadJson = canonicalJson(payload)
    const maxChars = input.maxChars ?? DEFAULT_MAX_EVENT_CHARS
    if (payloadJson.length > maxChars) {
      throw new ValidationError(
        `event payload too large: ${payloadJson.length} chars > ${maxChars} (type '${input.type}') â€” bound the payload at the writer`,
        { details: { type: input.type, size: payloadJson.length, maxChars } },
      )
    }
    const id = newId('event')
    const now = nowIso()
    const guard = fence ? fenceClause(fence) : null
    const shipId = input.shipId !== undefined ? input.shipId : (input.museId ?? null)
    const res = this.db
      .prepare(
        `INSERT INTO events (id, project_id, run_id, task_id, ship_id, type, payload_json, created_at)
         ${guard ? `SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}` : `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`}`,
      )
      .run(
        id,
        input.projectId,
        input.runId ?? null,
        input.taskId ?? null,
        shipId,
        input.type,
        payloadJson,
        now,
        ...(guard ? guard.params : []),
      )
    if (fence && Number(res.changes) !== 1) throw new OwnershipLostError(fence.runId)
    const seq = Number(res.lastInsertRowid)
    return {
      seq,
      id,
      projectId: input.projectId,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      shipId: input.shipId ?? null,
      type: input.type,
      payload,
      createdAt: now,
    }
  }

  eventsSince(projectId: string, afterSeq: number, limit = 200): EventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(projectId, afterSeq, limit) as Row[]
    return rows.map(rowToEvent)
  }

  latestEventSeq(projectId: string): number {
    const row = this.db
      .prepare('SELECT seq FROM events WHERE project_id = ? ORDER BY seq DESC LIMIT 1')
      .get(projectId) as { seq: number } | undefined
    return row?.seq ?? 0
  }

  /** One run's most recent events, newest first (readers look back from now). */
  listEvents(runId: string, opts: { type?: string; limit?: number } = {}): EventRecord[] {
    const limit = opts.limit ?? 50
    const rows =
      opts.type === undefined
        ? (this.db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?').all(runId, limit) as Row[])
        : (this.db
            .prepare('SELECT * FROM events WHERE run_id = ? AND type = ? ORDER BY seq DESC LIMIT ?')
            .all(runId, opts.type, limit) as Row[])
    return rows.map(rowToEvent)
  }

  // -- chat (operator conversation, ADR-0012) --------------------------------

  createChatSession(spec: {
    projectId: string
    shipId?: string
    /** @deprecated Use `shipId`; kept for backward compatibility. */
    museId?: string
    title?: string | null
    /** Absolute workspace root for this session; NULL/omitted = project root. */
    workspaceRoot?: string | null
  }): ChatSessionRecord {
    const id = newId('chat')
    const now = nowIso()
    const shipId = spec.shipId ?? spec.museId
    if (!shipId) throw new ValidationError('createChatSession requires shipId')
    this.db
      .prepare(
        `INSERT INTO chat_sessions (id, project_id, ship_id, title, state, native_session_id, resume_token,
                                    engine_session_id, workspace_root, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(id, spec.projectId, shipId, spec.title ?? null, spec.workspaceRoot ?? null, now, now)
    return this.getChatSession(id)
  }

  getChatSession(id: string): ChatSessionRecord {
    const session = this.getChatSessionOrNull(id)
    if (!session) throw new NotFoundError('chat session', id)
    return session
  }

  getChatSessionOrNull(id: string): ChatSessionRecord | null {
    const row = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as Row | undefined
    return row ? rowToChatSession(row) : null
  }

  /** Patch semantics: `undefined` leaves a field alone, `null` clears it. */
  updateChatSession(
    id: string,
    patch: {
      title?: string | null
      state?: ChatSessionState
      nativeSessionId?: string | null
      resumeToken?: string | null
      engineSessionId?: string | null
      workspaceRoot?: string | null
    },
  ): ChatSessionRecord {
    this.getChatSession(id) // NotFoundError before any write
    const sets: string[] = []
    const values: Array<string | null> = []
    if (patch.title !== undefined) {
      sets.push('title = ?')
      values.push(patch.title)
    }
    if (patch.state !== undefined) {
      sets.push('state = ?')
      values.push(patch.state)
    }
    if (patch.nativeSessionId !== undefined) {
      sets.push('native_session_id = ?')
      values.push(patch.nativeSessionId)
    }
    if (patch.resumeToken !== undefined) {
      sets.push('resume_token = ?')
      values.push(patch.resumeToken)
    }
    if (patch.engineSessionId !== undefined) {
      sets.push('engine_session_id = ?')
      values.push(patch.engineSessionId)
    }
    if (patch.workspaceRoot !== undefined) {
      sets.push('workspace_root = ?')
      values.push(patch.workspaceRoot)
    }
    sets.push('updated_at = ?')
    values.push(nowIso())
    this.db.prepare(`UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    return this.getChatSession(id)
  }

  /** Newest session for (project, ship) by updated_at (ties broken by id DESC); null when none. */
  getLatestChatSession(projectId: string, shipId: string): ChatSessionRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM chat_sessions WHERE project_id = ? AND ship_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
      )
      .get(projectId, shipId) as Row | undefined
    return row ? rowToChatSession(row) : null
  }

  /**
   * Append one message; the seq is computed and inserted inside one
   * transaction so two appends in the same tick stay monotonic. Text over
   * `MAX_CHAT_MESSAGE_CHARS` is cut and the marker records how much was
   * dropped (`meta.truncatedChars`). Appending bumps the session's updated_at.
   */
  appendChatMessage(spec: {
    sessionId: string
    role: ChatMessageRole
    text: string
    meta?: JsonValue
  }): ChatMessageRecord {
    this.getChatSession(spec.sessionId) // NotFoundError before any write
    const now = nowIso()
    let text = spec.text
    let meta: JsonValue = spec.meta ?? {}
    if (text.length > MAX_CHAT_MESSAGE_CHARS) {
      const truncatedChars = text.length - MAX_CHAT_MESSAGE_CHARS
      text = `${text.slice(0, MAX_CHAT_MESSAGE_CHARS)}\n… [truncated ${truncatedChars} chars]`
      const base = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}
      meta = { ...base, truncatedChars }
    }
    const id = newId('msg')
    return withTx(this.db, () => {
      const next = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM chat_messages WHERE session_id = ?')
        .get(spec.sessionId) as Row
      const seq = num(next, 'seq')
      this.db
        .prepare(
          'INSERT INTO chat_messages (id, session_id, seq, role, text, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, spec.sessionId, seq, spec.role, text, stringifyJson(meta), now)
      this.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, spec.sessionId)
      const saved = this.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as Row | undefined
      if (!saved) throw new InternalError('chat message insert disappeared')
      return rowToChatMessage(saved)
    })
  }

  /** Newest `limit` messages of a session, returned in seq ASC order (default limit 1000). */
  listChatMessages(sessionId: string, opts: { limit?: number } = {}): ChatMessageRecord[] {
    const limit = opts.limit ?? 1000
    const rows = this.db
      .prepare(
        'SELECT * FROM (SELECT * FROM chat_messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC',
      )
      .all(sessionId, limit) as Row[]
    return rows.map(rowToChatMessage)
  }

  /** List chat sessions for a project ordered by updated_at DESC. */
  listChatSessions(projectId: string, limit: number = 50): ChatSessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(projectId, limit) as Row[]
    return rows.map(rowToChatSession)
  }

  // -- plans (planning workflow) ----------------------------------------------

  createPlan(spec: {
    id?: string
    projectId: string
    sessionId: string
    goal: string
    tasks?: PlanTask[]
    state?: PlanState
  }): PlanRecord {
    const id = spec.id ?? newId('plan')
    const now = nowIso()
    const state: PlanState = spec.state ?? 'DRAFT'
    const tasksJson = stringifyJson(spec.tasks ?? [])
    this.db
      .prepare(
        `INSERT INTO plans (id, project_id, session_id, goal, state, tasks_json, run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, spec.projectId, spec.sessionId, spec.goal, state, tasksJson, now, now)
    return this.getPlan(id)
  }

  getPlan(id: string): PlanRecord {
    const plan = this.getPlanOrNull(id)
    if (!plan) throw new NotFoundError('plan', id)
    return plan
  }

  getPlanOrNull(id: string): PlanRecord | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as Row | undefined
    return row ? rowToPlan(row) : null
  }

  getLatestPlanForSession(sessionId: string): PlanRecord | null {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(sessionId) as Row | undefined
    return row ? rowToPlan(row) : null
  }

  updatePlan(
    id: string,
    patch: {
      goal?: string
      state?: PlanState
      tasks?: PlanTask[]
      runId?: string | null
    },
  ): PlanRecord {
    const current = this.getPlan(id)
    let nextState = current.state

    // If goal or tasks changed and plan was APPROVED, invalidate back to DRAFT
    if (current.state === 'APPROVED' && (patch.goal !== undefined || patch.tasks !== undefined)) {
      nextState = 'DRAFT'
    }

    if (patch.state !== undefined) {
      nextState = transitionPlanState(nextState, patch.state)
    }

    const sets: string[] = []
    const values: Array<string | null> = []

    if (patch.goal !== undefined) {
      sets.push('goal = ?')
      values.push(patch.goal)
    }

    sets.push('state = ?')
    values.push(nextState)

    if (patch.tasks !== undefined) {
      sets.push('tasks_json = ?')
      values.push(stringifyJson(patch.tasks))
    }

    if (patch.runId !== undefined) {
      sets.push('run_id = ?')
      values.push(patch.runId)
    }

    sets.push('updated_at = ?')
    values.push(nowIso())

    values.push(id)

    this.db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    return this.getPlan(id)
  }

  // -- receipts (idempotency core, Â§5) ---------------------------------------

  getReceipt(id: string): RequestReceiptRecord | null {
    const row = this.db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as Row | undefined
    return row ? rowToReceipt(row) : null
  }

  /**
   * Idempotent request admission:
   *  - first time: receipt row + created resource commit together (or nothing).
   *  - same id + same payload hash: returns the ORIGINAL receipt, creating nothing new.
   *  - same id + different payload hash: request_conflict; nothing is mutated,
   *    and an audit event records the attempted reuse.
   */
  admitRequest(input: AdmitRequestInput): AdmitResult {
    const hash = payloadHash(input.payload)
    const canonical = canonicalJson(input.payload)

    type Outcome =
      | { kind: 'duplicate'; receipt: RequestReceiptRecord }
      | { kind: 'conflict'; existing: RequestReceiptRecord }
      | { kind: 'created'; receipt: RequestReceiptRecord }

    const outcome = withTx(this.db, (): Outcome => {
      const existing = this.getReceipt(input.requestId)
      if (existing) {
        if (existing.payloadHash !== hash) return { kind: 'conflict', existing }
        return { kind: 'duplicate', receipt: existing }
      }
      const now = nowIso()
      this.db
        .prepare(
          `INSERT INTO receipts (id, project_id, target_kind, target_id, payload_hash, canonical_payload,
                                 state, result_json, error_json, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, 'accepted', NULL, NULL, ?, ?)`,
        )
        .run(input.requestId, input.projectId, input.targetKind, hash, canonical, now, now)
      const created = input.create()
      this.db
        .prepare(
          `UPDATE receipts SET target_id = ?, state = 'completed', result_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(created.targetId, stringifyJson(created.result), nowIso(), input.requestId)
      const receipt = this.getReceipt(input.requestId)
      if (!receipt) throw new InternalError('receipt row disappeared inside its transaction')
      return { kind: 'created', receipt }
    })

    if (outcome.kind === 'conflict') {
      this.appendEvent({
        projectId: input.projectId,
        type: 'request.conflict',
        payload: {
          requestId: input.requestId,
          targetKind: input.targetKind,
          existingPayloadHash: outcome.existing.payloadHash,
          incomingPayloadHash: hash,
        },
      })
      throw new ConflictError(
        `request id '${input.requestId}' was already used with a different payload (${outcome.existing.targetKind})`,
        {
          requestId: input.requestId,
          existingTargetKind: outcome.existing.targetKind,
          existingPayloadHash: outcome.existing.payloadHash,
          incomingPayloadHash: hash,
        },
      )
    }

    return { receipt: outcome.receipt, duplicate: outcome.kind === 'duplicate' }
  }

  // --- File Leases ---
  recordLease(
    lease: {
      id: string
      runId: string
      taskId: string
      shipId?: string
      /** @deprecated Use `shipId`; kept for backward compatibility. */
      museId?: string
      path: string
      symbols?: string[]
      acquiredAt?: string
      state?: 'active' | 'released'
    },
    fence?: SupervisorFence,
  ): void {
    const shipId = lease.shipId ?? lease.museId ?? ''
    const now = nowIso()
    const guard = fence ? fenceClause(fence) : null
    // Advisory/accounting write: a missed fence skips silently (callers live in
    // finally blocks and engine event pumps â€” they must never throw from here).
    this.db
      .prepare(
        `INSERT OR REPLACE INTO file_leases (id, run_id, task_id, ship_id, path, symbols_json, acquired_at, state)
         ${guard ? `SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}` : `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`}`,
      )
      .run(
        lease.id,
        lease.runId,
        lease.taskId,
        shipId,
        lease.path,
        stringifyJson(lease.symbols ?? []),
        lease.acquiredAt ?? now,
        lease.state ?? 'active',
        ...(guard ? guard.params : []),
      )
  }

  releaseLeasesForTask(taskId: string, fence?: SupervisorFence): string[] {
    const rows = this.db.prepare(`SELECT path FROM file_leases WHERE task_id = ? AND state = 'active'`).all(taskId) as Row[]
    const guard = fence ? fenceClause(fence) : null
    const res = this.db
      .prepare(`UPDATE file_leases SET state = 'released' WHERE task_id = ? AND state = 'active'${guard ? ` AND ${guard.sql}` : ''}`)
      .run(taskId, ...(guard ? guard.params : []))
    if (fence && Number(res.changes) === 0) return []
    return rows.map((r) => str(r, 'path'))
  }

  listActiveLeases(runId: string): Array<{
    id: string
    runId: string
    taskId: string
    shipId: string
    /** @deprecated Use `shipId`; kept for backward compatibility. */
    museId?: string
    path: string
    symbols: string[]
    acquiredAt: string
    state: 'active' | 'released'
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM file_leases WHERE run_id = ? AND state = 'active' ORDER BY acquired_at ASC`)
      .all(runId) as Row[]
    return rows.map((r) => {
      const shipId = str(r, 'ship_id')
      return {
        id: str(r, 'id'),
        runId: str(r, 'run_id'),
        taskId: str(r, 'task_id'),
        shipId,
        museId: shipId,
        path: str(r, 'path'),
        symbols: parseJsonText<string[]>(nstr(r, 'symbols_json'), []),
        acquiredAt: str(r, 'acquired_at'),
        state: str(r, 'state') as 'active' | 'released',
      }
    })
  }

  reapOrphanedLeases(activeTaskIds: Set<string>, fence?: SupervisorFence): void {
    // With a fence, both the read and the writes are ownership-gated AND
    // run-scoped: a supervisor's reap must never touch another run's live
    // leases. Without one the legacy global behavior is preserved (no other
    // caller exists).
    const guard = fence ? fenceClause(fence) : null
    const selectGuard = fence && guard ? ` AND run_id = ? AND ${guard.sql}` : ''
    const selectParams = fence && guard ? [fence.runId, ...guard.params] : []
    const rows = this.db
      .prepare(`SELECT id, task_id FROM file_leases WHERE state = 'active'${selectGuard}`)
      .all(...selectParams) as Row[]
    const stmt = this.db.prepare(`UPDATE file_leases SET state = 'released' WHERE id = ?${guard ? ` AND ${guard.sql}` : ''}`)
    for (const r of rows) {
      const taskId = str(r, 'task_id')
      if (!activeTaskIds.has(taskId)) {
        stmt.run(str(r, 'id'), ...(guard ? guard.params : []))
      }
    }
  }

  // --- Run Usage ---
  recordUsage(
    input: {
      id?: string
      runId: string
      shipId?: string
      /** @deprecated Use `shipId`; kept for backward compatibility. */
      museId?: string
      taskId?: string | null
      inputTokens?: number
      outputTokens?: number
      cachedTokens?: number
      costUsd?: number
    },
    fence?: SupervisorFence,
  ): void {
    const id = input.id ?? newId('attempt')
    const shipId = input.shipId ?? input.museId ?? 'unknown'
    const guard = fence ? fenceClause(fence) : null
    // Advisory/accounting write: a missed fence skips silently.
    this.db
      .prepare(
        `INSERT INTO run_usage (id, run_id, ship_id, task_id, input_tokens, output_tokens, cached_tokens, cost_usd, created_at)
         ${guard ? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}` : `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`}`,
      )
      .run(
        id,
        input.runId,
        shipId,
        input.taskId ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cachedTokens ?? 0,
        input.costUsd ?? 0.0,
        nowIso(),
        ...(guard ? guard.params : []),
      )
  }

  getRunUsage(runId: string): {
    totalInputTokens: number
    totalOutputTokens: number
    totalCachedTokens: number
    totalCostUsd: number
    perShip: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }>
    perMuse: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }>
  } {
    const rows = this.db
      .prepare(`SELECT ship_id, input_tokens, output_tokens, cached_tokens, cost_usd FROM run_usage WHERE run_id = ?`)
      .all(runId) as Row[]
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCachedTokens = 0
    let totalCostUsd = 0
    const perShip: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }> = {}

    for (const r of rows) {
      const shipId = str(r, 'ship_id')
      const inTok = num(r, 'input_tokens')
      const outTok = num(r, 'output_tokens')
      const cacheTok = num(r, 'cached_tokens')
      const cost = typeof r['cost_usd'] === 'number' ? r['cost_usd'] : 0

      totalInputTokens += inTok
      totalOutputTokens += outTok
      totalCachedTokens += cacheTok
      totalCostUsd += cost

      const entry = perShip[shipId] ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }
      entry.inputTokens += inTok
      entry.outputTokens += outTok
      entry.cachedTokens += cacheTok
      entry.costUsd += cost
      perShip[shipId] = entry
    }

    return { totalInputTokens, totalOutputTokens, totalCachedTokens, totalCostUsd, perShip, perMuse: perShip }
  }

  // --- Verifications ---
  recordVerification(input: {
    id?: string
    runId: string
    taskId: string
    verdict: string
    criteria?: JsonValue
    tamper?: JsonValue
    evidence?: JsonValue
  }): void {
    const id = input.id ?? newId('attempt')
    this.db
      .prepare(
        `INSERT INTO verifications (id, run_id, task_id, verdict, criteria_json, tamper_json, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.taskId,
        input.verdict,
        stringifyJson(input.criteria ?? []),
        stringifyJson(input.tamper ?? {}),
        stringifyJson(input.evidence ?? {}),
        nowIso(),
      )
  }

  getTaskVerification(taskId: string): {
    id: string
    runId: string
    taskId: string
    verdict: string
    criteria: JsonValue
    tamper: JsonValue
    evidence: JsonValue
    createdAt: string
  } | null {
    // `created_at` is millisecond ISO text, so two verifications recorded in
    // the same millisecond tie. Without a second key the winner is whatever
    // order the index/sorter happens to produce (fast hosts hit this: the
    // macOS runner returned the earlier row), which made "the latest
    // verification" nondeterministic. `rowid` is insertion order here, so the
    // last recorded row always wins the tie.
    const row = this.db
      .prepare(
        `SELECT * FROM verifications WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId) as Row | undefined
    if (!row) return null
    return {
      id: str(row, 'id'),
      runId: str(row, 'run_id'),
      taskId: str(row, 'task_id'),
      verdict: str(row, 'verdict'),
      criteria: parseJsonText(nstr(row, 'criteria_json'), []),
      tamper: parseJsonText(nstr(row, 'tamper_json'), {}),
      evidence: parseJsonText(nstr(row, 'evidence_json'), {}),
      createdAt: str(row, 'created_at'),
    }
  }
}

function isApprovalStatus(value: string): value is ApprovalStatus {
  return (APPROVAL_STATUSES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Row mappers â€” the only place DB text becomes typed records.
// ---------------------------------------------------------------------------

function rowToProject(r: Row): ProjectRecord {
  return {
    id: str(r, 'id'),
    name: str(r, 'name'),
    rootPath: str(r, 'root_path'),
    configPath: str(r, 'config_path'),
    defaultBranch: str(r, 'default_branch'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  }
}

function rowToShip(r: Row): ShipRecord {
  const role = str(r, 'role')
  const workspacePolicy = str(r, 'workspace_policy')
  const approvalMode = str(r, 'approval_mode')
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    slug: str(r, 'slug'),
    displayName: str(r, 'display_name'),
    role: role as ShipRecord['role'],
    engineKind: str(r, 'engine_kind'),
    model: str(r, 'model'),
    instructionsFile: nstr(r, 'instructions_file'),
    workspacePolicy: workspacePolicy as ShipRecord['workspacePolicy'],
    permissions: parseJsonText<string[]>(nstr(r, 'permissions_json'), []),
    approvalMode: approvalMode as ShipRecord['approvalMode'],
    engineHome: str(r, 'engine_home'),
    enabled: num(r, 'enabled') === 1,
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  }
}

function rowToRun(r: Row): RunRecord {
  const state = str(r, 'state')
  if (!isRunState(state)) throw new InternalError(`db row: invalid run state '${state}'`)
  const origin = str(r, 'origin')
  if (origin !== 'cli' && origin !== 'api') throw new InternalError(`db row: invalid run origin '${origin}'`)
  const managerShipId = str(r, 'manager_ship_id')
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    goal: str(r, 'goal'),
    origin,
    requestedBy: str(r, 'requested_by'),
    state,
    acceptanceCriteria: parseJsonText<string[]>(nstr(r, 'acceptance_json'), []),
    managerShipId,
    managerMuseId: managerShipId,
    budget: parseJsonText<RunBudget>(nstr(r, 'budget_json'), {
      maxConcurrentWorkers: 1,
      maxTasks: 1,
      maxDelegationDepth: 0,
      maxRunMinutes: 1,
      defaultTaskMinutes: 1,
    }),
    supervisorPid: nnum(r, 'supervisor_pid'),
    supervisorToken: nstr(r, 'supervisor_token'),
    supervisorHeartbeatAt: nnum(r, 'supervisor_heartbeat_at'),
    workspaceRoot: nstr(r, 'workspace_root'),
    originSessionId: nstr(r, 'origin_session_id'),
    createdAt: str(r, 'created_at'),
    startedAt: nstr(r, 'started_at'),
    completedAt: nstr(r, 'completed_at'),
    finalSummary: nstr(r, 'final_summary'),
  }
}

function rowToTask(r: Row): TaskRecord {
  const state = str(r, 'state')
  if (!isTaskState(state)) throw new InternalError(`db row: invalid task state '${state}'`)
  const assigneeShipId = nstr(r, 'assignee_ship_id')
  return {
    id: str(r, 'id'),
    runId: str(r, 'run_id'),
    parentTaskId: nstr(r, 'parent_task_id'),
    rootTaskId: str(r, 'root_task_id'),
    depth: num(r, 'depth'),
    title: str(r, 'title'),
    brief: str(r, 'brief'),
    acceptanceCriteria: parseJsonText<string[]>(nstr(r, 'acceptance_json'), []),
    writeScope: parseJsonText<string[]>(nstr(r, 'write_scope_json'), []),
    assigneeShipId,
    assigneeMuseId: assigneeShipId,
    state,
    attempt: num(r, 'attempt'),
    workspaceId: nstr(r, 'workspace_id'),
    engineSessionId: nstr(r, 'engine_session_id'),
    result: parseJsonText<JsonValue | null>(nstr(r, 'result_json'), null),
    failure: parseJsonText<JsonValue | null>(nstr(r, 'failure_json'), null),
    assignment: parseJsonText<JsonValue | null>(nstr(r, 'assignment_json'), null),
    createdAt: str(r, 'created_at'),
    startedAt: nstr(r, 'started_at'),
    completedAt: nstr(r, 'completed_at'),
  }
}

function rowToWorkspace(r: Row): WorkspaceRecord {
  const kind = str(r, 'kind')
  if (kind !== 'task-checkout' && kind !== 'integration-checkout') {
    throw new InternalError(`db row: invalid workspace kind '${kind}'`)
  }
  const state = str(r, 'state')
  if (state !== 'active' && state !== 'archived' && state !== 'removed') {
    throw new InternalError(`db row: invalid workspace state '${state}'`)
  }
  const shipId = nstr(r, 'ship_id')
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    runId: nstr(r, 'run_id'),
    taskId: nstr(r, 'task_id'),
    shipId,
    museId: shipId,
    kind,
    path: str(r, 'path'),
    branch: str(r, 'branch'),
    baseCommit: str(r, 'base_commit'),
    headCommit: nstr(r, 'head_commit'),
    state,
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  }
}

function rowToSandbox(r: Row): SandboxRecord {
  const kind = str(r, 'kind')
  if (!(SANDBOX_KINDS as readonly string[]).includes(kind)) {
    throw new InternalError(`db row: invalid sandbox kind '${kind}'`)
  }
  const state = str(r, 'state')
  if (!(SANDBOX_STATES as readonly string[]).includes(state)) {
    throw new InternalError(`db row: invalid sandbox state '${state}'`)
  }
  const shipId = nstr(r, 'ship_id')
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    shipId,
    museId: shipId,
    kind: kind as SandboxRecord['kind'],
    containerName: nstr(r, 'container_name'),
    containerId: nstr(r, 'container_id'),
    image: nstr(r, 'image'),
    state: state as SandboxState,
    createdBy: str(r, 'created_by'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
    active: bool01(r, 'active'),
    legacy: bool01(r, 'legacy'),
    executionMode: nenum(r, 'execution_mode', EXECUTION_MODES, 'sandbox execution mode'),
    networkPolicy: nenum(r, 'network_policy', EXECUTION_NETWORK_POLICIES, 'sandbox network policy'),
    helperVersion: nstr(r, 'helper_version'),
    policy: parseJsonText<JsonValue | null>(nstr(r, 'policy_json'), null),
    sessionState: nenum(r, 'session_state', SANDBOX_SESSION_STATES, 'sandbox session state'),
    lastSeenAt: nstr(r, 'last_seen_at'),
    exitCode: nnum(r, 'exit_code'),
    startedAt: nstr(r, 'started_at'),
    endedAt: nstr(r, 'ended_at'),
  }
}

function rowToTerminal(r: Row): TerminalRecord {
  const state = str(r, 'state')
  if (state !== 'present' && state !== 'absent' && state !== 'recreated' && state !== 'unknown') {
    throw new InternalError(`db row: invalid terminal state '${state}'`)
  }
  const shipId = str(r, 'ship_id')
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    shipId,
    museId: shipId,
    sandboxId: nstr(r, 'sandbox_id'),
    tmuxSessionName: str(r, 'tmux_session_name'),
    state,
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  }
}

function rowToApproval(r: Row): ApprovalRecord {
  const status = str(r, 'status')
  if (!isApprovalStatus(status)) throw new InternalError(`db row: invalid approval status '${status}'`)
  const scope = parseJsonText<JsonValue>(nstr(r, 'scope_json'), {})
  const scopeObj =
    scope !== null && typeof scope === 'object' && !Array.isArray(scope)
      ? (scope as Record<string, unknown>)
      : null
  const selectedOption =
    scopeObj && typeof scopeObj.selectedOption === 'string' ? scopeObj.selectedOption : null
  const answer = scopeObj && typeof scopeObj.answer === 'string' ? scopeObj.answer : null
  const requestedByShipId = nstr(r, 'requested_by_ship_id')

  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    runId: nstr(r, 'run_id'),
    taskId: nstr(r, 'task_id'),
    requestedByShipId,
    requestedByMuseId: requestedByShipId,
    action: str(r, 'action'),
    reason: str(r, 'reason'),
    scope,
    status,
    decidedBy: nstr(r, 'decided_by'),
    decidedAt: nstr(r, 'decided_at'),
    expiresAt: nstr(r, 'expires_at'),
    createdAt: str(r, 'created_at'),
    ...(selectedOption !== null ? { selectedOption } : {}),
    ...(answer !== null ? { answer } : {}),
  }
}

function rowToPlan(r: Row): PlanRecord {
  const state = str(r, 'state') as PlanState
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    sessionId: str(r, 'session_id'),
    goal: str(r, 'goal'),
    state,
    tasks: parseJsonText<PlanTask[]>(nstr(r, 'tasks_json'), []),
    runId: nstr(r, 'run_id'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  }
}

function rowToVerificationCheck(r: Row): VerificationCheckRecord {
  const status = str(r, 'status')
  if (status !== 'pending' && status !== 'passed' && status !== 'failed' && status !== 'skipped') {
    throw new InternalError(`db row: invalid verification status '${status}'`)
  }
  const exitCode = r['exit_code']
  const durationMs = r['duration_ms']
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    runId: str(r, 'run_id'),
    taskId: nstr(r, 'task_id'),
    name: str(r, 'name'),
    command: parseJsonText<string[]>(nstr(r, 'command_json'), []),
    cwd: nstr(r, 'cwd'),
    workspaceId: nstr(r, 'workspace_id'),
    status,
    exitCode: exitCode === null || exitCode === undefined ? null : num(r, 'exit_code'),
    stdoutArtifact: nstr(r, 'stdout_artifact'),
    stderrArtifact: nstr(r, 'stderr_artifact'),
    durationMs: durationMs === null || durationMs === undefined ? null : num(r, 'duration_ms'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  }
}

function rowToEvent(r: Row): EventRecord {
  const shipId = nstr(r, 'ship_id')
  return {
    seq: num(r, 'seq'),
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    runId: nstr(r, 'run_id'),
    taskId: nstr(r, 'task_id'),
    shipId,
    museId: shipId,
    type: str(r, 'type'),
    payload: parseJsonText<JsonValue>(nstr(r, 'payload_json'), {}),
    createdAt: str(r, 'created_at'),
  }
}

function rowToChatSession(r: Row): ChatSessionRecord {
  const state = str(r, 'state')
  if (!(CHAT_SESSION_STATES as readonly string[]).includes(state)) {
    throw new InternalError(`db row: invalid chat session state '${state}'`)
  }
  const shipId = str(r, 'ship_id')
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    shipId,
    museId: shipId,
    title: nstr(r, 'title'),
    state: state as ChatSessionState,
    nativeSessionId: nstr(r, 'native_session_id'),
    resumeToken: nstr(r, 'resume_token'),
    engineSessionId: nstr(r, 'engine_session_id'),
    workspaceRoot: nstr(r, 'workspace_root'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  }
}

function rowToChatMessage(r: Row): ChatMessageRecord {
  const role = str(r, 'role')
  if (!(CHAT_MESSAGE_ROLES as readonly string[]).includes(role)) {
    throw new InternalError(`db row: invalid chat message role '${role}'`)
  }
  return {
    id: str(r, 'id'),
    sessionId: str(r, 'session_id'),
    seq: num(r, 'seq'),
    role: role as ChatMessageRole,
    text: str(r, 'text'),
    meta: parseJsonText<JsonValue>(nstr(r, 'meta_json'), {}),
    createdAt: str(r, 'created_at'),
  }
}

function rowToReceipt(r: Row): RequestReceiptRecord {
  const state = str(r, 'state')
  if (state !== 'accepted' && state !== 'completed' && state !== 'failed' && state !== 'conflict') {
    throw new InternalError(`db row: invalid receipt state '${state}'`)
  }
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    targetKind: str(r, 'target_kind') as RequestTargetKind,
    targetId: nstr(r, 'target_id'),
    payloadHash: str(r, 'payload_hash'),
    canonicalPayload: str(r, 'canonical_payload'),
    state,
    result: parseJsonText<JsonValue | null>(nstr(r, 'result_json'), null),
    error: parseJsonText<JsonValue | null>(nstr(r, 'error_json'), null),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  }
}
