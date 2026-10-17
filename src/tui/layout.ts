/**
 * Pure geometry and layout calculator for Pluton full-screen TUI.
 * Implements two-column responsive arrangement and narrow terminal collapsing.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutOptions {
  inspectorOpen?: boolean
  draftLineCount?: number
  autocompleteOpen?: boolean
  autocompleteCount?: number
  /** Rows needed by the pinned approval card (0 = closed). */
  approvalCardHeight?: number
  /** Rows needed by the read-only approval details overlay (0 = closed). */
  detailsHeight?: number
  /** Enable wide brand banner header (6 rows) when terminal is wide enough. */
  brandHeader?: boolean
}

export interface ComputedLayout {
  tooSmall: boolean
  columns: number
  rows: number
  twoColumn: boolean
  inspectorOpen: boolean
  header: Rect
  dividerHeader: number // y row of divider line
  chat: Rect
  inspector: Rect | null
  dividerVertical: { x: number; top: number; bottom: number } | null
  dividerComposer: number // y row of divider line
  composer: Rect
  autocomplete: Rect | null
  approval: Rect | null
  details: Rect | null
  footer: Rect
}

export const MIN_TERMINAL_COLUMNS = 40
export const MIN_TERMINAL_ROWS = 12

export const WIDE_TERMINAL_COLUMNS = 120
export const TALL_TERMINAL_ROWS = 30

export function computeLayout(
  columns: number,
  rows: number,
  opts: LayoutOptions = {},
): ComputedLayout {
  if (columns < MIN_TERMINAL_COLUMNS || rows < MIN_TERMINAL_ROWS) {
    return {
      tooSmall: true,
      columns,
      rows,
      twoColumn: false,
      inspectorOpen: false,
      header: { x: 0, y: 0, width: columns, height: 0 },
      dividerHeader: 0,
      chat: { x: 0, y: 0, width: columns, height: rows },
      inspector: null,
      dividerVertical: null,
      dividerComposer: 0,
      composer: { x: 0, y: 0, width: columns, height: 0 },
      autocomplete: null,
      approval: null,
      details: null,
      footer: { x: 0, y: 0, width: columns, height: 0 },
    }
  }

  const wideWidth = columns >= WIDE_TERMINAL_COLUMNS
  const tallHeight = rows >= TALL_TERMINAL_ROWS
  const compactHeight = rows < 24

  // Inspector is enabled by default on wide + tall terminals, or if explicitly requested and width >= 80
  const inspectorOpen =
    opts.inspectorOpen !== undefined
      ? opts.inspectorOpen && columns >= 80
      : wideWidth && tallHeight

  const twoColumn = inspectorOpen && columns >= 80

  // Header: brand banner (6 rows) when requested and terminal is wide/tall enough,
  // or compact 1-row title plus the divider rule below it.
  const useWideBrand = opts.brandHeader && columns >= 80 && rows >= 24
  const headerHeight = useWideBrand ? 6 : 1
  const headerRect: Rect = { x: 0, y: 0, width: columns, height: headerHeight }
  const dividerHeaderY = headerHeight // row index of divider line

  // Footer: 1 row at bottom
  const footerHeight = 1
  const footerY = rows - footerHeight
  const footerRect: Rect = { x: 0, y: footerY, width: columns, height: footerHeight }

  // Composer height: clamped between 2 and (compact ? 3 : 5)
  // For boxed composer (brandHeader), we need 1 top border + content rows + 1 bottom border
  const maxComposerHeight = compactHeight ? 3 : 5
  const draftLines = opts.draftLineCount ?? 1
  const composerHeight = opts.brandHeader
    ? Math.max(2, Math.min(maxComposerHeight + 1, draftLines + 1))
    : Math.max(2, Math.min(maxComposerHeight, draftLines))

  const composerY = footerY - composerHeight
  const dividerComposerY = composerY - 1

  // Middle vertical space: between dividerHeaderY + 1 and dividerComposerY - 1
  const mainY = dividerHeaderY + 1
  const mainHeight = Math.max(1, dividerComposerY - mainY)

  let chatRect: Rect
  let inspectorRect: Rect | null = null
  let dividerVertical: { x: number; top: number; bottom: number } | null = null

  if (twoColumn) {
    // Inspector: 25-28% of width, min 30 cols, max 45 cols
    const rawInspectorWidth = Math.round(columns * 0.27)
    const inspectorWidth = Math.max(30, Math.min(48, rawInspectorWidth))
    const dividerX = columns - inspectorWidth - 1
    const chatWidth = dividerX

    chatRect = { x: 0, y: mainY, width: chatWidth, height: mainHeight }
    inspectorRect = { x: dividerX + 1, y: mainY, width: inspectorWidth, height: mainHeight }
    dividerVertical = { x: dividerX, top: mainY, bottom: mainY + mainHeight - 1 }
  } else {
    chatRect = { x: 0, y: mainY, width: columns, height: mainHeight }
  }

  const composerRect: Rect = {
    x: 0,
    y: composerY,
    width: columns,
    height: composerHeight,
  }

  // Approval card overlay: pinned just above the composer divider (canonical position,
  // independent of transcript scrolling). Autocomplete stacks above it when both exist.
  let approvalRect: Rect | null = null
  if ((opts.approvalCardHeight ?? 0) > 0) {
    const cardH = Math.min(opts.approvalCardHeight!, Math.max(1, mainHeight))
    const cardY = Math.max(mainY, dividerComposerY - cardH)
    const cardWidth = Math.min(columns - 4, 64)
    approvalRect = { x: 2, y: cardY, width: cardWidth, height: cardH }
  }

  // Autocomplete overlay
  let autocompleteRect: Rect | null = null
  if (opts.autocompleteOpen && (opts.autocompleteCount ?? 0) > 0) {
    const count = Math.min(opts.autocompleteCount ?? 0, 6)
    const autoH = count
    const ceiling = approvalRect ? approvalRect.y : dividerComposerY
    const autoY = Math.max(mainY, ceiling - autoH)
    const autoWidth = Math.min(columns - 4, 60)
    autocompleteRect = {
      x: 2,
      y: autoY,
      width: autoWidth,
      height: autoH,
    }
  }

  // Approval details overlay (read-only view): centred block over the main area.
  let detailsRect: Rect | null = null
  if ((opts.detailsHeight ?? 0) > 0) {
    const detH = Math.min(opts.detailsHeight!, Math.max(1, mainHeight - 1))
    const detY = mainY + Math.max(0, Math.floor((mainHeight - detH) / 2))
    const detWidth = Math.min(columns - 4, 84)
    detailsRect = { x: 2, y: detY, width: detWidth, height: detH }
  }

  return {
    tooSmall: false,
    columns,
    rows,
    twoColumn,
    inspectorOpen,
    header: headerRect,
    dividerHeader: dividerHeaderY,
    chat: chatRect,
    inspector: inspectorRect,
    dividerVertical,
    dividerComposer: dividerComposerY,
    composer: composerRect,
    autocomplete: autocompleteRect,
    approval: approvalRect,
    details: detailsRect,
    footer: footerRect,
  }
}
