import type { TaskState } from '../domain/state.ts'
import type { TaskRecord } from '../domain/models.ts'
import type { Store } from '../store/store.ts'

/**
 * In-process wakeup registry (prompt §4/§7): a settled child task wakes its
 * parent EXACTLY once, and the manager waits event-driven — it never polls.
 *
 * "Settled" means no further automatic progress is possible: a terminal state,
 * or `verifying` — work is done and only the operator's verification gate can
 * close the task (host-mode smoke, 2026-10-16: waiting for `completed` under a
 * configured gate deadlocked the manager until the run deadline).
 *
 * Durability lives in the events table (`task.completed` etc.); this registry is
 * only the in-process accelerator that turns "a child settled" into a resolved
 * promise. Correctness must never depend on it: callers re-check the actual
 * task/child states in the store after every wakeup (and on timeout), so a
 * missed or coalesced wakeup can only delay work, never lose it.
 */
export interface Wakeup {
  parentTaskId: string
  childTaskId: string
  childState: TaskState
  at: number
}

export interface WakeupRegistryOptions {
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number
}

/** The wakeup channel a caller waits on: its own task, or the run-level manager channel. */
export function wakeupChannelFor(callerTaskId: string | null, runId: string): string {
  return callerTaskId ?? `manager:${runId}`
}

/**
 * Wake every possible waiter after a settling transition (terminal, or
 * `verifying` when a verification gate is configured): the manager channel and
 * each ancestor task's channel (a task-scoped caller may be waiting on any
 * descendant). The registry dedupes per (channel, child) pair, so notifying
 * overlapping keys is harmless. Keying matches `wakeupChannelFor`: a task's
 * channel is the bare task id, the manager's channel is `manager:<runId>`.
 */
export function notifyTaskSettled(
  wakeups: WakeupRegistry,
  runId: string,
  task: TaskRecord,
  ancestors: string[],
): void {
  wakeups.notify(wakeupChannelFor(null, runId), task.id, task.state)
  for (const ancestorId of ancestors) wakeups.notify(ancestorId, task.id, task.state)
}

/** Ancestor task ids of a task (nearest first), cycle-guarded and bounded by the graph. */
export function taskAncestorIds(store: Store, task: TaskRecord): string[] {
  const ids: string[] = []
  const seen = new Set<string>([task.id])
  let parentId = task.parentTaskId
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId)
    ids.push(parentId)
    const parent = store.getTaskOrNull(parentId)
    parentId = parent?.parentTaskId ?? null
  }
  return ids
}

/** One pending waitFor() call. */
interface Waiter {
  resolve: (wakeups: Wakeup[]) => void
  timer: ReturnType<typeof setTimeout>
}

/** Composite key so the same child id can wake different parents independently. */
function pairKey(parentTaskId: string, childTaskId: string): string {
  return `${parentTaskId}\u0000${childTaskId}`
}

export class WakeupRegistry {
  private readonly now: () => number
  /** Wakeups buffered for a parent that has no waiter. */
  private readonly buffer = new Map<string, Wakeup[]>()
  /** FIFO waiters per parent; at most one waiter receives any given wakeup. */
  private readonly waiters = new Map<string, Waiter[]>()
  /** Every (parent, child) pair ever delivered — one wakeup per completed child. */
  private readonly delivered = new Set<string>()

  constructor(opts?: WakeupRegistryOptions) {
    this.now = opts?.now ?? Date.now
  }

  /**
   * Record a child settling against a channel key (terminal state, or
   * `verifying` under a configured gate). One wakeup per (channel, child) pair
   * is ever delivered. The producer chooses the keys: the run supervisor
   * notifies the manager channel (`manager:<runId>`) and every ancestor task's
   * channel, so a waiter on any ancestor is woken.
   */
  notify(channelKey: string, childTaskId: string, childState: TaskState): void {
    const key = pairKey(channelKey, childTaskId)
    if (this.delivered.has(key)) return
    this.delivered.add(key)
    const wakeup: Wakeup = { parentTaskId: channelKey, childTaskId, childState, at: this.now() }

    const list = this.waiters.get(channelKey)
    const waiter = list?.shift()
    if (list && list.length === 0) this.waiters.delete(channelKey)
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve([wakeup])
      return
    }
    const buffered = this.buffer.get(channelKey) ?? []
    buffered.push(wakeup)
    this.buffer.set(channelKey, buffered)
  }

  /** Drain buffered wakeups for the parent (consume-once). */
  drain(parentTaskId: string): Wakeup[] {
    const buffered = this.buffer.get(parentTaskId)
    if (!buffered) return []
    this.buffer.delete(parentTaskId)
    return buffered
  }

  /** Resolve with >=1 wakeups, or [] on timeout. Consume-once; multiple waiters never see the same wakeup twice. */
  waitFor(parentTaskId: string, timeoutMs: number): Promise<Wakeup[]> {
    const buffered = this.drain(parentTaskId)
    if (buffered.length > 0) return Promise.resolve(buffered)

    return new Promise<Wakeup[]>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const list = this.waiters.get(parentTaskId)
          if (list) {
            const i = list.indexOf(waiter)
            if (i >= 0) list.splice(i, 1)
            if (list.length === 0) this.waiters.delete(parentTaskId)
          }
          resolve([])
        }, timeoutMs),
      }
      const list = this.waiters.get(parentTaskId) ?? []
      list.push(waiter)
      this.waiters.set(parentTaskId, list)
    })
  }

  /** Buffered (not yet consumed) wakeups for the parent. */
  pendingCount(parentTaskId: string): number {
    return this.buffer.get(parentTaskId)?.length ?? 0
  }
}
