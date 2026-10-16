/**
 * Pure multi-line editor state and operations (ADR-0012).
 * Supports cursor movement, word kill, history navigation, and large paste collapsing.
 */

export interface EditorState {
  text: string
  cursor: number
  history: string[]
  historyIndex: number | null
  pastes: Array<{ id: number; text: string }>
}

export function initialEditor(): EditorState {
  return {
    text: '',
    cursor: 0,
    history: [],
    historyIndex: null,
    pastes: [],
  }
}

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

/**
 * Inserts text at cursor position. Strips bracketed-paste markers.
 * Pastes > 10 lines are collapsed into a placeholder, keeping full text in pastes.
 */
export function editorInsert(s: EditorState, rawText: string): EditorState {
  let textToInsert = rawText.replaceAll(BRACKETED_PASTE_START, '').replaceAll(BRACKETED_PASTE_END, '')

  const pastes = [...s.pastes]
  const lines = textToInsert.split('\n')

  if (lines.length > 10) {
    const id = pastes.length + 1
    pastes.push({ id, text: textToInsert })
    textToInsert = `[paste #${id} +${lines.length} lines]`
  }

  const before = s.text.slice(0, s.cursor)
  const after = s.text.slice(s.cursor)
  const newText = before + textToInsert + after
  const newCursor = s.cursor + textToInsert.length

  return {
    ...s,
    text: newText,
    cursor: newCursor,
    pastes,
  }
}

export function editorBackspace(s: EditorState): EditorState {
  if (s.cursor <= 0) return s
  const before = s.text.slice(0, s.cursor - 1)
  const after = s.text.slice(s.cursor)
  return {
    ...s,
    text: before + after,
    cursor: s.cursor - 1,
  }
}

export function editorDelete(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s
  const before = s.text.slice(0, s.cursor)
  const after = s.text.slice(s.cursor + 1)
  return {
    ...s,
    text: before + after,
  }
}

export function editorMove(s: EditorState, move: 'left' | 'right' | 'home' | 'end'): EditorState {
  let newCursor = s.cursor
  switch (move) {
    case 'left':
      newCursor = Math.max(0, s.cursor - 1)
      break
    case 'right':
      newCursor = Math.min(s.text.length, s.cursor + 1)
      break
    case 'home':
      newCursor = 0
      break
    case 'end':
      newCursor = s.text.length
      break
  }
  return { ...s, cursor: newCursor }
}

export function editorKill(s: EditorState, mode: 'toEnd' | 'toStart' | 'word'): EditorState {
  if (mode === 'toEnd') {
    return {
      ...s,
      text: s.text.slice(0, s.cursor),
    }
  }
  if (mode === 'toStart') {
    return {
      ...s,
      text: s.text.slice(s.cursor),
      cursor: 0,
    }
  }
  if (mode === 'word') {
    if (s.cursor <= 0) return s
    const before = s.text.slice(0, s.cursor)
    let endIdx = before.length
    while (endIdx > 0 && before[endIdx - 1] === ' ') {
      endIdx--
    }
    while (endIdx > 0 && before[endIdx - 1] !== ' ') {
      endIdx--
    }
    const newText = before.slice(0, endIdx) + s.text.slice(s.cursor)
    return {
      ...s,
      text: newText,
      cursor: endIdx,
    }
  }
  return s
}

export function editorHistory(s: EditorState, dir: 'prev' | 'next'): EditorState {
  if (s.history.length === 0) return s

  if (dir === 'prev') {
    let nextIndex: number
    if (s.historyIndex === null) {
      nextIndex = s.history.length - 1
    } else {
      nextIndex = Math.max(0, s.historyIndex - 1)
    }
    const entry = s.history[nextIndex] ?? ''
    return {
      ...s,
      text: entry,
      cursor: entry.length,
      historyIndex: nextIndex,
    }
  }

  if (dir === 'next') {
    if (s.historyIndex === null) return s
    const nextIndex = s.historyIndex + 1
    if (nextIndex >= s.history.length) {
      return {
        ...s,
        text: '',
        cursor: 0,
        historyIndex: null,
      }
    }
    const entry = s.history[nextIndex] ?? ''
    return {
      ...s,
      text: entry,
      cursor: entry.length,
      historyIndex: nextIndex,
    }
  }

  return s
}

/**
 * Replaces all collapsed `[paste #N +M lines]` placeholders with full text.
 */
export function expandPastes(s: EditorState): string {
  let expanded = s.text
  for (const paste of s.pastes) {
    const placeholder = new RegExp(`\\[paste #${paste.id} \\+\\d+ lines\\]`, 'g')
    expanded = expanded.replace(placeholder, paste.text)
  }
  return expanded
}
