/**
 * Reusable Header component for Pluton TUI 2.0.
 * Two-column wide banner with pirate ship & PLUTON wordmark + metadata at >=80 cols,
 * and compact single-line header below 80 cols or 24 rows.
 */

import type { UITheme } from './theme.ts'
import { renderBrandBanner } from './brand.ts'
import { displayWidth, truncateToWidth } from '../tui/width.ts'

export interface HeaderProps {
  version: string
  engine: string
  model: string
  rootDir: string
  shipSlug?: string
  /** @deprecated Use `shipSlug`; kept for backward compatibility. */
  museSlug?: string
  projectName?: string
}

export function renderHeader(
  props: HeaderProps,
  width: number,
  theme: UITheme,
  rows = 48,
): string[] {
  const isNarrow = width < 80 || rows < 24
  const hrChar = theme.box.horizontal

  if (isNarrow) {
    const shipIcon = theme.unicode ? '⚓' : '[SHIP]'
    const brand = `${theme.paint('accentLight', shipIcon)} ${theme.paint('accent', 'PLUTON')} ${theme.paint('textMuted', `v${props.version}`)}`
    const extra = ` ${theme.paint('textMuted', `· ${props.engine}`)}`
    const line1 = truncateToWidth(`${brand}${extra}`, width)
    const rule = theme.paint('border', hrChar.repeat(Math.max(0, width)))
    return [line1, rule]
  }

  // Wide layout: 2-column block
  const leftBanner = renderBrandBanner(theme)
  const leftWidth = Math.max(...leftBanner.map((l) => displayWidth(l)))

  // Right column metadata: 3 lines
  const projectSuffix = props.projectName ? ` · ${props.projectName}` : ''
  const rightLine1 = `${theme.paint('accentLight', 'PLUTON')} ${theme.paint('textMuted', `v${props.version}${projectSuffix}`)}`
  const engineLabel = props.engine.charAt(0).toUpperCase() + props.engine.slice(1)
  const shipSlug = props.shipSlug ?? props.museSlug
  const shipSuffix = shipSlug && shipSlug !== 'manager' ? ` (${shipSlug})` : ''
  const rightLine2 = `${theme.paint('textPrimary', 'Agentic Coding Harness')} ${theme.paint('textMuted', '·')} ${theme.paint('info', engineLabel)}${theme.paint('dim', shipSuffix)}`
  const rightLine3 = theme.paint('link', props.rootDir)

  const rightLines = [rightLine1, rightLine2, rightLine3]

  // We have leftBanner (6 lines).
  // Vertically center the right lines in the 6 lines: start at row 1 (rows 1, 2, 3)
  const rightStart = 1
  const sep = '   '
  const sepWidth = 3

  const lines: string[] = []
  for (let i = 0; i < leftBanner.length; i++) {
    const leftRaw = leftBanner[i] ?? ''
    const leftPad = ' '.repeat(Math.max(0, leftWidth - displayWidth(leftRaw)))
    const rightIdx = i - rightStart
    let rightContent = ''
    if (rightIdx >= 0 && rightIdx < rightLines.length) {
      rightContent = rightLines[rightIdx] ?? ''
    }

    const availableRight = Math.max(0, width - leftWidth - sepWidth)
    const truncatedRight = truncateToWidth(rightContent, availableRight)
    const rightPad = ' '.repeat(Math.max(0, availableRight - displayWidth(truncatedRight)))

    lines.push(`${leftRaw}${leftPad}${sep}${truncatedRight}${rightPad}`)
  }

  // Full-width bottom rule
  const bottomRule = theme.paint('border', hrChar.repeat(Math.max(0, width)))
  lines.push(bottomRule)

  return lines
}
