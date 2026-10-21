import { describe, expect, it } from 'vitest'
import { REDACTED, redactProseSecrets } from '../../src/util/redact.ts'

/**
 * Pattern-based prose redaction (prompt §2.7): free-running text destined for
 * durable surfaces (answers, result bodies, settlement messages, event
 * payload strings) must not carry high-confidence credential shapes, even
 * when no secret-NAMED key would catch them via `redactDeep`.
 */
describe('redactProseSecrets', () => {
  it('is a no-op on ordinary prose', () => {
    const text = 'Research done: 26C observed, forecast disagrees with wttr.in. See task records.'
    expect(redactProseSecrets(text)).toBe(text)
  })

  it('redacts bare model-style tokens after sk-', () => {
    expect(redactProseSecrets('the key is sk-abcdefghijklmnopqrstuvwxyz123456 ok'))
      .toBe(`the key is sk-${REDACTED} ok`)
  })

  it('redacts bearer tokens while keeping the scheme word', () => {
    expect(redactProseSecrets('sent bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJyYW5kb20'))
      .toBe(`sent bearer ${REDACTED}`)
  })

  it('redacts key=value secret assignments in prose (trailing punctuation is consumed, as in the SPA pattern)', () => {
    expect(redactProseSecrets('connected with password=hunter2 api_key: "abcd1234"'))
      .toBe(`connected with password=${REDACTED} api_key: "${REDACTED}"`)
  })

  it('redacts all patterns in one pass and stays idempotent', () => {
    const once = redactProseSecrets('sk-abcdefghijklmnopqrstuvwxyz123456 bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJyYW5kb20 password=hunter2')
    expect(once).not.toContain('sk-abcdefghijkl')
    expect(once).not.toContain('eyJhbGciOiJIUzI1NiIs')
    expect(once).not.toContain('hunter2')
    expect(redactProseSecrets(once)).toBe(once)
  })

  it('does not redact ordinary words that merely resemble the markers', () => {
    expect(redactProseSecrets('token histogram: 12; task noted passphrase complexity in its report'))
      .toBe('token histogram: 12; task noted passphrase complexity in its report')
  })

  it('returns empty strings untouched', () => {
    expect(redactProseSecrets('')).toBe('')
  })
})
