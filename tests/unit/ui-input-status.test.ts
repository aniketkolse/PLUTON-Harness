import { describe, expect, it } from 'vitest'
import { getUITheme } from '../../src/ui/theme.ts'
import { renderInputBox, type InputBoxProps } from '../../src/ui/input.ts'
import { renderStatusBar, type StatusBarProps } from '../../src/ui/status.ts'
import { stripAnsi, displayWidth } from '../../src/tui/width.ts'

describe('Docked InputBox and Live StatusBar (Phase 7 & 8)', () => {
  const theme = getUITheme({ colorLevel: 'truecolor', unicode: true })

  it('renders rounded InputBox with border, prompt chevron, and placeholder', () => {
    const props: InputBoxProps = {
      draft: '',
      cursorPos: 0,
      placeholder: 'Ask Pluton to plan, implement, investigate…',
      focused: true,
      busy: false,
    }

    const { lines, cursor, boxHeight } = renderInputBox(props, 60, theme)
    expect(boxHeight).toBeGreaterThanOrEqual(3) // top border, 1+ content line, bottom border
    expect(lines.length).toBe(boxHeight)

    const top = stripAnsi(lines[0]!)
    expect(top.startsWith('╭')).toBe(true)
    expect(top.endsWith('╮')).toBe(true)
    expect(displayWidth(top)).toBe(60)

    const content = stripAnsi(lines[1]!)
    expect(content).toContain('> Ask Pluton to plan')
    expect(content.endsWith('│')).toBe(true)

    const bottom = stripAnsi(lines[lines.length - 1]!)
    expect(bottom.startsWith('╰')).toBe(true)
    expect(bottom.endsWith('╯')).toBe(true)

    expect(cursor.row).toBe(1)
    expect(cursor.col).toBe(4) // after '│ > '
  })

  it('renders InputBox with multi-line draft and computes cursor position', () => {
    const props: InputBoxProps = {
      draft: 'Line 1\nLine 2',
      cursorPos: 7, // start of Line 2
      focused: true,
    }

    const { lines, cursor } = renderInputBox(props, 60, theme)
    expect(lines.length).toBe(4) // top, line 1, line 2, bottom
    expect(cursor.row).toBe(2)
  })

  it('renders one-line StatusBar with state, mode, model, context%, and right-aligned /help', () => {
    const props: StatusBarProps = {
      state: 'ready',
      mode: 'chat',
      model: 'anthropic/claude-3-7-sonnet',
      contextPct: 42,
      museCount: 3,
      cost: 0.04,
    }

    const line = renderStatusBar(props, 120, theme)
    expect(displayWidth(stripAnsi(line))).toBe(120)

    const plain = stripAnsi(line)
    expect(plain).toContain('● Ready')
    expect(plain).toContain('Mode: chat')
    expect(plain).toContain('anthropic/claude-3-7-sonnet')
    expect(plain).toContain('Context: 42%')
    expect(plain).toContain('Muses: 3')
    expect(plain).toContain('$0.04')
    expect(plain).toContain('/help')
  })

  it('colors context usage yellow at 75% and red at 90%', () => {
    const propsYellow: StatusBarProps = {
      state: 'ready',
      mode: 'chat',
      model: 'model-a',
      contextPct: 75,
    }
    const lineYellow = renderStatusBar(propsYellow, 100, theme)
    expect(lineYellow).toContain('\x1b[38;2;251;191;36m') // warning yellow

    const propsRed: StatusBarProps = {
      state: 'ready',
      mode: 'chat',
      model: 'model-a',
      contextPct: 90,
    }
    const lineRed = renderStatusBar(propsRed, 100, theme)
    expect(lineRed).toContain('\x1b[38;2;248;113;113m') // error red
  })
})
