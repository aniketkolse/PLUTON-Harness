/**
 * Pure frame builders for the Pluton chat TUI (ADR-0012).
 * Converts state views into formatted, width-constrained terminal lines.
 */

import type { Theme } from './theme.ts'
import { displayWidth, truncateToWidth, wrapText } from './width.ts'

export interface StatusView {
  museSlug: string
  engine: string
  model: string
  busy: boolean
  run: { id: string; state: string } | null
  approvalsPending: number
  usage: { inputTokens: number; outputTokens: number } | null
}

export function renderStatusLine(view: StatusView, width: number, theme: Theme): string {
  const parts: string[] = []

  // Left: Muse and engine/model
  const stateLabel = view.busy ? theme.paint('warn', '[busy]') : theme.paint('dim', '[idle]')
  parts.push(`${theme.paint('accent', view.museSlug)} (${view.engine}/${view.model}) ${stateLabel}`)

  // Active run
  if (view.run) {
    parts.push(theme.paint('accent', `run:${view.run.id}(${view.run.state})`))
  }

  // Pending approvals
  if (view.approvalsPending > 0) {
    const s = view.approvalsPending === 1 ? '' : 's'
    parts.push(theme.paint('approval', `${view.approvalsPending} approval${s}`))
  }

  // Token usage
  if (view.usage) {
    parts.push(theme.paint('dim', `${view.usage.inputTokens} in / ${view.usage.outputTokens} out`))
  }

  const raw = parts.join(' | ')
  return truncateToWidth(raw, width)
}

export interface InputRender {
  lines: string[]
  cursor: { row: number; col: number }
}

const CURSOR_SENTINEL = '\u0000'

export function renderInput(
  text: string,
  cursor: number,
  width: number,
  theme: Theme,
  opts: { prompt: string },
): InputRender {
  const prompt = opts.prompt
  const promptWidth = displayWidth(prompt)
  const indent = ' '.repeat(promptWidth)
  const maxContentWidth = Math.max(1, width - promptWidth)

  // Clamp cursor
  const clampedCursor = Math.max(0, Math.min(cursor, text.length))
  const markedText = text.slice(0, clampedCursor) + CURSOR_SENTINEL + text.slice(clampedCursor)

  const logicalLines = markedText.split('\n')
  const finalLines: string[] = []
  let cursorRow = 0
  let cursorCol = promptWidth

  for (let l = 0; l < logicalLines.length; l++) {
    const logicalLine = logicalLines[l]!
    const isFirstLine = l === 0

    // Wrap the logical line to fit within maxContentWidth
    const wrappedSegments = wrapText(logicalLine, maxContentWidth)

    for (let s = 0; s < wrappedSegments.length; s++) {
      const segment = wrappedSegments[s]!
      const prefix = isFirstLine && s === 0 ? prompt : indent
      const lineWithPrefix = prefix + segment

      if (lineWithPrefix.includes(CURSOR_SENTINEL)) {
        cursorRow = finalLines.length
        const before = lineWithPrefix.slice(0, lineWithPrefix.indexOf(CURSOR_SENTINEL))
        cursorCol = displayWidth(before)
      }

      const cleanLine = lineWithPrefix.replace(CURSOR_SENTINEL, '')
      finalLines.push(cleanLine)
    }
  }

  // Fallback in case sentinel was somehow not caught
  if (finalLines.length === 0) {
    finalLines.push(prompt)
    cursorRow = 0
    cursorCol = promptWidth
  }

  // Paint prompt and input text
  const paintedLines = finalLines.map((line, idx) => {
    if (idx === 0) {
      const p = theme.paint('accent', prompt)
      return p + theme.paint('input', line.slice(prompt.length))
    }
    return line
  })

  return {
    lines: paintedLines,
    cursor: { row: cursorRow, col: cursorCol },
  }
}

export function renderHeader(
  info: {
    projectName: string
    rootDir: string
    museSlug: string
    engine: string
    model: string
    mode: string
    sessionId: string
    resumed: boolean
    messageCount: number
  },
  theme: Theme,
): string {
  const title = `Pluton Chat — ${info.projectName}`
  const loc = `(${info.rootDir})`
  const muse = `Muse: ${info.museSlug} [${info.engine} / ${info.model}] (mode: ${info.mode})`
  const sessStatus = info.resumed ? 'resumed' : 'new'
  const session = `Session: ${info.sessionId} (${sessStatus}, ${info.messageCount} messages)`
  const help = `Type /help for slash commands, or Ctrl+C to exit.`

  return [
    theme.paint('accent', title) + ' ' + theme.paint('dim', loc),
    theme.paint('dim', muse),
    theme.paint('dim', session),
    theme.paint('dim', help),
  ].join('\n')
}

export function renderToolLine(
  ev: { name: string; phase: 'start' | 'end'; summary?: string; isError?: boolean },
  opts: { expanded: boolean },
  width: number,
  theme: Theme,
): string | null {
  if (ev.phase === 'start') {
    if (!opts.expanded) return null
    return truncateToWidth(theme.paint('tool', `▶ ${ev.name}...`), width)
  }

  const icon = ev.isError ? '✖' : '✔'
  const summaryPart = ev.summary ? ` (${ev.summary})` : ''
  const role = ev.isError ? 'toolError' : 'tool'
  const text = `${icon} ${ev.name}${summaryPart}`

  return truncateToWidth(theme.paint(role, text), width)
}

export function renderNotice(text: string, width: number, theme: Theme): string {
  const formatted = `ℹ ${text}`
  return truncateToWidth(theme.paint('accent', formatted), width)
}
