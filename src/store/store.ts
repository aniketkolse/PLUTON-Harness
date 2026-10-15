import type { DatabaseSync } from 'node:sqlite'
import { ConflictError, InternalError, NotFoundError, ValidationError } from '../domain/errors.ts'
import { newId } from '../domain/ids.ts'
import {
  assertRunTransition,
  assertTransition,
  isRunState,
  isTaskState,
  SANDBOX_STATES,
  TERMINAL_TASK_STATES,
  type RunState,
  type SandboxState,
  type TaskState,
} from '../domain/state.ts'
import type {
  EventRecord,
  JsonValue,
  MuseRecord,
  ProjectRecord,
  RequestReceiptRecord,
  RequestTargetKind,
  RunBudget,
  RunRecord,
  SandboxRecord,
  TaskEdgeRecord,
  TaskRecord,
  TerminalRecord,
  WorkspaceRecord,
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

const DEFAULT_MAX_EVENT_CHARS = 8_000

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  close(): void {
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

  listMuses(): MuseRecord[] {
    return (this.db.prepare('SELECT * FROM muses ORDER BY id').all() as Row[]).map(rowToMuse)
  }

  getMuse(id: string): MuseRecord | null {
    const row = this.db.prepare('SELECT * FROM muses WHERE id = ?').get(id) as Row | undefined
    return row ? rowToMuse(row) : null
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
                              assignee_muse_id, state, attempt, workspace_id, engine_session_id, result_json,
                              failure_json, created_at, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', 0, NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
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

  /** One sandbox row per (project, muse); re-upserting keeps the same record id. */
  upsertSandbox(spec: UpsertSandboxSpec): SandboxRecord {
    const existing = this.getSandboxForMuse(spec.projectId, spec.museId)
    const now = nowIso()
    if (existing) {
      this.db
        .prepare(
          `UPDATE sandboxes SET kind = ?, container_name = ?, container_id = ?, image = ?, state = ?,
                               updated_at = ? WHERE id = ?`,
        )
        .run(spec.kind, spec.containerName, spec.containerId, spec.image, spec.state, now, existing.id)
      return this.getSandboxOrNull(existing.id) as SandboxRecord
    }
    const id = newId('sandbox')
    this.db
      .prepare(
        `INSERT INTO sandboxes (id, project_id, muse_id, kind, container_name, container_id, image, state,
                                created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
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

  /** One terminal row per (project, muse); re-upserting keeps the same record id. */
  upsertTerminal(spec: UpsertTerminalSpec): TerminalRecord {
    const existing = this.getTerminalForMuse(spec.projectId, spec.museId)
    const now = nowIso()
    if (existing) {
      this.db
        .prepare('UPDATE terminals SET sandbox_id = ?, tmux_session_name = ?, state = ?, updated_at = ? WHERE id = ?')
        .run(spec.sandboxId, spec.tmuxSessionName, spec.state, now, existing.id)
      return this.getTerminal(existing.id)
    }
    const id = newId('terminal')
    this.db
      .prepare(
        `INSERT INTO terminals (id, project_id, muse_id, sandbox_id, tmux_session_name, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, spec.projectId, spec.museId, spec.sandboxId, spec.tmuxSessionName, spec.state, now, now)
    return this.getTerminal(id)
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
}

function isTerminalRunState(state: RunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'uncertain'
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
