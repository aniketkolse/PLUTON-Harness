/**
 * Keybindings and input normalization for the Pluton chat TUI (ADR-0012).
 * Pure function mapping (input, key) -> KeyAction.
 */

export interface Key {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}

export type KeyAction =
  | 'send'
  | 'newline'
  | 'interrupt'
  | 'exit'
  | 'clear-input'
  | 'redraw'
  | 'toggle-tools'
  | 'toggle-inspector'
  | 'scroll-up'
  | 'scroll-down'
  | 'palette'
  | 'help'
  | 'approve'
  | 'deny'
  | 'view-details'
  | 'history-prev'
  | 'history-next'
  | 'cursor-left'
  | 'cursor-right'
  | 'home'
  | 'end'
  | 'backspace'
  | 'delete'
  | 'kill-to-end'
  | 'kill-to-start'
  | 'kill-word'
  | 'insert'
  | 'ignore'

export interface KeyContext {
  approvalPending?: boolean
  draftEmpty?: boolean
}

export function keyAction(
  input: string,
  key: Key,
  ctx: KeyContext = {},
): { action: KeyAction; text?: string } {
  // Return / Enter variants
  if (key.name === 'return' || key.name === 'enter') {
    if (key.shift || key.meta) {
      return { action: 'newline' }
    }
    if (input === '\n') {
      return { action: 'newline' }
    }
    return { action: 'send' }
  }

  // Ctrl+J -> newline
  if (key.ctrl && key.name === 'j') {
    return { action: 'newline' }
  }

  // Raw \n without return name
  if (input === '\n') {
    return { action: 'newline' }
  }

  // Raw \r without return name
  if (input === '\r') {
    return { action: 'send' }
  }

  // Escape / Interrupt
  if (key.name === 'escape' || input === '\x1b') {
    return { action: 'interrupt' }
  }

  // Ctrl combinations
  if (key.ctrl) {
    switch (key.name) {
      case 'c':
        return { action: 'clear-input' }
      case 'd':
        return { action: 'exit' }
      case 'a':
        return { action: 'home' }
      case 'e':
        return { action: 'end' }
      case 'k':
        return { action: 'kill-to-end' }
      case 'u':
        return { action: 'kill-to-start' }
      case 'w':
        return { action: 'kill-word' }
      case 'o':
        return { action: 'toggle-tools' }
      case 'p':
        return { action: 'palette' }
      case 'l':
        return { action: 'redraw' }
    }
  }

  // Tab key -> toggle inspector
  if (key.name === 'tab') {
    return { action: 'toggle-inspector' }
  }

  // PageUp / PageDown -> scroll viewport
  if (key.name === 'pageup') {
    return { action: 'scroll-up' }
  }
  if (key.name === 'pagedown') {
    return { action: 'scroll-down' }
  }

  // F1 or ? (when draft empty)
  if (key.name === 'f1') {
    return { action: 'help' }
  }

  // Approval single-key triggers when approval is pending and no draft is being composed
  if (ctx.approvalPending && ctx.draftEmpty) {
    if (input.toLowerCase() === 'a') return { action: 'approve' }
    if (input.toLowerCase() === 'd') return { action: 'deny' }
    if (input.toLowerCase() === 'v') return { action: 'view-details' }
  }

  // Navigation and deletion keys
  if (key.name === 'backspace' || input === '\x7f' || input === '\b') {
    return { action: 'backspace' }
  }
  if (key.name === 'delete') {
    return { action: 'delete' }
  }
  if (key.name === 'up' || input === '\x1b[A') {
    return { action: 'history-prev' }
  }
  if (key.name === 'down' || input === '\x1b[B') {
    return { action: 'history-next' }
  }
  if (key.name === 'left' || input === '\x1b[D') {
    return { action: 'cursor-left' }
  }
  if (key.name === 'right' || input === '\x1b[C') {
    return { action: 'cursor-right' }
  }
  if (key.name === 'home') {
    return { action: 'home' }
  }
  if (key.name === 'end') {
    return { action: 'end' }
  }

  // Printable input text (including space)
  if (input && !key.ctrl && !key.meta) {
    return { action: 'insert', text: input }
  }

  return { action: 'ignore' }
}
