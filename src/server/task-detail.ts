import { existsSync } from 'node:fs'
import type { EventRecord, JsonValue, TaskRecord } from '../domain/models.ts'
import type { Store } from '../store/store.ts'
import { stripControlChars } from '../util/sanitize.ts'
import { GitWorkspaceManager } from '../workspace/manager.ts'
import { ActivityMapper } from './activity.ts'
import type {
  RunActivityItem,
  TaskDetailCheck,
  TaskDetailMessage,
  TaskDetailToolCall,
  TaskDetailView,
} from './types.ts'

/**
 * Authoritative worker detail (PLUTON 3.0, Phase 5).
 *
 * Everything shown in the modal comes from the durable store: the task row,
 * its event history, the real workspace, verification rows, and the result /
 * failure columns. Nothing is reconstructed from UI cache, and nothing here
 * mutates or cancels the worker.
 */

const MAX_DETAIL_EVENTS = 2_000
const MAX_LIST = 200
const MAX_TEXT = 8_000

function objectOf(value: JsonValue | null): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null
}

function str(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? stripControlChars(value) : null
}

function bounded(value: string | null, max = MAX_TEXT): string | null {
  if (value === null) return null
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function numberOrNull(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArray(value: JsonValue | undefined, max = MAX_LIST): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, max)
    .map((item) => stripControlChars(item))
}

/** A message event concerns this task when either endpoint names it. */
function messageConcernsTask(event: EventRecord, task: TaskRecord): boolean {
  if (event.type !== 'worker.message') return false
  const payload = objectOf(event.payload)
  if (payload === null) return false
  if (str(payload['senderTaskId']) === task.id) return true
  if (str(payload['recipientTaskId']) === task.id) return true
  // A ship-wide message (no recipient task) can be read by any session of the
  // assignee Ship; showing it is honest about its real addressing.
  return (
    str(payload['recipientTaskId']) === null &&
    task.assigneeShipId !== null &&
    str(payload['recipientShipId']) === task.assigneeShipId
  )
}

function messageView(event: EventRecord, task: TaskRecord): TaskDetailMessage | null {
  const payload = objectOf(event.payload)
  if (payload === null) return null
  const id = str(payload['messageId'])
  const recipientShipId = str(payload['recipientShipId'])
  const kind = str(payload['kind'])
  const body = str(payload['body'])
  if (id === null || recipientShipId === null || kind === null || body === null) return null
  const senderTaskId = str(payload['senderTaskId'])
  const recipientTaskId = str(payload['recipientTaskId'])
  const incoming = recipientTaskId === task.id || (recipientTaskId === null && recipientShipId === task.assigneeShipId)
  const createdAt = numberOrNull(payload['createdAt']) ?? Date.parse(event.createdAt)
  return {
    id,
    seq: event.seq,
    direction: incoming ? 'in' : 'out',
    senderShipId: str(payload['senderShipId']),
    senderLabel: str(payload['senderLabel']) ?? 'worker',
    senderTaskId,
    recipientShipId,
    recipientLabel: str(payload['recipientLabel']) ?? recipientShipId,
    recipientTaskId,
    kind,
    body,
    replyTo: str(payload['replyTo']),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  }
}

interface ChangedFiles {
  changed: string[]
  untracked: string[]
  truncated: boolean
}

const EMPTY_FILES: ChangedFiles = { changed: [], untracked: [], truncated: false }

/**
 * The real checkout diff, bounded to paths. A missing/removed/foreign checkout
 * is reported as no files, never guessed from the task title or result text.
 */
async function changedFilesFor(store: Store, task: TaskRecord, workspacesRoot: string | null): Promise<ChangedFiles> {
  if (workspacesRoot === null) return EMPTY_FILES
  const workspace = store.getWorkspaceByTask(task.id)
  if (workspace === null || !existsSync(workspace.path)) return EMPTY_FILES
  try {
    const manager = new GitWorkspaceManager({ workspacesRoot })
    const diff = await manager.captureDiff(workspace.path)
    const changed = new Set<string>()
    for (const line of diff.diff.split(/\r?\n/)) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      if (match !== null && match[2] !== undefined) changed.add(stripControlChars(match[2]))
    }
    return {
      changed: [...changed].sort().slice(0, MAX_LIST),
      untracked: diff.untracked.slice(0, MAX_LIST).map((path) => stripControlChars(path)),
      truncated: diff.truncated,
    }
  } catch {
    return EMPTY_FILES
  }
}

export interface BuildTaskDetailOptions {
  /** Per-task checkouts root; null/omitted keeps the files section honest-empty. */
  workspacesRoot?: string | null
}

/**
 * Build one task's detail, or null when the task does not exist in that run.
 * Read-only: no state transition, no cancellation, no session interaction.
 */
export async function buildTaskDetail(
  store: Store,
  runId: string,
  taskId: string,
  options: BuildTaskDetailOptions = {},
): Promise<TaskDetailView | null> {
  const run = store.getRunOrNull(runId)
  if (run === null) return null
  const task = store.getTaskOrNull(taskId)
  if (task === null || task.runId !== runId) return null

  const ship = task.assigneeShipId !== null ? store.getShip(task.assigneeShipId) : null
  const assignment = objectOf(task.assignment)
  const role = assignment === null ? null : str(assignment['role'])
  const engine = assignment === null ? null : str(assignment['engine'])
  const model = assignment === null ? null : str(assignment['model'])
  const workspace = store.getWorkspaceByTask(task.id)

  const all = store.listEvents(runId, { limit: MAX_DETAIL_EVENTS }).slice().reverse()
  const taskEvents = all.filter(
    (event) => event.taskId === task.id || messageConcernsTask(event, task),
  )

  const mapper = new ActivityMapper(store)
  const activity: RunActivityItem[] = []
  const supervisorActivity: RunActivityItem[] = []
  const messages: TaskDetailMessage[] = []
  const toolCalls: TaskDetailToolCall[] = []
  let retryScheduled = 0
  let revisions = 0
  let leaseBlockers = 0

  for (const event of taskEvents) {
    if (event.type === 'task.retry_scheduled') retryScheduled += 1
    if (event.type === 'task.revision_scheduled') revisions += 1
    if (event.type === 'task.blocked_by_lease') leaseBlockers += 1

    if (event.type === 'worker.message') {
      const message = messageView(event, task)
      if (message !== null) messages.push(message)
    }

    if (event.type === 'worker.progress') {
      const payload = objectOf(event.payload)
      const step = payload === null ? null : str(payload['step'])
      if (step !== null) {
        toolCalls.push({
          seq: event.seq,
          at: event.createdAt,
          step,
          isError: payload !== null && payload['isError'] === true,
        })
      }
    }

    const mapped = mapper.map(event)
    if (mapped !== null) {
      activity.push(mapped)
      const managerMessage =
        event.type === 'worker.message' && mapped.actor === 'worker' &&
        (objectOf(event.payload)?.['senderShipId'] === run.managerShipId || mapped.actorLabel === 'Supervisor')
      if (
        mapped.actor === 'supervisor' ||
        mapped.type === 'task.admitted' ||
        mapped.type === 'task.revision_scheduled' ||
        mapped.type === 'task.cancelled_by_tool' ||
        managerMessage
      ) {
        supervisorActivity.push(mapped)
      }
    }
  }

  const checks: TaskDetailCheck[] = store.listVerificationChecksByTask(task.id).map((check) => ({
    name: stripControlChars(check.name),
    status: check.status,
    exitCode: check.exitCode,
    durationMs: check.durationMs,
    attempt: check.attempt,
    note: null,
  }))
  const verification = store.getTaskVerification(task.id)

  const edges = store.listEdges(runId).filter((edge) => edge.fromTaskId === task.id)
  const diff = await changedFilesFor(store, task, options.workspacesRoot ?? null)
  const assigneeName = ship?.displayName ?? null
  const canMessage =
    task.assigneeShipId !== null &&
    ship !== null &&
    ship.enabled &&
    !['completed', 'failed', 'cancelled', 'interrupted', 'unknown_outcome'].includes(task.state) &&
    !['completed', 'failed', 'cancelled', 'uncertain'].includes(run.state)

  return {
    runId,
    runState: run.state,
    task: {
      id: task.id,
      title: stripControlChars(task.title),
      brief: bounded(stripControlChars(task.brief)) ?? '',
      state: task.state,
      attempt: task.attempt,
      parentTaskId: task.parentTaskId,
      assigneeShipId: task.assigneeShipId,
      assigneeName,
      role,
      engine,
      model: model ?? ship?.model ?? null,
      workspaceId: workspace?.id ?? null,
      workspacePath: workspace?.path ?? null,
      writeScope: (task.writeScope ?? []).slice(0, MAX_LIST).map((path) => stripControlChars(path)),
      dependsOn: edges.map((edge) => edge.toTaskId).slice(0, MAX_LIST),
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    },
    acceptanceCriteria: task.acceptanceCriteria.slice(0, MAX_LIST).map((criterion) => stripControlChars(criterion)),
    activity: activity.slice(-MAX_LIST),
    supervisorActivity: supervisorActivity.slice(-MAX_LIST),
    messages: messages.slice(-MAX_LIST),
    toolCalls: toolCalls.slice(-MAX_LIST),
    files: diff,
    verification: {
      verdict: verification?.verdict ?? null,
      checks,
      criteria: verification?.criteria ?? null,
      tamper: verification?.tamper ?? null,
      evidence: verification?.evidence ?? null,
    },
    retries: {
      attempts: task.attempt,
      retryScheduled,
      revisions,
      leaseBlockers,
    },
    result: task.result,
    failure: task.failure,
    canMessage,
  }
}
