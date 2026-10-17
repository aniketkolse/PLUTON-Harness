/**
 * Reusable ToolGroup and Progress Telemetry Step presentation components (Phase 4.3 & 4.4).
 * Formats grouped tool execution and rich telemetry lines.
 */

import type { UITheme, UIRole } from './theme.ts'
import { displayWidth, truncateToWidth } from '../tui/width.ts'

export interface ToolItemData {
  id: string
  name: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  command?: string
  input?: unknown
  output?: string
  error?: string
  durationMs?: number
}

export interface ToolGroupData {
  id: string
  tools: ToolItemData[]
  running: boolean
  label?: string
  expanded?: boolean
}

export interface StepData {
  title: string
  status: 'active' | 'success' | 'warning' | 'failed'
  telemetry?: Record<string, string | number | undefined>
}

export function renderToolGroup(group: ToolGroupData, width: number, theme: UITheme): string[] {
  const icon = theme.unicode ? '┆' : '|'
  const count = group.tools.length

  let defaultLabel: string
  const allShell = group.tools.every((t) => t.name === 'shell' || t.name === 'bash' || t.name === 'exec')
  if (allShell) {
    defaultLabel = `Run ${count} shell command${count === 1 ? '' : 's'}`
  } else {
    defaultLabel = `${count} tool call${count === 1 ? '' : 's'}`
  }

  const label = group.label ?? defaultLabel
  const spinner = group.running ? ` ${theme.paint('accentLight', theme.icon('running'))}` : ''

  const prefix = `${theme.paint('textMuted', icon)} ${theme.paint('info', label)}${spinner} `
  const prefixWidth = displayWidth(prefix)

  const hrChar = theme.box.horizontal
  const remaining = Math.max(0, width - prefixWidth)
  const rule = theme.paint('border', hrChar.repeat(remaining))

  const lines: string[] = [`${prefix}${rule}`]

  if (group.expanded) {
    for (const tool of group.tools) {
      const toolStatusRole: UIRole =
        tool.status === 'succeeded'
          ? 'success'
          : tool.status === 'failed'
            ? 'error'
            : tool.status === 'running'
              ? 'warn'
              : 'textMuted'
      const bullet = theme.paint(toolStatusRole, theme.icon('bullet'))
      const cmdText = tool.command ? `: ${tool.command}` : ''
      const toolLine = `  ${bullet} ${theme.paint('textPrimary', tool.name)}${theme.paint('textMuted', cmdText)}`
      lines.push(truncateToWidth(toolLine, width))

      if (tool.output) {
        const outLines = tool.output.trim().split(/\r?\n/).slice(0, 5)
        for (const out of outLines) {
          lines.push(truncateToWidth(`    ${theme.paint('dim', out)}`, width))
        }
      }
      if (tool.error) {
        lines.push(truncateToWidth(`    ${theme.paint('error', tool.error)}`, width))
      }
    }
  }

  return lines
}

export function renderStep(step: StepData, width: number, theme: UITheme): string[] {
  const statusRole: UIRole =
    step.status === 'success'
      ? 'success'
      : step.status === 'failed'
        ? 'error'
        : step.status === 'warning'
          ? 'warn'
          : 'success' // active uses green

  const icon = theme.icon('bullet')
  const titleLine = `${theme.paint(statusRole, icon)} ${theme.paint('textPrimary', step.title)}`
  const lines: string[] = [truncateToWidth(titleLine, width)]

  if (step.telemetry) {
    const pairs: string[] = []
    for (const [k, v] of Object.entries(step.telemetry)) {
      if (v !== undefined && v !== '') {
        pairs.push(`${k}: ${String(v)}`)
      }
    }

    if (pairs.length > 0) {
      const subIcon = theme.icon('substep')
      const telemetryText = pairs.join(' | ')
      const telemetryLine = `  ${theme.paint('textMuted', subIcon)} ${theme.paint('textMuted', telemetryText)}`
      lines.push(truncateToWidth(telemetryLine, width))
    }
  }

  return lines
}
