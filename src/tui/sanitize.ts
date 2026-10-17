/**
 * Sanitizes untrusted terminal control escape sequences from engine and tool output
 * to prevent terminal injection vulnerabilities (e.g. screen clear, clipboard access,
 * cursor repositioning, alternate buffer switching).
 */

const CONTROL_ANSI_REGEX =
  /(?:\x1b|\u009B)(?:\[[0-9;?]*[A-HJKSTfhlmnsu]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[P^_].*?(?:\x1b\\|\x07)|\?[0-9]+[hl])/g

export function sanitizeTerminalText(text: string): string {
  if (!text) return ''
  return text.replace(CONTROL_ANSI_REGEX, '')
}
