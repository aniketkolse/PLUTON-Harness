import { ValidationError } from '../../domain/errors.ts'
import type { EventRecord } from '../../domain/models.ts'
import {
  MAX_EVENT_QUERY_LIMIT,
  queryEvents,
  type EventPage,
} from '../../store/query.ts'
import type { Store } from '../../store/store.ts'
import { terminalSafeLine } from '../../util/sanitize.ts'
import { runByRef } from './status.ts'

/**
 * `pluton logs` — the operator/SDK read surface over the durable event log.
 *
 * Cursor contract (O1): the page's `nextAfter` is the Last-Event-ID
 * equivalent. A client loops `--after <nextAfter>` until `hasMore` is false.
 * Filtering happens in SQL before the limit, so a long run's events can never
 * be crowded out of the window by traffic from other runs (the defect the old
 * `eventsSince(...).filter(...)` scan had).
 */

export interface RawLogsArgs {
  /** Positional run reference (`pluton logs <run>`). */
  run?: string
  /** `--run` option; merged with the positional form by `normalizeLogsArgs`. */
  runOption?: string
  after?: string
  limit?: string
  type?: readonly string[]
  task?: string
  ship?: string
  since?: string
  until?: string
}

export interface LogsOptions {
  runRef: string | null
  afterSeq: number
  limit: number
  types: string[]
  taskId: string | null
  shipId: string | null
  since: string | null
  until: string | null
}

export interface LogsView extends EventPage {
  /** Resolved run id when the query was scoped to a run. */
  runId: string | null
}

/** Commander collector: `--type a --type b` → ['a', 'b']. */
export function collectLogType(value: string, previous: readonly string[] = []): string[] {
  return [...previous, value]
}

function parseNonNegativeInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ValidationError(`${flag} must be a non-negative integer`)
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed)) throw new ValidationError(`${flag} is out of range`)
  return parsed
}

export function normalizeLogsArgs(raw: RawLogsArgs): LogsOptions {
  if (raw.run !== undefined && raw.runOption !== undefined && raw.run !== raw.runOption) {
    throw new ValidationError('run id given twice with different values (positional and --run)')
  }
  const runRef = raw.run ?? raw.runOption ?? null
  if (runRef !== null && runRef.length === 0) {
    throw new ValidationError('run id must be a non-empty string')
  }

  const afterSeq = raw.after === undefined ? 0 : parseNonNegativeInt(raw.after, '--after')
  const limit = raw.limit === undefined ? 50 : parseNonNegativeInt(raw.limit, '--limit')
  if (limit < 1 || limit > MAX_EVENT_QUERY_LIMIT) {
    throw new ValidationError(`--limit must be an integer between 1 and ${MAX_EVENT_QUERY_LIMIT}`)
  }

  const types: string[] = []
  for (const type of raw.type ?? []) {
    if (type.trim().length === 0) throw new ValidationError('--type must be a non-empty string')
    if (!types.includes(type)) types.push(type)
  }

  return {
    runRef,
    afterSeq,
    limit,
    types,
    taskId: raw.task ?? null,
    shipId: raw.ship ?? null,
    since: raw.since ?? null,
    until: raw.until ?? null,
  }
}

/**
 * Resolve the run reference (full id or unique suffix) inside the project,
 * then read one cursor page. Because the store is project-scoped, a run that
 * resolves but belongs to another project is reported as not found rather
 * than leaking foreign event rows into this project's log.
 */
export function logsView(store: Store, projectId: string, raw: RawLogsArgs): LogsView {
  const opts = normalizeLogsArgs(raw)
  let runId: string | null = null
  if (opts.runRef !== null) {
    const run = runByRef(store, opts.runRef)
    if (run.projectId !== projectId) {
      throw new ValidationError(`run ${run.id} does not belong to this project`)
    }
    runId = run.id
  }

  const page = queryEvents(store, {
    projectId,
    afterSeq: opts.afterSeq,
    ...(runId !== null ? { runId } : {}),
    ...(opts.taskId !== null ? { taskId: opts.taskId } : {}),
    ...(opts.shipId !== null ? { shipId: opts.shipId } : {}),
    ...(opts.types.length > 0 ? { types: opts.types } : {}),
    ...(opts.since !== null ? { since: opts.since } : {}),
    ...(opts.until !== null ? { until: opts.until } : {}),
    limit: opts.limit,
  })
  return { runId, ...page }
}

function payloadPreview(payload: EventRecord['payload']): string {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 0) {
    return ''
  }
  const text = terminalSafeLine(JSON.stringify(payload) ?? 'null')
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

export function formatLogsHuman(view: LogsView): string {
  const lines = view.events.map((event) => {
    const type = terminalSafeLine(event.type)
    const refs = [
      event.runId !== null ? `run=${event.runId.slice(-8)}` : null,
      event.taskId !== null ? `task=${event.taskId.slice(-8)}` : null,
      event.shipId !== null ? `ship=${event.shipId}` : null,
    ]
      .filter((part): part is string => part !== null)
      .map((part) => terminalSafeLine(part))
      .join(' ')
    const preview = payloadPreview(event.payload)
    return `#${String(event.seq).padStart(6)}  ${event.createdAt}  ${type}${refs.length > 0 ? `  ${refs}` : ''}${preview.length > 0 ? `  ${preview}` : ''}`
  })

  if (lines.length === 0) {
    const scope = view.runId !== null ? ` for run ${view.runId}` : ''
    lines.push(`no events matched${scope}`)
  }
  const more = view.hasMore ? ', more available' : ''
  lines.push(`cursor #${view.nextAfter}${more}  head #${view.headSeq}  limit ${view.limit}`)
  return lines.join('\n')
}
