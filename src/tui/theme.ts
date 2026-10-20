import { detectColorLevel, getUITheme, type ColorLevel, type UIRole } from '../ui/theme.ts'

/**
 * Terminal color theme and paint tokens (ADR-0012).
 * Zero dependencies, respects NO_COLOR and provides ASCII/limited fallbacks.
 *
 * The terminal surface is a sibling of the graphical workspace, not a separate
 * design system: every colour resolves through the canonical PLUTON palette
 * in `src/ui/theme.ts`, so a truecolor terminal shows the same violet, cyan
 * and text ramp as the browser and a 256- or 16-colour terminal degrades
 * through one shared fallback table.
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

/**
 * Terminal role names resolve onto the shared PLUTON role names. The terminal
 * keeps its own vocabulary (`warn`, `dim`, `tool`); the palette decides what
 * those roles look like.
 */
const TUI_TO_UI_ROLE: Record<ThemeRole, UIRole> = {
  accent: 'accent',
  violet: 'violet',
  focus: 'focus',
  dim: 'dim',
  error: 'error',
  warn: 'warning',
  success: 'success',
  tool: 'tool',
  toolError: 'toolError',
  user: 'user',
  status: 'status',
  input: 'input',
  approval: 'approval',
  border: 'border',
  code: 'code',
  header: 'header',
  badge: 'badge',
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

export type { UITheme, UIRole, UIIcon, ColorLevel, BoxChars } from '../ui/theme.ts'
export { PALETTE, getUITheme } from '../ui/theme.ts'

export function createTheme(opts: { color?: boolean } = {}): Theme {
  let level: ColorLevel
  if (opts.color === true) {
    level = 'truecolor'
  } else if (opts.color === false) {
    level = 'none'
  } else {
    // Auto: colour only when the session is attached to a terminal, and never
    // under NO_COLOR. A piped or captured session stays plain.
    const tty = process.stdout?.isTTY ?? false
    const noColor = process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== ''
    level = tty && !noColor ? detectColorLevel() : 'none'
  }
  const ui = getUITheme({ colorLevel: level })
  return {
    enabled: ui.enabled,
    paint(role: ThemeRole, text: string): string {
      if (!ui.enabled || !text) return text
      return ui.paint(TUI_TO_UI_ROLE[role], text)
    },
    icon(name: ThemeIcon): string {
      // The plain theme (`color: false`) is the ASCII snapshot used by the
      // terminal tests and by no-colour terminals: it drops to ASCII marks.
      return ui.enabled ? UNICODE_ICONS[name] : ASCII_ICONS[name]
    },
  }
}
