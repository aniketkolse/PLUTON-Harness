/**
 * Bounded exponential backoff with full jitter (ADR-0006, PR-3).
 * Used exclusively for side-effect-free phases (engine process spawn and transport handshake).
 * Never blindly resends prompts or mutations that may have reached the model.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts after the initial failure (default: 0 in tests, 2 in prod). */
  maxRetries?: number
  /** Initial delay in milliseconds before the first retry (default: 50ms). */
  initialDelayMs?: number
  /** Maximum delay cap in milliseconds (default: 1000ms). */
  maxDelayMs?: number
  /** Exponential backoff multiplier (default: 2). */
  backoffFactor?: number
  /** Injectable sleep function (allows instantaneous time advancement in tests). */
  sleepFn?: (ms: number) => Promise<void>
}

/**
 * Computes a bounded exponential backoff delay with full jitter.
 */
export function computeBackoffDelay(
  attempt: number,
  opts?: Pick<RetryOptions, 'initialDelayMs' | 'maxDelayMs' | 'backoffFactor'>,
): number {
  const initial = opts?.initialDelayMs ?? 50
  const max = opts?.maxDelayMs ?? 1000
  const factor = opts?.backoffFactor ?? 2

  const base = Math.min(max, initial * Math.pow(factor, attempt))
  // Full jitter: uniformly random between 0.5 * base and 1.0 * base
  const jitter = Math.random() * (base * 0.5)
  return Math.min(max, Math.round(base * 0.5 + jitter))
}

/**
 * Executes a side-effect-free async action with bounded exponential backoff and jitter.
 */
export async function withRetry<T>(
  action: (attempt: number) => Promise<T>,
  opts?: RetryOptions,
  onRetry?: (error: Error, attempt: number, delayMs: number) => Promise<void> | void,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 0
  const sleep = opts?.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  let attempt = 0
  while (true) {
    try {
      return await action(attempt)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (attempt >= maxRetries) {
        throw error
      }
      const delayMs = computeBackoffDelay(attempt, opts)
      if (onRetry) {
        await onRetry(error, attempt + 1, delayMs)
      }
      await sleep(delayMs)
      attempt++
    }
  }
}
