import { describe, expect, it } from 'vitest'
import { canonicalJson, payloadHash, sha256Hex } from '../../src/util/canonical.ts'
import { redactDeep, REDACTED } from '../../src/util/redact.ts'
import { ValidationError } from '../../src/domain/errors.ts'
import type { JsonValue } from '../../src/domain/models.ts'

describe('canonicalJson', () => {
  it('sorts object keys and emits no whitespace', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
    expect(canonicalJson({ x: { d: [3, 2], c: null } })).toBe('{"x":{"c":null,"d":[3,2]}}')
  })

  it('is key-order independent for hashing but value-sensitive', () => {
    expect(payloadHash({ a: 1, b: 'x' })).toBe(payloadHash({ b: 'x', a: 1 }))
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }))
    expect(payloadHash({ a: [1, 2] })).not.toBe(payloadHash({ a: [2, 1] }))
  })

  it('treats -0 as 0 (same semantics, same hash)', () => {
    expect(payloadHash({ n: -0 })).toBe(payloadHash({ n: 0 }))
  })

  it('rejects non-JSON numbers and undefined values instead of coercing', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(ValidationError)
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(ValidationError)
    expect(() => canonicalJson({ a: undefined as unknown as JsonValue })).toThrow(ValidationError)
  })

  it('sha256Hex is stable and 64 hex chars', () => {
    const h = sha256Hex('pluton')
    expect(h).toHaveLength(64)
    expect(h).toBe(sha256Hex('pluton'))
    expect(h).not.toBe(sha256Hex('pluton '))
  })
})

describe('redactDeep', () => {
  it('redacts values under secret-looking keys, recursively', () => {
    const input: JsonValue = {
      password: 'p',
      nested: { api_key: 'k', authorization: 'Bearer x', safe: 'ok' },
      list: [{ token: 't' }],
    }
    expect(redactDeep(input)).toEqual({
      password: REDACTED,
      nested: { api_key: REDACTED, authorization: REDACTED, safe: 'ok' },
      list: [{ token: REDACTED }],
    })
  })

  it('replaces a whole array under a secret-looking key (safer than per-element guessing)', () => {
    expect(redactDeep({ tokens: ['a', 'b'] })).toEqual({ tokens: REDACTED })
  })

  it('leaves harmless payloads untouched', () => {
    const input: JsonValue = { goal: 'fix bug', files: ['a.ts'], count: 3, ok: true, nothing: null }
    expect(redactDeep(input)).toEqual(input)
  })

  it('tolerates optional payload fields that are undefined (worker.progress shape)', () => {
    // Live tool events may carry undefined optionals (tool.name/isError). The
    // redactor must not throw: Object.entries(undefined) aborted every
    // worker.progress broadcast with "Cannot convert undefined or null to object".
    const input = {
      step: 'read: src/index.ts',
      phase: 'start',
      tool: undefined,
      isError: undefined,
    } as unknown as JsonValue
    expect(() => redactDeep(input)).not.toThrow()
    expect(redactDeep(input)).toEqual({ step: 'read: src/index.ts', phase: 'start' })
  })
})
