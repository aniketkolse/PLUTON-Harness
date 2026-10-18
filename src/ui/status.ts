/**
 * Live single-line StatusBar component for Pluton TUI 2.0 (Phase 8).
 * Renders real-time execution state, mode, model, context usage, muses, cost,
 * and right-aligned shortcuts.
 */

import type { UITheme, UIRole } from './theme.ts'
import { displayWidth, truncateToWidth } from '../tui/width.ts'

export interface StatusBarProps {
  state: 'ready' | 'thinking' | 'running' | 'approval' | 'error'
  mode: string
  model: string
  engine?: string
  /** Percent used, or null when no real context window is known (renders "unknown"). */
  contextPct?: number | null
  museCount?: number
  /** Cost in USD, only when an engine actually reported one (never estimated). */
  cost?: number | null
  busy?: boolean
}

export function renderStatusBar(props: StatusBarProps, width: number, theme: UITheme): string {
  // 1. State bullet and label
  let stateRole: UIRole = 'success'
  let stateLabel = 'Ready'

  if (props.state === 'thinking') {
    stateRole = 'accentLight'
    stateLabel = 'Thinking'
  } else if (props.state === 'running') {
    stateRole = 'warn'
    stateLabel = 'Running'
  } else if (props.state === 'approval') {
    stateRole = 'warn'
    stateLabel = 'Waiting for approval'
  } else if (props.state === 'error') {
    stateRole = 'error'
    stateLabel = 'Error'
  }

  const bullet = theme.paint(stateRole, theme.icon('bullet'))
  const statePart = `${bullet} ${theme.paint('textPrimary', stateLabel)}`

  const sep = `  ${theme.paint('border', theme.box.vertical)}  `
  const dot = ` ${theme.paint('textMuted', '·')} `

  // 2. Middle segments
  const segments: string[] = []
  segments.push(`${theme.paint('textMuted', 'Mode:')} ${theme.paint('textPrimary', props.mode)}`)
  segments.push(`${theme.paint('textMuted', 'Model:')} ${theme.paint('info', props.model)}`)

  if (props.contextPct !== undefined) {
    if (props.contextPct === null) {
      // No real context window is known: say so instead of estimating (G5/PR-2).
      segments.push(`${theme.paint('textMuted', 'Context:')} ${theme.paint('textMuted', 'unknown')}`)
    } else {
      let ctxRole: UIRole = 'info'
      if (props.contextPct > 85) {
        ctxRole = 'error'
      } else if (props.contextPct >= 60) {
        ctxRole = 'warning'
      }
      const ctxText = theme.paint(ctxRole, `${Math.round(props.contextPct)}%`)
      segments.push(`${theme.paint('textMuted', 'Context:')} ${ctxText}`)
    }
  }

  if (props.museCount !== undefined) {
    segments.push(`${theme.paint('textMuted', 'Muses:')} ${theme.paint('textPrimary', String(props.museCount))}`)
  }

  if (typeof props.cost === 'number') {
    // Only shown when the engine reported a cost; `null` means unreported.
    const formattedCost = `$${props.cost.toFixed(2)}`
    segments.push(theme.paint('warning', formattedCost))
  }

  // Right-aligned part
  const shipIcon = theme.paint('accentLight', theme.icon('ship'))
  const helpText = theme.paint('textMuted', '/help')
  const rightPart = `${helpText}  ${shipIcon}`
  const rightWidth = displayWidth(rightPart)

  // Construct full line
  const leftPrefix = `${statePart}${sep}`
  let middleText = segments.join(dot)

  // Check if everything fits
  let totalLeft = `${leftPrefix}${middleText}`
  if (displayWidth(totalLeft) + rightWidth + 2 > width) {
    // Narrow down segments: keep only state and model
    const minimalSegments = [
      `${theme.paint('textMuted', 'Mode:')} ${theme.paint('textPrimary', props.mode)}`,
      `${theme.paint('info', props.model)}`,
    ]
    middleText = minimalSegments.join(dot)
    totalLeft = `${leftPrefix}${middleText}`
  }

  const availableLeft = Math.max(0, width - rightWidth - 1)
  const truncatedLeft = truncateToWidth(totalLeft, availableLeft)
  const leftPad = ' '.repeat(Math.max(0, width - displayWidth(truncatedLeft) - rightWidth))

  return `${truncatedLeft}${leftPad}${rightPart}`
}
