/**
 * Bounded single-consumer async queue used to bridge callback-style transport
 * events (engine notifications) into async generators (EngineSession stream).
 *
 * Rules:
 * - `push` never throws and never grows past `maxSize`: it returns false so the
 *   producer can fail the turn loudly instead of silently dropping events.
 *   `false` means closed OR full; callers that must react differently consult
 *   `isClosed` (a closed queue means the turn already settled — late frames are
 *   stale, not overflow).
 * - Values must never be `undefined` (undefined is the internal close sentinel).
 * - After `close()`, queued items are still drained, then iteration ends.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<(value: T | undefined) => void> = []
  private closed = false
  private readonly maxSize: number

  constructor(maxSize = 8192) {
    this.maxSize = maxSize
  }

  /** Returns true when accepted; false when the queue is closed or full. */
  push(item: T): boolean {
    if (this.closed || this.items.length >= this.maxSize) return false
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
    return true
  }

  get size(): number {
    return this.items.length
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Idempotent. Wakes all pending readers; remaining items still drain. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }

  async next(): Promise<IteratorResult<T>> {
    for (;;) {
      const item = this.items.shift()
      if (item !== undefined) return { done: false, value: item }
      if (this.closed) return { done: true, value: undefined }
      const pushed = await new Promise<T | undefined>((resolve) => {
        this.waiters.push(resolve)
      })
      if (pushed !== undefined) return { done: false, value: pushed }
      // Woken by close(): re-check for remaining items, then end.
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}
