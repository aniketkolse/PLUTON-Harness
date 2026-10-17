/**
 * Orchestra Inspector renderer for the Pluton TUI.
 * Displays real Muses state, task graph/list, pending approvals, and recent lifecycle events.
 */

import type { Theme } from './theme.ts'
import { displayWidth, truncateToWidth } from './width.ts'

export interface MuseInspectorItem {
  id: string
  slug: string
  role: string
  engine: string
  model: string
  state: 'idle' | 'working' | 'waiting' | 'failed' | 'done'
  activeTaskId?: string
}

export interface TaskInspectorItem {
  id: string
  title: string
  state: 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
  ownerMuseSlug?: string
  dependencies?: string[]
}

export interface EventInspectorItem {
  seq: number
  type: string
  summary: string
}

export interface OrchestraInspectorData {
  muses: MuseInspectorItem[]
  tasks: TaskInspectorItem[]
  approvals: Array<{ id: string; action: string; reason: string }>
  events: EventInspectorItem[]
  scrollOffset?: number
}

export function renderOrchestraInspector(
  data: OrchestraInspectorData,
  width: number,
  height: number,
  theme: Theme,
): string[] {
  if (width <= 0 || height <= 0) return []

  const lines: string[] = []

  function addLine(text: string): void {
    if (lines.length < height) {
      lines.push(truncateToWidth(text, width))
    }
  }

  function addEmpty(): void {
    if (lines.length < height) {
      lines.push('')
    }
  }

  // Header
  addLine(theme.paint('header', 'ORCHESTRA'))
  addEmpty()

  // 1. Muses Section
  addLine(theme.paint('accent', 'Muses'))
  if (data.muses.length === 0) {
    addLine(theme.paint('dim', '  (no muses configured)'))
  } else {
    for (const m of data.muses) {
      let icon = theme.icon('idle')
      let stateLabel = theme.paint('dim', m.state)

      if (m.state === 'working') {
        icon = theme.icon('bullet')
        stateLabel = theme.paint('warn', 'working')
      } else if (m.state === 'done') {
        icon = theme.icon('check')
        stateLabel = theme.paint('success', 'done')
      } else if (m.state === 'failed') {
        icon = theme.icon('cross')
        stateLabel = theme.paint('error', 'failed')
      } else if (m.state === 'waiting') {
        icon = theme.icon('running')
        stateLabel = theme.paint('warn', 'waiting')
      }

      const left = `  ${icon} ${theme.paint('focus', m.slug)}`
      const right = stateLabel
      const leftW = displayWidth(left)
      const rightW = displayWidth(right)
      const pad = Math.max(1, width - leftW - rightW)
      addLine(`${left}${' '.repeat(pad)}${right}`)
    }
  }
  addEmpty()

  // 2. Task Graph Section
  addLine(theme.paint('accent', 'Task graph'))
  if (data.tasks.length === 0) {
    addLine(theme.paint('dim', '  (no active tasks)'))
  } else {
    for (let i = 0; i < data.tasks.length; i++) {
      const t = data.tasks[i]!
      const isLast = i === data.tasks.length - 1
      const branch = isLast ? '└─' : '├─'

      let stateBadge = '[..]'
      if (t.state === 'completed') stateBadge = theme.icon('check')
      else if (t.state === 'running') stateBadge = theme.icon('bullet')
      else if (t.state === 'failed') stateBadge = theme.icon('cross')
      else if (t.state === 'blocked') stateBadge = '[!]'

      const owner = t.ownerMuseSlug ? ` (${t.ownerMuseSlug})` : ''
      const line = `  ${theme.paint('border', branch)} ${t.title}${theme.paint('dim', owner)} ${stateBadge}`
      addLine(line)
      if (t.dependencies && t.dependencies.length > 0) {
        const depLine = `     ${theme.paint('dim', `↳ needs: ${t.dependencies.join(', ')}`)}`
        addLine(depLine)
      }
    }
  }
  addEmpty()

  // 3. Pending Approvals Section
  addLine(theme.paint('accent', 'Pending approvals'))
  if (data.approvals.length === 0) {
    addLine(theme.paint('dim', '  (none)'))
  } else {
    for (const a of data.approvals.slice(0, 3)) {
      const ref = a.id.slice(0, 8)
      addLine(`  ${theme.paint('warn', '●')} ${ref} · ${a.action}`)
    }
    if (data.approvals.length > 3) {
      addLine(theme.paint('dim', `  +${data.approvals.length - 3} more`))
    }
  }
  addEmpty()

  // 4. Recent Events
  if (lines.length + 2 < height) {
    addLine(theme.paint('accent', 'Recent events'))
    if (data.events.length === 0) {
      addLine(theme.paint('dim', '  (none)'))
    } else {
      const slice = data.events.slice(-4)
      for (const ev of slice) {
        addLine(theme.paint('dim', `  · ${ev.summary}`))
      }
    }
  }

  // Pad remaining height with blank rows
  while (lines.length < height) {
    lines.push('')
  }

  return lines
}
