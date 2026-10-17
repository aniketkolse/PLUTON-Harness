import { describe, expect, it } from 'vitest'
import {
  editorBackspace,
  editorDelete,
  editorHistory,
  editorInsert,
  editorKill,
  editorMove,
  expandPastes,
  initialEditor,
} from '../../src/tui/editor.ts'

describe('initialEditor', () => {
  it('creates empty editor state', () => {
    const s = initialEditor()
    expect(s.text).toBe('')
    expect(s.cursor).toBe(0)
    expect(s.history).toEqual([])
    expect(s.historyIndex).toBeNull()
    expect(s.pastes).toEqual([])
  })
})

describe('editorInsert & delete/backspace', () => {
  it('inserts text at cursor and advances cursor', () => {
    let s = initialEditor()
    s = editorInsert(s, 'hello')
    expect(s.text).toBe('hello')
    expect(s.cursor).toBe(5)

    // Move to middle and insert
    s = editorMove(s, 'left')
    s = editorMove(s, 'left')
    expect(s.cursor).toBe(3) // 'hel|lo'
    s = editorInsert(s, '-')
    expect(s.text).toBe('hel-lo')
    expect(s.cursor).toBe(4)
  })

  it('backspace deletes char before cursor', () => {
    let s = initialEditor()
    s = editorInsert(s, 'hello')
    s = editorBackspace(s)
    expect(s.text).toBe('hell')
    expect(s.cursor).toBe(4)

    // Backspace at 0 does nothing
    s = editorMove(s, 'home')
    s = editorBackspace(s)
    expect(s.text).toBe('hell')
    expect(s.cursor).toBe(0)
  })

  it('delete removes char at cursor', () => {
    let s = initialEditor()
    s = editorInsert(s, 'hello')
    s = editorMove(s, 'home')
    s = editorDelete(s)
    expect(s.text).toBe('ello')
    expect(s.cursor).toBe(0)

    // Delete at end does nothing
    s = editorMove(s, 'end')
    s = editorDelete(s)
    expect(s.text).toBe('ello')
    expect(s.cursor).toBe(4)
  })
})

describe('editorMove & editorKill', () => {
  it('moves cursor correctly with left, right, home, end', () => {
    let s = initialEditor()
    s = editorInsert(s, 'abc')
    s = editorMove(s, 'home')
    expect(s.cursor).toBe(0)
    s = editorMove(s, 'right')
    expect(s.cursor).toBe(1)
    s = editorMove(s, 'end')
    expect(s.cursor).toBe(3)
    s = editorMove(s, 'left')
    expect(s.cursor).toBe(2)
  })

  it('kills toEnd, toStart, and word', () => {
    let s = initialEditor()
    s = editorInsert(s, 'foo bar baz')
    s = editorMove(s, 'home')
    s = editorMove(s, 'right')
    s = editorMove(s, 'right')
    s = editorMove(s, 'right') // cursor at 3 ('foo| bar baz')

    const killedEnd = editorKill(s, 'toEnd')
    expect(killedEnd.text).toBe('foo')
    expect(killedEnd.cursor).toBe(3)

    const killedStart = editorKill(s, 'toStart')
    expect(killedStart.text).toBe(' bar baz')
    expect(killedStart.cursor).toBe(0)

    // Kill word backward
    let s2 = initialEditor()
    s2 = editorInsert(s2, 'foo bar')
    const killedWord = editorKill(s2, 'word')
    expect(killedWord.text).toBe('foo ')
    expect(killedWord.cursor).toBe(4)
  })
})

describe('bracketed-paste & paste collapsing', () => {
  it('strips bracketed-paste markers', () => {
    let s = initialEditor()
    s = editorInsert(s, '\x1b[200~hello world\x1b[201~')
    expect(s.text).toBe('hello world')
  })

  it('collapses pastes longer than 10 lines and expandPastes restores full text', () => {
    let s = initialEditor()
    const longText = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n')
    s = editorInsert(s, longText)
    expect(s.pastes.length).toBe(1)
    expect(s.text).toContain('[paste #1 +15 lines]')

    const expanded = expandPastes(s)
    expect(expanded).toBe(longText)
  })

  it('preserves $ patterns (like $1, $&, $$) in collapsed paste expansions', () => {
    let s = initialEditor()
    const codeWithDollar = Array.from({ length: 15 }, (_, i) => `echo "$${i + 1}" && cost=$$`).join('\n')
    s = editorInsert(s, codeWithDollar)
    expect(s.pastes.length).toBe(1)

    const expanded = expandPastes(s)
    expect(expanded).toBe(codeWithDollar)
  })
})

describe('editorHistory', () => {
  it('navigates through history entries', () => {
    let s = initialEditor()
    s.history = ['cmd 1', 'cmd 2', 'cmd 3']

    s = editorHistory(s, 'prev')
    expect(s.text).toBe('cmd 3')
    expect(s.historyIndex).toBe(2)

    s = editorHistory(s, 'prev')
    expect(s.text).toBe('cmd 2')
    expect(s.historyIndex).toBe(1)

    s = editorHistory(s, 'next')
    expect(s.text).toBe('cmd 3')
    expect(s.historyIndex).toBe(2)

    s = editorHistory(s, 'next')
    expect(s.text).toBe('')
    expect(s.historyIndex).toBeNull()
  })
})
