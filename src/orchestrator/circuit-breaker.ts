export interface FailureFingerprint {
  code?: string
  message?: string
}

export interface CircuitBreakerOptions {
  maxRetriesPerTask: number
  consecutiveIdenticalFailuresThreshold: number
}

export class CircuitBreaker {
  private readonly maxRetries: number
  private readonly identicalFailuresThreshold: number
  private readonly failureHistory = new Map<string, string[]>()
  private tripped = false
  private tripReason: string | null = null

  constructor(opts?: Partial<CircuitBreakerOptions>) {
    this.maxRetries = opts?.maxRetriesPerTask ?? 2
    this.identicalFailuresThreshold = opts?.consecutiveIdenticalFailuresThreshold ?? 2
  }

  isTripped(): boolean {
    return this.tripped
  }

  getTripReason(): string | null {
    return this.tripReason
  }

  fingerprint(failure: unknown): string {
    if (typeof failure === 'string') {
      return failure.trim().toLowerCase().slice(0, 200)
    }
    if (failure && typeof failure === 'object') {
      const rec = failure as Record<string, unknown>
      const code = String(rec['code'] ?? rec['error'] ?? '').trim().toLowerCase()
      const msg = String(rec['message'] ?? rec['summary'] ?? '').trim().toLowerCase()
      if (code || msg) {
        return `${code}:${msg}`.slice(0, 200)
      }
      try {
        return JSON.stringify(failure).slice(0, 200)
      } catch {
        return 'unserializable_error'
      }
    }
    return String(failure).slice(0, 200)
  }

  recordFailure(taskId: string, failure: unknown): { shouldRetry: boolean; reason: string } {
    const fp = this.fingerprint(failure)
    const history = this.failureHistory.get(taskId) ?? []
    history.push(fp)
    this.failureHistory.set(taskId, history)

    const recent = history.slice(-this.identicalFailuresThreshold)
    if (recent.length >= this.identicalFailuresThreshold && recent.every((f) => f === fp)) {
      this.tripped = true
      this.tripReason = `Circuit breaker tripped: task ${taskId} encountered ${this.identicalFailuresThreshold} consecutive identical failures (${fp})`
      return { shouldRetry: false, reason: this.tripReason }
    }

    if (history.length > this.maxRetries) {
      return {
        shouldRetry: false,
        reason: `Task ${taskId} exceeded max retries (${this.maxRetries})`,
      }
    }

    return {
      shouldRetry: true,
      reason: `Task ${taskId} failure recorded; attempt ${history.length} of ${this.maxRetries}`,
    }
  }

  reset(): void {
    this.tripped = false
    this.tripReason = null
    this.failureHistory.clear()
  }
}
