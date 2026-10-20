/**
 * Centralized design system tokens, color handling, and terminal capabilities.
 * Supports Truecolor (24-bit), 256-color, 16-color, and NO_COLOR environments.
 */

export const PALETTE = {
  bg: '#0B0C10',
  primaryAccent: '#8B5CF6',
  accentLight: '#A78BFA',
  cyan: '#38BDF8',
  info: '#7C8CFF',
  link: '#60A5FA',
  success: '#34D399',
  error: '#F87171',
  warning: '#FBBF24',
  textPrimary: '#F3F0FA',
  textSecondary: '#E2E0EC',
  textMuted: '#A49FB4',
  textDim: '#8E8A9F',
  border: '#2A2F45',
} as const

export type ColorLevel = 'truecolor' | '256' | '16' | 'none'

export type UIRole =
  | 'accent'
  | 'accentLight'
  | 'violet'
  | 'info'
  | 'link'
  | 'success'
  | 'error'
  | 'warn'
  | 'warning'
  | 'textPrimary'
  | 'textSecondary'
  | 'textMuted'
  | 'textDim'
  | 'dim'
  | 'border'
  | 'focus'
  | 'code'
  | 'user'
  | 'status'
  | 'input'
  | 'approval'
  | 'tool'
  | 'toolError'
  | 'header'
  | 'badge'

export type UIIcon =
  | 'check'
  | 'cross'
  | 'bullet'
  | 'running'
  | 'idle'
  | 'arrowRight'
  | 'arrowDown'
  | 'ship'
  | 'substep'
  | 'warning'

export interface BoxChars {
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
  horizontal: string
  vertical: string
  tDown: string
  tUp: string
  tRight: string
  tLeft: string
  cross: string
}

export interface UITheme {
  colorLevel: ColorLevel
  enabled: boolean
  unicode: boolean
  box: BoxChars
  paint(role: UIRole, text: string): string
  icon(name: UIIcon): string
}

const HEX_RGB: Record<string, [number, number, number]> = {
  [PALETTE.bg]: [11, 12, 16],
  [PALETTE.primaryAccent]: [139, 92, 246],
  [PALETTE.accentLight]: [167, 139, 250],
  [PALETTE.cyan]: [56, 189, 248],
  [PALETTE.info]: [124, 140, 255],
  [PALETTE.link]: [96, 165, 250],
  [PALETTE.success]: [52, 211, 153],
  [PALETTE.error]: [248, 113, 113],
  [PALETTE.warning]: [251, 191, 36],
  [PALETTE.textPrimary]: [243, 240, 250],
  [PALETTE.textSecondary]: [226, 224, 236],
  [PALETTE.textMuted]: [164, 159, 180],
  [PALETTE.textDim]: [142, 138, 159],
  [PALETTE.border]: [42, 47, 69],
}

const ROLE_HEX: Record<UIRole, string> = {
  accent: PALETTE.primaryAccent,
  violet: PALETTE.primaryAccent,
  accentLight: PALETTE.accentLight,
  info: PALETTE.info,
  link: PALETTE.link,
  success: PALETTE.success,
  error: PALETTE.error,
  warn: PALETTE.warning,
  warning: PALETTE.warning,
  textPrimary: PALETTE.textPrimary,
  textSecondary: PALETTE.textSecondary,
  textMuted: PALETTE.textMuted,
  textDim: PALETTE.textDim,
  user: PALETTE.textPrimary,
  status: PALETTE.textPrimary,
  input: PALETTE.textPrimary,
  dim: PALETTE.textDim,
  border: PALETTE.border,
  focus: PALETTE.cyan,
  code: PALETTE.textSecondary,
  approval: PALETTE.warning,
  tool: PALETTE.info,
  toolError: PALETTE.error,
  header: PALETTE.primaryAccent,
  badge: PALETTE.primaryAccent,
}

// 256-color fallback codes
const ROLE_256: Record<UIRole, number> = {
  accent: 141,
  violet: 141,
  accentLight: 147,
  info: 111,
  link: 75,
  success: 78,
  error: 203,
  warn: 215,
  warning: 215,
  textPrimary: 254,
  textSecondary: 254,
  textMuted: 246,
  textDim: 243,
  user: 254,
  status: 254,
  input: 254,
  dim: 243,
  border: 237,
  focus: 75,
  code: 252,
  approval: 215,
  tool: 111,
  toolError: 203,
  header: 141,
  badge: 141,
}

// 16-color ANSI fallback codes
const ROLE_16: Record<UIRole, { open: string; close: string }> = {
  accent: { open: '\x1b[35m', close: '\x1b[39m' }, // magenta
  violet: { open: '\x1b[35m', close: '\x1b[39m' },
  accentLight: { open: '\x1b[95m', close: '\x1b[39m' }, // bright magenta
  info: { open: '\x1b[36m', close: '\x1b[39m' }, // cyan
  link: { open: '\x1b[94m', close: '\x1b[39m' }, // bright blue
  success: { open: '\x1b[32m', close: '\x1b[39m' }, // green
  error: { open: '\x1b[31m', close: '\x1b[39m' }, // red
  warn: { open: '\x1b[33m', close: '\x1b[39m' }, // yellow
  warning: { open: '\x1b[33m', close: '\x1b[39m' },
  textPrimary: { open: '\x1b[37m', close: '\x1b[39m' }, // white
  textSecondary: { open: '\x1b[37m', close: '\x1b[39m' },
  textMuted: { open: '\x1b[90m', close: '\x1b[39m' }, // bright black (gray)
  textDim: { open: '\x1b[90m', close: '\x1b[39m' },
  user: { open: '\x1b[37m', close: '\x1b[39m' },
  status: { open: '\x1b[37m', close: '\x1b[39m' },
  input: { open: '\x1b[1;37m', close: '\x1b[0m' }, // bold white
  dim: { open: '\x1b[2m', close: '\x1b[22m' },
  border: { open: '\x1b[90m', close: '\x1b[39m' },
  focus: { open: '\x1b[96m', close: '\x1b[39m' }, // bright cyan
  code: { open: '\x1b[37m', close: '\x1b[39m' },
  approval: { open: '\x1b[33m', close: '\x1b[39m' },
  tool: { open: '\x1b[36m', close: '\x1b[39m' },
  toolError: { open: '\x1b[31m', close: '\x1b[39m' },
  header: { open: '\x1b[35m', close: '\x1b[39m' },
  badge: { open: '\x1b[35m', close: '\x1b[39m' },
}

export function detectColorLevel(): ColorLevel {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') {
    return 'none'
  }
  const colorterm = (process.env['COLORTERM'] ?? '').toLowerCase()
  if (colorterm === 'truecolor' || colorterm === '24bit') {
    return 'truecolor'
  }
  const term = (process.env['TERM'] ?? '').toLowerCase()
  if (term.includes('256color') || term.includes('xterm') || term.includes('alacritty') || term.includes('kitty')) {
    return '256'
  }
  if (process.stdout.isTTY) {
    return '256'
  }
  return 'none'
}

export function detectUnicode(): boolean {
  if (process.env['TERM'] === 'dumb') return false
  if (
    process.env['LC_ALL']?.includes('UTF-8') ||
    process.env['LC_CTYPE']?.includes('UTF-8') ||
    process.env['LANG']?.includes('UTF-8') ||
    process.env['WT_SESSION'] ||
    process.env['TERM_PROGRAM']
  ) {
    return true
  }
  return process.platform === 'win32'
}

export interface UIThemeOptions {
  colorLevel?: ColorLevel
  color?: boolean
  unicode?: boolean
}

export function getUITheme(options?: UIThemeOptions): UITheme {
  let colorLevel: ColorLevel
  if (options?.color === false) {
    colorLevel = 'none'
  } else if (options?.colorLevel) {
    colorLevel = options.colorLevel
  } else {
    colorLevel = detectColorLevel()
  }

  const unicode = options?.unicode ?? detectUnicode()

  const box: BoxChars = unicode
    ? {
        topLeft: '╭',
        topRight: '╮',
        bottomLeft: '╰',
        bottomRight: '╯',
        horizontal: '─',
        vertical: '│',
        tDown: '┬',
        tUp: '┴',
        tRight: '├',
        tLeft: '┤',
        cross: '┼',
      }
    : {
        topLeft: '+',
        topRight: '+',
        bottomLeft: '+',
        bottomRight: '+',
        horizontal: '-',
        vertical: '|',
        tDown: '+',
        tUp: '+',
        tRight: '+',
        tLeft: '+',
        cross: '+',
      }

  const unicodeIcons: Record<UIIcon, string> = {
    check: '✓',
    cross: '✗',
    bullet: '●',
    running: '◌',
    idle: '○',
    arrowRight: '→',
    arrowDown: '↓',
    ship: '⛵',
    substep: '↳',
    warning: '⚠',
  }

  const asciiIcons: Record<UIIcon, string> = {
    check: '[v]',
    cross: '[x]',
    bullet: '*',
    running: '..',
    idle: '.',
    arrowRight: '->',
    arrowDown: 'v',
    ship: '[SHIP]',
    substep: '>',
    warning: '[!]',
  }

  return {
    colorLevel,
    enabled: colorLevel !== 'none',
    unicode,
    box,
    paint(role: UIRole, text: string): string {
      if (colorLevel === 'none' || !text) return text

      if (colorLevel === 'truecolor') {
        const hex = ROLE_HEX[role] ?? PALETTE.textPrimary
        const rgb = HEX_RGB[hex] ?? [229, 231, 235]
        return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`
      }

      if (colorLevel === '256') {
        const code = ROLE_256[role] ?? 254
        return `\x1b[38;5;${code}m${text}\x1b[39m`
      }

      const c16 = ROLE_16[role] ?? { open: '\x1b[37m', close: '\x1b[39m' }
      return `${c16.open}${text}${c16.close}`
    },
    icon(name: UIIcon): string {
      return unicode ? unicodeIcons[name] ?? '•' : asciiIcons[name] ?? '*'
    },
  }
}
