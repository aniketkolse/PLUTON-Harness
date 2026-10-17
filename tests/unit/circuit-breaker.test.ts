import { describe, expect, it } from 'vitest'
import { CircuitBreaker } from '../../src/orchestrator/circuit-breaker.ts'

describe('CircuitBreaker', () => {
  it('allows retries under the max retry limit for non-identical errors', () => {
    const cb = new CircuitBreaker({ maxRetriesPerTask: 2, consecutiveIdenticalFailuresThreshold: 3 })
    
    const r1 = cb.recordFailure('task-1', { code: 'network_timeout', message: 'timeout on host A' })
    expect(r1.shouldRetry).toBe(true)
    expect(cb.isTripped()).toBe(false)

    const r2 = cb.recordFailure('task-1', { code: 'compilation_error', message: 'syntax error in foo.ts' })
    expect(r2.shouldRetry).toBe(true)
    expect(cb.isTripped()).toBe(false)

    const r3 = cb.recordFailure('task-1', { code: 'test_failed', message: 'assert failed' })
    expect(r3.shouldRetry).toBe(false)
    expect(r3.reason).toContain('exceeded max retries')
  })

  it('detects repeated identical failures and trips the circuit breaker', () => {
    const cb = new CircuitBreaker({ maxRetriesPerTask: 5, consecutiveIdenticalFailuresThreshold: 2 })

    const r1 = cb.recordFailure('task-1', { code: 'type_error', message: 'Cannot find module X' })
    expect(r1.shouldRetry).toBe(true)
    expect(cb.isTripped()).toBe(false)

    // Second consecutive identical failure trips
    const r2 = cb.recordFailure('task-1', { code: 'type_error', message: 'Cannot find module X' })
    expect(r2.shouldRetry).toBe(false)
    expect(cb.isTripped()).toBe(true)
    expect(cb.getTripReason()).toContain('consecutive identical failures')
  })

  it('generates consistent fingerprints for string and object errors', () => {
    const cb = new CircuitBreaker()
    const fp1 = cb.fingerprint('Error: connection refused at 127.0.0.1:8080')
    const fp2 = cb.fingerprint('Error: connection refused at 127.0.0.1:8080')
    expect(fp1).toBe(fp2)

    const fp3 = cb.fingerprint({ error: 'EADDRINUSE', details: 'port busy' })
    const fp4 = cb.fingerprint({ error: 'EADDRINUSE', details: 'port busy' })
    expect(fp3).toBe(fp4)
  })
})
