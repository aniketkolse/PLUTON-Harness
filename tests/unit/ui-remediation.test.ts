import { describe, expect, it } from 'vitest'
import { getUITheme, detectUnicode } from '../../src/ui/theme.ts'
import { renderResultCard } from '../../src/ui/cards.ts'
import { stripAnsi, displayWidth } from '../../src/tui/width.ts'
import { renderFullScreenFrame } from '../../src/tui/render.ts'
import { renderMarkdown } from '../../src/tui/markdown.ts'

describe('Code Review Remediation Tests', () => {
  const theme = getUITheme({ colorLevel: 'truecolor', unicode: true })

  it('sanitizes dangerous terminal control escape codes from markdown and tool output', () => {
    const maliciousProse = 'Here is the result \x1b[2J\x1b[?1049l\x1b]52;c;evil\x07done.'
    const rendered = renderMarkdown(maliciousProse, 80, theme)
    const text = rendered.join('\n')
    expect(text).not.toContain('\x1b[2J')
    expect(text).not.toContain('\x1b[?1049l')
    expect(text).not.toContain('\x1b]52')
  })

  it('bounds ResultCard top line even with an extremely long title', () => {
    const card = {
      title: 'This is an extremely long title that exceeds the total available width of the card by a huge margin and would overflow without truncation',
      status: 'failed' as const,
      sections: [{ type: 'paragraph' as const, text: 'Hello' }],
    }

    const lines = renderResultCard(card, 60, theme)
    const top = stripAnsi(lines[0]!)
    expect(displayWidth(top)).toBe(60)
  })

  it('renders compact brand header when brandHeader is true on narrow terminal', () => {
    const frame = renderFullScreenFrame({
      header: {
        projectName: 'pluton-harness',
        rootDir: 'Y:/Pluton',
        museSlug: 'captain',
        engine: 'opencode',
        model: 'deepseek-v4',
        version: '0.1.0',
      },
      transcriptLines: ['Hello'],
      editor: { text: '', cursor: 0 },
      statusView: {
        museSlug: 'captain',
        engine: 'opencode',
        model: 'deepseek-v4',
        busy: false,
        run: null,
        approvalsPending: 0,
        usage: null,
      },
      columns: 70,
      rows: 20,
      theme,
      brandHeader: true,
    })

    const plain = stripAnsi(frame.lines.join('\n'))
    expect(plain).toMatch(/⚓|\[SHIP\]/)
    expect(plain).toContain('PLUTON')
    expect(plain).toContain('v0.1.0')
  })
})
