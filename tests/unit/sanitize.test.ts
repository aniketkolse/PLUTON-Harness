import { describe, expect, it } from 'vitest'
import { stripControlChars, stripControlDeep, terminalSafeLine } from '../../src/util/sanitize.ts'

/**
 * Terminal-safety sanitization (post-P1 hardening): one implementation shared
 * by the store's persistence boundary, the engine approval bridge, event
 * emission and the CLI renderers. Stripping is not redaction.
 */

describe('terminal-safety sanitization', () => {
  it('stripControlChars removes C0/C1 and bidi controls but keeps ordinary text', () => {
    expect(stripControlChars('a\u001b[2Jb\u0007c\u007fd\u202ee')).toBe('a[2Jbcde')
    expect(stripControlChars('a\u061cb')).toBe('ab')
    expect(stripControlChars('plain text')).toBe('plain text')
  })

  it('stripControlDeep walks objects and arrays', () => {
    const out = stripControlDeep({ paths: ['a\u001b[2J.ts', { note: 'x\u202ey' }], n: 1, ok: true })
    expect(out).toEqual({ paths: ['a[2J.ts', { note: 'xy' }], n: 1, ok: true })
  })

  it('terminalSafeLine keeps words readable across stripped controls', () => {
    expect(terminalSafeLine('line1\nline2\u001b[31mred\u0007')).toBe('line1 line2 [31mred')
    expect(terminalSafeLine('  spaced\tout  ')).toBe('spaced out')
    expect(terminalSafeLine('a\u061cb')).toBe('a b')
  })
})
