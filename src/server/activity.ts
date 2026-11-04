import type { EventRecord, ShipRecord, TaskRecord } from '../domain/models.ts'
import type { Store } from '../store/store.ts'
import { stripControlChars } from '../util/sanitize.ts'
import type { RunActivityItem, RunActivityTone } from './types.ts'

/**
 * Durable event → concise conversation progress (PLUTON 3.0, Phase 3).
 *
 * One mapper, used by both the live log watcher and the REST recovery
 * endpoint, so the main conversation can never diverge from the durable log.
 * Low-level tool chatter stays out: only meaningful lifecycle transitions,
 * communication, blockers and verification become activity items.
 */

const MAX_TEXT = 260
const MAX_DETAIL = 400

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function clip(value: string, max: number): string {
  const clean = stripControlChars(value).replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/** Worker events persist their payload both nested (`payload`) and flattened. */
function eventData(event: EventRecord): Record<string, unknown> {
  const top = objectOf(event.payload) ?? {}
  const nested = objectOf(top['payload'])
  return nested !== null ? { ...nested, ...top } : top
}

function messageVerb(kind: string): string {
  switch (kind) {
    case 'finding':
      return 'shared a finding'
    case 'evidence':
      return 'shared evidence'
    case 'contract':
      return 'shared an interface contract'
    case 'blocker':
      return 'reported a blocker'
    case 'question':
      return 'asked a question'
    case 'handoff':
      return 'handed off work'
    case 'instruction':
      return 'sent an instruction'
    case 'idea':
      return 'floated an idea'
    case 'progress':
      return 'gave a progress update'
    case 'announcement':
      return 'announced to the team'
    case 'discussion':
      return 'discussed with the team'
    case 'request':
      return 'made a request'
    default:
      return 'sent a message'
  }
}

export class ActivityMapper {
  private readonly store: Store
  private readonly taskCache = new Map<string, TaskRecord | null>()
  private readonly shipCache = new Map<string, ShipRecord | null>()

  constructor(store: Store) {
    this.store = store
  }

  private task(taskId: string | null): TaskRecord | null {
    if (taskId === null) return null
    if (this.taskCache.has(taskId)) return this.taskCache.get(taskId) ?? null
    const task = this.store.getTaskOrNull(taskId)
    this.taskCache.set(taskId, task)
    return task
  }

  private ship(shipId: string | null): ShipRecord | null {
    if (shipId === null) return null
    if (this.shipCache.has(shipId)) return this.shipCache.get(shipId) ?? null
    const ship = this.store.getShip(shipId)
    this.shipCache.set(shipId, ship)
    return ship
  }

  /** Prefer the runtime-captured display name, then the task's assignee Ship. */
  private label(taskId: string | null, data: Record<string, unknown>, fallback = 'Worker'): string {
    const fromPayload = str(data['shipName']) ?? str(data['senderLabel'])
    if (fromPayload !== null) return clip(fromPayload, 80)
    const task = this.task(taskId)
    const ship = task === null ? null : this.ship(task.assigneeShipId)
    return clip(ship?.displayName ?? str(data['role']) ?? fallback, 80)
  }

  private title(taskId: string | null): string | null {
    const task = this.task(taskId)
    return task === null ? null : clip(task.title, 120)
  }

  map(event: EventRecord): RunActivityItem | null {
    const data = eventData(event)
    const taskId = event.taskId
    const base = {
      seq: event.seq,
      id: event.id,
      runId: event.runId ?? '',
      taskId,
      type: event.type,
      at: event.createdAt,
    }
    const item = (
      actor: RunActivityItem['actor'],
      actorLabel: string,
      text: string,
      tone: RunActivityTone,
      detail?: string | null,
    ): RunActivityItem => ({
      ...base,
      actor,
      actorLabel: clip(actorLabel, 80),
      text: clip(text, MAX_TEXT),
      tone,
      ...(detail !== null && detail !== undefined && detail.trim() !== ''
        ? { detail: clip(detail, MAX_DETAIL) }
        : {}),
    })

    switch (event.type) {
      case 'run.started': {
        const goal = str(data['goal'])
        return item('supervisor', 'Supervisor', 'started the run', 'info', goal)
      }
      case 'task.admitted': {
        const title = str(data['title']) ?? this.title(taskId) ?? 'task'
        const assignee = str(data['assigneeShipId'])
        const ship = this.ship(assignee)
        const deps = Array.isArray(data['dependsOn']) ? data['dependsOn'].filter((d): d is string => typeof d === 'string') : []
        const after =
          deps.length === 0
            ? null
            : `after ${deps
                .map((id) => this.title(id) ?? id)
                .slice(0, 4)
                .join(', ')}`
        return item(
          'supervisor',
          'Supervisor',
          `delegated “${clip(title, 120)}” to ${ship?.displayName ?? assignee ?? 'a worker'}`,
          'info',
          after,
        )
      }
      case 'worker.started': {
        const label = this.label(taskId, data)
        const title = this.title(taskId)
        return item('worker', label, title !== null ? `started “${title}”` : 'started work', 'info')
      }
      case 'worker.waiting': {
        const label = this.label(taskId, data)
        return item('worker', label, 'waiting', 'warning')
      }
      case 'worker.question': {
        const label = this.label(taskId, data)
        const question = str(data['question']) ?? str(data['summary']) ?? 'needs input'
        return item('worker', label, `needs input — ${question}`, 'warning')
      }
      case 'worker.report': {
        const label = this.label(taskId, data)
        const summary = str(data['summary']) ?? str(data['text'])
        return item('worker', label, summary !== null ? `reported — ${summary}` : 'reported a result', 'info')
      }
      case 'worker.progress': {
        if (data['isError'] !== true) return null
        const label = this.label(taskId, data)
        const step = str(data['step']) ?? str(data['tool']) ?? 'tool call failed'
        return item('worker', label, `tool error — ${step}`, 'error')
      }
      case 'worker.completed': {
        const label = this.label(taskId, data)
        const title = this.title(taskId)
        const summary = str(data['summary'])
        return item(
          'worker',
          label,
          title !== null ? `completed “${title}”` : 'completed',
          'success',
          summary,
        )
      }
      case 'worker.failed': {
        const label = this.label(taskId, data)
        const error = str(data['error']) ?? str(data['summary']) ?? 'unknown failure'
        return item('worker', label, `failed — ${error}`, 'error')
      }
      case 'worker.cancelled': {
        const label = this.label(taskId, data)
        const title = this.title(taskId)
        return item('worker', label, title !== null ? `cancelled “${title}”` : 'cancelled', 'warning')
      }
      case 'worker.message': {
        const sender = str(data['senderLabel']) ?? this.label(taskId, data)
        const recipient = str(data['recipientLabel']) ?? 'a worker'
        const kind = str(data['kind']) ?? 'message'
        const body = str(data['body'])
        // The actor label already names the sender; repeating it in the text
        // would show every identity twice in one row.
        return item('worker', sender, `→ ${recipient}: ${messageVerb(kind)}`, 'message', body)
      }
      case 'worker.spec.created':
      case 'worker.spec.updated': {
        const label = this.label(taskId, data)
        const title = str(data['title']) ?? 'spec'
        const version = typeof data['version'] === 'number' ? data['version'] : 1
        const isNew = event.type === 'worker.spec.created'
        return item(
          'worker',
          label,
          `${isNew ? 'published' : 'updated'} spec “${clip(title, MAX_TEXT)}” (v${version})`,
          'info',
        )
      }
      case 'worker.file.claim': {
        const label = this.label(taskId, data)
        const path = str(data['path']) ?? 'a file'
        const intent = str(data['intent'])
        return item(
          'worker',
          label,
          `claimed ${clip(path, MAX_TEXT)}`,
          'info',
          intent !== null ? clip(intent, MAX_DETAIL) : null,
        )
      }
      case 'worker.file.release': {
        const label = this.label(taskId, data)
        const path = str(data['path']) ?? 'a file'
        return item('worker', label, `released ${clip(path, MAX_TEXT)}`, 'info')
      }
      case 'task.awaiting_verification': {
        const label = this.label(taskId, data)
        const title = this.title(taskId)
        return item(
          'worker',
          label,
          title !== null ? `“${title}” awaits verification` : 'work awaits verification',
          'warning',
        )
      }
      case 'verification.run': {
        const label = this.label(taskId, data)
        const name = str(data['name']) ?? 'check'
        const status = str(data['status']) ?? 'unknown'
        return item(
          'system',
          label,
          `verification “${name}” ${status}`,
          status === 'passed' ? 'success' : status === 'failed' ? 'error' : 'warning',
          typeof data['note'] === 'string' ? data['note'] : null,
        )
      }
      case 'scope.conflict': {
        const label = this.label(taskId, data)
        const explanation = str(data['explanation']) ?? 'file scope conflict'
        return item('system', label, `file scope conflict — ${explanation}`, 'error')
      }
      case 'task.cancelled_by_tool': {
        const title = this.title(taskId) ?? 'task'
        const reason = str(data['reason']) ?? 'cancelled'
        return item('supervisor', 'Supervisor', `cancelled “${title}” — ${reason}`, 'warning')
      }
      case 'task.revision_scheduled': {
        const title = this.title(taskId) ?? 'task'
        return item('supervisor', 'Supervisor', `sent “${title}” back for revision`, 'warning')
      }
      case 'approval.requested': {
        const action = str(data['action']) ?? 'approval'
        return item('system', 'Approval', `requested — ${action}`, 'warning')
      }
      case 'approval.decided': {
        const action = str(data['action']) ?? 'approval'
        const status = str(data['status']) ?? 'decided'
        return item('system', 'Approval', `${status} — ${action}`, status === 'approved' ? 'success' : 'warning')
      }
      case 'run.stop_requested': {
        const reason = str(data['reason']) ?? 'operator request'
        return item('system', 'Supervisor', `stop requested — ${reason}`, 'warning')
      }
      case 'run.finished':
      case 'run.uncertain': {
        const state = str(data['state']) ?? (event.type === 'run.uncertain' ? 'uncertain' : 'finished')
        const summary = str(data['managerSummary'])
        const counts = objectOf(data['taskCounts'])
        const countText =
          counts === null
            ? null
            : Object.entries(counts)
                .map(([key, value]) => `${String(value)} ${key}`)
                .join(' · ')
        const tone: RunActivityTone =
          state === 'completed' ? 'success' : state === 'failed' ? 'error' : 'warning'
        return item(
          'supervisor',
          'Supervisor',
          `run ${state}`,
          tone,
          summary ?? countText,
        )
      }
      default:
        return null
    }
  }
}

/** Map a batch oldest-first, dropping events with no user-facing meaning. */
export function buildRunActivity(store: Store, events: EventRecord[]): RunActivityItem[] {
  const mapper = new ActivityMapper(store)
  const items: RunActivityItem[] = []
  for (const event of events) {
    const mapped = mapper.map(event)
    if (mapped !== null) items.push(mapped)
  }
  return items
}
