import type { DatabaseSync } from 'node:sqlite'
import { ConflictError, InternalError, NotFoundError, ValidationError } from '../domain/errors.ts'
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
  type ApprovalRecord,
  type ApprovalStatus,
  type ChatMessageRecord,
  type ChatMessageRole,
  type ChatSessionRecord,
  type ChatSessionState,
  type EventRecord,
  type JsonValue,
  type MuseRecord,
  type ProjectRecord,
  type RequestReceiptRecord,
  type RequestTargetKind,
  type RunBudget,
  type RunRecord,
  type SandboxRecord,
  type TaskEdgeRecord,
  type TaskRecord,
  type TerminalRecord,
  type VerificationCheckRecord,
  type WorkspaceRecord,
} from '../domain/models.ts'
import { canonicalJson, payloadHash } from '../util/canonical.ts'
import { redactDeep } from '../util/redact.ts'
import { withTx } from './db.ts'

/**
 * Durable store (ADR-0002/ADR-0006). All multi-write operations run inside one
 * BEGIN IMMEDIATE transaction, so receipts, state and events are committed
 * atomically: a crash either leaves everything or nothing.
 *
 * Rule enforced here (prompt §5): the store never invents success. Transitions
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

function stringifyJson(v: unknown): string {
  const text = JSON.stringify(v)
  if (text === undefined) throw new InternalError('cannot serialize undefined to JSON')
  return text
}

const nowIso = (): string => new Date().toISOString()

// ---------------------------------------------------------------------------
// Input specs
// ---------------------------------------------------------------------------

export interface NewProjectSpec {
  name: string
  rootPath: string
  configPath: string
  defaultBranch: string
}

export interface MuseSyncSpec {
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

export interface NewRunSpec {
  projectId: string
  goal: string
  origin: 'cli' | 'api'
  requestedBy: string
  acceptanceCriteria: string[]
  managerMuseId: string
  budget: RunBudget
}

export interface NewTaskSpec {
  runId: string
  parentTaskId: string | null
  title: string
  brief: string
  acceptanceCriteria: string[]
  assigneeMuseId: string | null
  writeScope?: string[]
}

export interface AppendEventInput {
  projectId: string
  runId?: string | null
  taskId?: string | null
  museId?: string | null
  type: string
  payload?: JsonValue
  /** Hard cap for the serialized payload (prompt §2.4 bounded payloads). */
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
  museId: string | null
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
  /** argv array — never a shell string. */
  command: string[]
  cwd: string | null
  workspaceId: string | null
}

export interface UpsertSandboxSpec {
  projectId: string
  museId: string | null
  kind: SandboxRecord['kind']
  containerName: string | null
  containerId: string | null
  image: string | null
  state: SandboxState
  createdBy: string
}

export interface UpsertTerminalSpec {
  projectId: string
  museId: string
  sandboxId: string | null
  tmuxSessionName: string
  state: TerminalRecord['state']
}

export interface NewApprovalSpec {
  projectId: string
  runId: string | null
  taskId: string | null
  requestedByMuseId: string | null
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

  // -- project / muses -------------------------------------------------------

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

  listMuses(): MuseRecord[] {
    return (this.db.prepare('SELECT * FROM muses ORDER BY id').all() as Row[]).map(rowToMuse)
  }

  getMuse(id: string): MuseRecord | null {
    const row = this.db.prepare('SELECT * FROM muses WHERE id = ?').get(id) as Row | undefined
    return row ? rowToMuse(row) : null
  }

  updateMuseModel(id: string, model: string): void {
    const now = nowIso()
    const res = this.db.prepare('UPDATE muses SET model = ?, updated_at = ? WHERE id = ?').run(model, now, id)
    if (res.changes === 0) {
      throw new NotFoundError('muse', id)
    }
  }

  /** Upsert all configured muses; rows absent from the config are disabled (never deleted). */
  syncMuses(projectId: string, specs: MuseSyncSpec[]): { upserted: number; disabled: number } {
    return withTx(this.db, () => {
      const now = nowIso()
      const upsert = this.db.prepare(
        `INSERT INTO muses (id, project_id, slug, display_name, role, engine_kind, model, instructions_file,
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
        const r = this.db.prepare('UPDATE muses SET enabled = 0, updated_at = ? WHERE enabled = 1').run(now)
        disabled = Number(r.changes)
      } else {
        const placeholders = specs.map(() => '?').join(',')
        const r = this.db
          .prepare(`UPDATE muses SET enabled = 0, updated_at = ? WHERE enabled = 1 AND id NOT IN (${placeholders})`)
          .run(now, ...specs.map((s) => s.id))
        disabled = Number(r.changes)
      }
      return { upserted: specs.length, disabled }
    })
  }

  // -- runs ------------------------------------------------------------------

  createRun(spec: NewRunSpec): RunRecord {
    const id = newId('run')
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, goal, origin, requested_by, state, acceptance_json, manager_muse_id,
                           budget_json, supervisor_pid, created_at, started_at, completed_at, final_summary)
         VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, NULL, ?, NULL, NULL, NULL)`,
      )
      .run(
        id,
        spec.projectId,
        spec.goal,
        spec.origin,
        spec.requestedBy,
        stringifyJson(spec.acceptanceCriteria),
        spec.managerMuseId,
        stringifyJson(spec.budget),
        now,
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

  setRunState(
    id: string,
    to: RunState,
    patch: { supervisorPid?: number | null; finalSummary?: string | null } = {},
  ): RunRecord {
    const run = this.getRun(id)
    assertRunTransition(run.state, to)
    const now = nowIso()
    const startedAt = run.startedAt ?? (to === 'active' ? now : null)
    const completedAt = isTerminalRunState(to) ? (run.completedAt ?? now) : run.completedAt
    this.db
      .prepare(
        `UPDATE runs SET state = ?, supervisor_pid = ?, started_at = ?, completed_at = ?, final_summary = ?
         WHERE id = ?`,
      )
      .run(
        to,
        patch.supervisorPid !== undefined ? patch.supervisorPid : run.supervisorPid,
        startedAt,
        completedAt,
        patch.finalSummary !== undefined ? patch.finalSummary : run.finalSummary,
        id,
      )
    return this.getRun(id)
  }

  // -- tasks -----------------------------------------------------------------

  createTask(spec: NewTaskSpec): TaskRecord {
    const parent = spec.parentTaskId ? this.getTask(spec.parentTaskId) : null
    if (spec.parentTaskId && !parent) throw new NotFoundError('parent task', spec.parentTaskId)
    if (parent && parent.runId !== spec.runId) {
      throw new ValidationError(`parent task ${parent.id} belongs to run ${parent.runId}, not ${spec.runId}`)
    }
    const id = newId('task')
    const now = nowIso()
    try {
      this.db
        .prepare(
          `INSERT INTO tasks (id, run_id, parent_task_id, root_task_id, depth, title, brief, acceptance_json,
                              write_scope_json, assignee_muse_id, state, attempt, workspace_id, engine_session_id,
                              result_json, failure_json, created_at, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', 0, NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
        )
        .run(
          id,
          spec.runId,
          spec.parentTaskId,
          parent ? parent.rootTaskId : id,
          parent ? parent.depth + 1 : 0,
          spec.title,
          spec.brief,
          stringifyJson(spec.acceptanceCriteria),
          stringifyJson(spec.writeScope ?? []),
          spec.assigneeMuseId,
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

  setTaskState(
    id: string,
    to: TaskState,
    patch: {
      attempt?: number
      result?: JsonValue | null
      failure?: JsonValue | null
      workspaceId?: string | null
      engineSessionId?: string | null
    } = {},
  ): TaskRecord {
    const task = this.getTask(id)
    assertTransition(task.state, to)
    const now = nowIso()
    const startedAt = task.startedAt ?? (to === 'running' ? now : null)
    const completedAt = TERMINAL_TASK_STATES.has(to) ? (task.completedAt ?? now) : task.completedAt
    this.db
      .prepare(
        `UPDATE tasks SET state = ?, attempt = ?, workspace_id = ?, engine_session_id = ?,
                          result_json = ?, failure_json = ?, started_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        to,
        patch.attempt !== undefined ? patch.attempt : task.attempt,
        patch.workspaceId !== undefined ? patch.workspaceId : task.workspaceId,
        patch.engineSessionId !== undefined ? patch.engineSessionId : task.engineSessionId,
        patch.result !== undefined ? (patch.result === null ? null : stringifyJson(patch.result)) : task.result === null ? null : stringifyJson(task.result),
        patch.failure !== undefined ? (patch.failure === null ? null : stringifyJson(patch.failure)) : task.failure === null ? null : stringifyJson(task.failure),
        startedAt,
        completedAt,
        id,
      )
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

  createWorkspace(spec: NewWorkspaceSpec): WorkspaceRecord {
    const id = newId('workspace')
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO workspaces (id, project_id, run_id, task_id, muse_id, kind, path, branch, base_commit,
                                 head_commit, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?)`,
      )
      .run(
        id,
        spec.projectId,
        spec.runId,
        spec.taskId,
        spec.museId,
        spec.kind,
        spec.path,
        spec.branch,
        spec.baseCommit,
        now,
        now,
      )
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
  ): WorkspaceRecord {
    const ws = this.getWorkspace(id)
    const now = nowIso()
    this.db
      .prepare('UPDATE workspaces SET head_commit = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.headCommit !== undefined ? patch.headCommit : ws.headCommit,
        patch.state ?? ws.state,
        now,
        id,
      )
    return this.getWorkspace(id)
  }

  // -- sandboxes (one long-lived container per Muse, ADR-0004) --------------

  /**
   * One sandbox row per (project, muse), re-upserting keeps the same record id.
   * Backed by the NULL-safe unique index `idx_sandboxes_project_muse` (v2): the
   * insert and the conflicting update are one atomic statement, so two
   * concurrent writers cannot both insert — the loser updates the winner's row
   * (excluded.id is never assigned, so id/created_by/created_at stay stable).
   */
  upsertSandbox(spec: UpsertSandboxSpec): SandboxRecord {
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO sandboxes (id, project_id, muse_id, kind, container_name, container_id, image, state,
                                created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, IFNULL(muse_id,'')) DO UPDATE SET
           kind = excluded.kind,
           container_name = excluded.container_name,
           container_id = excluded.container_id,
           image = excluded.image,
           state = excluded.state,
           updated_at = excluded.updated_at`,
      )
      .run(
        newId('sandbox'),
        spec.projectId,
        spec.museId,
        spec.kind,
        spec.containerName,
        spec.containerId,
        spec.image,
        spec.state,
        spec.createdBy,
        now,
        now,
      )
    const saved = this.getSandboxForMuse(spec.projectId, spec.museId)
    if (!saved) throw new InternalError('sandbox row disappeared inside upsert')
    return saved
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

  getSandboxForMuse(projectId: string, museId: string | null): SandboxRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sandboxes WHERE project_id = ? AND muse_id IS ? ORDER BY created_at DESC LIMIT 1')
      .get(projectId, museId) as Row | undefined
    return row ? rowToSandbox(row) : null
  }

  listSandboxes(projectId: string): SandboxRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sandboxes WHERE project_id = ? ORDER BY created_at DESC, id DESC')
      .all(projectId) as Row[]
    return rows.map(rowToSandbox)
  }

  setSandboxState(
    id: string,
    state: SandboxState,
    patch: { containerId?: string | null; containerName?: string | null; image?: string | null } = {},
  ): SandboxRecord {
    const sb = this.getSandbox(id)
    this.db
      .prepare(
        `UPDATE sandboxes SET state = ?, container_id = ?, container_name = ?, image = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        state,
        patch.containerId !== undefined ? patch.containerId : sb.containerId,
        patch.containerName !== undefined ? patch.containerName : sb.containerName,
        patch.image !== undefined ? patch.image : sb.image,
        nowIso(),
        id,
      )
    return this.getSandbox(id)
  }

  // -- terminals (tmux per Muse, ADR-0005) -----------------------------------

  /**
   * One terminal row per (project, muse), re-upserting keeps the same record id.
   * Same atomic single-statement upsert shape as upsertSandbox, backed by the
   * NULL-safe unique index `idx_terminals_project_muse` (v2).
   */
  upsertTerminal(spec: UpsertTerminalSpec): TerminalRecord {
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO terminals (id, project_id, muse_id, sandbox_id, tmux_session_name, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, IFNULL(muse_id,'')) DO UPDATE SET
           sandbox_id = excluded.sandbox_id,
           tmux_session_name = excluded.tmux_session_name,
           state = excluded.state,
           updated_at = excluded.updated_at`,
      )
      .run(
        newId('terminal'),
        spec.projectId,
        spec.museId,
        spec.sandboxId,
        spec.tmuxSessionName,
        spec.state,
        now,
        now,
      )
    const saved = this.getTerminalForMuse(spec.projectId, spec.museId)
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

  getTerminalForMuse(projectId: string, museId: string): TerminalRecord | null {
    const row = this.db
      .prepare('SELECT * FROM terminals WHERE project_id = ? AND muse_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(projectId, museId) as Row | undefined
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

  // -- approvals (human gate, prompt §4/§7) ----------------------------------

  createApproval(spec: NewApprovalSpec): ApprovalRecord {
    const id = newId('approval')
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO approvals (id, project_id, run_id, task_id, requested_by_muse_id, action, reason, scope_json,
                                 status, decided_by, decided_at, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        spec.projectId,
        spec.runId,
        spec.taskId,
        spec.requestedByMuseId,
        spec.action,
        spec.reason,
        stringifyJson(spec.scope),
        spec.expiresAt ?? null,
        now,
      )
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
   * arrived is flipped to `expired` (fail-closed — it can never be approved),
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
   * final — the evidence must not be rewritten.
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
  setApprovalStatus(id: string, status: ApprovalStatus, patch: { decidedBy?: string | null } = {}): ApprovalRecord {
    const approval = this.getApproval(id)
    if (approval.status === status) return approval
    if (approval.status !== 'pending') {
      throw new ValidationError(
        `approval ${id} is already ${approval.status}; ${approval.status} -> ${status} is not a legal transition (only pending approvals can be decided)`,
      )
    }
    const now = nowIso()
    this.db
      .prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
      .run(status, patch.decidedBy ?? null, now, id)
    return this.getApproval(id)
  }

  // -- events ----------------------------------------------------------------

  appendEvent(input: AppendEventInput): EventRecord {
    const payload = redactDeep(input.payload ?? {})
    const payloadJson = canonicalJson(payload)
    const maxChars = input.maxChars ?? DEFAULT_MAX_EVENT_CHARS
    if (payloadJson.length > maxChars) {
      throw new ValidationError(
        `event payload too large: ${payloadJson.length} chars > ${maxChars} (type '${input.type}') — bound the payload at the writer`,
        { details: { type: input.type, size: payloadJson.length, maxChars } },
      )
    }
    const id = newId('event')
    const now = nowIso()
    const res = this.db
      .prepare(
        `INSERT INTO events (id, project_id, run_id, task_id, muse_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.runId ?? null,
        input.taskId ?? null,
        input.museId ?? null,
        input.type,
        payloadJson,
        now,
      )
    const seq = Number(res.lastInsertRowid)
    return {
      seq,
      id,
      projectId: input.projectId,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      museId: input.museId ?? null,
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

  createChatSession(spec: { projectId: string; museId: string; title?: string | null }): ChatSessionRecord {
    const id = newId('chat')
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO chat_sessions (id, project_id, muse_id, title, state, native_session_id, resume_token,
                                    engine_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)`,
      )
      .run(id, spec.projectId, spec.museId, spec.title ?? null, now, now)
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
    sets.push('updated_at = ?')
    values.push(nowIso())
    this.db.prepare(`UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    return this.getChatSession(id)
  }

  /** Newest session for (project, muse) by updated_at (ties broken by id DESC); null when none. */
  getLatestChatSession(projectId: string, museId: string): ChatSessionRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM chat_sessions WHERE project_id = ? AND muse_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
      )
      .get(projectId, museId) as Row | undefined
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

  // -- receipts (idempotency core, §5) ---------------------------------------

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
  recordLease(lease: {
    id: string
    runId: string
    taskId: string
    museId: string
    path: string
    symbols?: string[]
    acquiredAt?: string
    state?: 'active' | 'released'
  }): void {
    const now = nowIso()
    this.db
      .prepare(
        `INSERT OR REPLACE INTO file_leases (id, run_id, task_id, muse_id, path, symbols_json, acquired_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lease.id,
        lease.runId,
        lease.taskId,
        lease.museId,
        lease.path,
        stringifyJson(lease.symbols ?? []),
        lease.acquiredAt ?? now,
        lease.state ?? 'active',
      )
  }

  releaseLeasesForTask(taskId: string): string[] {
    const rows = this.db.prepare(`SELECT path FROM file_leases WHERE task_id = ? AND state = 'active'`).all(taskId) as Row[]
    this.db.prepare(`UPDATE file_leases SET state = 'released' WHERE task_id = ? AND state = 'active'`).run(taskId)
    return rows.map((r) => str(r, 'path'))
  }

  listActiveLeases(runId: string): Array<{
    id: string
    runId: string
    taskId: string
    museId: string
    path: string
    symbols: string[]
    acquiredAt: string
    state: 'active' | 'released'
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM file_leases WHERE run_id = ? AND state = 'active' ORDER BY acquired_at ASC`)
      .all(runId) as Row[]
    return rows.map((r) => ({
      id: str(r, 'id'),
      runId: str(r, 'run_id'),
      taskId: str(r, 'task_id'),
      museId: str(r, 'muse_id'),
      path: str(r, 'path'),
      symbols: parseJsonText<string[]>(nstr(r, 'symbols_json'), []),
      acquiredAt: str(r, 'acquired_at'),
      state: str(r, 'state') as 'active' | 'released',
    }))
  }

  reapOrphanedLeases(activeTaskIds: Set<string>): void {
    const rows = this.db.prepare(`SELECT id, task_id FROM file_leases WHERE state = 'active'`).all() as Row[]
    const stmt = this.db.prepare(`UPDATE file_leases SET state = 'released' WHERE id = ?`)
    for (const r of rows) {
      const taskId = str(r, 'task_id')
      if (!activeTaskIds.has(taskId)) {
        stmt.run(str(r, 'id'))
      }
    }
  }

  // --- Run Usage ---
  recordUsage(input: {
    id?: string
    runId: string
    museId: string
    taskId?: string | null
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    costUsd?: number
  }): void {
    const id = input.id ?? newId('attempt')
    this.db
      .prepare(
        `INSERT INTO run_usage (id, run_id, muse_id, task_id, input_tokens, output_tokens, cached_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.museId,
        input.taskId ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cachedTokens ?? 0,
        input.costUsd ?? 0.0,
        nowIso(),
      )
  }

  getRunUsage(runId: string): {
    totalInputTokens: number
    totalOutputTokens: number
    totalCachedTokens: number
    totalCostUsd: number
    perMuse: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }>
  } {
    const rows = this.db
      .prepare(`SELECT muse_id, input_tokens, output_tokens, cached_tokens, cost_usd FROM run_usage WHERE run_id = ?`)
      .all(runId) as Row[]
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCachedTokens = 0
    let totalCostUsd = 0
    const perMuse: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }> = {}

    for (const r of rows) {
      const museId = str(r, 'muse_id')
      const inTok = num(r, 'input_tokens')
      const outTok = num(r, 'output_tokens')
      const cacheTok = num(r, 'cached_tokens')
      const cost = typeof r['cost_usd'] === 'number' ? r['cost_usd'] : 0

      totalInputTokens += inTok
      totalOutputTokens += outTok
      totalCachedTokens += cacheTok
      totalCostUsd += cost

      const entry = perMuse[museId] ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }
      entry.inputTokens += inTok
      entry.outputTokens += outTok
      entry.cachedTokens += cacheTok
      entry.costUsd += cost
      perMuse[museId] = entry
    }

    return { totalInputTokens, totalOutputTokens, totalCachedTokens, totalCostUsd, perMuse }
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
    const row = this.db
      .prepare(`SELECT * FROM verifications WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`)
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
// Row mappers — the only place DB text becomes typed records.
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

function rowToMuse(r: Row): MuseRecord {
  const role = str(r, 'role')
  const workspacePolicy = str(r, 'workspace_policy')
  const approvalMode = str(r, 'approval_mode')
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    slug: str(r, 'slug'),
    displayName: str(r, 'display_name'),
    role: role as MuseRecord['role'],
    engineKind: str(r, 'engine_kind'),
    model: str(r, 'model'),
    instructionsFile: nstr(r, 'instructions_file'),
    workspacePolicy: workspacePolicy as MuseRecord['workspacePolicy'],
    permissions: parseJsonText<string[]>(nstr(r, 'permissions_json'), []),
    approvalMode: approvalMode as MuseRecord['approvalMode'],
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
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    goal: str(r, 'goal'),
    origin,
    requestedBy: str(r, 'requested_by'),
    state,
    acceptanceCriteria: parseJsonText<string[]>(nstr(r, 'acceptance_json'), []),
    managerMuseId: str(r, 'manager_muse_id'),
    budget: parseJsonText<RunBudget>(nstr(r, 'budget_json'), {
      maxConcurrentWorkers: 1,
      maxTasks: 1,
      maxDelegationDepth: 0,
      maxRunMinutes: 1,
      defaultTaskMinutes: 1,
    }),
    supervisorPid: nnum(r, 'supervisor_pid'),
    createdAt: str(r, 'created_at'),
    startedAt: nstr(r, 'started_at'),
    completedAt: nstr(r, 'completed_at'),
    finalSummary: nstr(r, 'final_summary'),
  }
}

function rowToTask(r: Row): TaskRecord {
  const state = str(r, 'state')
  if (!isTaskState(state)) throw new InternalError(`db row: invalid task state '${state}'`)
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
    assigneeMuseId: nstr(r, 'assignee_muse_id'),
    state,
    attempt: num(r, 'attempt'),
    workspaceId: nstr(r, 'workspace_id'),
    engineSessionId: nstr(r, 'engine_session_id'),
    result: parseJsonText<JsonValue | null>(nstr(r, 'result_json'), null),
    failure: parseJsonText<JsonValue | null>(nstr(r, 'failure_json'), null),
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
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    runId: nstr(r, 'run_id'),
    taskId: nstr(r, 'task_id'),
    museId: nstr(r, 'muse_id'),
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
  if (kind !== 'docker' && kind !== 'local-process') {
    throw new InternalError(`db row: invalid sandbox kind '${kind}'`)
  }
  const state = str(r, 'state')
  if (!(SANDBOX_STATES as readonly string[]).includes(state)) {
    throw new InternalError(`db row: invalid sandbox state '${state}'`)
  }
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    museId: nstr(r, 'muse_id'),
    kind,
    containerName: nstr(r, 'container_name'),
    containerId: nstr(r, 'container_id'),
    image: nstr(r, 'image'),
    state: state as SandboxState,
    createdBy: str(r, 'created_by'),
    createdAt: str(r, 'created_at'),
    updatedAt: str(r, 'updated_at'),
  }
}

function rowToTerminal(r: Row): TerminalRecord {
  const state = str(r, 'state')
  if (state !== 'present' && state !== 'absent' && state !== 'recreated' && state !== 'unknown') {
    throw new InternalError(`db row: invalid terminal state '${state}'`)
  }
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    museId: str(r, 'muse_id'),
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
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    runId: nstr(r, 'run_id'),
    taskId: nstr(r, 'task_id'),
    requestedByMuseId: nstr(r, 'requested_by_muse_id'),
    action: str(r, 'action'),
    reason: str(r, 'reason'),
    scope: parseJsonText<JsonValue>(nstr(r, 'scope_json'), {}),
    status,
    decidedBy: nstr(r, 'decided_by'),
    decidedAt: nstr(r, 'decided_at'),
    expiresAt: nstr(r, 'expires_at'),
    createdAt: str(r, 'created_at'),
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
  return {
    seq: num(r, 'seq'),
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    runId: nstr(r, 'run_id'),
    taskId: nstr(r, 'task_id'),
    museId: nstr(r, 'muse_id'),
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
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    museId: str(r, 'muse_id'),
    title: nstr(r, 'title'),
    state: state as ChatSessionState,
    nativeSessionId: nstr(r, 'native_session_id'),
    resumeToken: nstr(r, 'resume_token'),
    engineSessionId: nstr(r, 'engine_session_id'),
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
