import { describe, expect, it } from 'vitest'
import { getUITheme } from '../../src/ui/theme.ts'
import { renderPirateShipLogo, renderBrandBanner } from '../../src/ui/brand.ts'
import { renderHeader, type HeaderProps } from '../../src/ui/header.ts'
import { stripAnsi, displayWidth } from '../../src/tui/width.ts'

describe('Pirate Ship Brand and Header (Phase 2)', () => {
  const theme = getUITheme({ colorLevel: 'truecolor', unicode: true })

  it('renders a recognizable pirate ship silhouette with skull and sails', () => {
    const shipLines = renderPirateShipLogo(theme)
    expect(shipLines.length).toBeGreaterThanOrEqual(4)
    const plain = shipLines.map((l) => stripAnsi(l)).join('\n')
    expect(plain).toMatch(/☠|X|x/) // Skull flag or ascii skull
    expect(plain).toMatch(/\\.*\/|_/) // Hull or deck
  })

  it('renders the brand banner with ship and PLUTON wordmark side-by-side', () => {
    const bannerLines = renderBrandBanner(theme)
    expect(bannerLines.length).toBeGreaterThanOrEqual(5)
    const plain = bannerLines.map((l) => stripAnsi(l)).join('\n')
    // In unicode it has block chars, in ascii it has PLUTON letters
    expect(plain).toMatch(/█▀█|___/)

    const asciiTheme = getUITheme({ colorLevel: 'none', unicode: false })
    const asciiBanner = renderBrandBanner(asciiTheme).map((l) => stripAnsi(l)).join('\n')
    expect(asciiBanner).toContain('___')
  })

  it('renders two-column wide header at 129 columns with metadata and separator', () => {
    const props: HeaderProps = {
      version: '0.1.0',
      engine: 'opencode',
      model: 'anthropic/claude-3-7-sonnet',
      rootDir: 'Y:/Pluton',
      museSlug: 'captain',
    }

    const lines = renderHeader(props, 129, theme)
    expect(lines.length).toBeGreaterThanOrEqual(6)

    const text = lines.map((l) => stripAnsi(l)).join('\n')
    expect(text).toContain('PLUTON')
    expect(text).toContain('v0.1.0')
    expect(text).toContain('Agentic Coding Harness')
    expect(text).toContain('Y:/Pluton')

    // Bottom rule check
    const lastLine = stripAnsi(lines[lines.length - 1]!)
    expect(lastLine).toMatch(/[─-]+/)
    expect(displayWidth(lastLine)).toBe(129)
  })

  it('renders compact header on narrow terminals (< 80 cols)', () => {
    const props: HeaderProps = {
      version: '0.1.0',
      engine: 'opencode',
      model: 'anthropic/claude-3-7-sonnet',
      rootDir: 'Y:/Pluton',
      museSlug: 'captain',
    }

    const lines = renderHeader(props, 70, theme)
    expect(lines.length).toBeLessThanOrEqual(3)
    const text = lines.map((l) => stripAnsi(l)).join('\n')
    expect(text).toContain('PLUTON')
    expect(text).toContain('v0.1.0')
  })
})
