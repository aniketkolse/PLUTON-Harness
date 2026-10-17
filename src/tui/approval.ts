/**
 * Approval card renderer for the Pluton chat TUI.
 * One canonical actionable card for a real backend approval record, a read-only
 * details view that never approves, and an informational notice for engine-level
 * permission requests (which the adapters auto-deny fail-closed).
 *
 * Only information present in the actual approval record is rendered; nothing is
 * invented (no risk levels, no friendly renames of the action string).
 */

import type { Theme } from './theme.ts'
import { displayWidth, wrapText } from './width.ts'

export interface ApprovalViewData {
  id: string
  /** Raw action string from the backend record (e.g. 'integration.apply'). */
  action: string
  reason: string
  /** Only set when the request scope names a concrete target. */
  target?: string
  requestedByMuse?: string
  /** Bounded JSON scope from the record: what exactly would happen if approved. */
  scope?: unknown
  status?: string
  runId?: string | null
  taskId?: string | null
  expiresAt?: string | null
}

/** Max rows a single card may occupy (keeps the overlay dense and readable). */
const MAX_CARD_ROWS = 14

function boxChars(theme: Theme): {
  tl: string
  tr: string
  bl: string
  br: string
  hz: string
  vt: string
} {
  return theme.enabled
    ? { tl: '┌─', tr: '┐', bl: '└─', br: '┘', hz: '─', vt: '│' }
    : { tl: '+-', tr: '+', bl: '+-', br: '+', hz: '-', vt: '|' }
}

function compactScope(scope: unknown): string {
  if (scope === undefined || scope === null) return ''
  try {
    const s = JSON.stringify(scope)
    if (!s || s === '{}' || s === 'null') return ''
    return s
  } catch {
    return ''
  }
}

export function renderApprovalCard(
  data: ApprovalViewData,
  maxWidth: number,
  theme: Theme,
): string[] {
  const boxWidth = Math.min(maxWidth, 72)
  const innerWidth = Math.max(10, boxWidth - 4)
  const { tl, tr, bl, br, hz, vt } = boxChars(theme)

  const title = ' APPROVAL REQUIRED '
  const padTop = Math.max(0, boxWidth - 3 - displayWidth(title))
  const topBorder = theme.paint('approval', `${tl}${title}${hz.repeat(padTop)}${tr}`)

  const rows: string[] = [topBorder]

  function pushRaw(row: string): void {
    if (rows.length >= MAX_CARD_ROWS - 1) return
    rows.push(row)
  }

  function addRow(label: string, value: string): void {
    if (rows.length >= MAX_CARD_ROWS - 1) return
    const text = `${label}: ${value}`
    const wrapped = wrapText(text, innerWidth)
    for (const w of wrapped) {
      if (rows.length >= MAX_CARD_ROWS - 1) {
        rows.push(
          `${theme.paint('approval', vt)}  ${theme.paint('dim', '…')}${' '.repeat(Math.max(0, innerWidth - 1))}  ${theme.paint('approval', vt)}`,
        )
        return
      }
      const padRight = Math.max(0, innerWidth - displayWidth(w))
      rows.push(
        `${theme.paint('approval', vt)}  ${w}${' '.repeat(padRight)}  ${theme.paint('approval', vt)}`,
      )
    }
  }

  function addEmptyRow(): void {
    if (rows.length >= MAX_CARD_ROWS - 1) return
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
  const scope = compactScope(data.scope)
  if (scope) {
    addRow('Scope', theme.paint('dim', scope))
  }
  addRow('Ref', theme.paint('dim', data.id))

  addEmptyRow()

  // Key affordances row — these map to real operations on the referenced record.
  const actionsText = `${theme.paint('success', '[A] Approve once')}   ${theme.paint('error', '[D] Deny')}   ${theme.paint('focus', '[V] View details')}`
  const padActions = Math.max(0, innerWidth - displayWidth(actionsText))
  pushRaw(
    `${theme.paint('approval', vt)}  ${actionsText}${' '.repeat(padActions)}  ${theme.paint('approval', vt)}`,
  )

  const bottomBorder = theme.paint(
    'approval',
    `${bl}${hz.repeat(Math.max(0, boxWidth - 3))}${br}`,
  )
  rows.push(bottomBorder)

  return rows
}

/**
 * Read-only details view. Never approves, never mutates: strictly renders the
 * record fields plus a close hint. Fits within `height` rows when possible.
 */
export function renderApprovalDetails(
  data: ApprovalViewData,
  width: number,
  height: number,
  theme: Theme,
): string[] {
  const boxWidth = Math.min(width, 84)
  const innerWidth = Math.max(10, boxWidth - 4)
  const { tl, tr, bl, br, hz, vt } = boxChars(theme)

  const title = ' APPROVAL DETAILS · read-only '
  const padTop = Math.max(0, boxWidth - 3 - displayWidth(title))
  const rows: string[] = [theme.paint('approval', `${tl}${title}${hz.repeat(padTop)}${tr}`)]

  const bodyBudget = Math.max(3, height - 3) // minus top border, hint row, bottom border

  function addBody(label: string, value: string, paintRole?: Parameters<Theme['paint']>[0]): void {
    if (rows.length - 1 >= bodyBudget) return
    const text = `${label}: ${value}`
    const wrapped = wrapText(text, innerWidth)
    for (const w of wrapped) {
      if (rows.length - 1 >= bodyBudget) {
        rows.push(
          `${theme.paint('approval', vt)}  ${theme.paint('dim', '… truncated')}${' '.repeat(Math.max(0, innerWidth - 12))}  ${theme.paint('approval', vt)}`,
        )
        return
      }
      const painted = paintRole ? theme.paint(paintRole, w) : w
      const padRight = Math.max(0, innerWidth - displayWidth(painted))
      rows.push(
        `${theme.paint('approval', vt)}  ${painted}${' '.repeat(padRight)}  ${theme.paint('approval', vt)}`,
      )
    }
  }

  addBody('Ref', data.id, 'focus')
  addBody('Status', data.status ?? 'pending')
  if (data.requestedByMuse) addBody('Muse', data.requestedByMuse)
  addBody('Action', data.action)
  if (data.target) addBody('Target', data.target)
  addBody('Reason', data.reason)
  if (data.runId) addBody('Run', data.runId)
  if (data.taskId) addBody('Task', data.taskId)
  if (data.expiresAt) addBody('Expires', data.expiresAt)

  let scopeText = ''
  try {
    scopeText = data.scope !== undefined && data.scope !== null ? JSON.stringify(data.scope, null, 2) : ''
  } catch {
    scopeText = ''
  }
  if (scopeText && scopeText !== '{}' && scopeText !== 'null') {
    if (rows.length - 1 >= bodyBudget) {
      rows.push(
        `${theme.paint('approval', vt)}  ${theme.paint('dim', '… scope truncated')}${' '.repeat(Math.max(0, innerWidth - 17))}  ${theme.paint('approval', vt)}`,
      )
    } else {
      const scopeLines = scopeText.split('\n')
      addBody('Scope', '', 'dim')
      // Replace the just-added empty scope line with wrapped scope content.
      for (const sl of scopeLines) {
        if (rows.length - 1 >= bodyBudget) {
          rows.push(
            `${theme.paint('approval', vt)}  ${theme.paint('dim', '… scope truncated')}${' '.repeat(Math.max(0, innerWidth - 17))}  ${theme.paint('approval', vt)}`,
          )
          break
        }
        const wrapped = wrapText(`  ${sl}`, innerWidth)
        for (const w of wrapped) {
          if (rows.length - 1 >= bodyBudget) break
          const padRight = Math.max(0, innerWidth - displayWidth(w))
          rows.push(
            `${theme.paint('approval', vt)}  ${theme.paint('dim', w)}${' '.repeat(padRight)}  ${theme.paint('approval', vt)}`,
          )
        }
      }
    }
  }

  const hint = 'Esc closes · A/D act on this approval'
  const padHint = Math.max(0, innerWidth - displayWidth(hint))
  rows.push(
    `${theme.paint('approval', vt)}  ${theme.paint('dim', hint)}${' '.repeat(padHint)}  ${theme.paint('approval', vt)}`,
  )
  rows.push(theme.paint('approval', `${bl}${hz.repeat(Math.max(0, boxWidth - 3))}${br}`))

  return rows.slice(0, Math.max(1, height))
}

/**
 * Informational (non-actionable) notice for an engine-level permission request.
 * Pluton's engine adapters auto-deny such requests fail-closed; there is no
 * interactive approval channel for them, so no approve/deny affordances are shown.
 */
export function renderEngineRequestNotice(
  requestId: string,
  description: string,
  width: number,
  theme: Theme,
): string[] {
  const lines: string[] = []
  lines.push(
    `${theme.paint('warn', '⚠ engine permission request (auto-denied, fail-closed)')} ${theme.paint('dim', `[${requestId}]`)}`,
  )
  for (const w of wrapText(description, Math.max(10, width - 2))) {
    lines.push(`  ${theme.paint('dim', w)}`)
  }
  return lines
}
