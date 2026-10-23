/**
 * Keyed async mutex (prompt §5: per-Ship task serialization). One lock per key
 * (a Ship id): tasks assigned to the same Ship run strictly one at a time;
 * different Ships never block each other. The lock lives in process — the
 * durable record of "who is running what" is the store, this only prevents
 * concurrent execution inside one supervisor process.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()

    // Our release switch: the next waiter chains onto `current`.
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })

    const chained = previous.catch(() => {}).then(() => current)
    this.tails.set(key, chained)

    // Wait for the previous holder; its failures are irrelevant to us.
    await previous.catch(() => {})

    try {
      return await fn()
    } finally {
      release()
      // If nobody chained after us, drop the map entry so long-lived processes
      // don't accumulate one promise per key forever.
      if (this.tails.get(key) === chained) {
        // Microtask delay: a waiter may have chained between release() and here.
        queueMicrotask(() => {
          if (this.tails.get(key) === chained) this.tails.delete(key)
        })
      }
    }
  }

  /** Test/introspection aid: how many keys currently hold or wait on a lock. */
  activeKeys(): string[] {
    return [...this.tails.keys()]
  }
}
