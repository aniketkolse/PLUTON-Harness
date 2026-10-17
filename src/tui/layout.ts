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
      footer: { x: 0, y: 0, width: columns, height: 0 },
    }
  }

  const compactHeight = rows < 24
  const wideWidth = columns >= WIDE_TERMINAL_COLUMNS
  const tallHeight = rows >= TALL_TERMINAL_ROWS

  // Inspector is enabled by default on wide + tall terminals, or if explicitly requested and width >= 80
  const inspectorOpen =
    opts.inspectorOpen !== undefined
      ? opts.inspectorOpen && columns >= 80
      : wideWidth && tallHeight

  const twoColumn = inspectorOpen && columns >= 80

  // Header height: 2 rows if not compact, 1 row if compact
  const headerHeight = compactHeight ? 1 : 2
  const headerRect: Rect = { x: 0, y: 0, width: columns, height: headerHeight }
  const dividerHeaderY = headerHeight // row index of divider line

  // Footer: 1 row at bottom
  const footerHeight = 1
  const footerY = rows - footerHeight
  const footerRect: Rect = { x: 0, y: footerY, width: columns, height: footerHeight }

  // Composer height: clamped between 2 and (compact ? 3 : 5)
  const maxComposerHeight = compactHeight ? 3 : 5
  const draftLines = opts.draftLineCount ?? 1
  const composerHeight = Math.max(2, Math.min(maxComposerHeight, draftLines))

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

  // Autocomplete overlay
  let autocompleteRect: Rect | null = null
  if (opts.autocompleteOpen && (opts.autocompleteCount ?? 0) > 0) {
    const count = Math.min(opts.autocompleteCount ?? 0, 6)
    const autoH = count
    const autoY = Math.max(mainY, dividerComposerY - autoH)
    const autoWidth = Math.min(columns - 4, 60)
    autocompleteRect = {
      x: 2,
      y: autoY,
      width: autoWidth,
      height: autoH,
    }
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
    footer: footerRect,
  }
}
