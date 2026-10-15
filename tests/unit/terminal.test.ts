import { describe, expect, it } from 'vitest'
import { TerminalUnavailableError, ValidationError } from '../../src/domain/errors.ts'
import type { RunResult } from '../../src/util/exec.ts'
import { TmuxTerminalManager } from '../../src/terminal/manager.ts'
import {
  assertSafeTmuxName,
  parseWindowList,
  taskWindowName,
  tmuxSessionName,
  TMUX_NAME_MAX,
} from '../../src/terminal/names.ts'
import { failResult, FakeSandbox, okResult } from '../helpers/fake-sandbox.ts'

/**
 * Terminal conformance: every tmux interaction is asserted as an exact argv
 * vector against the FakeSandbox — no container runtime involved. The naming
 * functions are pure and tested for sanitization, stability and uniqueness.
 */

const MUSE_ID = 'muse_00000000abcdef12'
const SESSION = tmuxSessionName('Pluton', MUSE_ID) // pluton_pluton_cdef12
const TASK_ID = 'task_00000000abc123'
const WINDOW = taskWindowName(TASK_ID) // task-abc123
const CONTAINER = 'pluton-pluton-cdef12'

function timedOutResult(): RunResult {
  return { argv: [], exitCode: null, timedOut: true, stdout: '', stderr: '', truncated: false, durationMs: 15_000 }
}

function make(): { sandbox: FakeSandbox; tmux: TmuxTerminalManager } {
  const sandbox = new FakeSandbox()
  return { sandbox, tmux: new TmuxTerminalManager(sandbox) }
}

describe('tmux naming', () => {
  it('derives a deterministic, sanitized session name from project + muse id', () => {
    expect(SESSION).toBe('pluton_pluton_cdef12')
    expect(tmuxSessionName('Pluton', MUSE_ID)).toBe(SESSION)
    // Hostile characters never survive; the result is always a valid name.
    const evil = tmuxSessionName('My Project; rm -rf / :..', MUSE_ID)
    expect(evil).toBe('pluton_my-project-rm-rf_cdef12')
    expect(() => assertSafeTmuxName('session', evil)).not.toThrow()
  })

  it('keeps distinct muses and projects distinct even after length capping', () => {
    const a = 'a'.repeat(40)
    const long1 = tmuxSessionName(`${a}x`, MUSE_ID)
    const long2 = tmuxSessionName(`${a}y`, MUSE_ID)
    expect(long1).not.toBe(long2)
    expect(long1.length).toBeLessThanOrEqual(TMUX_NAME_MAX)
    expect(long2.length).toBeLessThanOrEqual(TMUX_NAME_MAX)
    expect(tmuxSessionName('Pluton', 'muse_00000000abcdef12')).not.toBe(
      tmuxSessionName('Pluton', 'muse_00000000abcdef13'),
    )
  })

  it('derives window names from task ids and hashed fallbacks', () => {
    expect(WINDOW).toBe('task-abc123')
    expect(taskWindowName('build')).toBe('task-build')
    const long1 = taskWindowName('hand written task alpha')
    const long2 = taskWindowName('hand written task beta')
    expect(long1).toMatch(/^task-[a-z0-9]+-[0-9a-f]{6}$/)
    expect(long1).not.toBe(long2)
    // Deterministic: the same input always produces the same targetable name.
    expect(taskWindowName('hand written task alpha')).toBe(long1)
  })

  it('rejects anything that could change tmux target resolution', () => {
    for (const bad of ['evil:target', 'evil.target', 'evil target', 'UPPER', '', ':', '-leading']) {
      expect(() => assertSafeTmuxName('session', bad)).toThrow(ValidationError)
    }
    expect(() => assertSafeTmuxName('window', 'x'.repeat(65))).toThrow(ValidationError)
  })

  it('parses window lists tolerantly (CRLF, blank lines)', () => {
    expect(parseWindowList('shell\r\ntask-x\r\n\r\n')).toEqual(['shell', 'task-x'])
    expect(parseWindowList('')).toEqual([])
  })
})

describe('sessionExists', () => {
  it('reports true with the exact has-session argv', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(okResult([]))
    await expect(tmux.sessionExists(CONTAINER, SESSION)).resolves.toBe(true)
    expect(sandbox.execCalls[0]?.argv).toEqual(['tmux', 'has-session', '-t', `=${SESSION}`])
    expect(sandbox.execCalls[0]?.options.timeoutMs).toBe(15_000)
  })

  it('reports false when no tmux server is running (a legitimate answer)', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(failResult([], 'no server running on /tmp/tmux-10001/default'))
    await expect(tmux.sessionExists(CONTAINER, SESSION)).resolves.toBe(false)
  })

  it('throws a fixable terminal_unavailable when tmux is not installed in the image', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(
      failResult([], 'OCI runtime exec failed: exec: "tmux": executable file not found in $PATH: unknown', 127),
    )
    const err = await tmux.sessionExists(CONTAINER, SESSION).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TerminalUnavailableError)
    expect((err as TerminalUnavailableError).details).toMatchObject({ reason: 'tmux_missing' })
    expect((err as TerminalUnavailableError).message).toContain('build-image')
  })

  it('fails honest (not "false") on an unrecognized tmux failure', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(failResult([], 'some brand new tmux error', 1))
    const err = await tmux.sessionExists(CONTAINER, SESSION).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TerminalUnavailableError)
    expect((err as TerminalUnavailableError).details).toMatchObject({ reason: 'exec_failed' })
  })

  it('classifies docker exec timeouts', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(timedOutResult())
    const err = await tmux.sessionExists(CONTAINER, SESSION).catch((e: unknown) => e)
    expect((err as TerminalUnavailableError).details).toMatchObject({ reason: 'timeout' })
  })
})

describe('ensureSession', () => {
  it('creates the session with a shell window and server-wide safe defaults', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(
      failResult([], 'no server running on /tmp/tmux-10001/default'),
      okResult([]),
      okResult([]),
      okResult([]),
      okResult([]),
    )
    await expect(tmux.ensureSession(CONTAINER, SESSION, { cwd: '/work/task' })).resolves.toEqual({ created: true })
    const argvs = sandbox.execCalls.map((c) => c.argv)
    expect(argvs).toEqual([
      ['tmux', 'has-session', '-t', `=${SESSION}`],
      ['tmux', 'new-session', '-d', '-s', SESSION, '-n', 'shell', '-c', '/work/task'],
      ['tmux', 'set-option', '-g', 'history-limit', '20000'],
      ['tmux', 'set-window-option', '-g', 'automatic-rename', 'off'],
      ['tmux', 'set-window-option', '-g', 'allow-rename', 'off'],
    ])
  })

  it('omits -c when no cwd is given', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(failResult([], 'no server running'), okResult([]), okResult([]), okResult([]), okResult([]))
    await tmux.ensureSession(CONTAINER, SESSION)
    expect(sandbox.execCalls[1]?.argv).toEqual(['tmux', 'new-session', '-d', '-s', SESSION, '-n', 'shell'])
  })

  it('is idempotent: an existing session costs exactly one exec', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(okResult([]))
    await expect(tmux.ensureSession(CONTAINER, SESSION)).resolves.toEqual({ created: false })
    expect(sandbox.calls.length).toBe(1)
  })

  it('treats a duplicate-session race as success (created: false)', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(
      failResult([], 'no server running'),
      failResult([], `duplicate session: ${SESSION}`),
    )
    await expect(tmux.ensureSession(CONTAINER, SESSION)).resolves.toEqual({ created: false })
    expect(sandbox.calls.length).toBe(2)
  })
})

describe('ensureWindow / listWindows', () => {
  it('creates a detached window with the exact argv', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(okResult([], 'shell\n'), okResult([]))
    await expect(tmux.ensureWindow(CONTAINER, SESSION, WINDOW, { cwd: '/work/task' })).resolves.toEqual({
      created: true,
    })
    expect(sandbox.execCalls[0]?.argv).toEqual(['tmux', 'list-windows', '-t', `=${SESSION}`, '-F', '#{window_name}'])
    expect(sandbox.execCalls[1]?.argv).toEqual([
      'tmux',
      'new-window',
      '-d',
      '-t',
      `=${SESSION}`,
      '-n',
      WINDOW,
      '-c',
      '/work/task',
    ])
  })

  it('is idempotent when the window is already present', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(okResult([], `shell\n${WINDOW}\n`))
    await expect(tmux.ensureWindow(CONTAINER, SESSION, WINDOW)).resolves.toEqual({ created: false })
    expect(sandbox.calls.length).toBe(1)
  })

  it('surfaces a missing session as session_missing, never as an empty window list', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(failResult([], `can't find session: ${SESSION}`))
    const err = await tmux.listWindows(CONTAINER, SESSION).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TerminalUnavailableError)
    expect((err as TerminalUnavailableError).details).toMatchObject({ reason: 'session_missing' })
  })

  it('parses listWindows output with CRLF endings', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(okResult([], 'shell\r\ntask-x\r\n'))
    await expect(tmux.listWindows(CONTAINER, SESSION)).resolves.toEqual(['shell', 'task-x'])
  })
})

describe('capturePane', () => {
  it('captures the last N lines with the exact targeting argv', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(okResult([], 'line1\nline2\n'))
    await expect(tmux.capturePane(CONTAINER, SESSION, WINDOW)).resolves.toBe('line1\nline2\n')
    expect(sandbox.execCalls[0]?.argv).toEqual([
      'tmux',
      'capture-pane',
      '-p',
      '-t',
      `=${SESSION}:=${WINDOW}`,
      '-S',
      '-200',
    ])
  })

  it('honors an explicit line bound', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(okResult([], 'x'))
    await tmux.capturePane(CONTAINER, SESSION, WINDOW, { lines: 5_000 })
    expect(sandbox.execCalls[0]?.argv.at(-1)).toBe('-5000')
  })

  it('rejects out-of-range line bounds before executing anything', async () => {
    const { sandbox, tmux } = make()
    await expect(tmux.capturePane(CONTAINER, SESSION, WINDOW, { lines: 0 })).rejects.toThrow(ValidationError)
    await expect(tmux.capturePane(CONTAINER, SESSION, WINDOW, { lines: 5_001 })).rejects.toThrow(ValidationError)
    expect(sandbox.calls.length).toBe(0)
  })

  it('maps a vanished window to window_missing', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(failResult([], `can't find window: ${WINDOW}`))
    const err = await tmux.capturePane(CONTAINER, SESSION, WINDOW).catch((e: unknown) => e)
    expect((err as TerminalUnavailableError).details).toMatchObject({ reason: 'window_missing', windowName: WINDOW })
  })
})

describe('killWindow', () => {
  it('kills with the exact argv', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(okResult([]))
    await expect(tmux.killWindow(CONTAINER, SESSION, WINDOW)).resolves.toBe('killed')
    expect(sandbox.execCalls[0]?.argv).toEqual(['tmux', 'kill-window', '-t', `=${SESSION}:=${WINDOW}`])
  })

  it('is idempotent: an already-gone window is "absent", not an error', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(failResult([], `can't find window: ${WINDOW}`))
    await expect(tmux.killWindow(CONTAINER, SESSION, WINDOW)).resolves.toBe('absent')
  })

  it('reports a deleted container distinctly', async () => {
    const { sandbox, tmux } = make()
    sandbox.execQueue.push(failResult([], `Error response from daemon: No such container: ${CONTAINER}`))
    const err = await tmux.killWindow(CONTAINER, SESSION, WINDOW).catch((e: unknown) => e)
    expect((err as TerminalUnavailableError).details).toMatchObject({ reason: 'container_missing' })
  })
})

describe('name safety at the manager boundary', () => {
  it('refuses unsafe names without executing anything', async () => {
    const { sandbox, tmux } = make()
    await expect(tmux.capturePane(CONTAINER, 'evil:target', WINDOW)).rejects.toThrow(ValidationError)
    await expect(tmux.ensureWindow(CONTAINER, SESSION, 'evil.window')).rejects.toThrow(ValidationError)
    expect(sandbox.calls.length).toBe(0)
  })
})
