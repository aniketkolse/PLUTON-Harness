/**
 * Approval card renderer for the Pluton chat TUI.
 * Renders distinct action cards with real backend action, target, reason, and key shortcuts.
 */

import type { Theme } from './theme.ts'
import { displayWidth, wrapText } from './width.ts'

export interface ApprovalViewData {
  id: string
  action: string
  target?: string
  reason: string
  requestedByMuse?: string
}

export function renderApprovalCard(
  data: ApprovalViewData,
  maxWidth: number,
  theme: Theme,
): string[] {
  const boxWidth = Math.min(maxWidth, 72)
  const innerWidth = Math.max(10, boxWidth - 4)

  const tl = theme.enabled ? '┌─' : '+--'
  const tr = theme.enabled ? '┐' : '+'
  const bl = theme.enabled ? '└─' : '+--'
  const br = theme.enabled ? '┘' : '+'
  const hz = theme.enabled ? '─' : '-'
  const vt = theme.enabled ? '│' : '|'

  const title = ' ACTION NEEDS YOUR APPROVAL '
  const padTop = Math.max(0, boxWidth - 3 - displayWidth(title))
  const topBorder = theme.paint('approval', `${tl}${title}${hz.repeat(padTop)}${tr}`)

  const rows: string[] = [topBorder]

  function addRow(label: string, value: string): void {
    const text = `${label}: ${value}`
    const wrapped = wrapText(text, innerWidth)
    for (const w of wrapped) {
      const padRight = Math.max(0, innerWidth - displayWidth(w))
      rows.push(
        `${theme.paint('approval', vt)}  ${w}${' '.repeat(padRight)}  ${theme.paint('approval', vt)}`,
      )
    }
  }

  function addEmptyRow(): void {
    rows.push(
      `${theme.paint('approval', vt)}${' '.repeat(innerWidth + 4)}${theme.paint('approval', vt)}`,
    )
  }

  if (data.requestedByMuse) {
    addRow('Muse', theme.paint('accent', data.requestedByMuse))
  }
  addRow('Action', theme.paint('input', data.action))
  if (data.target) {
    addRow('Target', data.target)
  }
  addRow('Reason', theme.paint('warn', data.reason))

  addEmptyRow()

  // Key affordances row
  const actionsText = `${theme.paint('success', '[A] Approve once')}   ${theme.paint('error', '[D] Deny')}   ${theme.paint('focus', '[V] View details')}`
  const padActions = Math.max(0, innerWidth - displayWidth(actionsText))
  rows.push(
    `${theme.paint('approval', vt)}  ${actionsText}${' '.repeat(padActions)}  ${theme.paint('approval', vt)}`,
  )

  const bottomBorder = theme.paint(
    'approval',
    `${bl}${hz.repeat(Math.max(0, boxWidth - 3))}${br}`,
  )
  rows.push(bottomBorder)

  return rows
}
