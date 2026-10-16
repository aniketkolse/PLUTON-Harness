/**
 * ANSI-aware display width and text wrapping primitives (ADR-0012).
 * Zero runtime dependencies, relies on Node.js built-in Intl.Segmenter.
 */

const ANSI_REGEX =
  /(?:\x1B|\u009B)(?:\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\)|[@-Z\\-_])/g

export function stripAnsi(text: string): string {
  if (!text) return ''
  return text.replace(ANSI_REGEX, '')
}

/**
 * Fast check for East Asian Wide / Fullwidth and Emoji code points (UAX#11 subset).
 */
function isWideCodePoint(code: number): boolean {
  if (code < 0x1100) return false

  return (
    // Hangul Jamo
    (code >= 0x1100 && code <= 0x115f) ||
    // Miscellaneous symbols & pictographs
    code === 0x231a ||
    code === 0x231b ||
    (code >= 0x23e9 && code <= 0x23ec) ||
    code === 0x23f0 ||
    code === 0x23f3 ||
    (code >= 0x25fd && code <= 0x25fe) ||
    (code >= 0x2614 && code <= 0x2615) ||
    (code >= 0x2648 && code <= 0x2653) ||
    code === 0x267f ||
    code === 0x2693 ||
    code === 0x26a1 ||
    (code >= 0x26aa && code <= 0x26ab) ||
    (code >= 0x26bd && code <= 0x26be) ||
    (code >= 0x26c4 && code <= 0x26c5) ||
    code === 0x26ce ||
    code === 0x26d4 ||
    code === 0x26ea ||
    (code >= 0x26f2 && code <= 0x26f3) ||
    code === 0x26f5 ||
    code === 0x26fa ||
    code === 0x26fd ||
    code === 0x2705 ||
    (code >= 0x270a && code <= 0x270b) ||
    code === 0x2728 ||
    code === 0x274c ||
    code === 0x274e ||
    (code >= 0x2753 && code <= 0x2755) ||
    code === 0x2757 ||
    (code >= 0x2795 && code <= 0x2797) ||
    code === 0x27b0 ||
    code === 0x27bf ||
    (code >= 0x2b1b && code <= 0x2b1c) ||
    code === 0x2b50 ||
    code === 0x2b55 ||
    // CJK Radicals, Symbols, Punctuation, Hiragana, Katakana, Bopomofo, Hangul
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    // Hangul Syllables
    (code >= 0xac00 && code <= 0xd7a3) ||
    // CJK Compatibility
    (code >= 0xf900 && code <= 0xfaff) ||
    // Vertical / CJK Compatibility Forms
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    // Fullwidth ASCII and symbols
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    // Supplementary Ideographic and Emoji planes
    (code >= 0x16fe0 && code <= 0x18aff) ||
    (code >= 0x1b000 && code <= 0x1b2ff) ||
    (code >= 0x1f000 && code <= 0x1ffff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

function isZeroWidthCodePoint(code: number): boolean {
  return (
    // Combining diacritical marks
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x0483 && code <= 0x0489) ||
    (code >= 0x0591 && code <= 0x05bd) ||
    code === 0x05bf ||
    code === 0x05c1 ||
    code === 0x05c2 ||
    code === 0x05c4 ||
    code === 0x05c5 ||
    code === 0x05c7 ||
    (code >= 0x0610 && code <= 0x061a) ||
    (code >= 0x064b && code <= 0x065f) ||
    code === 0x0670 ||
    (code >= 0x06d6 && code <= 0x06dc) ||
    (code >= 0x06df && code <= 0x06e4) ||
    code === 0x06e7 ||
    code === 0x06e8 ||
    (code >= 0x06ea && code <= 0x06ed) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    // Zero-width characters & formatting
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200d ||
    code === 0xfeff ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef) ||
    // Control characters (excluding tab)
    (code >= 0x0000 && code <= 0x001f && code !== 0x0009) ||
    (code >= 0x007f && code <= 0x009f)
  )
}

function graphemeWidth(g: string): number {
  if (!g) return 0
  // Wide character (emoji or CJK)
  for (const char of g) {
    const cp = char.codePointAt(0)
    if (cp !== undefined && isWideCodePoint(cp)) {
      return 2
    }
  }
  // Zero-width combining mark check
  let hasVisible = false
  for (const char of g) {
    const cp = char.codePointAt(0)
    if (cp !== undefined && !isZeroWidthCodePoint(cp)) {
      hasVisible = true
      break
    }
  }
  return hasVisible ? 1 : 0
}

/**
 * Pragmatic display width: ANSI stripped; combining marks/ZWJ = 0;
 * East-Asian Wide/Fullwidth + emoji = 2. Documented subset of UAX#11.
 */
export function displayWidth(text: string): number {
  const clean = stripAnsi(text)
  if (!clean) return 0
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
  let width = 0
  for (const { segment } of segmenter.segment(clean)) {
    width += graphemeWidth(segment)
  }
  return width
}

type Token =
  | { kind: 'ansi'; raw: string }
  | { kind: 'text'; grapheme: string; width: number; isSpace: boolean; isTab: boolean; isNewline: boolean }

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

  ANSI_REGEX.lastIndex = 0
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = ANSI_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const slice = text.slice(lastIndex, match.index)
      for (const { segment } of segmenter.segment(slice)) {
        tokens.push({
          kind: 'text',
          grapheme: segment,
          width: graphemeWidth(segment),
          isSpace: segment === ' ',
          isTab: segment === '\t',
          isNewline: segment === '\n' || segment === '\r\n',
        })
      }
    }
    tokens.push({ kind: 'ansi', raw: match[0] })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    const slice = text.slice(lastIndex)
    for (const { segment } of segmenter.segment(slice)) {
      tokens.push({
        kind: 'text',
        grapheme: segment,
        width: graphemeWidth(segment),
        isSpace: segment === ' ',
        isTab: segment === '\t',
        isNewline: segment === '\n' || segment === '\r\n',
      })
    }
  }

  return tokens
}

function wrapSingleLine(lineTokens: Token[], maxWidth: number): string[] {
  if (lineTokens.length === 0) return ['']
  if (maxWidth <= 0) return ['']

  const units: Array<{ type: 'word' | 'space'; tokens: Token[]; width: number }> = []
  let pendingAnsi: Token[] = []
  let currentUnit: { type: 'word' | 'space'; tokens: Token[]; width: number } | null = null

  for (const tok of lineTokens) {
    if (tok.kind === 'ansi') {
      if (currentUnit && currentUnit.type === 'word') {
        currentUnit.tokens.push(tok)
      } else {
        pendingAnsi.push(tok)
      }
      continue
    }

    if (tok.isSpace) {
      if (!currentUnit || currentUnit.type !== 'space') {
        if (currentUnit) units.push(currentUnit)
        currentUnit = { type: 'space', tokens: [...pendingAnsi], width: 0 }
        pendingAnsi = []
      }
      currentUnit.tokens.push(tok)
      currentUnit.width += tok.width
    } else {
      if (!currentUnit || currentUnit.type !== 'word') {
        if (currentUnit) units.push(currentUnit)
        currentUnit = { type: 'word', tokens: [...pendingAnsi], width: 0 }
        pendingAnsi = []
      }
      currentUnit.tokens.push(tok)
      currentUnit.width += tok.width
    }
  }

  if (currentUnit) {
    if (pendingAnsi.length > 0) {
      currentUnit.tokens.push(...pendingAnsi)
    }
    units.push(currentUnit)
  } else if (pendingAnsi.length > 0) {
    units.push({ type: 'word', tokens: pendingAnsi, width: 0 })
  }

  const lines: string[] = []
  let curLineTokens: Token[] = []
  let curLineWidth = 0

  function flushLine(): void {
    if (curLineTokens.length === 0) return
    let str = ''
    for (const t of curLineTokens) {
      str += t.kind === 'ansi' ? t.raw : t.grapheme
    }
    lines.push(str)
    curLineTokens = []
    curLineWidth = 0
  }

  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!

    if (unit.type === 'space') {
      if (curLineWidth === 0) {
        if (lines.length === 0) {
          curLineTokens.push(...unit.tokens)
          curLineWidth += unit.width
        }
        continue
      }

      const nextUnit = units[i + 1]
      if (nextUnit && nextUnit.type === 'word') {
        if (curLineWidth + unit.width + nextUnit.width <= maxWidth) {
          curLineTokens.push(...unit.tokens)
          curLineWidth += unit.width
        } else {
          flushLine()
        }
      } else {
        if (curLineWidth + unit.width <= maxWidth) {
          curLineTokens.push(...unit.tokens)
          curLineWidth += unit.width
        } else {
          flushLine()
        }
      }
      continue
    }

    // unit is 'word'
    if (unit.width <= maxWidth) {
      if (curLineWidth + unit.width <= maxWidth) {
        curLineTokens.push(...unit.tokens)
        curLineWidth += unit.width
      } else {
        flushLine()
        curLineTokens.push(...unit.tokens)
        curLineWidth += unit.width
      }
    } else {
      // Overlong word
      if (curLineWidth > 0) {
        flushLine()
      }

      let sliceTokens: Token[] = []
      let sliceWidth = 0

      for (const tok of unit.tokens) {
        if (tok.kind === 'ansi') {
          sliceTokens.push(tok)
          continue
        }
        if (sliceWidth + tok.width > maxWidth && sliceWidth > 0) {
          curLineTokens = sliceTokens
          flushLine()
          sliceTokens = []
          sliceWidth = 0
        }
        sliceTokens.push(tok)
        sliceWidth += tok.width
      }

      if (sliceTokens.length > 0) {
        curLineTokens = sliceTokens
        curLineWidth = sliceWidth
      }
    }
  }

  flushLine()
  return lines.length > 0 ? lines : ['']
}

/**
 * Newline-aware word wrap; hard-breaks overlong tokens; tabs → 8-column stops;
 * never splits an ANSI SGR sequence.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return ['']
  const rawLines = text.split(/\r?\n/)
  const result: string[] = []

  for (const rawLine of rawLines) {
    if (rawLine === '') {
      result.push('')
      continue
    }
    const tokens = tokenize(rawLine)
    // Expand tabs with 8-column stops
    const expandedTokens: Token[] = []
    let col = 0
    for (const tok of tokens) {
      if (tok.kind === 'ansi') {
        expandedTokens.push(tok)
        continue
      }
      if (tok.isTab) {
        const spaces = 8 - (col % 8)
        for (let s = 0; s < spaces; s++) {
          expandedTokens.push({
            kind: 'text',
            grapheme: ' ',
            width: 1,
            isSpace: true,
            isTab: false,
            isNewline: false,
          })
        }
        col += spaces
        continue
      }
      expandedTokens.push(tok)
      col += tok.width
    }

    const wrapped = wrapSingleLine(expandedTokens, width)
    result.push(...wrapped)
  }

  return result
}

/**
 * ANSI-aware truncation preserving leading SGR runs; appends the ellipsis
 * and a reset when cut.
 */
export function truncateToWidth(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return ''
  const total = displayWidth(text)
  if (total <= width) return text

  const ellipsisW = displayWidth(ellipsis)
  const budget = width - ellipsisW
  if (budget < 0) return ''

  const tokens = tokenize(text)
  let curWidth = 0
  let out = ''
  let hasAnsi = false

  for (const tok of tokens) {
    if (tok.kind === 'ansi') {
      out += tok.raw
      hasAnsi = true
      continue
    }
    if (curWidth + tok.width > budget) {
      break
    }
    out += tok.grapheme
    curWidth += tok.width
  }

  out += ellipsis
  if (hasAnsi) {
    out += '\x1b[0m'
  }
  return out
}
