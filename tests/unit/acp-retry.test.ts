import { describe, expect, it } from 'vitest'
import { computeBackoffDelay, withRetry } from '../../src/engines/acp/retry.ts'

describe('acp backoff and retry', () => {
  it('computes exponential backoff bounded by maxDelayMs with jitter', () => {
    const opts = { initialDelayMs: 50, maxDelayMs: 500, backoffFactor: 2 }

    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = computeBackoffDelay(attempt, opts)
      // delay must be positive and not exceed maxDelayMs
      expect(delay).toBeGreaterThanOrEqual(25)
      expect(delay).toBeLessThanOrEqual(500)
    }

    // Attempt 0 base is 50; with [0.5, 1.0] jitter, delay in [25, 50]
    const delay0 = computeBackoffDelay(0, opts)
    expect(delay0).toBeGreaterThanOrEqual(25)
    expect(delay0).toBeLessThanOrEqual(50)

    // Large attempt capped at 500
    const delay10 = computeBackoffDelay(10, opts)
    expect(delay10).toBeLessThanOrEqual(500)
  })

  it('succeeds on first attempt without delay or retry', async () => {
    let calls = 0
    const sleptDelays: number[] = []

    const result = await withRetry(
      async () => {
        calls++
        return 'success'
      },
      {
        maxRetries: 3,
        sleepFn: async (ms) => {
          sleptDelays.push(ms)
        },
      },
    )

    expect(result).toBe('success')
    expect(calls).toBe(1)
    expect(sleptDelays).toEqual([])
  })

  it('retries N times on failure and succeeds on attempt N+1', async () => {
    let calls = 0
    const sleptDelays: number[] = []
    const retriedAttempts: number[] = []

    const result = await withRetry(
      async (attempt) => {
        calls++
        if (attempt < 2) {
          throw new Error(`transient spawn failure ${attempt}`)
        }
        return `recovered at ${attempt}`
      },
      {
        maxRetries: 3,
        initialDelayMs: 50,
        maxDelayMs: 500,
        sleepFn: async (ms) => {
          sleptDelays.push(ms)
        },
      },
      (_err, attempt, delay) => {
        retriedAttempts.push(attempt)
        expect(delay).toBeGreaterThan(0)
      },
    )

    expect(result).toBe('recovered at 2')
    expect(calls).toBe(3) // attempt 0, attempt 1, attempt 2
    expect(retriedAttempts).toEqual([1, 2])
    expect(sleptDelays.length).toBe(2)
  })

  it('throws final error when retries are exhausted', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('persistent spawn error')
        },
        {
          maxRetries: 2,
          sleepFn: async () => {},
        },
      ),
    ).rejects.toThrow('persistent spawn error')

    expect(calls).toBe(3) // attempt 0 + 2 retries
  })
})
