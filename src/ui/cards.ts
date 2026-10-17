/**
 * Reusable ResultCard, Checklist, DiffBlock & File Link Highlighting (Phase 5).
 * Formats structured run diagnostics, tests, diffs, and summaries in rounded border cards.
 */

import type { UITheme, UIRole } from './theme.ts'
import { displayWidth, truncateToWidth, wrapText } from '../tui/width.ts'

export type CardStatus = 'passed' | 'failed' | 'running' | 'warning' | 'cancelled'

export type CardSection =
  | {
      type: 'checklist'
      items: Array<{ text: string; status: 'pass' | 'fail' | 'neutral' }>
    }
  | {
      type: 'paragraph'
      text: string
    }
  | {
      type: 'diff'
      diff: string
    }
  | {
      type: 'keyvalue'
      entries: Record<string, string | number | undefined>
    }

export interface ResultCardData {
  title: string
  status: CardStatus
  sections: CardSection[]
  completedDuration?: string
}

// Regex matching repository-relative file paths like src/foo/bar.ts or tests/unit/baz.js
const FILE_PATH_REGEX = /\b(?:[a-zA-Z0-9_-]+[\\/])+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+\b/g

export function highlightFilePaths(text: string, theme: UITheme): string {
  if (!text) return ''
  return text.replace(FILE_PATH_REGEX, (match) => theme.paint('link', match))
}

export function renderDiffBlock(diff: string, width: number, theme: UITheme): string[] {
  if (!diff) return []
  const rawLines = diff.split(/\r?\n/)
  const result: string[] = []

  for (const raw of rawLines) {
    let painted: string
    if (raw.startsWith('+')) {
      painted = theme.paint('success', raw)
    } else if (raw.startsWith('-')) {
      painted = theme.paint('error', raw)
    } else if (raw.startsWith('@@')) {
      painted = theme.paint('info', raw)
    } else {
      painted = theme.paint('textMuted', raw)
    }
    result.push(truncateToWidth(painted, width))
  }

  return result
}

export function renderResultCard(card: ResultCardData, width: number, theme: UITheme): string[] {
  const innerWidth = Math.max(10, width - 4)
  const contentLines: string[] = []

  // Empty top padding line
  contentLines.push('')

  for (let sIdx = 0; sIdx < card.sections.length; sIdx++) {
    const section = card.sections[sIdx]!

    if (section.type === 'checklist') {
      for (const item of section.items) {
        let icon: string
        if (item.status === 'pass') {
          icon = theme.paint('success', theme.icon('check'))
        } else if (item.status === 'fail') {
          icon = theme.paint('error', theme.icon('cross'))
        } else {
          icon = theme.paint('textMuted', '-')
        }
        contentLines.push(`  ${icon} ${theme.paint('textPrimary', item.text)}`)
      }
    } else if (section.type === 'paragraph') {
      const highlighted = highlightFilePaths(section.text, theme)
      const wrapped = wrapText(highlighted, innerWidth - 2)
      for (const w of wrapped) {
        contentLines.push(`  ${w}`)
      }
    } else if (section.type === 'diff') {
      const diffLines = renderDiffBlock(section.diff, innerWidth - 2, theme)
      for (const dl of diffLines) {
        contentLines.push(`  ${dl}`)
      }
    } else if (section.type === 'keyvalue') {
      for (const [k, v] of Object.entries(section.entries)) {
        if (v !== undefined && v !== '') {
          contentLines.push(`  ${theme.paint('info', k)}: ${theme.paint('textPrimary', String(v))}`)
        }
      }
    }

    if (sIdx < card.sections.length - 1) {
      contentLines.push('')
    }
  }

  if (card.completedDuration) {
    contentLines.push('')
    const bullet = theme.paint('info', theme.icon('bullet'))
    contentLines.push(`  ${bullet} ${theme.paint('textMuted', `Completed in ${card.completedDuration}`)}`)
  }

  // Draw card frame
  const tl = theme.box.topLeft
  const tr = theme.box.topRight
  const bl = theme.box.bottomLeft
  const br = theme.box.bottomRight
  const hz = theme.box.horizontal
  const vt = theme.box.vertical

  // Top header line: ╭─ Title ───────╮
  const statusRole: UIRole =
    card.status === 'passed'
      ? 'success'
      : card.status === 'failed'
        ? 'error'
        : card.status === 'warning'
          ? 'warn'
          : card.status === 'running'
            ? 'accentLight'
            : 'textMuted'

  const maxTitleWidth = Math.max(5, width - 6)
  const safeTitle = truncateToWidth(card.title, maxTitleWidth)
  const paintedTitle = theme.paint(statusRole, safeTitle)
  const titlePart = `${tl}${hz} `
  const remainingTop = Math.max(0, width - displayWidth(`${titlePart}${safeTitle} `) - 1)
  const topLine = `${theme.paint('border', titlePart)}${paintedTitle} ${theme.paint('border', hz.repeat(remainingTop))}${theme.paint('border', tr)}`

  const lines: string[] = [topLine]

  for (const raw of contentLines) {
    const truncated = truncateToWidth(raw, innerWidth)
    const pad = ' '.repeat(Math.max(0, innerWidth - displayWidth(truncated)))
    lines.push(`${theme.paint('border', vt)} ${truncated}${pad} ${theme.paint('border', vt)}`)
  }

  const bottomRule = hz.repeat(Math.max(0, width - 2))
  lines.push(`${theme.paint('border', bl)}${theme.paint('border', bottomRule)}${theme.paint('border', br)}`)

  return lines
}
