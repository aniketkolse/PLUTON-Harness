import { describe, expect, it } from 'vitest'
import { getUITheme } from '../../src/ui/theme.ts'
import { renderUserMessage, renderAssistantMessage } from '../../src/ui/messages.ts'
import { stripAnsi } from '../../src/tui/width.ts'

describe('User and Assistant Message Components (Phase 4.1 & 4.2)', () => {
  const theme = getUITheme({ colorLevel: 'truecolor', unicode: true })

  it('renders UserMessage with lavender label and bold text', () => {
    const lines = renderUserMessage('What happened in my last failed build?', 80, theme)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const plain = stripAnsi(lines[0]!)
    expect(plain).toMatch(/👤 You  What happened in my last failed build\?/)
  })

  it('wraps long UserMessage cleanly', () => {
    const longText = 'This is a very long user prompt that exceeds the terminal width and must be wrapped across multiple lines while preserving readability and not breaking words awkwardly.'
    const lines = renderUserMessage(longText, 40, theme)
    expect(lines.length).toBeGreaterThan(1)
    expect(stripAnsi(lines[0]!)).toContain('👤 You')
  })

  it('provides ascii icon fallback for UserMessage when unicode is disabled', () => {
    const asciiTheme = getUITheme({ colorLevel: 'none', unicode: false })
    const lines = renderUserMessage('Hello Pluton', 80, asciiTheme)
    const plain = stripAnsi(lines[0]!)
    expect(plain).toMatch(/> You  Hello Pluton/)
  })

  it('renders AssistantMessage identity and indented markdown content', () => {
    const markdown = 'Here is the analysis:\n- Test 1 passed\n- Test 2 failed'
    const lines = renderAssistantMessage(markdown, 80, theme)
    expect(lines.length).toBeGreaterThanOrEqual(3)

    const plainHeader = stripAnsi(lines[0]!)
    expect(plainHeader).toMatch(/⛵ PLUTON|\[SHIP\] PLUTON/)

    // Content should be indented
    const plainBody1 = stripAnsi(lines[1]!)
    expect(plainBody1.startsWith('  ')).toBe(true)
    expect(plainBody1).toContain('Here is the analysis:')
  })
})
