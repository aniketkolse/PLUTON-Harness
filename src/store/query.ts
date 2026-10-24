import { ValidationError } from '../domain/errors.ts'
import type { ApprovalRecord, EventRecord, JsonValue } from '../domain/models.ts'
import type { Store } from './store.ts'

/**
 * Read model over the append-only event log (P2 / parity R2, O1).
 *
 * The durable log is ordered by a global monotonic `seq` (SQLite rowid). This
 * module is the only place that turns "what happened after seq N, optionally
 * filtered" into a page plus a cursor, so every reader (CLI `pluton logs`,
 * `status --run`, future SDK) shares the same no-gap/no-duplicate semantics.
 * It is deliberately read-only and schema-additive: no migration, no writes.
 *
 * `afterSeq` is the Last-Event-ID equivalent: pass the previous page's
 * `nextAfter` to continue. Because filtering happens in SQL *before* the
 * limit, a page never silently skips matching rows buried behind another
 * run's events (the historical `eventsSince(...).filter(...)` defect).
 */

type Row = Record<string, unknown>

export const DEFAULT_EVENT_QUERY_LIMIT = 50
export const MAX_EVENT_QUERY_LIMIT = 1_000
/** Bound on the number of `type` values accepted in one query. */
export const MAX_EVENT_TYPE_FILTERS = 50

export interface EventQuery {
  projectId: string
  /** Exclusive lower bound (Last-Event-ID). Default 0 = from the beginning. */
  afterSeq?: number
  runId?: string
  taskId?: string
  shipId?: string
  types?: readonly string[]
  /** Inclusive ISO-8601 lower bound on `created_at`. */
  since?: string
  /** Inclusive ISO-8601 upper bound on `created_at`. */
  until?: string
  limit?: number
}

export interface EventPage {
  events: EventRecord[]
  /** Cursor to pass as `afterSeq` for the next page (last returned seq). */
  nextAfter: number
  hasMore: boolean
  limit: number
  /** Newest matching event seq, independent of the page window. */
  headSeq: number
}

export interface RecentEventQuery {
  projectId: string
  runId?: string
  taskId?: string
  shipId?: string
  types?: readonly string[]
  since?: string
  until?: string
  limit?: number
}

export interface TaskStateProjection {
  taskCounts: Record<string, number>
  totalTasks: number
}

export interface RunUsageProjection {
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedTokens: number
  totalCostUsd: number
  perShip: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }>
  /** @deprecated Use `perShip`; kept for backward compatibility. */
  perMuse: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }>
}

export interface RunProjection {
  runId: string
  taskCounts: Record<string, number>
  totalTasks: number
  pendingApprovals: number
  usage: RunUsageProjection
  headSeq: number
}

function str(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new ValidationError(`event query: expected string at '${key}', got ${typeof value}`)
  }
  return value
}

function nstr(row: Row, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new ValidationError(`event query: expected string|null at '${key}', got ${typeof value}`)
  }
  return value
}

function num(row: Row, key: string): number {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new ValidationError(`event query: expected number at '${key}', got ${typeof value}`)
}

function nnum(row: Row, key: string): number | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new ValidationError(`event query: expected number|null at '${key}', got ${typeof value}`)
}

function parseJsonText<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ValidationError('event query: invalid JSON stored in events.payload_json')
  }
}

function rowToEvent(row: Row): EventRecord {
  const shipId = nstr(row, 'ship_id')
  return {
    seq: num(row, 'seq'),
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    runId: nstr(row, 'run_id'),
    taskId: nstr(row, 'task_id'),
    shipId,
    museId: shipId,
    type: str(row, 'type'),
    payload: parseJsonText<JsonValue>(nstr(row, 'payload_json'), {}),
    createdAt: str(row, 'created_at'),
  }
}

interface NormalizedQuery {
  projectId: string
  afterSeq: number
  runId: string | null
  taskId: string | null
  shipId: string | null
  types: string[]
  since: string | null
  until: string | null
  limit: number
}

function isoBound(value: string, field: string): string {
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    throw new ValidationError(`event query: ${field} must be an ISO-8601 timestamp`)
  }
  return new Date(ms).toISOString()
}

function optionalRef(value: string | undefined, field: string): string | null {
  if (value === undefined) return null
  if (value.length === 0) throw new ValidationError(`event query: ${field} must be a non-empty string`)
  return value
}

function normalizeQuery(query: EventQuery): NormalizedQuery {
  if (query.projectId.length === 0) {
    throw new ValidationError('event query: projectId must be a non-empty string')
  }
  const afterSeq = query.afterSeq ?? 0
  if (!Number.isInteger(afterSeq) || afterSeq < 0) {
    throw new ValidationError('event query: afterSeq must be a non-negative integer')
  }
  const limit = query.limit ?? DEFAULT_EVENT_QUERY_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_QUERY_LIMIT) {
    throw new ValidationError(`event query: limit must be an integer between 1 and ${MAX_EVENT_QUERY_LIMIT}`)
  }

  const rawTypes = query.types ?? []
  if (rawTypes.length > MAX_EVENT_TYPE_FILTERS) {
    throw new ValidationError(`event query: at most ${MAX_EVENT_TYPE_FILTERS} type filters are allowed`)
  }
  const types: string[] = []
  for (const type of rawTypes) {
    if (type.trim().length === 0) throw new ValidationError('event query: type filters must be non-empty strings')
    if (!types.includes(type)) types.push(type)
  }

  const since = query.since === undefined ? null : isoBound(query.since, 'since')
  const until = query.until === undefined ? null : isoBound(query.until, 'until')
  if (since !== null && until !== null && since > until) {
    throw new ValidationError('event query: since must not be after until')
  }

  return {
    projectId: query.projectId,
    afterSeq,
    runId: optionalRef(query.runId, 'runId'),
    taskId: optionalRef(query.taskId, 'taskId'),
    shipId: optionalRef(query.shipId, 'shipId'),
    types,
    since,
    until,
    limit,
  }
}

/** SQL predicate shared by the page, head and recent-event queries. */
function filterSql(query: NormalizedQuery): { sql: string; params: Array<string | number> } {
  const clauses: string[] = ['project_id = ?']
  const params: Array<string | number> = [query.projectId]
  if (query.runId !== null) {
    clauses.push('run_id = ?')
    params.push(query.runId)
  }
  if (query.taskId !== null) {
    clauses.push('task_id = ?')
    params.push(query.taskId)
  }
  if (query.shipId !== null) {
    clauses.push('ship_id = ?')
    params.push(query.shipId)
  }
  if (query.types.length > 0) {
    clauses.push(`type IN (${query.types.map(() => '?').join(', ')})`)
    params.push(...query.types)
  }
  if (query.since !== null) {
    clauses.push('created_at >= ?')
    params.push(query.since)
  }
  if (query.until !== null) {
    clauses.push('created_at <= ?')
    params.push(query.until)
  }
  return { sql: clauses.join(' AND '), params }
}

/**
 * One ascending page of durable events. Call repeatedly with `nextAfter`
 * until `hasMore` is false; rows appended between pages are returned exactly
 * once because the cursor is the last seen global `seq`.
 */
export function queryEvents(store: Store, query: EventQuery): EventPage {
  const normalized = normalizeQuery(query)
  const filter = filterSql(normalized)
  // Fetch one extra row to distinguish "exactly limit" from "more available"
  // without a second COUNT query over the same predicate.
  const rows = store.db
    .prepare(`SELECT * FROM events WHERE ${filter.sql} AND seq > ? ORDER BY seq ASC LIMIT ?`)
    .all(...filter.params, normalized.afterSeq, normalized.limit + 1) as Row[]

  const hasMore = rows.length > normalized.limit
  const events = rows.slice(0, normalized.limit).map(rowToEvent)
  const last = events[events.length - 1]
  const nextAfter = last === undefined ? normalized.afterSeq : last.seq

  const headRow = store.db
    .prepare(`SELECT MAX(seq) AS seq FROM events WHERE ${filter.sql}`)
    .get(...filter.params) as Row | undefined
  const headSeq = headRow === undefined ? 0 : (nnum(headRow, 'seq') ?? 0)

  return { events, nextAfter, hasMore, limit: normalized.limit, headSeq }
}

/**
 * Newest matching events, oldest-first. Used by `status --run` so the view
 * reflects the run's true tail rather than the last N rows of a project-wide
 * scan that another run's traffic can push out of the window.
 */
export function recentEvents(store: Store, query: RecentEventQuery): EventRecord[] {
  const limit = query.limit ?? DEFAULT_EVENT_QUERY_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_QUERY_LIMIT) {
    throw new ValidationError(`event query: limit must be an integer between 1 and ${MAX_EVENT_QUERY_LIMIT}`)
  }
  const normalized = normalizeQuery({ ...query, afterSeq: 0, limit })
  const filter = filterSql(normalized)
  const rows = store.db
    .prepare(`SELECT * FROM events WHERE ${filter.sql} ORDER BY seq DESC LIMIT ?`)
    .all(...filter.params, limit) as Row[]
  return rows.map(rowToEvent).reverse()
}

/** Task-state histogram for one run (projection: "tasks by state in run"). */
export function taskStateCounts(store: Store, runId: string): TaskStateProjection {
  const taskCounts: Record<string, number> = {}
  const tasks = store.listTasks(runId)
  for (const task of tasks) taskCounts[task.state] = (taskCounts[task.state] ?? 0) + 1
  return { taskCounts, totalTasks: tasks.length }
}

/** Pending approvals of one run, newest first (projection: "pending approvals"). */
export function pendingApprovalsForRun(store: Store, runId: string): ApprovalRecord[] {
  return store.listApprovals(runId).filter((approval) => approval.status === 'pending')
}

/** Durable usage totals for one run, per Ship (projection: "usage per Ship"). */
export function usageForRun(store: Store, runId: string): RunUsageProjection {
  return store.getRunUsage(runId)
}

/**
 * One call for the run inspector / future SDK: task counts, pending approvals,
 * usage and the run's newest event seq. The run must exist and belong to the
 * project; an unknown or cross-project id is a typed not-found (never an empty
 * projection that looks like "nothing happened").
 */
export function runProjection(store: Store, projectId: string, runId: string): RunProjection {
  const run = store.getRun(runId)
  if (run.projectId !== projectId) {
    throw new ValidationError(`run ${runId} does not belong to project ${projectId}`)
  }
  const tasks = taskStateCounts(store, runId)
  const head = store.db
    .prepare('SELECT MAX(seq) AS seq FROM events WHERE project_id = ? AND run_id = ?')
    .get(projectId, runId) as Row | undefined
  return {
    runId,
    taskCounts: tasks.taskCounts,
    totalTasks: tasks.totalTasks,
    pendingApprovals: pendingApprovalsForRun(store, runId).length,
    usage: usageForRun(store, runId),
    headSeq: head === undefined ? 0 : (nnum(head, 'seq') ?? 0),
  }
}
