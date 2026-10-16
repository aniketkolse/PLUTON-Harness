import { describe, expect, it } from 'vitest'
import { displayWidth, stripAnsi, truncateToWidth, wrapText } from '../../src/tui/width.ts'

describe('stripAnsi', () => {
  it('leaves plain text untouched', () => {
    expect(stripAnsi('')).toBe('')
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('removes color, style, and cursor ANSI sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('\x1b[1;32;4mbold green underline\x1b[0m')).toBe('bold green underline')
    expect(stripAnsi('\x1b[2J\x1b[Hclear screen')).toBe('clear screen')
    expect(stripAnsi('mix \x1b[38;5;214m256-color\x1b[39m end')).toBe('mix 256-color end')
  })
})

describe('displayWidth', () => {
  it('measures ASCII characters as width 1', () => {
    expect(displayWidth('a')).toBe(1)
    expect(displayWidth('hello')).toBe(5)
    expect(displayWidth(' ')).toBe(1)
    expect(displayWidth('')).toBe(0)
  })

  it('measures CJK ideographs as width 2', () => {
    expect(displayWidth('宽')).toBe(2)
    expect(displayWidth('你好')).toBe(4)
    expect(displayWidth('a宽b')).toBe(4)
  })

  it('measures combining characters as width 0 attached to base', () => {
    // 'e\u0301' -> e with acute accent = width 1
    expect(displayWidth('e\u0301')).toBe(1)
    expect(displayWidth('caf\u0065\u0301')).toBe(4)
  })

  it('measures emojis and ZWJ sequences as width 2', () => {
    expect(displayWidth('👍')).toBe(2)
    expect(displayWidth('🎉')).toBe(2)
    // ZWJ family sequence: 👨‍👩‍👧‍👦
    expect(displayWidth('👨‍👩‍👧‍👦')).toBe(2)
    // Emoji with skin tone modifier
    expect(displayWidth('👍🏽')).toBe(2)
  })

  it('ignores ANSI sequences in width calculation', () => {
    expect(displayWidth('\x1b[31mred\x1b[0m')).toBe(3)
    expect(displayWidth('\x1b[1m\x1b[32m宽\x1b[0m')).toBe(2)
    expect(displayWidth('\x1b[33mhello \x1b[34mworld\x1b[0m')).toBe(11)
  })
})

describe('wrapText', () => {
  it('wraps simple words at or before maxWidth', () => {
    const text = 'the quick brown fox jumps over the lazy dog'
    const wrapped = wrapText(text, 15)
    expect(wrapped).toEqual([
      'the quick brown',
      'fox jumps over',
      'the lazy dog',
    ])
    for (const line of wrapped) {
      expect(displayWidth(line)).toBeLessThanOrEqual(15)
    }
  })

  it('hard-breaks overlong tokens that exceed maxWidth', () => {
    const text = 'supercalifragilisticexpialidocious'
    const wrapped = wrapText(text, 10)
    expect(wrapped).toEqual([
      'supercalif',
      'ragilistic',
      'expialidoc',
      'ious',
    ])
  })

  it('respects existing newlines', () => {
    const text = 'line one\n\nline two is longer\nline three'
    const wrapped = wrapText(text, 10)
    expect(wrapped).toEqual([
      'line one',
      '',
      'line two',
      'is longer',
      'line three',
    ])
  })

  it('expands tabs to 8-column tab stops', () => {
    const text = 'a\tb'
    // 'a' (col 1) + 7 spaces to reach stop at col 8 + 'b'
    const wrapped = wrapText(text, 20)
    expect(wrapped).toEqual(['a       b'])
    expect(displayWidth(wrapped[0]!)).toBe(9)
  })

  it('never splits ANSI SGR sequences across wrap boundaries', () => {
    const text = '\x1b[31mhello\x1b[0m \x1b[32mworld\x1b[0m'
    const wrapped = wrapText(text, 6)
    expect(wrapped).toEqual([
      '\x1b[31mhello\x1b[0m',
      '\x1b[32mworld\x1b[0m',
    ])
  })

  it('handles wide characters when wrapping without splitting them', () => {
    const text = '一 二 三 四 五'
    const wrapped = wrapText(text, 5)
    // '一 二' = 2 + 1 + 2 = 5
    expect(wrapped[0]).toBe('一 二')
  })
})

describe('truncateToWidth', () => {
  it('returns unchanged text if displayWidth <= width', () => {
    expect(truncateToWidth('hello', 10)).toBe('hello')
    expect(truncateToWidth('hello', 5)).toBe('hello')
    expect(truncateToWidth('', 5)).toBe('')
  })

  it('truncates plain text and appends ellipsis', () => {
    // width 5: ellipsis '…' takes 1 width, leaving 4 for text
    expect(truncateToWidth('hello world', 5)).toBe('hell…')
    expect(displayWidth(truncateToWidth('hello world', 5))).toBe(5)
  })

  it('never splits a surrogate pair or wide character mid-cut', () => {
    // '宽' is width 2. If available width is 1, it should not fit '宽'
    // 'a宽b' -> width 3: ellipsis is 1, remaining is 2. 'a' (1) fits, '宽' (2) needs 2+1=3 -> exceeds 2!
    // So only 'a' fits: 'a…' (width 2 <= 3)
    const truncated = truncateToWidth('a宽b', 3)
    expect(truncated).toBe('a…')
    expect(displayWidth(truncated)).toBeLessThanOrEqual(3)
  })

  it('preserves leading SGR runs and appends reset when cut', () => {
    const text = '\x1b[31mhello world\x1b[0m'
    const truncated = truncateToWidth(text, 5)
    expect(truncated).toBe('\x1b[31mhell…\x1b[0m')
    expect(displayWidth(truncated)).toBe(5)
  })

  it('handles 0 and negative widths cleanly', () => {
    expect(truncateToWidth('hello', 0)).toBe('')
    expect(truncateToWidth('hello', -5)).toBe('')
  })

  it('respects custom ellipsis', () => {
    expect(truncateToWidth('hello world', 6, '..')).toBe('hell..')
  })
})
