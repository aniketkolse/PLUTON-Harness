/**
 * Pure frame builders for the Pluton chat TUI (ADR-0012).
 * Converts state views into formatted, width-constrained terminal lines.
 */

import type { Theme } from './theme.ts'
import { displayWidth, truncateToWidth, wrapText } from './width.ts'
import { computeLayout } from './layout.ts'
import { renderOrchestraInspector, type OrchestraInspectorData } from './orchestra.ts'

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

export interface FullScreenFrameOptions {
  header: {
    projectName: string
    rootDir: string
    museSlug: string
    engine: string
    model: string
    runState?: string
  }
  transcriptLines: string[]
  orchestra?: OrchestraInspectorData | null
  editor: {
    text: string
    cursor: number
  }
  statusView: StatusView
  autocomplete?: Array<{ syntax: string; description: string }> | null
  scrollOffset?: number
  columns: number
  rows: number
  theme: Theme
  inspectorOpen?: boolean
}

export function shortenPath(fullPath: string, maxLength = 35): string {
  if (!fullPath) return ''
  const normalized = fullPath.replace(/\\/g, '/')
  const home = process.env['HOME'] || process.env['USERPROFILE']
  let res = normalized
  if (home) {
    const homeNorm = home.replace(/\\/g, '/')
    if (res.startsWith(homeNorm)) {
      res = '~' + res.slice(homeNorm.length)
    }
  }
  if (res.length > maxLength) {
    const parts = res.split('/')
    if (parts.length > 2) {
      res = `.../${parts.slice(-2).join('/')}`
    }
  }
  return res
}

export function renderFullScreenFrame(opts: FullScreenFrameOptions): {
  lines: string[]
  cursor: { row: number; col: number }
} {
  const { columns, rows, theme } = opts
  const draftLines = opts.editor.text.split('\n').length
  const autocompleteCount = opts.autocomplete?.length ?? 0
  const layout = computeLayout(columns, rows, {
    inspectorOpen: opts.inspectorOpen,
    draftLineCount: draftLines,
    autocompleteOpen: autocompleteCount > 0,
    autocompleteCount,
  })

  if (layout.tooSmall) {
    const lines: string[] = []
    const msg = `Terminal too small (${columns}x${rows}). Minimum is 40x12.`
    for (let r = 0; r < rows; r++) {
      if (r === Math.floor(rows / 2)) {
        lines.push(truncateToWidth(`  ${theme.paint('warn', msg)}`, columns))
      } else {
        lines.push('')
      }
    }
    return { lines, cursor: { row: 0, col: 0 } }
  }

  const screenLines: string[] = new Array(rows).fill('')

  const tl = theme.enabled ? '┌─' : '+-'
  const tr = theme.enabled ? '┐' : '+'
  const bl = theme.enabled ? '└─' : '+-'
  const br = theme.enabled ? '┘' : '+'
  const hz = theme.enabled ? '─' : '-'
  const vt = theme.enabled ? '│' : '|'
  const teeDown = theme.enabled ? '┬' : '+'
  const teeUp = theme.enabled ? '┴' : '+'
  const teeCross = theme.enabled ? '┼' : '+'

  // 1. Header Line 0
  const title = ` PLUTON ─ ${opts.header.projectName} ─ ${shortenPath(opts.header.rootDir)} `
  const topPad = Math.max(0, columns - 3 - displayWidth(title))
  screenLines[0] = theme.paint('header', `${tl}${title}${hz.repeat(topPad)}${tr}`)

  // Header Line 1
  if (layout.header.height > 1) {
    const runLabel = opts.header.runState ?? (opts.statusView.busy ? 'running' : 'ready')
    const leftText = ` Muse: ${opts.header.museSlug} · Engine: ${opts.header.engine} · Model: ${opts.header.model} · Run: ${runLabel}`
    const leftW = displayWidth(leftText)
    const rightText = opts.statusView.usage
      ? `${opts.statusView.usage.inputTokens} in / ${opts.statusView.usage.outputTokens} out `
      : ' '
    const rightW = displayWidth(rightText)
    const midPad = Math.max(1, columns - 2 - leftW - rightW)
    screenLines[1] = `${theme.paint('border', vt)}${theme.paint('accent', leftText)}${' '.repeat(midPad)}${theme.paint('dim', rightText)}${theme.paint('border', vt)}`
  }

  // Header Divider
  if (layout.twoColumn && layout.dividerVertical) {
    const divX = layout.dividerVertical.x
    const leftHz = hz.repeat(Math.max(0, divX - 1))
    const rightHz = hz.repeat(Math.max(0, columns - divX - 2))
    screenLines[layout.dividerHeader] = theme.paint(
      'border',
      `├${leftHz}${teeDown}${rightHz}┤`,
    )
  } else {
    screenLines[layout.dividerHeader] = theme.paint(
      'border',
      `├${hz.repeat(Math.max(0, columns - 2))}┤`,
    )
  }

  // 2. Chat Transcript & Orchestra Main Area
  const chatHeight = layout.chat.height
  const transcript = opts.transcriptLines
  const scrollOffset = opts.scrollOffset ?? 0

  // Calculate visible slice of transcript
  const endIdx = Math.max(0, transcript.length - scrollOffset)
  const startIdx = Math.max(0, endIdx - chatHeight)
  const chatSlice = transcript.slice(startIdx, endIdx)

  // Pad top if transcript lines are fewer than viewport height
  while (chatSlice.length < chatHeight) {
    chatSlice.unshift('')
  }

  let inspLines: string[] = []
  if (layout.twoColumn && layout.inspector && opts.orchestra) {
    inspLines = renderOrchestraInspector(
      opts.orchestra,
      layout.inspector.width,
      layout.inspector.height,
      theme,
    )
  }

  for (let i = 0; i < chatHeight; i++) {
    const rowY = layout.chat.y + i
    const chatLine = chatSlice[i] ?? ''

    if (layout.twoColumn && layout.inspector) {
      const chatW = layout.chat.width
      const inspW = layout.inspector.width
      const leftPadded = truncateToWidth(chatLine, chatW)
      const padLeft = Math.max(0, chatW - displayWidth(leftPadded))
      const right = truncateToWidth(inspLines[i] ?? '', inspW)
      const padRight = Math.max(0, inspW - displayWidth(right))

      screenLines[rowY] = `${leftPadded}${' '.repeat(padLeft)}${theme.paint('border', vt)}${right}${' '.repeat(padRight)}`
    } else {
      const leftPadded = truncateToWidth(chatLine, layout.chat.width)
      screenLines[rowY] = leftPadded
    }
  }

  // 3. Composer Divider
  if (layout.twoColumn && layout.dividerVertical) {
    const divX = layout.dividerVertical.x
    const leftHz = hz.repeat(Math.max(0, divX - 1))
    const rightHz = hz.repeat(Math.max(0, columns - divX - 2))
    screenLines[layout.dividerComposer] = theme.paint(
      'border',
      `├${leftHz}${teeUp}${rightHz}┤`,
    )
  } else {
    screenLines[layout.dividerComposer] = theme.paint(
      'border',
      `├${hz.repeat(Math.max(0, columns - 2))}┤`,
    )
  }

  // 4. Composer Rendering
  const promptSymbol = '❯ '
  const inputRender = renderInput(
    opts.editor.text,
    opts.editor.cursor,
    columns - 2,
    theme,
    { prompt: promptSymbol },
  )

  const composerStartY = layout.composer.y
  for (let c = 0; c < layout.composer.height; c++) {
    const lineIdx = c
    const composerLine = inputRender.lines[lineIdx] ?? ''
    screenLines[composerStartY + c] = ` ${composerLine}`
  }

  // Parking cursor position
  let cursorRow = composerStartY + inputRender.cursor.row
  let cursorCol = 1 + inputRender.cursor.col

  // 5. Autocomplete Overlay (if open)
  if (layout.autocomplete && opts.autocomplete && opts.autocomplete.length > 0) {
    const auto = opts.autocomplete.slice(0, layout.autocomplete.height)
    for (let a = 0; a < auto.length; a++) {
      const item = auto[a]!
      const itemRow = layout.autocomplete.y + a
      const itemText = `  ${theme.paint('focus', item.syntax.padEnd(16))} ${theme.paint('dim', item.description)}`
      screenLines[itemRow] = truncateToWidth(itemText, layout.autocomplete.width)
    }
  }

  // 6. Footer Line
  let statusBadge: string
  if (opts.statusView.approvalsPending > 0) {
    statusBadge = theme.paint(
      'approval',
      `APPROVAL REQUIRED (${opts.statusView.approvalsPending})`,
    )
  } else if (opts.statusView.busy) {
    statusBadge = theme.paint('warn', 'RUNNING')
  } else {
    statusBadge = theme.paint('success', 'READY')
  }

  const hints =
    opts.statusView.approvalsPending > 0
      ? 'A approve once · D deny · V details · Esc stop'
      : 'Enter send · Shift+Enter newline · / commands · Ctrl+P palette · Tab inspector · Esc stop'

  const footerText = `${statusBadge} · ${theme.paint('dim', hints)}`
  screenLines[layout.footer.y] = truncateToWidth(footerText, columns)

  // Ensure every screen line is strictly bounded by columns width
  for (let r = 0; r < rows; r++) {
    screenLines[r] = truncateToWidth(screenLines[r] ?? '', columns)
  }

  return {
    lines: screenLines,
    cursor: { row: cursorRow, col: cursorCol },
  }
}

