import type { ChatIo } from '../../src/tui/terminal.ts'
import type { Key } from '../../src/tui/keys.ts'

export class ScriptedIo implements ChatIo {
  readonly isTty = true
  columns = 80
  rows = 24
  commits: string[] = []
  frames: Array<{ lines: string[]; cursor: { row: number; col: number } }> = []
  private keyHandler: ((input: string, key: Key) => void) | null = null
  private resizeHandler: (() => void) | null = null
  started = false
  stopped = false

  size(): { columns: number; rows: number } {
    return { columns: this.columns, rows: this.rows }
  }

  commit(text: string): void {
    this.commits.push(text)
  }

  redraw(frame: { lines: string[]; cursor: { row: number; col: number } }): void {
    this.frames.push(frame)
  }

  onKey(handler: (input: string, key: Key) => void): void {
    this.keyHandler = handler
  }

  onResize(handler: () => void): void {
    this.resizeHandler = handler
  }

  start(): void {
    this.started = true
  }

  stop(): void {
    this.stopped = true
  }

  // Scripting helpers
  press(name: string, opts: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {}): void {
    if (!this.keyHandler) throw new Error('no key handler registered')
    const key: Key = { name, ...opts }
    this.keyHandler('', key)
  }

  type(text: string): void {
    if (!this.keyHandler) throw new Error('no key handler registered')
    for (const char of text) {
      this.keyHandler(char, { name: char })
    }
  }

  send(text: string): void {
    this.type(text)
    this.press('return')
  }

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.resizeHandler?.()
  }
}
