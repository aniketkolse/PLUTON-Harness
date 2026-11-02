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
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) {
    return v.map((item) => redact(item, '', depth + 1))
  }
  const out: { [k: string]: JsonValue } = {}
  for (const [k, child] of Object.entries(v)) {
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redact(child, k, depth + 1)
  }
  return out
}

/**
 * Pattern-based secret redaction for free prose. `redactDeep` only catches
 * values under secret-NAMED keys; a model (or an engine error) can instead
 * echo a credential into free-running text that ends up persisted in
 * result/answer bodies, settlement messages, and event summaries (prompt §2.7:
 * secrets never appear in db, events, logs). This trims the handful of
 * high-confidence credential shapes before they are stored. It mirrors the
 * patterns the SPA applies at display time — server-side redaction is
 * defense in depth for the at-rest surfaces, not a license to emit secrets.
 */
const SK_TOKEN_RE = /sk-[a-zA-Z0-9_-]{16,}/g
const BEARER_TOKEN_RE = /(bearer[ \t]+)[a-zA-Z0-9_.-]{20,}/gi
const KEY_VALUE_SECRET_RE = /((?:api[_-]?key|password|token|secret)[ \t]*[:=][ \t]*["']?)[^ \t\r\n"']+/gi

/**
 * The SPA redaction helper (redactSecrets in src/server/static-assets.ts)
 * deliberately mirrors exactly these three patterns at display time — the two
 * surfaces cannot share one implementation (server bundles it for at-rest
 * persistence, the SPA standalone asset needs a local copy), so the
 * duplication is intentional and documented. The spa-ui parity test pins both
 * copies: a pattern change here fails tests until the SPA copy is updated,
 * and vice versa.
 */
export const PROSE_SECRET_PATTERNS: readonly RegExp[] = [SK_TOKEN_RE, BEARER_TOKEN_RE, KEY_VALUE_SECRET_RE]

export function redactProseSecrets(text: string): string {
  if (!text) return text
  return text
    .replace(SK_TOKEN_RE, `sk-${REDACTED}`)
    .replace(BEARER_TOKEN_RE, `$1${REDACTED}`)
    .replace(KEY_VALUE_SECRET_RE, `$1${REDACTED}`)
}
