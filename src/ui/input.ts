/**
 * Docked rounded InputBox component for Pluton TUI 2.0 (Phase 7).
 * Renders a clean bordered input card with prompt chevron, placeholder,
 * multiline draft support, and exact cursor tracking.
 */

import type { UITheme, UIRole } from './theme.ts'
import { displayWidth, truncateToWidth, wrapText } from '../tui/width.ts'

export interface InputBoxProps {
  draft: string
  cursorPos: number
  placeholder?: string
  focused?: boolean
  busy?: boolean
  maxRows?: number
}

export interface InputBoxRender {
  lines: string[]
  cursor: { row: number; col: number }
  boxHeight: number
}

const CURSOR_SENTINEL = '\uE000'

export function renderInputBox(props: InputBoxProps, width: number, theme: UITheme): InputBoxRender {
  const maxContentRows = props.maxRows ?? 6
  const innerWidth = Math.max(10, width - 4) // accounts for '│ ' and ' │'
  const borderRole: UIRole = props.busy ? 'dim' : props.focused ? 'accent' : 'border'

  const tl = theme.box.topLeft
  const tr = theme.box.topRight
  const bl = theme.box.bottomLeft
  const br = theme.box.bottomRight
  const hz = theme.box.horizontal
  const vt = theme.box.vertical

  // Top border
  const topLine = `${theme.paint(borderRole, tl)}${theme.paint(borderRole, hz.repeat(Math.max(0, width - 2)))}${theme.paint(borderRole, tr)}`

  // Prompt prefix
  const chevron = '> '
  const chevronWidth = displayWidth(chevron)

  let cursorRow = 1
  let cursorCol = 2 + chevronWidth // 2 cols for '│ '

  const contentLines: string[] = []

  if (!props.draft) {
    const phText = props.placeholder ?? 'Ask Pluton to plan, implement, investigate…'
    const promptPart = theme.paint('textPrimary', chevron)
    const phPart = theme.paint('textMuted', phText)
    const fullLineText = `${chevron}${phText}`
    const pad = ' '.repeat(Math.max(0, innerWidth - displayWidth(fullLineText)))

    contentLines.push(
      `${theme.paint(borderRole, vt)} ${promptPart}${phPart}${pad} ${theme.paint(borderRole, vt)}`,
    )
  } else {
    // Insert cursor sentinel
    const safePos = Math.max(0, Math.min(props.draft.length, props.cursorPos))
    const withSentinel = props.draft.slice(0, safePos) + CURSOR_SENTINEL + props.draft.slice(safePos)

    const rawDraftLines = withSentinel.split(/\r?\n/)
    const wrappedRows: Array<{ text: string; hasSentinel: boolean }> = []

    for (let rIdx = 0; rIdx < rawDraftLines.length; rIdx++) {
      const raw = rawDraftLines[rIdx] ?? ''
      const prefix = rIdx === 0 ? chevron : '  '
      const lineWithPrefix = prefix + raw

      // Wrap line if it exceeds innerWidth
      const chunks = wrapText(lineWithPrefix, innerWidth)
      if (chunks.length === 0) {
        wrappedRows.push({ text: prefix, hasSentinel: lineWithPrefix.includes(CURSOR_SENTINEL) })
      } else {
        for (const ch of chunks) {
          wrappedRows.push({ text: ch, hasSentinel: ch.includes(CURSOR_SENTINEL) })
        }
      }
    }

    // Slice to maxContentRows (show recent rows if draft is long)
    const visibleRows = wrappedRows.slice(-maxContentRows)
    const rowOffset = Math.max(0, wrappedRows.length - maxContentRows)

    for (let i = 0; i < visibleRows.length; i++) {
      const rowItem = visibleRows[i]!
      if (rowItem.hasSentinel) {
        cursorRow = 1 + i // 1 for top border
        const before = rowItem.text.slice(0, rowItem.text.indexOf(CURSOR_SENTINEL))
        cursorCol = 2 + displayWidth(before) // 2 cols for '│ '
      }

      const clean = rowItem.text.replace(CURSOR_SENTINEL, '')
      const truncated = truncateToWidth(clean, innerWidth)
      const pad = ' '.repeat(Math.max(0, innerWidth - displayWidth(truncated)))

      let paintedRow: string
      if (i === 0 && rowOffset === 0) {
        const pChevron = theme.paint('textPrimary', chevron)
        const rest = theme.paint('textPrimary', clean.slice(chevron.length))
        paintedRow = `${pChevron}${rest}`
      } else {
        paintedRow = theme.paint('textPrimary', clean)
      }

      contentLines.push(
        `${theme.paint(borderRole, vt)} ${paintedRow}${pad} ${theme.paint(borderRole, vt)}`,
      )
    }
  }

  // Bottom border
  const bottomLine = `${theme.paint(borderRole, bl)}${theme.paint(borderRole, hz.repeat(Math.max(0, width - 2)))}${theme.paint(borderRole, br)}`

  const allLines = [topLine, ...contentLines, bottomLine]

  return {
    lines: allLines,
    cursor: { row: cursorRow, col: cursorCol },
    boxHeight: allLines.length,
  }
}
