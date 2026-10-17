/**
 * Reusable UserMessage and AssistantMessage presentation components (Phase 4.1 & 4.2).
 * Formats user inquiries with lavender labels and assistant responses with PLUTON branding.
 */

import type { UITheme } from './theme.ts'
import { renderMarkdown } from '../tui/markdown.ts'
import { displayWidth, wrapText } from '../tui/width.ts'

export function renderUserMessage(text: string, width: number, theme: UITheme): string[] {
  const icon = theme.unicode ? '👤' : '>'
  const prefix = `${theme.paint('accentLight', `${icon} You`)}  `
  const prefixLen = displayWidth(`${icon} You  `)

  const availableWidth = Math.max(10, width - prefixLen)
  const wrapped = wrapText(text, availableWidth)

  if (wrapped.length === 0) {
    return [prefix]
  }

  const result: string[] = []
  result.push(`${prefix}${theme.paint('textPrimary', wrapped[0] ?? '')}`)

  const indent = ' '.repeat(prefixLen)
  for (let i = 1; i < wrapped.length; i++) {
    result.push(`${indent}${theme.paint('textPrimary', wrapped[i] ?? '')}`)
  }

  return result
}

export function renderAssistantMessage(markdown: string, width: number, theme: UITheme): string[] {
  const ship = theme.unicode ? '⛵' : '[SHIP]'
  const identity = `${theme.paint('accentLight', ship)} ${theme.paint('accent', 'PLUTON')}`

  if (!markdown) {
    return [identity]
  }

  const bodyWidth = Math.max(10, width - 2)
  const mdLines = renderMarkdown(markdown, bodyWidth, theme)

  const result: string[] = [identity]
  for (const line of mdLines) {
    result.push(`  ${line}`)
  }

  return result
}
