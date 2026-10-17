/**
 * Tool activity state management and rendering (ADR-0012).
 * Formats correlated tool lifecycles (queued, running, succeeded, failed, cancelled).
 * Sanitizes untrusted terminal control codes.
 */

import type { Theme } from './theme.ts'
import { displayWidth, truncateToWidth, wrapText } from './width.ts'

export type ToolStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'denied'
  | 'uncertain'

export interface ToolActivityState {
  id: string
  name: string
  summary: string
  status: ToolStatus
  input?: unknown
  output?: string
  startTime?: number
  endTime?: number
  durationMs?: number
  isTruncated?: boolean
}

// Regex to strip dangerous terminal control codes (screen clear, alt-buffer, cursor movement)
const CONTROL_ANSI_REGEX =
  /\x1b\[[0-9;?]*[A-HJKSTfhlmnsu]|\x1b\].*?(?:\x07|\x1b\\)/g

export function sanitizeToolOutput(text: string): string {
  if (!text) return ''
  return text.replace(CONTROL_ANSI_REGEX, '')
}

export function createToolActivity(opts: {
  id: string
  name: string
  summary?: string
  input?: unknown
  startTime?: number
}): ToolActivityState {
  return {
    id: opts.id,
    name: opts.name,
    summary: opts.summary ?? opts.name,
    status: 'running',
    input: opts.input,
    startTime: opts.startTime ?? Date.now(),
  }
}

export function updateToolActivity(
  act: ToolActivityState,
  update: {
    status: ToolStatus
    output?: string
    summary?: string
    endTime?: number
    isTruncated?: boolean
  },
): ToolActivityState {
  const endTime = update.endTime ?? Date.now()
  const durationMs = act.startTime !== undefined ? endTime - act.startTime : undefined
  return {
    ...act,
    status: update.status,
    summary: update.summary ?? act.summary,
    output: update.output !== undefined ? sanitizeToolOutput(update.output) : act.output,
    endTime,
    durationMs,
    isTruncated: update.isTruncated ?? act.isTruncated,
  }
}

export function renderToolActivity(
  act: ToolActivityState,
  expanded: boolean,
  maxWidth: number,
  theme: Theme,
  currentTimeMs = Date.now(),
): string[] {
  const lines: string[] = []

  // Status icon & label
  let statusBadge: string
  let icon: string

  switch (act.status) {
    case 'running':
      icon = theme.icon('arrowRight')
      statusBadge = theme.paint('warn', 'RUNNING')
      break
    case 'succeeded':
      icon = theme.icon('check')
      statusBadge = theme.paint('success', formatDuration(act.durationMs))
      break
    case 'failed':
      icon = theme.icon('cross')
      statusBadge = theme.paint('error', 'FAILED')
      break
    case 'cancelled':
      icon = theme.icon('cross')
      statusBadge = theme.paint('dim', 'CANCELLED')
      break
    case 'denied':
      icon = theme.icon('cross')
      statusBadge = theme.paint('error', 'DENIED')
      break
    default:
      icon = theme.icon('idle')
      statusBadge = theme.paint('dim', act.status.toUpperCase())
      break
  }

  // If running and has startTime, format elapsed seconds
  if (act.status === 'running' && act.startTime) {
    const elapsedSec = ((currentTimeMs - act.startTime) / 1000).toFixed(1)
    statusBadge = theme.paint('warn', `RUNNING (${elapsedSec}s)`)
  }

  const hasDistinctSummary =
    Boolean(act.summary) &&
    act.summary.trim() !== '' &&
    act.summary.trim().toLowerCase() !== act.name.trim().toLowerCase() &&
    act.summary.trim().toLowerCase() !== 'tool'

  const expandIcon = expanded ? theme.icon('arrowDown') : icon
  const headerLeft = hasDistinctSummary
    ? `${expandIcon} ${theme.paint('tool', act.name)} — ${act.summary}`
    : `${expandIcon} ${theme.paint('tool', act.name)}`
  const badgeWidth = displayWidth(statusBadge)
  const availForLeft = Math.max(10, maxWidth - badgeWidth - 2)
  const leftTruncated = truncateToWidth(headerLeft, availForLeft)
  const pad = Math.max(1, maxWidth - displayWidth(leftTruncated) - badgeWidth)

  lines.push(`${leftTruncated}${' '.repeat(pad)}${statusBadge}`)

  // If expanded, render input & output
  if (expanded) {
    if (act.input !== undefined) {
      const inputStr =
        typeof act.input === 'string' ? act.input : JSON.stringify(act.input, null, 2)
      const inputLines = inputStr.split('\n').slice(0, 5)
      for (const il of inputLines) {
        lines.push(`  ${theme.paint('dim', '$')} ${theme.paint('code', il)}`)
      }
    }

    if (act.output) {
      let outputText = act.output
      try {
        const parsed = JSON.parse(act.output)
        if (typeof parsed === 'object' && parsed !== null) {
          outputText = JSON.stringify(parsed, null, 2)
        }
      } catch {
        // plain text
      }
      const sanitized = sanitizeToolOutput(outputText)
      const outputLines = sanitized.split('\n')
      const maxDisplay = 15
      const displayLines = outputLines.slice(0, maxDisplay)
      for (const ol of displayLines) {
        const wrapped = wrapText(ol, Math.max(10, maxWidth - 4))
        for (const w of wrapped) {
          lines.push(`    ${theme.paint('dim', w)}`)
        }
      }
      if (outputLines.length > maxDisplay || act.isTruncated) {
        const remaining = outputLines.length - maxDisplay
        const note = remaining > 0 ? `[+${remaining} lines truncated]` : '[truncated]'
        lines.push(`    ${theme.paint('warn', note)}`)
      }
    }
  }

  return lines
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
