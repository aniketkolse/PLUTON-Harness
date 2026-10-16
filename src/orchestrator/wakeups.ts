import type { TaskState } from '../domain/state.ts'

/**
 * In-process wakeup registry (prompt §4/§7): a completed child task wakes its
 * parent EXACTLY once, and the manager waits event-driven — it never polls.
 *
 * Durability lives in the events table (`task.completed` etc.); this registry is
 * only the in-process accelerator that turns "a child finished" into a resolved
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

  /** Record a child reaching a terminal state. One wakeup per child is ever delivered. */
  notify(parentTaskId: string, childTaskId: string, childState: TaskState): void {
    const key = pairKey(parentTaskId, childTaskId)
    if (this.delivered.has(key)) return
    this.delivered.add(key)
    const wakeup: Wakeup = { parentTaskId, childTaskId, childState, at: this.now() }

    const list = this.waiters.get(parentTaskId)
    const waiter = list?.shift()
    if (list && list.length === 0) this.waiters.delete(parentTaskId)
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve([wakeup])
      return
    }
    const buffered = this.buffer.get(parentTaskId) ?? []
    buffered.push(wakeup)
    this.buffer.set(parentTaskId, buffered)
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
