/**
 * Terminal host and I/O driver for the Pluton chat TUI (ADR-0012).
 * Owns raw mode, bracketed paste, resize listener, and throttled live-region rendering.
 * Never uses alt-screen, scroll regions, or ESC[6n (Windows-safe).
 */

import readline from 'node:readline'
import { InternalError } from '../domain/errors.ts'
import type { Key } from './keys.ts'

export interface ChatIo {
  readonly isTty: boolean
  size(): { columns: number; rows: number }
  /** Append finalized lines to scrollback. Requires an empty live region (asserted). */
  commit(text: string): void
  /** Replace the live region. `frame.cursor` parks the terminal cursor inside it. */
  redraw(frame: { lines: string[]; cursor: { row: number; col: number } }): void
  onKey(handler: (input: string, key: Key) => void): void
  onResize(handler: () => void): void
  start(): void
  stop(): void
}

export class TerminalHost implements ChatIo {
  readonly isTty: boolean
  private readonly stdin: NodeJS.ReadStream
  private readonly stdout: NodeJS.WriteStream
  private readonly throttleMs: number

  private liveRows = 0
  private pendingFrame: { lines: string[]; cursor: { row: number; col: number } } | null = null
  private throttleTimer: NodeJS.Timeout | null = null
  private started = false

  private readonly keyHandlers: Array<(input: string, key: Key) => void> = []
  private readonly resizeHandlers: Array<() => void> = []

  private keypressListener: ((str: string, key: unknown) => void) | null = null
  private resizeListener: (() => void) | null = null

  constructor(opts: {
    stdin?: NodeJS.ReadStream
    stdout?: NodeJS.WriteStream
    throttleMs?: number
  } = {}) {
    this.stdin = opts.stdin ?? (process.stdin as NodeJS.ReadStream)
    this.stdout = opts.stdout ?? (process.stdout as NodeJS.WriteStream)
    this.throttleMs = opts.throttleMs ?? 33
    this.isTty = Boolean((this.stdin as any)?.isTTY && (this.stdout as any)?.isTTY)
  }

  size(): { columns: number; rows: number } {
    const cols = (this.stdout as any)?.columns
    const r = (this.stdout as any)?.rows
    return {
      columns: typeof cols === 'number' && cols > 0 ? cols : 80,
      rows: typeof r === 'number' && r > 0 ? r : 24,
    }
  }

  commit(text: string): void {
    if (this.liveRows > 0) {
      throw new InternalError('cannot commit to scrollback with active live region (must clear first)')
    }
    this.stdout.write(text + '\n')
  }

  redraw(frame: { lines: string[]; cursor: { row: number; col: number } }): void {
    this.pendingFrame = frame
    if (this.throttleTimer !== null) {
      return
    }
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null
      if (this.pendingFrame !== null) {
        const f = this.pendingFrame
        this.pendingFrame = null
        this.renderFrame(f)
      }
    }, this.throttleMs)
  }

  private renderFrame(frame: { lines: string[]; cursor: { row: number; col: number } }): void {
    let buf = ''
    if (this.liveRows > 0) {
      if (this.liveRows > 1) {
        buf += `\x1b[${this.liveRows - 1}A`
      } else {
        buf += '\r'
      }
      buf += '\r\x1b[J'
    }

    if (frame.lines.length > 0) {
      buf += frame.lines.join('\n')
      buf += '\r'
      if (frame.cursor.row < frame.lines.length - 1) {
        const up = frame.lines.length - 1 - frame.cursor.row
        buf += `\x1b[${up}A`
      }
      if (frame.cursor.col > 0) {
        buf += `\x1b[${frame.cursor.col}C`
      }
    }

    this.liveRows = frame.lines.length
    if (buf) {
      this.stdout.write(buf)
    }
  }

  onKey(handler: (input: string, key: Key) => void): void {
    this.keyHandlers.push(handler)
  }

  onResize(handler: () => void): void {
    this.resizeHandlers.push(handler)
  }

  start(): void {
    if (this.started) return
    this.started = true

    if ((this.stdin as any)?.isTTY && typeof (this.stdin as any).setRawMode === 'function') {
      ;(this.stdin as any).setRawMode(true)
      this.stdin.resume()
    }

    // Bracketed paste ON
    this.stdout.write('\x1b[?2004h')

    // Readline keypress setup
    readline.emitKeypressEvents(this.stdin)
    this.keypressListener = (str: string, rawKey: any) => {
      const normalizedKey: Key = {
        name: rawKey?.name ?? '',
        ctrl: rawKey?.ctrl,
        meta: rawKey?.meta,
        shift: rawKey?.shift,
        sequence: rawKey?.sequence,
      }
      for (const h of this.keyHandlers) {
        h(str ?? '', normalizedKey)
      }
    }
    this.stdin.on('keypress', this.keypressListener)

    this.resizeListener = () => {
      for (const h of this.resizeHandlers) {
        h()
      }
    }
    this.stdout.on('resize', this.resizeListener)
  }

  stop(): void {
    if (!this.started) return
    this.started = false

    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer)
      this.throttleTimer = null
    }
    if (this.pendingFrame !== null) {
      const f = this.pendingFrame
      this.pendingFrame = null
      this.renderFrame(f)
    }

    // Bracketed paste OFF, show cursor
    this.stdout.write('\x1b[?2004l\x1b[?25h')

    if ((this.stdin as any)?.isTTY && typeof (this.stdin as any).setRawMode === 'function') {
      try {
        ;(this.stdin as any).setRawMode(false)
      } catch {
        // ignore
      }
    }

    if (this.keypressListener !== null) {
      this.stdin.removeListener('keypress', this.keypressListener)
      this.keypressListener = null
    }
    if (this.resizeListener !== null) {
      this.stdout.removeListener('resize', this.resizeListener)
      this.resizeListener = null
    }
  }
}
