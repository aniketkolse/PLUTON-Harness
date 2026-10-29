import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.ts'
import { newId } from '../domain/ids.ts'
import type { JsonValue } from '../domain/models.ts'
import { isTerminal, isTerminalRunState } from '../domain/state.ts'
import type { Store } from '../store/store.ts'
import type { WakeupRegistry } from './wakeups.ts'

/**
 * Direct worker-to-worker communication (PLUTON 3.0).
 *
 * The durable event log is the message history: every message is a
 * `worker.message` event and every delivery batch a `worker.message.delivered`
 * event. There is no second message table and no second scheduler.
 *
 * Delivery is pull-based (`ship.inbox`): an engine turn cannot be injected with
 * text from the outside, so a worker receives messages at its next tool call.
 * The bus guarantees at-most-once delivery per recipient session through a
 * durable delivered-id set, and every wait is bounded and abortable so
 * cancellation/failure cannot leave a worker blocked.
 */

export const WORKER_MESSAGE_KINDS = [
  'finding',
  'evidence',
  'contract',
  'blocker',
  'question',
  'handoff',
  'instruction',
] as const

export type WorkerMessageKind = (typeof WORKER_MESSAGE_KINDS)[number]

export const MAX_MESSAGE_BODY_CHARS = 8_000
export const MAX_MESSAGES_PER_RUN = 500
export const MAX_INBOX_WAIT_MS = 60_000
export const MAX_INBOX_LIMIT = 50

const MESSAGE_EVENT = 'worker.message'
const DELIVERED_EVENT = 'worker.message.delivered'

export interface WorkerMessage {
  /** Stable id (`msg_…`) — never derived from a display name. */
  id: string
  /** Durable event seq: total order and the activity-feed key. */
  seq: number
  runId: string
  senderShipId: string | null
  senderLabel: string
  senderTaskId: string | null
  recipientShipId: string
  recipientLabel: string
  /** Null = any session of the recipient Ship may read it. */
  recipientTaskId: string | null
  kind: WorkerMessageKind
  body: string
  replyTo: string | null
  createdAt: number
}

export interface SendWorkerMessageInput {
  senderShipId: string
  senderTaskId?: string | null
  recipientShipId: string
  recipientTaskId?: string | null
  kind: WorkerMessageKind
  body: string
  replyTo?: string | null
}

export interface InboxInput {
  recipientShipId: string
  taskId?: string | null
  limit?: number
  waitMs?: number
  signal?: AbortSignal
}

export interface WorkerMessageBusOptions {
  store: Store
  projectId: string
  runId: string
  wakeups: WakeupRegistry
  now?: () => number
  /** Live observer for a just-persisted message. Never persisted again here. */
  onMessage?: (message: WorkerMessage) => void
  maxMessagesPerRun?: number
  maxBodyChars?: number
}

function objectOf(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null
}

function stringOf(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function messageFromEvent(event: {
  seq: number
  runId: string | null
  payload: JsonValue
}): WorkerMessage | null {
  const payload = objectOf(event.payload)
  if (payload === null) return null
  const id = stringOf(payload['messageId'])
  const recipientShipId = stringOf(payload['recipientShipId'])
  const kind = stringOf(payload['kind'])
  const body = stringOf(payload['body'])
  const senderLabel = stringOf(payload['senderLabel']) ?? 'worker'
  const recipientLabel = stringOf(payload['recipientLabel']) ?? recipientShipId ?? 'worker'
  const createdAtRaw = payload['createdAt']
  const createdAt = typeof createdAtRaw === 'number' ? createdAtRaw : Date.now()
  if (id === null || recipientShipId === null || kind === null || body === null) return null
  return {
    id,
    seq: event.seq,
    runId: event.runId ?? '',
    senderShipId: stringOf(payload['senderShipId']),
    senderLabel,
    senderTaskId: stringOf(payload['senderTaskId']),
    recipientShipId,
    recipientLabel,
    recipientTaskId: stringOf(payload['recipientTaskId']),
    kind: kind as WorkerMessageKind,
    body,
    replyTo: stringOf(payload['replyTo']),
    createdAt,
  }
}

export class WorkerMessageBus {
  private readonly store: Store
  private readonly projectId: string
  private readonly runId: string
  private readonly wakeups: WakeupRegistry
  private readonly now: () => number
  private readonly onMessage: ((message: WorkerMessage) => void) | null
  private readonly maxMessagesPerRun: number
  private readonly maxBodyChars: number
  /** Every retained message, in send order. */
  private readonly order: WorkerMessage[] = []
  private readonly byId = new Map<string, WorkerMessage>()
  /** Message ids already handed to a recipient session. */
  private readonly delivered = new Set<string>()
  /** Highest durable worker.message seq this bus has ingested. */
  private lastMessageSeq = 0
  private closed = false

  constructor(opts: WorkerMessageBusOptions) {
    this.store = opts.store
    this.projectId = opts.projectId
    this.runId = opts.runId
    this.wakeups = opts.wakeups
    this.now = opts.now ?? Date.now
    this.onMessage = opts.onMessage ?? null
    this.maxMessagesPerRun = opts.maxMessagesPerRun ?? MAX_MESSAGES_PER_RUN
    this.maxBodyChars = opts.maxBodyChars ?? MAX_MESSAGE_BODY_CHARS
    this.rebuild()
  }

  /**
   * Rehydrate from the durable log so a new process (or a restarted supervisor)
   * sees the same history and does not re-deliver acknowledged messages.
   */
  private rebuild(): void {
    const events = this.store.listEvents(this.runId, { type: MESSAGE_EVENT, limit: this.maxMessagesPerRun })
    for (const event of [...events].reverse()) {
      const message = messageFromEvent(event)
      if (message === null) continue
      this.order.push(message)
      this.byId.set(message.id, message)
    }
    // Events are newest-first: the head carries the highest seq, valid or not,
    // so a malformed historical payload can never wedge future refreshes.
    if (events.length > 0 && events[0] !== undefined) this.lastMessageSeq = events[0].seq
    const acks = this.store.listEvents(this.runId, { type: DELIVERED_EVENT, limit: this.maxMessagesPerRun * 2 })
    for (const ack of acks) {
      const payload = objectOf(ack.payload)
      const ids = payload?.['messageIds']
      if (!Array.isArray(ids)) continue
      for (const id of ids) if (typeof id === 'string') this.delivered.add(id)
    }
    // Retain the newest window if the log grew past the bound.
    while (this.order.length > this.maxMessagesPerRun) {
      const dropped = this.order.shift()
      if (dropped !== undefined) this.byId.delete(dropped.id)
    }
  }

  /**
   * Ingest messages appended by another process (the operator route, another
   * CLI). The durable log is the authority; this bus is only a cache.
   *
   * Deliberately does NOT call `onMessage`: the writer owns live publication,
   * so a refresh can never double-broadcast the same durable message.
   */
  private refresh(): void {
    if (this.closed) return
    const events = this.store.listEventsSince(this.runId, this.lastMessageSeq, this.maxMessagesPerRun, MESSAGE_EVENT)
    for (const event of events) {
      if (event.seq <= this.lastMessageSeq) continue
      this.lastMessageSeq = event.seq
      const message = messageFromEvent(event)
      if (message === null || this.byId.has(message.id)) continue
      this.order.push(message)
      this.byId.set(message.id, message)
    }
    while (this.order.length > this.maxMessagesPerRun) {
      const dropped = this.order.shift()
      if (dropped !== undefined) this.byId.delete(dropped.id)
    }
  }

  private channel(recipientShipId: string): string {
    return `worker-messages:${this.runId}:${recipientShipId}`
  }

  private assertLive(): void {
    if (this.closed) throw new ConflictError('worker messaging is closed for this run')
    if (isTerminalRunState(this.store.getRun(this.runId).state)) {
      throw new ConflictError('run is terminal; no further worker messages are accepted')
    }
  }

  private resolveShip(shipId: string, role: 'sender' | 'recipient') {
    const ship = this.store.getShip(shipId)
    if (ship === null || !ship.enabled) {
      throw new NotFoundError(`${role} ship`, shipId)
    }
    return ship
  }

  private validateTask(
    taskId: string | null | undefined,
    shipId: string,
    role: 'sender' | 'recipient',
  ): void {
    if (taskId === undefined || taskId === null) return
    const task = this.store.getTaskOrNull(taskId)
    if (task === null || task.runId !== this.runId) {
      throw new NotFoundError(`${role} task`, taskId)
    }
    if (task.assigneeShipId !== shipId) {
      throw new ValidationError(`${role} task ${taskId} is not assigned to ship ${shipId}`)
    }
    if (isTerminal(task.state)) {
      throw new ConflictError(`${role} task ${taskId} is already ${task.state}`)
    }
  }

  /** Persist + publish one authenticated message. */
  send(input: SendWorkerMessageInput): WorkerMessage {
    this.assertLive()
    const sender = this.resolveShip(input.senderShipId, 'sender')
    const recipient = this.resolveShip(input.recipientShipId, 'recipient')
    if (sender.id === recipient.id) {
      throw new ValidationError('a Ship cannot send a worker message to itself')
    }
    this.validateTask(input.senderTaskId, sender.id, 'sender')
    this.validateTask(input.recipientTaskId, recipient.id, 'recipient')
    const body = input.body.trim()
    if (body === '') throw new ValidationError('message body is required')
    if (body.length > this.maxBodyChars) {
      throw new ValidationError(`message body exceeds ${this.maxBodyChars} chars`)
    }
    if (this.order.length >= this.maxMessagesPerRun) {
      throw new ConflictError(`run message budget exhausted (${this.maxMessagesPerRun})`)
    }
    const createdAt = this.now()
    const id = newId('msg')
    const record = this.store.appendEvent({
      projectId: this.projectId,
      runId: this.runId,
      ...(input.senderTaskId !== undefined && input.senderTaskId !== null
        ? { taskId: input.senderTaskId }
        : {}),
      shipId: sender.id,
      type: MESSAGE_EVENT,
      maxChars: 16_000,
      payload: {
        messageId: id,
        senderShipId: sender.id,
        senderLabel: sender.displayName,
        senderTaskId: input.senderTaskId ?? null,
        recipientShipId: recipient.id,
        recipientLabel: recipient.displayName,
        recipientTaskId: input.recipientTaskId ?? null,
        kind: input.kind,
        body,
        replyTo: input.replyTo ?? null,
        createdAt,
      },
    })
    // The persisted payload is the authority (redaction already applied).
    const persisted = messageFromEvent(record)
    if (persisted === null) throw new ValidationError('worker message payload was rejected')
    this.order.push(persisted)
    this.byId.set(persisted.id, persisted)
    this.lastMessageSeq = Math.max(this.lastMessageSeq, persisted.seq)
    this.wakeups.notify(this.channel(recipient.id), persisted.id, 'running')
    try {
      this.onMessage?.(persisted)
    } catch {
      // A live-observer failure must never break the sending worker.
    }
    return persisted
  }

  /**
   * Operator → worker instruction. Same durable shape as a Ship message; the
   * sender is the operator, not a Ship, and the recipient permission boundary
   * is unchanged (the worker still decides what its scope allows).
   */
  sendOperator(input: {
    recipientShipId: string
    recipientTaskId?: string | null
    body: string
  }): WorkerMessage {
    this.assertLive()
    const recipient = this.resolveShip(input.recipientShipId, 'recipient')
    this.validateTask(input.recipientTaskId, recipient.id, 'recipient')
    const body = input.body.trim()
    if (body === '') throw new ValidationError('message body is required')
    if (body.length > this.maxBodyChars) {
      throw new ValidationError(`message body exceeds ${this.maxBodyChars} chars`)
    }
    if (this.order.length >= this.maxMessagesPerRun) {
      throw new ConflictError(`run message budget exhausted (${this.maxMessagesPerRun})`)
    }
    const createdAt = this.now()
    const id = newId('msg')
    const record = this.store.appendEvent({
      projectId: this.projectId,
      runId: this.runId,
      ...(input.recipientTaskId !== undefined && input.recipientTaskId !== null
        ? { taskId: input.recipientTaskId }
        : {}),
      type: MESSAGE_EVENT,
      maxChars: 16_000,
      payload: {
        messageId: id,
        senderShipId: null,
        senderLabel: 'operator',
        senderTaskId: null,
        recipientShipId: recipient.id,
        recipientLabel: recipient.displayName,
        recipientTaskId: input.recipientTaskId ?? null,
        kind: 'instruction',
        body,
        replyTo: null,
        createdAt,
      },
    })
    const persisted = messageFromEvent(record)
    if (persisted === null) throw new ValidationError('operator message payload was rejected')
    this.order.push(persisted)
    this.byId.set(persisted.id, persisted)
    this.lastMessageSeq = Math.max(this.lastMessageSeq, persisted.seq)
    this.wakeups.notify(this.channel(recipient.id), persisted.id, 'running')
    try {
      this.onMessage?.(persisted)
    } catch {
      // ignore
    }
    return persisted
  }

  private available(recipientShipId: string, taskId: string | null | undefined): WorkerMessage[] {
    const result: WorkerMessage[] = []
    for (const message of this.order) {
      if (message.recipientShipId !== recipientShipId) continue
      if (this.delivered.has(message.id)) continue
      if (message.recipientTaskId !== null && message.recipientTaskId !== (taskId ?? null)) continue
      result.push(message)
    }
    return result
  }

  private markDelivered(messages: WorkerMessage[], recipientShipId: string): void {
    if (messages.length === 0) return
    const ids = messages.map((m) => m.id)
    for (const id of ids) this.delivered.add(id)
    const throughSeq = messages[messages.length - 1]!.seq
    try {
      this.store.appendEvent({
        projectId: this.projectId,
        runId: this.runId,
        type: DELIVERED_EVENT,
        payload: { recipientShipId, messageIds: ids, throughSeq },
      })
    } catch {
      // Delivery already happened; a lost ack can at worst re-deliver once.
    }
  }

  /** Wait up to `waitMs` for at least one undelivered message addressed to this caller. */
  async inbox(input: InboxInput): Promise<WorkerMessage[]> {
    const limit = Math.max(1, Math.min(MAX_INBOX_LIMIT, input.limit ?? 20))
    const waitMs = Math.max(0, Math.min(MAX_INBOX_WAIT_MS, input.waitMs ?? 0))
    const deadline = this.now() + waitMs
    let slice = Math.min(waitMs, 1_000)
    for (;;) {
      if (this.closed) return []
      // Another process (the operator route, a second CLI) may have appended a
      // message since the last look: the durable log is the authority.
      this.refresh()
      const run = this.store.getRun(this.runId)
      if (isTerminalRunState(run.state)) return []
      if (input.taskId !== undefined && input.taskId !== null) {
        const task = this.store.getTaskOrNull(input.taskId)
        // A cancelled/failed attempt cannot process messages any more.
        if (task === null || isTerminal(task.state)) return []
      }
      const found = this.available(input.recipientShipId, input.taskId)
      if (found.length > 0) {
        const batch = found.slice(0, limit)
        this.markDelivered(batch, input.recipientShipId)
        return batch
      }
      if (this.now() >= deadline || input.signal?.aborted === true) return []
      await this.waitSafely(input.recipientShipId, slice, input.signal)
      slice = Math.min(1_000, Math.max(1, deadline - this.now()))
    }
  }

  private async waitSafely(
    recipientShipId: string,
    ms: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (ms <= 0) return
    if (signal === undefined) {
      await this.wakeups.waitFor(this.channel(recipientShipId), ms)
      return
    }
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const onAbort = (): void => resolve()
      signal.addEventListener('abort', onAbort, { once: true })
      void this.wakeups.waitFor(this.channel(recipientShipId), ms).then(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })
  }

  /** Wake every pending inbox wait so shutdown cannot strand a worker. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const recipients = new Set(this.order.map((m) => m.recipientShipId))
    for (const recipient of recipients) {
      this.wakeups.notify(this.channel(recipient), `close:${this.runId}`, 'cancelled')
    }
  }

  /** Durable history for one run (oldest first), independent of delivery state. */
  history(limit = MAX_MESSAGES_PER_RUN): WorkerMessage[] {
    this.refresh()
    return this.order.slice(-limit)
  }

  /** Pending (undelivered) messages for a Ship, for truthful UI badges. */
  pending(recipientShipId: string, taskId?: string | null): WorkerMessage[] {
    this.refresh()
    return this.available(recipientShipId, taskId)
  }

  /** Expose one message by id (message detail view), or null. */
  get(messageId: string): WorkerMessage | null {
    return this.byId.get(messageId) ?? null
  }
}
