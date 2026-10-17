/**
 * Pure frame builders for the Pluton chat TUI (ADR-0012).
 * Converts state views into formatted, width-constrained terminal lines.
 */

import type { Theme } from './theme.ts'
import { displayWidth, truncateToWidth, wrapText } from './width.ts'
import { computeLayout } from './layout.ts'
import { renderOrchestraInspector, type OrchestraInspectorData } from './orchestra.ts'
import {
  renderApprovalCard,
  renderApprovalDetails,
  type ApprovalViewData,
} from './approval.ts'
import { renderHeader as renderUIHeader } from '../ui/header.ts'
import { renderStatusBar as renderUIStatusBar } from '../ui/status.ts'
import { renderInputBox } from '../ui/input.ts'
import { getUITheme } from '../ui/theme.ts'

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
  opts: { prompt: string; placeholder?: string },
): InputRender {
  const prompt = opts.prompt
  const promptWidth = displayWidth(prompt)
  const indent = ' '.repeat(promptWidth)
  const maxContentWidth = Math.max(1, width - promptWidth)

  // Empty draft: show the placeholder as a dim ghost, cursor parked after the prompt.
  if (text.length === 0 && opts.placeholder) {
    const ghost = prompt + theme.paint('dim', opts.placeholder)
    return {
      lines: [truncateToWidth(ghost, width)],
      cursor: { row: 0, col: promptWidth },
    }
  }

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
  const ship = theme.icon('ship')
  const sessStatus = info.resumed ? 'resumed' : 'new'
  const left = `${theme.paint('header', `${ship} Pluton`)} ${theme.paint('dim', '·')} ${theme.paint('accent', info.projectName)}`
  let cleanModel = info.model
  const prefix = `${info.engine}/`
  while (cleanModel.startsWith(prefix)) {
    cleanModel = cleanModel.slice(prefix.length)
  }
  const right = theme.paint(
    'dim',
    `${info.museSlug} · ${info.engine}/${cleanModel} · session ${info.sessionId} (${sessStatus}, ${info.messageCount} messages)`,
  )
  return `${left} ${theme.paint('dim', '·')} ${right}`
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
    version?: string
  }
  transcriptLines: string[]
  orchestra?: OrchestraInspectorData | null
  editor: {
    text: string
    cursor: number
  }
  statusView: StatusView
  autocomplete?: Array<{ syntax: string; description: string }> | null
  /** Canonical pinned approval card (real backend record only). */
  approvalCard?: ApprovalViewData | null
  /** Read-only approval details overlay; never actionable. */
  approvalDetails?: ApprovalViewData | null
  /** Composer placeholder shown when the draft is empty. */
  placeholder?: string
  /** Enabled Muse count for the footer (omit when unknown). */
  museCount?: number
  scrollOffset?: number
  columns: number
  rows: number
  theme: Theme
  inspectorOpen?: boolean
  brandHeader?: boolean
  mode?: string
  contextPct?: number
  cost?: number
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

  // The canonical approval card is rendered before layout so its true height can
  // be reserved; it is pinned above the composer, out of the transcript flow.
  const approvalLines = opts.approvalCard
    ? renderApprovalCard(opts.approvalCard, Math.min(columns - 4, 64), theme)
    : []
  const detailsHeight = opts.approvalDetails ? 16 : 0

  const layout = computeLayout(columns, rows, {
    inspectorOpen: opts.inspectorOpen,
    draftLineCount: draftLines,
    autocompleteOpen: autocompleteCount > 0,
    autocompleteCount,
    approvalCardHeight: approvalLines.length,
    detailsHeight,
    brandHeader: opts.brandHeader,
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

  const uiTheme = getUITheme({ color: theme.enabled })

  // 1. Header: brand banner when brandHeader is requested,
  // or compact brand row — ship mark, wordmark, project — with muse/engine on right.
  if (opts.brandHeader) {
    const hLines = renderUIHeader(
      {
        version: opts.header.version ?? '0.1.0',
        engine: opts.header.engine,
        model: opts.header.model,
        rootDir: opts.header.rootDir,
        museSlug: opts.header.museSlug,
        projectName: opts.header.projectName,
      },
      columns,
      uiTheme,
      rows,
    )

    if (columns >= 80 && rows >= 24) {
      for (let h = 0; h < 6 && h < layout.dividerHeader; h++) {
        screenLines[h] = hLines[h] ?? ''
      }

      if (layout.twoColumn && layout.dividerVertical) {
        const divX = layout.dividerVertical.x
        const leftHz = hz.repeat(Math.max(0, divX - 1))
        const rightHz = hz.repeat(Math.max(0, columns - divX - 1))
        screenLines[layout.dividerHeader] = theme.paint(
          'border',
          `${hz}${leftHz}${teeDown}${rightHz}`,
        )
      } else {
        screenLines[layout.dividerHeader] = hLines[6] ?? theme.paint('border', hz.repeat(columns))
      }
    } else {
      screenLines[0] = hLines[0] ?? ''
      screenLines[layout.dividerHeader] = hLines[1] ?? theme.paint('border', hz.repeat(columns))
    }
  } else {
    const ship = theme.icon('ship')
    const leftHeader =
      ` ${theme.paint('focus', ship)} ${theme.paint('header', 'PLUTON')}  ${theme.paint('accent', opts.header.projectName)}`
    const rightHeader = `${opts.header.museSlug} · ${opts.header.engine} `
    const headerLeftW = displayWidth(leftHeader)
    const headerRightW = displayWidth(rightHeader)
    if (headerLeftW + headerRightW + 2 <= columns) {
      screenLines[0] = `${leftHeader}${' '.repeat(columns - headerLeftW - headerRightW)}${theme.paint('dim', rightHeader)}`
    } else {
      screenLines[0] = truncateToWidth(leftHeader, columns)
    }

    // Header Divider (rule)
    if (layout.twoColumn && layout.dividerVertical) {
      const divX = layout.dividerVertical.x
      const leftHz = hz.repeat(Math.max(0, divX - 1))
      const rightHz = hz.repeat(Math.max(0, columns - divX - 1))
      screenLines[layout.dividerHeader] = theme.paint(
        'border',
        `${hz}${leftHz}${teeDown}${rightHz}`,
      )
    } else {
      screenLines[layout.dividerHeader] = theme.paint(
        'border',
        hz.repeat(columns),
      )
    }
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

  let cursorRow = 0
  let cursorCol = 0

  if (opts.brandHeader) {
    const boxRender = renderInputBox(
      {
        draft: opts.editor.text,
        cursorPos: opts.editor.cursor,
        placeholder: opts.placeholder,
        focused: true,
        busy: opts.statusView.busy,
        maxRows: Math.max(1, layout.composer.height - 1),
      },
      columns,
      uiTheme,
    )

    const boxStartY = layout.dividerComposer
    const maxRows = layout.composer.height + 1 // divider row + composer rows

    for (let r = 0; r < maxRows; r++) {
      const targetRow = boxStartY + r
      if (targetRow >= rows - 1) break // preserve footer
      if (r < boxRender.lines.length) {
        screenLines[targetRow] = boxRender.lines[r]!
      } else {
        screenLines[targetRow] = ' '.repeat(columns)
      }
    }

    cursorRow = boxStartY + boxRender.cursor.row
    cursorCol = boxRender.cursor.col
  } else {
    // 3. Composer Divider (rule)
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
    const promptSymbol = '> '
    const inputRender = renderInput(
      opts.editor.text,
      opts.editor.cursor,
      columns - 2,
      theme,
      { prompt: promptSymbol, ...(opts.placeholder ? { placeholder: opts.placeholder } : {}) },
    )

    const composerStartY = layout.composer.y
    for (let c = 0; c < layout.composer.height; c++) {
      const lineIdx = c
      const composerLine = inputRender.lines[lineIdx] ?? ''
      screenLines[composerStartY + c] = ` ${composerLine}`
    }

    // Parking cursor position
    cursorRow = composerStartY + inputRender.cursor.row
    cursorCol = 1 + inputRender.cursor.col
  }

  // 5. Overlays: autocomplete (topmost), approval card (pinned), details (modal)
  function drawOverlay(
    rect: { x: number; y: number; width: number; height: number },
    lines: string[],
  ): void {
    for (let i = 0; i < lines.length && i < rect.height; i++) {
      const row = rect.y + i
      if (row < 0 || row >= rows) continue
      const line = truncateToWidth(lines[i] ?? '', rect.width)
      screenLines[row] = ` ${line}`
    }
  }

  if (layout.autocomplete && opts.autocomplete && opts.autocomplete.length > 0) {
    const auto = opts.autocomplete.slice(0, layout.autocomplete.height)
    const autoLines: string[] = []
    for (const item of auto) {
      autoLines.push(
        `  ${theme.paint('focus', item.syntax.padEnd(16))} ${theme.paint('dim', item.description)}`,
      )
    }
    drawOverlay(layout.autocomplete, autoLines)
  }

  if (layout.approval && approvalLines.length > 0) {
    drawOverlay(layout.approval, approvalLines)
  }

  if (layout.details && opts.approvalDetails) {
    drawOverlay(
      layout.details,
      renderApprovalDetails(opts.approvalDetails, layout.details.width, layout.details.height, theme),
    )
  }

  // 6. Footer Line: status + contextual hints on the left, real telemetry on the right.
  if (opts.brandHeader) {
    const state =
      opts.statusView.approvalsPending > 0
        ? 'approval'
        : opts.statusView.busy
          ? 'running'
          : 'ready'
    screenLines[layout.footer.y] = renderUIStatusBar(
      {
        state,
        mode: opts.mode ?? 'chat',
        model: opts.statusView.model,
        engine: opts.statusView.engine,
        contextPct: opts.contextPct,
        museCount: opts.museCount,
        cost: opts.cost,
        busy: opts.statusView.busy,
      },
      columns,
      uiTheme,
    )
  } else {
    let statusBadge: string
    if (opts.statusView.approvalsPending > 0) {
      statusBadge = theme.paint('approval', `APPROVAL REQUIRED (${opts.statusView.approvalsPending})`)
    } else if (opts.statusView.busy) {
      statusBadge = theme.paint('warn', 'RUNNING')
    } else {
      statusBadge = theme.paint('success', 'READY')
    }

    const hints =
      opts.statusView.approvalsPending > 0
        ? 'A approve once · D deny · V details'
        : opts.statusView.busy
          ? 'Esc interrupt · Ctrl+J newline'
          : 'Enter send · / commands · Ctrl+P palette · ? help'

    const runPart = opts.statusView.run
      ? ` ${theme.paint('dim', '·')} ${theme.paint('accent', `run ${opts.statusView.run.id} (${opts.statusView.run.state})`)}`
      : ''

    const rightParts: string[] = [opts.statusView.model]
    if (opts.museCount !== undefined) {
      rightParts.push(`${String(opts.museCount)} muse${opts.museCount === 1 ? '' : 's'}`)
    }
    if (opts.statusView.usage) {
      rightParts.push(
        `${String(opts.statusView.usage.inputTokens)}↑ ${String(opts.statusView.usage.outputTokens)}↓`,
      )
    }
    const rightFooter = `${rightParts.join(' · ')} `

    const leftPlain = statusBadge.length > 0 ? `${statusBadge} ${theme.paint('dim', '·')} ${theme.paint('dim', hints)}${runPart}` : ''
    const footerLeftW = displayWidth(leftPlain)
    const footerRightW = displayWidth(rightFooter)
    if (footerLeftW + footerRightW + 2 <= columns) {
      screenLines[layout.footer.y] = `${leftPlain}${' '.repeat(columns - footerLeftW - footerRightW)}${theme.paint('dim', rightFooter)}`
    } else {
      screenLines[layout.footer.y] = truncateToWidth(leftPlain, columns)
    }
  }

  // Ensure every screen line is strictly bounded by columns width
  for (let r = 0; r < rows; r++) {
    screenLines[r] = truncateToWidth(screenLines[r] ?? '', columns)
  }

  return {
    lines: screenLines,
    cursor: { row: cursorRow, col: cursorCol },
  }
}

