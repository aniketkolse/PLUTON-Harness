import { describe, expect, it } from 'vitest'
import { createTheme, type ThemeRole } from '../../src/tui/theme.ts'
import { stripAnsi } from '../../src/tui/width.ts'

describe('Theme tokens and icons', () => {
  it('supports violet, focus, border, success, and code roles', () => {
    const theme = createTheme({ color: true })
    const roles: ThemeRole[] = ['violet', 'focus', 'border', 'success', 'code', 'header', 'accent']
    for (const r of roles) {
      const painted = theme.paint(r, 'sample')
      expect(stripAnsi(painted)).toBe('sample')
      expect(painted).not.toBe('sample')
    }
  })

  it('provides icons with ascii fallbacks when disabled', () => {
    const coloredTheme = createTheme({ color: true })
    expect(coloredTheme.icon('check')).toBe('✓')
    expect(coloredTheme.icon('running')).toBe('◌')

    const plainTheme = createTheme({ color: false })
    expect(plainTheme.icon('check')).toBe('[v]')
    expect(plainTheme.icon('cross')).toBe('[x]')
    expect(plainTheme.icon('running')).toBe('..')
  })
})
