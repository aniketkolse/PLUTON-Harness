import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from '../../src/tui/terminal.ts'
import { InternalError } from '../../src/domain/errors.ts'

class FakeStdout extends EventEmitter {
  columns = 80
  rows = 24
  isTTY = true
  written = ''

  write(chunk: string): boolean {
    this.written += chunk
    return true
  }

  clear(): void {
    this.written = ''
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true
  rawMode = false

  setRawMode(mode: boolean): this {
    this.rawMode = mode
    return this
  }

  pause(): this {
    return this
  }

  resume(): this {
    return this
  }
}

describe('TerminalHost', () => {
  let stdin: FakeStdin
  let stdout: FakeStdout
  let host: TerminalHost

  beforeEach(() => {
    vi.useFakeTimers()
    stdin = new FakeStdin()
    stdout = new FakeStdout()
    host = new TerminalHost({
      stdin: stdin as any,
      stdout: stdout as any,
      throttleMs: 33,
    })
  })

  afterEach(() => {
    host.stop()
    vi.useRealTimers()
  })

  it('first redraw writes lines without cursor-up and parks cursor', () => {
    host.redraw({
      lines: ['status line', 'input prompt'],
      cursor: { row: 1, col: 2 },
    })
    vi.advanceTimersByTime(33)

    // First redraw: liveRows was 0 -> no cursor up
    // Lines: 'status line\ninput prompt'
    // Parking at row 1 (bottom line of 2 lines: lines.length - 1 = 1, so row === 1 -> no up)
    // col 2 -> \r\x1b[2C
    expect(stdout.written).toBe('status line\ninput prompt\r\x1b[2C')
  })

  it('second redraw moves up rows-1, clears down, writes new frame, and parks cursor', () => {
    // Frame 1: 3 lines
    host.redraw({
      lines: ['line 1', 'line 2', 'line 3'],
      cursor: { row: 2, col: 0 },
    })
    vi.advanceTimersByTime(33)
    stdout.clear()

    // Frame 2: 2 lines, cursor parked at row 0, col 5
    host.redraw({
      lines: ['new line 1', 'new line 2'],
      cursor: { row: 0, col: 5 },
    })
    vi.advanceTimersByTime(33)

    // liveRows was 3 (> 1) -> moves up 2 rows: \x1b[2A
    // then \r\x1b[J (clear down)
    // then new frame: 'new line 1\nnew line 2'
    // then park: \r\x1b[1A\x1b[5C (up 1 row to reach row 0, right 5 cols)
    expect(stdout.written).toBe(
      '\x1b[2A\r\x1b[J' + 'new line 1\nnew line 2' + '\r\x1b[1A\x1b[5C',
    )
  })

  it('commit writes text with newline when liveRows is 0', () => {
    host.commit('finalized block')
    expect(stdout.written).toBe('finalized block\n')
  })

  it('commit throws InternalError when liveRows > 0', () => {
    host.redraw({
      lines: ['active status'],
      cursor: { row: 0, col: 0 },
    })
    vi.advanceTimersByTime(33)

    expect(() => host.commit('another block')).toThrow(InternalError)
    expect(() => host.commit('another block')).toThrow(/live region/)
  })

  it('coalesces multiple redraw calls within throttleMs to the latest frame', () => {
    host.redraw({ lines: ['frame 1'], cursor: { row: 0, col: 0 } })
    host.redraw({ lines: ['frame 2'], cursor: { row: 0, col: 0 } })
    host.redraw({ lines: ['frame 3'], cursor: { row: 0, col: 0 } })

    expect(stdout.written).toBe('') // nothing written yet before timer

    vi.advanceTimersByTime(33)
    // Only frame 3 should have been rendered!
    expect(stdout.written).toBe('frame 3\r')
  })

  it('start enables raw mode and bracketed paste; stop restores them and shows cursor', () => {
    host.start()
    expect(stdin.rawMode).toBe(true)
    expect(stdout.written).toContain('\x1b[?2004h') // bracketed paste on

    stdout.clear()
    const pauseSpy = vi.spyOn(stdin, 'pause')
    host.stop()
    expect(pauseSpy).toHaveBeenCalled()
    expect(stdin.rawMode).toBe(false)
    expect(stdout.written).toContain('\x1b[?2004l') // bracketed paste off
    expect(stdout.written).toContain('\x1b[?25h') // show cursor
  })

  it('dispatches resize events to onResize listeners', () => {
    let resized = 0
    host.onResize(() => {
      resized++
    })
    host.start()

    stdout.emit('resize')
    expect(resized).toBe(1)
  })

  it('returns terminal dimensions via size()', () => {
    stdout.columns = 120
    stdout.rows = 40
    expect(host.size()).toEqual({ columns: 120, rows: 40 })
  })

  it('tracks parked cursor row correctly when clearing multi-line frames with elevated cursor', () => {
    host.start()
    stdout.clear()

    // Frame 1: 3 lines, cursor on row 0 (top line)
    host.redraw({
      lines: ['line 0', 'line 1', 'line 2'],
      cursor: { row: 0, col: 0 },
    })
    vi.advanceTimersByTime(50)

    // Verify frame 1 parked cursor at row 0 (moved up 2 from bottom)
    expect(stdout.written).toContain('\x1b[2A')

    stdout.clear()

    // Frame 2: subsequent redraw must move up by parkedRow (0), NOT liveRows - 1 (2)
    host.redraw({
      lines: ['line 0 modified', 'line 1', 'line 2'],
      cursor: { row: 0, col: 0 },
    })
    vi.advanceTimersByTime(50)

    // The clear sequence should NOT move up 2A since cursor was already parked on row 0
    expect(stdout.written).not.toContain('\x1b[2A\r\x1b[J')
    expect(stdout.written).toContain('\r\x1b[J')
  })

  it('enters and leaves alternate screen when alternateScreen is true', () => {
    const altHost = new TerminalHost({
      stdin: stdin as any,
      stdout: stdout as any,
      alternateScreen: true,
    })
    altHost.start()
    expect(stdout.written).toContain('\x1b[?1049h')
    stdout.clear()

    altHost.stop()
    expect(stdout.written).toContain('\x1b[?1049l')
  })

  it('alternate screen mode: redraw renders absolute full-screen frame from home position', () => {
    const altStdout = new FakeStdout()
    const altStdin = new FakeStdin()
    const altHost = new TerminalHost({
      stdin: altStdin as any,
      stdout: altStdout as any,
      alternateScreen: true,
      throttleMs: 10,
    })

    altHost.start()
    altStdout.clear()

    altHost.redraw({
      lines: ['HEADER', 'CHAT BODY', 'FOOTER'],
      cursor: { row: 1, col: 5 },
    })
    vi.advanceTimersByTime(10)

    // Hidden cursor -> home -> content \r\n -> clear below -> cursor at (2, 6) -> show cursor
    expect(altStdout.written).toContain('\x1b[?25l\x1b[H')
    expect(altStdout.written).toContain('HEADER\r\nCHAT BODY\r\nFOOTER\x1b[J')
    expect(altStdout.written).toContain('\x1b[2;6H\x1b[?25h')

    // Commit does not write raw text to stdout in alt-screen mode
    altStdout.clear()
    altHost.commit('should not write raw text')
    expect(altStdout.written).toBe('')

    altHost.stop()
  })
})
