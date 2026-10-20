import type { JsonValue } from '../domain/models.ts'

/**
 * Terminal-safety stripping shared by every trust boundary that persists or
 * prints operator-facing text (approval rows, engine events, CLI renderers).
 * Removes C0/C1 control bytes (ESC/CR/BEL/CSI …) and Unicode bidi controls so
 * no model- or engine-provided string can drive a terminal or reorder the card
 * it renders in.
 *
 * This is NOT a redactor: secrets are handled per field (key-based
 * `redactDeep` for scope); values under benign keys stay operator-visible.
 */
export const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** Removes every control byte/char (including newlines) — single-line fields. */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHAR_REGEX, '')
}

/** Deep variant for JSON payloads (scope objects, event fields). */
export function stripControlDeep(value: JsonValue): JsonValue {
  if (typeof value === 'string') return stripControlChars(value)
  if (Array.isArray(value)) return value.map((entry) => stripControlDeep(entry as JsonValue))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = stripControlDeep(entry as JsonValue)
    return out
  }
  return value
}

/**
 * One printable line for terminal renderers: control bytes/sequences become
 * spaces (so words never fuse across a stripped newline) and surviving
 * whitespace collapses. Use where the text must stay readable, not just inert.
 */
export function terminalSafeLine(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
