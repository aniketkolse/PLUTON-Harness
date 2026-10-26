import type { Store } from './store.ts'
import type {
  ChatSessionRecord,
  ChatMessageRecord,
  RunRecord,
  TaskRecord,
  EventRecord,
} from '../domain/models.ts'
import { ValidationError, NotFoundError } from '../domain/errors.ts'

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
  | { type: 'event'; data: EventRecord }

export function exportSessionToJsonl(store: Store, sessionId: string): string {
  const session = store.getChatSessionOrNull(sessionId)
  if (!session) {
    throw new NotFoundError('chat session', sessionId)
  }
  const messages = store.listChatMessages(sessionId)

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
  opts: { targetProjectId?: string } = {},
): { session: ChatSessionRecord; messageCount: number } {
  const rawLines = jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (rawLines.length === 0) {
    throw new ValidationError('Invalid JSONL: content is empty')
  }

  let header: JsonlHeader
  try {
    header = JSON.parse(rawLines[0]!)
  } catch {
    throw new ValidationError('Invalid JSONL header: could not parse JSON')
  }

  if (header.type !== 'header' || header.format !== 'pluton-jsonl') {
    throw new ValidationError('Invalid JSONL header: format must be pluton-jsonl')
  }
  if (header.entity !== 'session') {
    throw new ValidationError(`Invalid JSONL entity: expected 'session', got '${header.entity}'`)
  }

  let sessionData: ChatSessionRecord | null = null
  const messages: ChatMessageRecord[] = []

  for (let i = 1; i < rawLines.length; i++) {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawLines[i]!)
    } catch {
      throw new ValidationError(`Invalid JSONL at line ${i + 1}: syntax error`)
    }
    const rec = parsed as { type?: string; data?: unknown }
    if (rec.type === 'session') {
      if (sessionData) {
        throw new ValidationError(`Invalid JSONL: duplicate session entry at line ${i + 1}`)
      }
      sessionData = rec.data as ChatSessionRecord
    } else if (rec.type === 'message') {
      messages.push(rec.data as ChatMessageRecord)
    }
  }

  if (!sessionData) {
    throw new ValidationError('Invalid JSONL: no session entry found')
  }

  const targetProjectId = opts.targetProjectId ?? sessionData.projectId
  const existingProject = store.db.prepare('SELECT id FROM projects WHERE id = ?').get(targetProjectId)
  if (!existingProject) {
    throw new ValidationError(`Target project '${targetProjectId}' does not exist`)
  }

  store.db.exec('BEGIN IMMEDIATE')
  try {
    store.db
      .prepare(
        `INSERT OR REPLACE INTO chat_sessions (
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
        sessionData.workspaceRoot ?? null,
        sessionData.createdAt,
        sessionData.updatedAt ?? sessionData.createdAt,
      )

    const insertMsg = store.db.prepare(
      `INSERT OR REPLACE INTO chat_messages (
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

    store.db.exec('COMMIT')
  } catch (err) {
    store.db.exec('ROLLBACK')
    throw err
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
  const events = store.listEvents(runId)

  const header: JsonlHeader = {
    type: 'header',
    format: 'pluton-jsonl',
    version: 1,
    entity: 'run',
    exportedAt: new Date().toISOString(),
  }

  const lines: string[] = [JSON.stringify(header)]
  lines.push(JSON.stringify({ type: 'run', data: run }))
  for (const t of tasks) {
    lines.push(JSON.stringify({ type: 'task', data: t }))
  }
  for (const e of events) {
    lines.push(JSON.stringify({ type: 'event', data: e }))
  }

  return lines.join('\n') + '\n'
}

export function importRunFromJsonl(
  store: Store,
  jsonl: string,
  opts: { targetProjectId?: string } = {},
): { run: RunRecord; taskCount: number; eventCount: number } {
  const rawLines = jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (rawLines.length === 0) {
    throw new ValidationError('Invalid JSONL: content is empty')
  }

  let header: JsonlHeader
  try {
    header = JSON.parse(rawLines[0]!)
  } catch {
    throw new ValidationError('Invalid JSONL header: could not parse JSON')
  }

  if (header.type !== 'header' || header.format !== 'pluton-jsonl') {
    throw new ValidationError('Invalid JSONL header: format must be pluton-jsonl')
  }
  if (header.entity !== 'run') {
    throw new ValidationError(`Invalid JSONL entity: expected 'run', got '${header.entity}'`)
  }

  let runData: RunRecord | null = null
  const tasks: TaskRecord[] = []
  const events: EventRecord[] = []

  for (let i = 1; i < rawLines.length; i++) {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawLines[i]!)
    } catch {
      throw new ValidationError(`Invalid JSONL at line ${i + 1}: syntax error`)
    }
    const rec = parsed as { type?: string; data?: unknown }
    if (rec.type === 'run') {
      if (runData) {
        throw new ValidationError(`Invalid JSONL: duplicate run entry at line ${i + 1}`)
      }
      runData = rec.data as RunRecord
    } else if (rec.type === 'task') {
      tasks.push(rec.data as TaskRecord)
    } else if (rec.type === 'event') {
      events.push(rec.data as EventRecord)
    }
  }

  if (!runData) {
    throw new ValidationError('Invalid JSONL: no run entry found')
  }

  const targetProjectId = opts.targetProjectId ?? runData.projectId
  const existingProject = store.db.prepare('SELECT id FROM projects WHERE id = ?').get(targetProjectId)
  if (!existingProject) {
    throw new ValidationError(`Target project '${targetProjectId}' does not exist`)
  }

  store.db.exec('BEGIN IMMEDIATE')
  try {
    store.db
      .prepare(
        `INSERT OR REPLACE INTO runs (
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
        runData.workspaceRoot ?? null,
        runData.originSessionId ?? null,
      )

    const insertTask = store.db.prepare(
      `INSERT OR REPLACE INTO tasks (
        id, run_id, parent_task_id, root_task_id, depth, title, brief,
        acceptance_json, write_scope_json, assignee_ship_id, state, attempt,
        workspace_id, engine_session_id, result_json, failure_json, assignment_json,
        created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const t of tasks) {
      insertTask.run(
        t.id,
        runData.id,
        t.parentTaskId ?? null,
        t.rootTaskId ?? t.id,
        t.depth ?? 0,
        t.title,
        t.brief ?? '',
        JSON.stringify(t.acceptanceCriteria ?? []),
        JSON.stringify(t.writeScope ?? []),
        t.assigneeShipId ?? null,
        t.state,
        t.attempt ?? 0,
        t.workspaceId ?? null,
        t.engineSessionId ?? null,
        t.result ? JSON.stringify(t.result) : null,
        t.failure ? JSON.stringify(t.failure) : null,
        t.assignment ? JSON.stringify(t.assignment) : null,
        t.createdAt,
        t.startedAt ?? null,
        t.completedAt ?? null,
      )
    }

    const insertEvent = store.db.prepare(
      `INSERT OR REPLACE INTO events (
        id, project_id, run_id, task_id, ship_id, type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const e of events) {
      insertEvent.run(
        e.id,
        targetProjectId,
        runData.id,
        e.taskId ?? null,
        e.shipId ?? null,
        e.type,
        JSON.stringify(e.payload ?? {}),
        e.createdAt,
      )
    }

    store.db.exec('COMMIT')
  } catch (err) {
    store.db.exec('ROLLBACK')
    throw err
  }

  return {
    run: store.getRun(runData.id),
    taskCount: tasks.length,
    eventCount: events.length,
  }
}
