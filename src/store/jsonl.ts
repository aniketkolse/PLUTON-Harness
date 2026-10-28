import type { Store } from './store.ts'
import { withTx } from './db.ts'
import {
  CHAT_MESSAGE_ROLES,
  CHAT_SESSION_STATES,
  type ChatSessionRecord,
  type ChatMessageRecord,
  type RunRecord,
  type TaskRecord,
  type TaskEdgeRecord,
  type EventRecord,
} from '../domain/models.ts'
import { isRunState, isTaskState, RUN_STATES, TASK_STATES } from '../domain/state.ts'
import { ValidationError, NotFoundError } from '../domain/errors.ts'
import { wouldCreateAncestorCycle, wouldCreateDependencyCycle } from '../domain/task-graph.ts'
import { resolveWorkspaceRoot } from '../util/workspace-root.ts'

export interface JsonlHeader {
  type: 'header'
  format: 'pluton-jsonl'
  version: 1
  entity: 'session' | 'run'
  exportedAt: string
}

export type SessionJsonlLine =
  | JsonlHeader
  | { type: 'session'; data: ChatSessionRecord }
  | { type: 'message'; data: ChatMessageRecord }

export type RunJsonlLine =
  | JsonlHeader
  | { type: 'run'; data: RunRecord }
  | { type: 'task'; data: TaskRecord }
  | { type: 'edge'; data: TaskEdgeRecord }
  | { type: 'event'; data: EventRecord }

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new ValidationError(`Invalid JSONL: ${label} must be an object`)
  return value
}

function requireString(obj: JsonRecord, key: string, label: string): string {
  const value = obj[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`Invalid JSONL: ${label}.${key} must be a non-empty string`)
  }
  return value
}

function parseHeader(raw: string, entity: 'session' | 'run'): JsonlHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ValidationError('Invalid JSONL header: could not parse JSON')
  }
  const header = requireRecord(parsed, 'header') as Partial<JsonlHeader>
  if (header.type !== 'header' || header.format !== 'pluton-jsonl') {
    throw new ValidationError('Invalid JSONL header: format must be pluton-jsonl')
  }
  if (header.entity !== entity) {
    throw new ValidationError(`Invalid JSONL entity: expected '${entity}', got '${String(header.entity)}'`)
  }
  if (header.version !== 1) {
    throw new ValidationError(
      `Unsupported JSONL version '${String(header.version)}'; this build reads version 1 only`,
    )
  }
  return header as JsonlHeader
}

function readLines(jsonl: string): string[] {
  return jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function parseLines(rawLines: string[]): Array<{ type: string; data: unknown; line: number }> {
  const records: Array<{ type: string; data: unknown; line: number }> = []
  for (let i = 1; i < rawLines.length; i++) {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawLines[i]!)
    } catch {
      throw new ValidationError(`Invalid JSONL at line ${i + 1}: syntax error`)
    }
    const rec = requireRecord(parsed, `line ${i + 1}`)
    if (typeof rec['type'] !== 'string') {
      throw new ValidationError(`Invalid JSONL at line ${i + 1}: missing record type`)
    }
    requireRecord(rec['data'], `line ${i + 1} data`)
    records.push({ type: rec['type'], data: rec['data'], line: i + 1 })
  }
  return records
}

/** Reject an import that would overwrite an existing row; imports never merge. */
function assertIdsFree(store: Store, table: string, ids: readonly string[], label: string): void {
  const seen = new Set<string>()
  const stmt = store.db.prepare(`SELECT 1 AS present FROM ${table} WHERE id = ?`)
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    if (stmt.get(id) !== undefined) {
      throw new ValidationError(
        `JSONL import would overwrite existing ${label} '${id}': nothing was imported. ` +
          'Choose a different target project or restore into an empty database.',
      )
    }
  }
}

function isConstraintFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /constraint failed/i.test(message)
}

function rethrowImportFailure(err: unknown, entity: string): never {
  if (err instanceof ValidationError) throw err
  if (isConstraintFailure(err)) {
    throw new ValidationError(
      `JSONL ${entity} import conflicted with existing records; the transaction was rolled back and nothing was imported`,
      { cause: err },
    )
  }
  throw err
}

function assertProjectExists(store: Store, projectId: string): void {
  const project = store.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
  if (project === undefined) {
    throw new ValidationError(`Target project '${projectId}' does not exist`)
  }
}

/**
 * Exports must never silently truncate. `listEvents` defaults to the newest 50
 * and `listChatMessages` to the newest 1000, so both export callers pass an
 * explicit unbounded limit.
 */
const EXPORT_ALL_LIMIT = Number.MAX_SAFE_INTEGER

/**
 * Imported workspace roots are host-specific absolute paths. Accept one only
 * when it resolves to a readable directory on this host; otherwise fail closed.
 * Cross-host restores pass an explicit override (CLI: --workspace-root).
 */
function resolveImportedWorkspaceRoot(
  value: unknown,
  label: string,
  override?: string,
): string | null {
  const candidate = override !== undefined ? override : value
  if (candidate === null || candidate === undefined) return null
  if (typeof candidate !== 'string') {
    throw new ValidationError(`Invalid JSONL: ${label}.workspaceRoot must be a string or null`)
  }
  const source = override !== undefined ? 'the --workspace-root override' : `${label}.workspaceRoot`
  try {
    return resolveWorkspaceRoot(candidate)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new ValidationError(
      `Invalid JSONL: ${source} '${candidate}' cannot be used on this host: ${detail}. ` +
        'Absolute workspace paths are host-specific; pass --workspace-root with a local directory.',
      { cause: err },
    )
  }
}

export function exportSessionToJsonl(store: Store, sessionId: string): string {
  const session = store.getChatSessionOrNull(sessionId)
  if (!session) {
    throw new NotFoundError('chat session', sessionId)
  }
  const messages = store.listChatMessages(sessionId, { limit: EXPORT_ALL_LIMIT })

  const header: JsonlHeader = {
    type: 'header',
    format: 'pluton-jsonl',
    version: 1,
    entity: 'session',
    exportedAt: new Date().toISOString(),
  }

  const lines: string[] = [JSON.stringify(header)]
  lines.push(JSON.stringify({ type: 'session', data: session }))
  for (const msg of messages) {
    lines.push(JSON.stringify({ type: 'message', data: msg }))
  }

  return lines.join('\n') + '\n'
}

export function importSessionFromJsonl(
  store: Store,
  jsonl: string,
  opts: { targetProjectId?: string; workspaceRoot?: string } = {},
): { session: ChatSessionRecord; messageCount: number } {
  const rawLines = readLines(jsonl)
  if (rawLines.length === 0) {
    throw new ValidationError('Invalid JSONL: content is empty')
  }

  const header = parseHeader(rawLines[0]!, 'session')
  const records = parseLines(rawLines)

  let sessionData: ChatSessionRecord | null = null
  const messages: ChatMessageRecord[] = []

  for (const rec of records) {
    if (rec.type === 'session') {
      if (sessionData) {
        throw new ValidationError(`Invalid JSONL: duplicate session entry at line ${rec.line}`)
      }
      sessionData = rec.data as ChatSessionRecord
    } else if (rec.type === 'message') {
      messages.push(rec.data as ChatMessageRecord)
    } else {
      throw new ValidationError(`Invalid JSONL: unexpected '${rec.type}' record in a session export`)
    }
  }

  if (!sessionData) {
    throw new ValidationError('Invalid JSONL: no session entry found')
  }
  const sessionObj = requireRecord(sessionData, 'session')
  requireString(sessionObj, 'id', 'session')
  requireString(sessionObj, 'shipId', 'session')
  requireString(sessionObj, 'createdAt', 'session')
  if (
    sessionData.state !== undefined &&
    sessionData.state !== null &&
    !(CHAT_SESSION_STATES as readonly string[]).includes(sessionData.state)
  ) {
    throw new ValidationError(
      `Invalid JSONL: session.state must be one of ${CHAT_SESSION_STATES.join(', ')}`,
    )
  }

  const targetProjectId = opts.targetProjectId ?? sessionData.projectId
  requireString({ projectId: targetProjectId }, 'projectId', 'target')
  assertProjectExists(store, targetProjectId)
  if (store.getShip(sessionData.shipId) === null) {
    throw new ValidationError(
      `JSONL session '${sessionData.id}' references Ship '${sessionData.shipId}', which does not exist in the target project; create the Ship first`,
    )
  }
  const workspaceRoot = resolveImportedWorkspaceRoot(
    sessionData.workspaceRoot,
    `session '${sessionData.id}'`,
    opts.workspaceRoot,
  )

  const messageIds = new Set<string>()
  const sequenceKeys = new Set<string>()
  for (const [index, message] of messages.entries()) {
    const label = `message[${index}]`
    const msg = requireRecord(message, label)
    requireString(msg, 'id', label)
    requireString(msg, 'role', label)
    requireString(msg, 'sessionId', label)
    requireString(msg, 'text', label)
    requireString(msg, 'createdAt', label)
    if (!(CHAT_MESSAGE_ROLES as readonly string[]).includes(message.role)) {
      throw new ValidationError(`Invalid JSONL: ${label}.role must be one of ${CHAT_MESSAGE_ROLES.join(', ')}`)
    }
    if (typeof msg['seq'] !== 'number' || !Number.isInteger(msg['seq']) || (msg['seq'] as number) < 1) {
      throw new ValidationError(`Invalid JSONL: ${label}.seq must be a positive integer`)
    }
    if (message.sessionId !== sessionData.id) {
      throw new ValidationError(
        `Invalid JSONL: ${label} belongs to session '${message.sessionId}', not '${sessionData.id}'`,
      )
    }
    if (messageIds.has(message.id)) {
      throw new ValidationError(`Invalid JSONL: duplicate message id '${message.id}'`)
    }
    messageIds.add(message.id)
    const sequenceKey = `${sessionData.id}:${message.seq}`
    if (sequenceKeys.has(sequenceKey)) {
      throw new ValidationError(`Invalid JSONL: duplicate message sequence ${message.seq} for the session`)
    }
    sequenceKeys.add(sequenceKey)
  }

  assertIdsFree(store, 'chat_sessions', [sessionData.id], 'session')
  assertIdsFree(store, 'chat_messages', messages.map((message) => message.id), 'chat message')

  try {
    withTx(store.db, () => {
      store.db
        .prepare(
          `INSERT INTO chat_sessions (
            id, project_id, ship_id, title, state, native_session_id, resume_token,
            engine_session_id, workspace_root, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionData.id,
          targetProjectId,
          sessionData.shipId,
          sessionData.title ?? null,
          sessionData.state ?? 'active',
          sessionData.nativeSessionId ?? null,
          sessionData.resumeToken ?? null,
          sessionData.engineSessionId ?? null,
          workspaceRoot,
          sessionData.createdAt,
          sessionData.updatedAt ?? sessionData.createdAt,
        )

      const insertMsg = store.db.prepare(
        `INSERT INTO chat_messages (
          id, session_id, seq, role, text, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )

      for (const msg of messages) {
        insertMsg.run(
          msg.id,
          sessionData.id,
          msg.seq,
          msg.role,
          msg.text,
          JSON.stringify(msg.meta ?? {}),
          msg.createdAt,
        )
      }
    })
  } catch (err) {
    rethrowImportFailure(err, 'session')
  }

  return {
    session: store.getChatSession(sessionData.id),
    messageCount: messages.length,
  }
}

export function exportRunToJsonl(store: Store, runId: string): string {
  const run = store.getRunOrNull(runId)
  if (!run) {
    throw new NotFoundError('run', runId)
  }
  const tasks = store.listTasks(runId)
  const edges = store.listEdges(runId)
  // listEvents returns the newest 50 by default; export the complete run in
  // chronological (seq ASC) order so import replays it faithfully.
  const events = store.listEvents(runId, { limit: EXPORT_ALL_LIMIT }).reverse()

  const header: JsonlHeader = {
    type: 'header',
    format: 'pluton-jsonl',
    version: 1,
    entity: 'run',
    exportedAt: new Date().toISOString(),
  }

  const lines: string[] = [JSON.stringify(header)]
  lines.push(JSON.stringify({ type: 'run', data: run }))
  for (const task of tasks) {
    lines.push(JSON.stringify({ type: 'task', data: task }))
  }
  for (const edge of edges) {
    lines.push(JSON.stringify({ type: 'edge', data: edge }))
  }
  for (const event of events) {
    lines.push(JSON.stringify({ type: 'event', data: event }))
  }

  return lines.join('\n') + '\n'
}

export function importRunFromJsonl(
  store: Store,
  jsonl: string,
  opts: { targetProjectId?: string; workspaceRoot?: string } = {},
): { run: RunRecord; taskCount: number; eventCount: number } {
  const rawLines = readLines(jsonl)
  if (rawLines.length === 0) {
    throw new ValidationError('Invalid JSONL: content is empty')
  }

  const header = parseHeader(rawLines[0]!, 'run')
  const records = parseLines(rawLines)

  let runData: RunRecord | null = null
  const tasks: TaskRecord[] = []
  const edges: TaskEdgeRecord[] = []
  const events: EventRecord[] = []

  for (const rec of records) {
    if (rec.type === 'run') {
      if (runData) {
        throw new ValidationError(`Invalid JSONL: duplicate run entry at line ${rec.line}`)
      }
      runData = rec.data as RunRecord
    } else if (rec.type === 'task') {
      tasks.push(rec.data as TaskRecord)
    } else if (rec.type === 'edge') {
      edges.push(rec.data as TaskEdgeRecord)
    } else if (rec.type === 'event') {
      events.push(rec.data as EventRecord)
    } else {
      throw new ValidationError(`Invalid JSONL: unexpected '${rec.type}' record in a run export`)
    }
  }

  if (!runData) {
    throw new ValidationError('Invalid JSONL: no run entry found')
  }
  const runObj = requireRecord(runData, 'run')
  requireString(runObj, 'id', 'run')
  requireString(runObj, 'goal', 'run')
  requireString(runObj, 'state', 'run')
  requireString(runObj, 'managerShipId', 'run')
  requireString(runObj, 'createdAt', 'run')
  if (!isRunState(runData.state)) {
    throw new ValidationError(`Invalid JSONL: run.state must be one of ${RUN_STATES.join(', ')}`)
  }
  if (
    runData.origin !== undefined &&
    runData.origin !== null &&
    runData.origin !== 'cli' &&
    runData.origin !== 'api'
  ) {
    throw new ValidationError(`Invalid JSONL: run.origin must be 'cli' or 'api'`)
  }
  if (store.getShip(runData.managerShipId) === null) {
    throw new ValidationError(
      `JSONL run '${runData.id}' references manager Ship '${runData.managerShipId}', which does not exist in the target project`,
    )
  }
  const workspaceRoot = resolveImportedWorkspaceRoot(
    runData.workspaceRoot,
    `run '${runData.id}'`,
    opts.workspaceRoot,
  )

  const taskIds = new Set<string>()
  for (const [index, task] of tasks.entries()) {
    const label = `task[${index}]`
    const taskObj = requireRecord(task, label)
    requireString(taskObj, 'id', label)
    requireString(taskObj, 'runId', label)
    requireString(taskObj, 'title', label)
    requireString(taskObj, 'state', label)
    requireString(taskObj, 'createdAt', label)
    if (!isTaskState(task.state)) {
      throw new ValidationError(`Invalid JSONL: ${label}.state must be one of ${TASK_STATES.join(', ')}`)
    }
    if (task.runId !== runData.id) {
      throw new ValidationError(`Invalid JSONL: ${label} belongs to run '${task.runId}', not '${runData.id}'`)
    }
    if (taskIds.has(task.id)) {
      throw new ValidationError(`Invalid JSONL: duplicate task id '${task.id}'`)
    }
    taskIds.add(task.id)
    if (task.assigneeShipId !== undefined && task.assigneeShipId !== null && store.getShip(task.assigneeShipId) === null) {
      throw new ValidationError(
        `Invalid JSONL: ${label} references Ship '${task.assigneeShipId}', which does not exist in the target project`,
      )
    }
  }
  for (const [index, task] of tasks.entries()) {
    if (task.parentTaskId !== null && task.parentTaskId !== undefined) {
      if (task.parentTaskId === task.id) {
        throw new ValidationError(`Invalid JSONL: task[${index}] cannot be its own parent`)
      }
      if (!taskIds.has(task.parentTaskId)) {
        throw new ValidationError(
          `Invalid JSONL: task[${index}] references parent '${task.parentTaskId}', which is not in the export`,
        )
      }
      if (wouldCreateAncestorCycle(tasks, task.id, task.parentTaskId)) {
        throw new ValidationError(
          `Invalid JSONL: task[${index}] parent '${task.parentTaskId}' creates an ancestor cycle`,
        )
      }
    }
    if (task.rootTaskId !== undefined && task.rootTaskId !== null && !taskIds.has(task.rootTaskId)) {
      throw new ValidationError(
        `Invalid JSONL: task[${index}] references root '${task.rootTaskId}', which is not in the export`,
      )
    }
  }

  // Reconcile the denormalized hierarchy fields with the parent chain instead
  // of trusting them. A wrong depth/root would corrupt delegation limits and
  // graph projections even though every foreign key happened to resolve.
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const hierarchy = new Map<string, { depth: number; rootTaskId: string }>()
  const hierarchyFor = (taskId: string): { depth: number; rootTaskId: string } => {
    const cached = hierarchy.get(taskId)
    if (cached) return cached
    const task = tasksById.get(taskId)
    if (!task) throw new ValidationError(`Invalid JSONL: task '${taskId}' is not in the export`)
    const parentId = task.parentTaskId ?? null
    const resolved = parentId === null
      ? { depth: 0, rootTaskId: task.id }
      : (() => {
          const parent = hierarchyFor(parentId)
          return { depth: parent.depth + 1, rootTaskId: parent.rootTaskId }
        })()
    hierarchy.set(taskId, resolved)
    return resolved
  }
  for (const [index, task] of tasks.entries()) {
    const expected = hierarchyFor(task.id)
    if (task.depth !== expected.depth) {
      throw new ValidationError(
        `Invalid JSONL: task[${index}].depth is ${String(task.depth)}, expected ${expected.depth} from its parent chain`,
      )
    }
    if (task.rootTaskId !== expected.rootTaskId) {
      throw new ValidationError(
        `Invalid JSONL: task[${index}].rootTaskId is '${String(task.rootTaskId)}', expected '${expected.rootTaskId}' from its parent chain`,
      )
    }
  }

  // Parents must be inserted before children: the tasks table has a
  // self-referencing foreign key and JSONL line order is not guaranteed.
  const orderedTasks: TaskRecord[] = []
  const orderedIds = new Set<string>()
  const appendTask = (task: TaskRecord): void => {
    if (orderedIds.has(task.id)) return
    orderedIds.add(task.id)
    if (task.parentTaskId !== null && task.parentTaskId !== undefined) {
      const parent = tasksById.get(task.parentTaskId)
      if (parent) appendTask(parent)
    }
    orderedTasks.push(task)
  }
  for (const task of tasks) appendTask(task)

  const edgeKeys = new Set<string>()
  const acceptedEdges: TaskEdgeRecord[] = []
  for (const [index, edge] of edges.entries()) {
    const label = `edge[${index}]`
    const edgeObj = requireRecord(edge, label)
    requireString(edgeObj, 'runId', label)
    requireString(edgeObj, 'fromTaskId', label)
    requireString(edgeObj, 'toTaskId', label)
    if (edge.runId !== runData.id) {
      throw new ValidationError(`Invalid JSONL: ${label} belongs to run '${edge.runId}', not '${runData.id}'`)
    }
    if (!taskIds.has(edge.fromTaskId) || !taskIds.has(edge.toTaskId)) {
      throw new ValidationError(`Invalid JSONL: ${label} references a task that is not in the export`)
    }
    if (edge.fromTaskId === edge.toTaskId) {
      throw new ValidationError(`Invalid JSONL: ${label} is a self-dependency`)
    }
    if (edge.kind !== undefined && edge.kind !== 'depends_on') {
      throw new ValidationError(`Invalid JSONL: ${label}.kind must be 'depends_on'`)
    }
    const key = `${edge.fromTaskId}\u0000${edge.toTaskId}\u0000${edge.kind ?? 'depends_on'}`
    if (edgeKeys.has(key)) throw new ValidationError(`Invalid JSONL: duplicate ${label}`)
    if (wouldCreateDependencyCycle(acceptedEdges, edge.fromTaskId, edge.toTaskId)) {
      throw new ValidationError(`Invalid JSONL: ${label} would create a dependency cycle`)
    }
    edgeKeys.add(key)
    acceptedEdges.push({
      runId: edge.runId,
      fromTaskId: edge.fromTaskId,
      toTaskId: edge.toTaskId,
      kind: 'depends_on',
    })
  }

  const eventIds = new Set<string>()
  for (const [index, event] of events.entries()) {
    const label = `event[${index}]`
    const eventObj = requireRecord(event, label)
    requireString(eventObj, 'id', label)
    requireString(eventObj, 'runId', label)
    requireString(eventObj, 'type', label)
    requireString(eventObj, 'createdAt', label)
    if (event.runId !== runData.id) {
      throw new ValidationError(`Invalid JSONL: ${label} belongs to run '${event.runId}', not '${runData.id}'`)
    }
    if (event.taskId !== undefined && event.taskId !== null && !taskIds.has(event.taskId)) {
      throw new ValidationError(`Invalid JSONL: ${label} references a task that is not in the export`)
    }
    if (eventIds.has(event.id)) {
      throw new ValidationError(`Invalid JSONL: duplicate event id '${event.id}'`)
    }
    eventIds.add(event.id)
  }

  const targetProjectId = opts.targetProjectId ?? runData.projectId
  requireString({ projectId: targetProjectId }, 'projectId', 'target')
  assertProjectExists(store, targetProjectId)

  assertIdsFree(store, 'runs', [runData.id], 'run')
  assertIdsFree(store, 'tasks', tasks.map((task) => task.id), 'task')
  assertIdsFree(store, 'events', events.map((event) => event.id), 'event')

  try {
    withTx(store.db, () => {
      store.db
        .prepare(
          `INSERT INTO runs (
            id, project_id, goal, origin, requested_by, state, acceptance_json,
            manager_ship_id, budget_json, supervisor_pid, created_at, started_at,
            completed_at, final_summary, workspace_root, origin_session_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runData.id,
          targetProjectId,
          runData.goal,
          runData.origin ?? 'cli',
          runData.requestedBy ?? 'operator',
          runData.state,
          JSON.stringify(runData.acceptanceCriteria ?? []),
          runData.managerShipId ?? 'supervisor',
          JSON.stringify(runData.budget ?? {}),
          runData.supervisorPid ?? null,
          runData.createdAt,
          runData.startedAt ?? null,
          runData.completedAt ?? null,
          runData.finalSummary ?? null,
          workspaceRoot,
          runData.originSessionId ?? null,
        )

      const insertTask = store.db.prepare(
        `INSERT INTO tasks (
          id, run_id, parent_task_id, root_task_id, depth, title, brief,
          acceptance_json, write_scope_json, assignee_ship_id, state, attempt,
          workspace_id, engine_session_id, result_json, failure_json, assignment_json,
          created_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const task of orderedTasks) {
        const expected = hierarchyFor(task.id)
        insertTask.run(
          task.id,
          runData.id,
          task.parentTaskId ?? null,
          expected.rootTaskId,
          expected.depth,
          task.title,
          task.brief ?? '',
          JSON.stringify(task.acceptanceCriteria ?? []),
          JSON.stringify(task.writeScope ?? []),
          task.assigneeShipId ?? null,
          task.state,
          task.attempt ?? 0,
          task.workspaceId ?? null,
          task.engineSessionId ?? null,
          task.result ? JSON.stringify(task.result) : null,
          task.failure ? JSON.stringify(task.failure) : null,
          task.assignment ? JSON.stringify(task.assignment) : null,
          task.createdAt,
          task.startedAt ?? null,
          task.completedAt ?? null,
        )
      }

      const insertEdge = store.db.prepare(
        `INSERT INTO task_edges (run_id, from_task_id, to_task_id, kind) VALUES (?, ?, ?, ?)`,
      )
      for (const edge of edges) {
        insertEdge.run(runData.id, edge.fromTaskId, edge.toTaskId, edge.kind ?? 'depends_on')
      }

      const insertEvent = store.db.prepare(
        `INSERT INTO events (
          id, project_id, run_id, task_id, ship_id, type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const event of events) {
        insertEvent.run(
          event.id,
          targetProjectId,
          runData.id,
          event.taskId ?? null,
          event.shipId ?? null,
          event.type,
          JSON.stringify(event.payload ?? {}),
          event.createdAt,
        )
      }
    })
  } catch (err) {
    rethrowImportFailure(err, 'run')
  }

  return {
    run: store.getRun(runData.id),
    taskCount: tasks.length,
    eventCount: events.length,
  }
}
