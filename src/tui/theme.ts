/**
 * Terminal color theme and paint tokens (ADR-0012).
 * Zero dependencies, respects NO_COLOR and provides ASCII/limited fallbacks.
 */

export type ThemeRole =
  | 'accent'
  | 'violet'
  | 'focus'
  | 'dim'
  | 'error'
  | 'warn'
  | 'success'
  | 'tool'
  | 'toolError'
  | 'user'
  | 'status'
  | 'input'
  | 'approval'
  | 'border'
  | 'code'
  | 'header'
  | 'badge'

export type ThemeIcon =
  | 'check'
  | 'cross'
  | 'bullet'
  | 'running'
  | 'idle'
  | 'arrowRight'
  | 'arrowDown'
  | 'ship'

export interface Theme {
  enabled: boolean
  paint(role: ThemeRole, text: string): string
  icon(name: ThemeIcon): string
}

const CODES: Record<ThemeRole, { open: string; close: string }> = {
  accent: { open: '\x1b[38;5;141m', close: '\x1b[39m' }, // Pluton muted violet
  violet: { open: '\x1b[38;5;141m', close: '\x1b[39m' }, // Pluton muted violet
  focus: { open: '\x1b[38;5;75m', close: '\x1b[39m' }, // Cool cyan/blue
  dim: { open: '\x1b[2m', close: '\x1b[22m' }, // Dim grey
  error: { open: '\x1b[31m', close: '\x1b[39m' }, // Red
  warn: { open: '\x1b[33m', close: '\x1b[39m' }, // Amber / Yellow
  success: { open: '\x1b[32m', close: '\x1b[39m' }, // Green
  tool: { open: '\x1b[38;5;147m', close: '\x1b[39m' }, // Light violet
  toolError: { open: '\x1b[1;31m', close: '\x1b[0m' }, // Bold red
  user: { open: '\x1b[32m', close: '\x1b[39m' }, // Green
  status: { open: '\x1b[2;37m', close: '\x1b[0m' }, // Dim white
  input: { open: '\x1b[1m', close: '\x1b[22m' }, // Bold
  approval: { open: '\x1b[1;33m', close: '\x1b[0m' }, // Bold yellow
  border: { open: '\x1b[38;5;238m', close: '\x1b[39m' }, // Subtle charcoal
  code: { open: '\x1b[38;5;222m', close: '\x1b[39m' }, // Warm code accent
  header: { open: '\x1b[1;38;5;141m', close: '\x1b[0m' }, // Bold violet
  badge: { open: '\x1b[7m', close: '\x1b[27m' }, // Inverse pill
}

const UNICODE_ICONS = {
  check: '✓',
  cross: '✖',
  bullet: '●',
  running: '◌',
  idle: '○',
  arrowRight: '▸',
  arrowDown: '▾',
  ship: '⛵',
}

const ASCII_ICONS = {
  check: '[v]',
  cross: '[x]',
  bullet: '*',
  running: '..',
  idle: 'o',
  arrowRight: '>',
  arrowDown: 'v',
  ship: '~^~',
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
    icon(name: ThemeIcon): string {
      return enabled ? UNICODE_ICONS[name] : ASCII_ICONS[name]
    },
  }
}
