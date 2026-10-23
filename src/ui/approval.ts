/**
 * Concise, actionable Approval Notification Card component (Phase 9).
 * Eliminates duplicate notices and presents single-card interactive approvals.
 */

import type { UITheme } from './theme.ts'
import { displayWidth, truncateToWidth } from '../tui/width.ts'

export interface ApprovalCardProps {
  id: string
  action: string
  reason: string
  target?: string
  requestedByShip?: string
  pendingIndex?: number
  pendingTotal?: number
}

export function renderActionableApprovalCard(
  props: ApprovalCardProps,
  width: number,
  theme: UITheme,
): string[] {
  const cardWidth = Math.min(width, 76)
  const innerWidth = Math.max(10, cardWidth - 4)

  const tl = theme.box.topLeft
  const tr = theme.box.topRight
  const bl = theme.box.bottomLeft
  const br = theme.box.bottomRight
  const hz = theme.box.horizontal
  const vt = theme.box.vertical

  // Top header: ╭─ ⚠ Approval required: <action> ───────╮
  const warnIcon = theme.icon('warning')
  const queueIndicator =
    props.pendingTotal && props.pendingTotal > 1
      ? ` (${props.pendingIndex ?? 1} of ${props.pendingTotal})`
      : ''
  const titleText = `${warnIcon} Approval required${queueIndicator}: ${props.action}`
  const paintedTitle = theme.paint('warn', titleText)

  const titlePrefix = `${tl}${hz} `
  const titlePart = `${titlePrefix}${paintedTitle} `
  const titleWidth = displayWidth(`${titlePrefix}${titleText} `)
  const remainingTop = Math.max(0, cardWidth - titleWidth - 1)
  const topLine = `${theme.paint('warn', titlePrefix)}${paintedTitle} ${theme.paint('warn', hz.repeat(remainingTop))}${theme.paint('warn', tr)}`

  // Row 1: Reason and reference
  const shipPart = props.requestedByShip ? `[${props.requestedByShip}] ` : ''
  const targetPart = props.target ? ` on ${props.target}` : ''
  const descRaw = `  ${shipPart}${props.reason}${targetPart} ${theme.paint('dim', `(ref: ${props.id})`)}`
  const descTrunc = truncateToWidth(descRaw, innerWidth)
  const descPad = ' '.repeat(Math.max(0, innerWidth - displayWidth(descTrunc)))
  const row1 = `${theme.paint('warn', vt)}  ${descTrunc}${descPad}  ${theme.paint('warn', vt)}`

  // Row 2: Action buttons
  const btnApprove = theme.paint('success', '[A] Approve once')
  const btnDeny = theme.paint('error', '[D] Deny')
  const btnDetails = theme.paint('focus', '[V] Details')
  const btnClose = theme.paint('dim', '[Esc] Close')
  const actionsRaw = `  ${btnApprove}  ${btnDeny}  ${btnDetails}  ${btnClose}`
  const actionsTrunc = truncateToWidth(actionsRaw, innerWidth)
  const actionsPad = ' '.repeat(Math.max(0, innerWidth - displayWidth(actionsTrunc)))
  const row2 = `${theme.paint('warn', vt)}  ${actionsTrunc}${actionsPad}  ${theme.paint('warn', vt)}`

  // Bottom border: ╰──────────────────────────────────╯
  const bottomRule = hz.repeat(Math.max(0, cardWidth - 2))
  const bottomLine = `${theme.paint('warn', bl)}${theme.paint('warn', bottomRule)}${theme.paint('warn', br)}`

  return [topLine, row1, row2, bottomLine]
}
