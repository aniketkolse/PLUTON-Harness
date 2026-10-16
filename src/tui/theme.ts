/**
 * Terminal color theme and paint tokens (ADR-0012).
 * Zero dependencies, respects NO_COLOR.
 */

export type ThemeRole =
  | 'accent'
  | 'dim'
  | 'error'
  | 'warn'
  | 'tool'
  | 'toolError'
  | 'user'
  | 'status'
  | 'input'
  | 'approval'

export interface Theme {
  enabled: boolean
  paint(role: ThemeRole, text: string): string
}

const CODES: Record<ThemeRole, { open: string; close: string }> = {
  accent: { open: '\x1b[36m', close: '\x1b[39m' }, // cyan
  dim: { open: '\x1b[2m', close: '\x1b[22m' }, // dim
  error: { open: '\x1b[31m', close: '\x1b[39m' }, // red
  warn: { open: '\x1b[33m', close: '\x1b[39m' }, // yellow
  tool: { open: '\x1b[35m', close: '\x1b[39m' }, // magenta
  toolError: { open: '\x1b[1;31m', close: '\x1b[0m' }, // bold red
  user: { open: '\x1b[32m', close: '\x1b[39m' }, // green
  status: { open: '\x1b[2;37m', close: '\x1b[0m' }, // dim white
  input: { open: '\x1b[1m', close: '\x1b[22m' }, // bold
  approval: { open: '\x1b[1;33m', close: '\x1b[0m' }, // bold yellow
}

export function createTheme(opts: { color?: boolean } = {}): Theme {
  let enabled: boolean
  if (opts.color !== undefined) {
    enabled = opts.color
  } else {
    const noColor = process.env['NO_COLOR']
    if (noColor !== undefined && noColor !== '') {
      enabled = false
    } else {
      enabled = process.stdout?.isTTY ?? false
    }
  }

  return {
    enabled,
    paint(role: ThemeRole, text: string): string {
      if (!enabled || !text) return text
      const code = CODES[role]
      if (!code) return text
      return `${code.open}${text}${code.close}`
    },
  }
}
