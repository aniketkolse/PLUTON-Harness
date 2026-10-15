import { createHash } from 'node:crypto'
import { ValidationError } from '../domain/errors.ts'
import type { JsonValue } from '../domain/models.ts'

/**
 * Canonical JSON (RFC 8785-style subset) used for request-payload hashing.
 * Rules: object keys sorted lexicographically, no whitespace, numbers must be
 * finite, `-0` normalizes to `0`, no undefined/NaN/Infinity anywhere.
 * Two payloads that differ only in key order hash identically; any real
 * difference in data hashes differently (this is what makes receipts work).
 */
export function canonicalJson(value: JsonValue): string {
  return canon(value, 0)
}

const MAX_DEPTH = 64

function canon(v: JsonValue, depth: number): string {
  if (depth > MAX_DEPTH) throw new ValidationError(`canonicalJson: payload nesting exceeds ${MAX_DEPTH}`)
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ValidationError('canonicalJson: numbers must be finite (no NaN/Infinity)')
    return JSON.stringify(Object.is(v, -0) ? 0 : v)
  }
  if (Array.isArray(v)) {
    return `[${v.map((item) => canon(item, depth + 1)).join(',')}]`
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort()
    const parts: string[] = []
    for (const k of keys) {
      const child = (v as { [k: string]: JsonValue })[k]
      if (child === undefined) {
        throw new ValidationError(`canonicalJson: key '${k}' has an undefined value — payloads must be JSON`)
      }
      parts.push(`${JSON.stringify(k)}:${canon(child, depth + 1)}`)
    }
    return `{${parts.join(',')}}`
  }
  throw new ValidationError(`canonicalJson: unsupported value type '${typeof v}'`)
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** sha256 of the canonical JSON encoding — the payload identity used by receipts. */
export function payloadHash(payload: JsonValue): string {
  return sha256Hex(canonicalJson(payload))
}
