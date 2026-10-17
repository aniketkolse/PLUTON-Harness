import { describe, expect, it } from 'vitest'
import { getUITheme } from '../../src/ui/theme.ts'
import {
  renderResultCard,
  renderDiffBlock,
  highlightFilePaths,
  type ResultCardData,
} from '../../src/ui/cards.ts'
import { stripAnsi, displayWidth } from '../../src/tui/width.ts'

describe('ResultCard, Checklist, DiffBlock & File Link Highlighting (Phase 5)', () => {
  const theme = getUITheme({ colorLevel: 'truecolor', unicode: true })

  it('renders rounded border ResultCard with correct width', () => {
    const card: ResultCardData = {
      title: 'Latest run: abc123 "Currency validator" — failed (43s, CI)',
      status: 'failed',
      sections: [
        {
          type: 'checklist',
          items: [
            { text: 'Build and lint passed', status: 'pass' },
            { text: 'Tests failed', status: 'fail' },
            { text: 'Coverage did not run', status: 'neutral' },
          ],
        },
        {
          type: 'paragraph',
          text: 'Root cause: src/validators/currency.js',
        },
        {
          type: 'diff',
          diff: '- if (oldCondition) {\n+ if (correctedCondition) {',
        },
      ],
      completedDuration: '46s',
    }

    const lines = renderResultCard(card, 70, theme)
    expect(lines.length).toBeGreaterThan(6)

    // Check top line rounded corner
    const top = stripAnsi(lines[0]!)
    expect(top.startsWith('╭─')).toBe(true)
    expect(top.endsWith('╮')).toBe(true)
    expect(displayWidth(top)).toBe(70)

    // Check bottom line rounded corner
    const bottom = stripAnsi(lines[lines.length - 1]!)
    expect(bottom.startsWith('╰')).toBe(true)
    expect(bottom.endsWith('╯')).toBe(true)
    expect(displayWidth(bottom)).toBe(70)

    // Check checklist items
    const plainText = lines.map((l) => stripAnsi(l)).join('\n')
    expect(plainText).toContain('✓ Build and lint passed')
    expect(plainText).toContain('✗ Tests failed')
    expect(plainText).toContain('- Coverage did not run')
    expect(plainText).toContain('Completed in 46s')
  })

  it('renders DiffBlock with red removals and green additions', () => {
    const diff = '- const bad = true\n+ const good = true'
    const lines = renderDiffBlock(diff, 60, theme)
    expect(lines.length).toBe(2)

    // Line 0 is removal (red)
    expect(lines[0]).toContain('\x1b[38;2;248;113;113m') // error/red hex
    expect(stripAnsi(lines[0]!)).toContain('- const bad = true')

    // Line 1 is addition (green)
    expect(lines[1]).toContain('\x1b[38;2;52;211;153m') // success/green hex
    expect(stripAnsi(lines[1]!)).toContain('+ const good = true')
  })

  it('highlights repository-relative file paths in paragraphs', () => {
    const text = 'Check the file src/validators/currency.js and tests/unit/card.test.ts for details.'
    const highlighted = highlightFilePaths(text, theme)
    expect(highlighted).toContain('\x1b[38;2;96;165;250m') // link hex #60A5FA
    expect(stripAnsi(highlighted)).toBe(text)
  })
})
