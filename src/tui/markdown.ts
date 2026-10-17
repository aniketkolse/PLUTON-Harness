/**
 * Lightweight, zero-dependency streaming Markdown renderer for the Pluton chat TUI.
 * Formats headings, bold/italic, inline code, fenced code blocks, lists, and blockquotes.
 */

import type { Theme } from './theme.ts'
import { displayWidth, wrapText } from './width.ts'
import { sanitizeTerminalText } from './sanitize.ts'

export function renderMarkdown(markdown: string, maxWidth: number, theme: Theme): string[] {
  if (!markdown) return []
  if (maxWidth <= 0) return ['']

  const sanitized = sanitizeTerminalText(markdown)
  const lines = sanitized.split(/\r?\n/)
  const result: string[] = []

  let inCodeBlock = false
  let codeBlockLang = ''
  let codeBlockLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!
    const trimmed = rawLine.trim()

    // Fenced code block start / end
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        result.push(...formatCodeBlock(codeBlockLines, codeBlockLang, maxWidth, theme))
        inCodeBlock = false
        codeBlockLang = ''
        codeBlockLines = []
      } else {
        // Start code block
        inCodeBlock = true
        codeBlockLang = trimmed.slice(3).trim()
        codeBlockLines = []
      }
      continue
    }

    if (inCodeBlock) {
      codeBlockLines.push(rawLine)
      continue
    }

    // Empty line
    if (!rawLine.trim()) {
      result.push('')
      continue
    }

    // Headings
    if (trimmed.startsWith('# ')) {
      const heading = formatInline(trimmed.slice(2).trim(), theme)
      result.push(theme.paint('header', heading))
      continue
    }
    if (trimmed.startsWith('## ')) {
      const heading = formatInline(trimmed.slice(3).trim(), theme)
      result.push(theme.paint('header', heading))
      continue
    }
    if (trimmed.startsWith('### ')) {
      const heading = formatInline(trimmed.slice(4).trim(), theme)
      result.push(theme.paint('accent', heading))
      continue
    }

    // Horizontal Rule
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      const char = theme.enabled ? '─' : '-'
      result.push(theme.paint('border', char.repeat(Math.min(maxWidth, 40))))
      continue
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteText = formatInline(trimmed.slice(1).trim(), theme)
      const bar = theme.enabled ? '│ ' : '| '
      const wrapped = wrapText(quoteText, Math.max(10, maxWidth - 2))
      for (const w of wrapped) {
        result.push(theme.paint('dim', `${bar}${w}`))
      }
      continue
    }

    // Unordered List
    const bulletMatch = rawLine.match(/^(\s*)([-*+])\s+(.*)$/)
    if (bulletMatch) {
      const indent = bulletMatch[1] ?? ''
      const bullet = theme.enabled ? '•' : '*'
      const content = formatInline(bulletMatch[3] ?? '', theme)
      const prefix = `${indent}  ${theme.paint('focus', bullet)} `
      const avail = Math.max(10, maxWidth - (indent.length + 4))
      const wrapped = wrapText(content, avail)
      for (let j = 0; j < wrapped.length; j++) {
        if (j === 0) {
          result.push(`${prefix}${wrapped[j]}`)
        } else {
          result.push(`${' '.repeat(indent.length + 4)}${wrapped[j]}`)
        }
      }
      continue
    }

    // Ordered List
    const numMatch = rawLine.match(/^(\s*)(\d+\.)\s+(.*)$/)
    if (numMatch) {
      const indent = numMatch[1] ?? ''
      const num = numMatch[2] ?? ''
      const content = formatInline(numMatch[3] ?? '', theme)
      const prefix = `${indent}  ${theme.paint('focus', num)} `
      const avail = Math.max(10, maxWidth - (indent.length + num.length + 3))
      const wrapped = wrapText(content, avail)
      for (let j = 0; j < wrapped.length; j++) {
        if (j === 0) {
          result.push(`${prefix}${wrapped[j]}`)
        } else {
          result.push(`${' '.repeat(indent.length + num.length + 3)}${wrapped[j]}`)
        }
      }
      continue
    }

    // Standard paragraph line
    const formatted = formatInline(rawLine, theme)
    const wrapped = wrapText(formatted, maxWidth)
    for (const w of wrapped) {
      result.push(w)
    }
  }

  // Handle open code block during active stream
  if (inCodeBlock && codeBlockLines.length > 0) {
    result.push(...formatCodeBlock(codeBlockLines, codeBlockLang, maxWidth, theme, true))
  }

  return result
}

/**
 * Formats inline Markdown tokens: bold, italic, inline code.
 */
function formatInline(text: string, theme: Theme): string {
  if (!text) return ''

  // Replace inline code: `code`
  let out = text.replace(/`([^`]+)`/g, (_m, code) => {
    return theme.paint('code', code)
  })

  // Replace bold: **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, bold) => {
    return theme.paint('input', bold)
  })

  // Replace italic: *text* (avoiding lone asterisks)
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_m, italic) => {
    return theme.paint('dim', italic)
  })

  return out
}

/**
 * Formats a fenced code block with borders and indentation.
 */
function formatCodeBlock(
  lines: string[],
  lang: string,
  maxWidth: number,
  theme: Theme,
  streaming = false,
): string[] {
  const boxWidth = Math.min(maxWidth, 90)
  const innerWidth = Math.max(10, boxWidth - 4)
  const tl = theme.enabled ? '┌─' : '+--'
  const tr = theme.enabled ? '┐' : '+'
  const bl = theme.enabled ? '└─' : '+--'
  const br = theme.enabled ? '┘' : '+'
  const hz = theme.enabled ? '─' : '-'
  const vt = theme.enabled ? '│' : '|'

  const langLabel = lang ? ` ${lang} ` : ''
  const streamBadge = streaming ? ' [streaming] ' : ''
  const title = `${langLabel}${streamBadge}`
  const topPad = Math.max(0, boxWidth - 3 - displayWidth(title))
  const topBorder = theme.paint('border', `${tl}${title}${hz.repeat(topPad)}${tr}`)

  const rows: string[] = [topBorder]

  for (const line of lines) {
    // Truncate or wrap line inside code box
    const cleanLine = line.replace(/\t/g, '  ')
    const padded = cleanLine.padEnd(innerWidth).slice(0, innerWidth)
    rows.push(
      `${theme.paint('border', vt)} ${theme.paint('code', padded)} ${theme.paint('border', vt)}`,
    )
  }

  const bottomBorder = theme.paint('border', `${bl}${hz.repeat(Math.max(0, boxWidth - 3))}${br}`)
  rows.push(bottomBorder)

  return rows
}
