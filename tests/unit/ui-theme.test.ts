import { describe, expect, it } from 'vitest'
import { getUITheme, PALETTE, type ColorLevel } from '../../src/ui/theme.ts'
import { stripAnsi } from '../../src/tui/width.ts'

describe('UITheme system (Phase 1)', () => {
  it('defines exact hex color palette tokens', () => {
    expect(PALETTE.bg).toBe('#0B0C10')
    expect(PALETTE.primaryAccent).toBe('#8B5CF6')
    expect(PALETTE.accentLight).toBe('#A78BFA')
    expect(PALETTE.cyan).toBe('#38BDF8')
    expect(PALETTE.info).toBe('#7C8CFF')
    expect(PALETTE.link).toBe('#60A5FA')
    expect(PALETTE.success).toBe('#34D399')
    expect(PALETTE.error).toBe('#F87171')
    expect(PALETTE.warning).toBe('#FBBF24')
    expect(PALETTE.textPrimary).toBe('#F3F0FA')
    expect(PALETTE.textSecondary).toBe('#E2E0EC')
    expect(PALETTE.textMuted).toBe('#A49FB4')
    expect(PALETTE.textDim).toBe('#8E8A9F')
    expect(PALETTE.border).toBe('#2A2F45')
  })

  it('generates 24-bit truecolor escape sequences when colorLevel is truecolor', () => {
    const theme = getUITheme({ colorLevel: 'truecolor', unicode: true })
    const painted = theme.paint('accent', 'Pluton')
    expect(painted).toContain('\x1b[38;2;139;92;246m')
    expect(painted).toContain('\x1b[39m')
    expect(stripAnsi(painted)).toBe('Pluton')
  })

  it('falls back to 256-color when colorLevel is 256', () => {
    const theme = getUITheme({ colorLevel: '256', unicode: true })
    const painted = theme.paint('accent', 'Pluton')
    expect(painted).toContain('\x1b[38;5;')
    expect(stripAnsi(painted)).toBe('Pluton')
  })

  it('falls back to 16-color when colorLevel is 16', () => {
    const theme = getUITheme({ colorLevel: '16', unicode: true })
    const painted = theme.paint('accent', 'Pluton')
    expect(painted).toContain('\x1b[35m') // magenta
    expect(stripAnsi(painted)).toBe('Pluton')
  })

  it('strips color and respects NO_COLOR / disabled colors', () => {
    const theme = getUITheme({ colorLevel: 'none', unicode: false })
    const painted = theme.paint('accent', 'Pluton')
    expect(painted).toBe('Pluton')
  })

  it('provides rounded box drawing characters with ascii fallback', () => {
    const unicodeTheme = getUITheme({ unicode: true })
    expect(unicodeTheme.box.topLeft).toBe('╭')
    expect(unicodeTheme.box.topRight).toBe('╮')
    expect(unicodeTheme.box.bottomLeft).toBe('╰')
    expect(unicodeTheme.box.bottomRight).toBe('╯')
    expect(unicodeTheme.box.horizontal).toBe('─')
    expect(unicodeTheme.box.vertical).toBe('│')

    const asciiTheme = getUITheme({ unicode: false })
    expect(asciiTheme.box.topLeft).toBe('+')
    expect(asciiTheme.box.topRight).toBe('+')
    expect(asciiTheme.box.bottomLeft).toBe('+')
    expect(asciiTheme.box.bottomRight).toBe('+')
    expect(asciiTheme.box.horizontal).toBe('-')
    expect(asciiTheme.box.vertical).toBe('|')
  })

  it('supports semantic roles including link, info, textPrimary, textMuted', () => {
    const theme = getUITheme({ colorLevel: 'truecolor' })
    expect(stripAnsi(theme.paint('link', 'src/cli/main.ts'))).toBe('src/cli/main.ts')
    expect(stripAnsi(theme.paint('info', 'important info'))).toBe('important info')
    expect(stripAnsi(theme.paint('textMuted', 'secondary text'))).toBe('secondary text')
  })
})
