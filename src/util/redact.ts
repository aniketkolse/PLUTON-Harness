import type { JsonValue } from '../domain/models.ts'

/**
 * Secret redaction for anything that leaves the process or is persisted in
 * events/logs (prompt §2.7: secrets never appear in yaml, db, events, logs or
 * argv). Key-name based: values under secret-looking keys are replaced before
 * the payload is stored or printed. This is a safety net, not a license to put
 * secrets in payloads — the runtime never puts credentials there by design.
 */
const SECRET_KEY_RE = /(secret|token|password|passwd|api[_-]?key|auth(orization)?|cookie|credential|private[_-]?key)/i

export const REDACTED = '[redacted]'

const MAX_DEPTH = 32

export function redactDeep(value: JsonValue, keyHint = ''): JsonValue {
  return redact(value, keyHint, 0)
}

function redact(v: JsonValue, keyHint: string, depth: number): JsonValue {
  if (depth > MAX_DEPTH) return '[depth-limit]'
  if (typeof v === 'string') {
    return SECRET_KEY_RE.test(keyHint) ? REDACTED : v
  }
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) {
    return v.map((item) => redact(item, '', depth + 1))
  }
  const out: { [k: string]: JsonValue } = {}
  for (const [k, child] of Object.entries(v)) {
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redact(child, k, depth + 1)
  }
  return out
}
