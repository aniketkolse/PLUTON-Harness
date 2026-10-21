/**
 * Server-side event-log watcher (CS-8): derives live `run_state` / `task_state`
 * SSE frames from the durable event log.
 *
 * The append-only event log stays the source of truth; the watcher only tails it
 * (`store.eventsSince`) and broadcasts derived deltas. History is never replayed
 * — a freshly connected SPA does its REST initial load, then receives only what
 * changed afterwards. Mapping contract: every event whose type starts with
 * `run.` maps to a `run_state` frame for its run, every `task.` event to a
 * `task_state` frame for its task (present and future types alike). Frames carry
 * the CURRENT durable state read fresh from the store — never the event payload —
 * and a burst is collapsed per entity so each pass sends one frame per entity,
 * carrying that entity's final state.
 */

import type { Store } from '../store/store.ts'
import { stripControlChars } from '../util/sanitize.ts'
import type { ServerEventBroadcaster } from './events.ts'
import type { ServerSSEEvent } from './types.ts'

export interface ServerLogWatcherOptions {
  store: Store
  projectId: string
  broadcaster: ServerEventBroadcaster
  /** Poll cadence in ms (default 2000; tests pass a small value). */
  pollIntervalMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 2000
const BATCH_LIMIT = 200
/**
 * Per-`pollOnce()` batch budget (10 × 200 = 2 000 events): draining an
 * arbitrarily large backlog in one synchronous loop would starve the event
 * loop, so a tick stops at the budget. The cursor has already advanced past
 * every batch read, and the next tick simply resumes from there.
 */
const MAX_BATCHES_PER_POLL = 10

export class ServerLogWatcher {
  private readonly store: Store
  private readonly projectId: string
  private readonly broadcaster: ServerEventBroadcaster
  private readonly pollIntervalMs: number
  private cursor: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: ServerLogWatcherOptions) {
    this.store = options.store
    this.projectId = options.projectId
    this.broadcaster = options.broadcaster
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    // Tail-primed cursor: everything already in the log is history the client
    // fetches over REST; only events appended from here on become frames.
    this.cursor = this.store.latestEventSeq(this.projectId)
  }

  /**
   * Idempotent. The interval is unref'd so the watcher never keeps the Node
   * process alive on its own.
   */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      // Fail-soft: a store that errors mid-pass (e.g. teardown closed it) loses
      // the frames that pass had already consumed — the durable log stays the
      // record, frames are best-effort live deltas, and the SPA's next REST
      // refresh recovers truth from it. What must never happen is the watcher
      // crashing the server, so the error stops here.
      try {
        this.pollOnce()
      } catch {
        // ignore
      }
    }, this.pollIntervalMs)
    this.timer.unref()
  }

  /** Clears the timer; idempotent. */
  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Drains the log since the cursor and broadcasts at most one frame per entity. */
  pollOnce(): void {
    const frames = new Map<string, ServerSSEEvent>()
    // Referents seen this pass, in first-seen order (Set preserves insertion
    // order). A busy window can hold many events per entity, and every frame
    // carries the CURRENT durable state anyway, so each entity is read exactly
    // once after the scan instead of once per event: a burst of N events for
    // one task costs one row read, not N. The scan is synchronous, so a
    // post-pass read observes the same final state the per-event reads saw —
    // the collapse-to-final-state contract is unchanged.
    const runIds = new Set<string>()
    const taskIds = new Set<string>()
    for (let batch = 0; batch < MAX_BATCHES_PER_POLL; batch += 1) {
      const events = this.store.eventsSince(this.projectId, this.cursor, BATCH_LIMIT)
      for (const event of events) {
        // The cursor advances past every event read, mapped or not, so an
        // unmappable event can never wedge the watcher on a stalled backlog.
        this.cursor = event.seq
        if (event.type.startsWith('run.') && event.runId !== null) {
          runIds.add(event.runId)
        } else if (event.type.startsWith('task.') && event.taskId !== null) {
          taskIds.add(event.taskId)
        } else if (
          event.type === 'approval.requested' ||
          event.type === 'approval.decided' ||
          event.type === 'approval.expired'
        ) {
          // Human-approval rows filed by a worker's `approval.request` tool
          // (and by expiry/decision paths) become live SSE frames here. Without
          // this the SPA only saw engine-permission requests from chat turns,
          // so a QA question filed mid-task never rendered its card live.
          const payload = event.payload
          const approvalId =
            payload !== null && typeof payload === 'object' && !Array.isArray(payload)
              ? (payload as Record<string, unknown>)['approvalId']
              : undefined
          if (typeof approvalId === 'string') {
            const approval = this.store.getApprovalOrNull(approvalId)
            if (approval !== null) {
              frames.set(`approval:${approval.id}`, {
                type: event.type === 'approval.requested' ? 'approval_requested' : 'approval_decided',
                approval,
              })
            }
          }
        }
      }
      if (events.length < BATCH_LIMIT) break
    }

    // One frame per entity per pass: unique entities -> one fresh row read
    // each. Runs first, then tasks — the SPA applies the two frame kinds
    // independently, so cross-kind order carries no semantics, and each kind
    // keeps first-seen order. A burst (task.started + task.completed in one
    // window) yields a single frame carrying the final state.
    for (const runId of runIds) {
      const run = this.store.getRunOrNull(runId)
      if (run !== null) {
        // Frames carry real model text now (the answer, failure reasons):
        // sanitize like the worker-event path does server-side (control
        // chars out; key-based secret redaction applies to keyed objects,
        // and embedded secret strings in prose are the engine's input the
        // operator already owns — loopback + token frames, operator data).
        frames.set(run.id, {
          type: 'run_state',
          runId: run.id,
          state: run.state,
          goal: stripControlChars(run.goal),
          summary:
            run.finalSummary !== null ? stripControlChars(run.finalSummary.slice(0, 20_000)) : undefined,
          error: run.state === 'failed' ? (run.finalSummary !== null ? stripControlChars(run.finalSummary.slice(0, 20_000)) : undefined) : undefined,
        })
      }
    }
    for (const taskId of taskIds) {
      const task = this.store.getTaskOrNull(taskId)
      if (task !== null) {
        frames.set(task.id, {
          type: 'task_state',
          taskId: task.id,
          runId: task.runId,
          state: task.state,
          title: stripControlChars(task.title),
        })
      }
    }
    for (const frame of frames.values()) this.broadcaster.broadcast(frame)
  }
}
