import { describe, expect, it } from 'vitest'
import { TerminalUnavailableError, ValidationError } from '../../src/domain/errors.ts'
import {
  attachToMuseTerminal,
  buildAttachArgv,
  inheritStdioSpawn,
  type AttachTarget,
} from '../../src/terminal/attach.ts'
import {
  NativeTerminalManager,
  TMUX_NOT_INSTALLED_FIX,
} from '../../src/terminal/native.ts'
import type {
  TerminalEnsureResult,
  TerminalKillOutcome,
  TerminalManager,
} from '../../src/terminal/types.ts'
import type { RunResult } from '../../src/util/exec.ts'

/**
 * Attach core (ADR-0005): the interactive seam is `docker exec -it <container>
 * tmux attach-session` — never a host shell, never a shell string. Every tmux
 * interaction is asserted against a recording manager and the spawned argv is
 * captured verbatim; the plan mode (no spawn fn) still ensures the session.
 */

const CONTAINER = 'pluton-pluton-cdef12'
const SESSION = 'pluton_pluton_cdef12'
const WINDOW = 'task-abc123'
const TARGET: AttachTarget = { containerName: CONTAINER, sessionName: SESSION }

class RecordingTerminalManager implements TerminalManager {
  readonly calls: string[] = []
  ensureSessionResult: TerminalEnsureResult = { created: true }

  async ensureSession(containerName: string, sessionName: string): Promise<TerminalEnsureResult> {
    this.calls.push(`ensureSession:${containerName}:${sessionName}`)
    return this.ensureSessionResult
  }

  async sessionExists(): Promise<boolean> {
    return false
  }

  async ensureWindow(containerName: string, sessionName: string, windowName: string): Promise<TerminalEnsureResult> {
    this.calls.push(`ensureWindow:${containerName}:${sessionName}:${windowName}`)
    return { created: true }
  }

  async listWindows(): Promise<string[]> {
    return []
  }

  async capturePane(): Promise<string> {
    return ''
  }

  async killWindow(): Promise<TerminalKillOutcome> {
    return 'killed'
  }
}

describe('buildAttachArgv', () => {
  it('builds the exact docker exec -it argv for a session target', () => {
    expect(buildAttachArgv(TARGET)).toEqual([
      'docker',
      'exec',
      '-it',
      CONTAINER,
      'tmux',
      'attach-session',
      '-t',
      `=${SESSION}`,
    ])
  })

  it('targets the window exactly when one is named', () => {
    expect(buildAttachArgv({ ...TARGET, windowName: WINDOW })).toEqual([
      'docker',
      'exec',
      '-it',
      CONTAINER,
      'tmux',
      'attach-session',
      '-t',
      `=${SESSION}:=${WINDOW}`,
    ])
  })

  it('refuses unsafe session, window and container names', () => {
    expect(() => buildAttachArgv({ ...TARGET, sessionName: 'evil:target' })).toThrow(ValidationError)
    expect(() => buildAttachArgv({ ...TARGET, windowName: 'evil.window' })).toThrow(ValidationError)
    expect(() => buildAttachArgv({ ...TARGET, containerName: 'Bad Container!' })).toThrow(ValidationError)
    expect(() => buildAttachArgv({ ...TARGET, containerName: '-leading' })).toThrow(ValidationError)
    expect(() => buildAttachArgv({ ...TARGET, containerName: '' })).toThrow(ValidationError)
  })

  it('builds direct tmux attach-session argv on host when sandboxKind is native', () => {
    expect(buildAttachArgv(TARGET, 'native')).toEqual([
      'tmux',
      'attach-session',
      '-t',
      `=${SESSION}`,
    ])
    expect(buildAttachArgv({ ...TARGET, windowName: WINDOW }, 'native')).toEqual([
      'tmux',
      'attach-session',
      '-t',
      `=${SESSION}:=${WINDOW}`,
    ])
  })

  it('builds direct tmux attach-session argv when containerName is host', () => {
    expect(buildAttachArgv({ containerName: 'host', sessionName: SESSION })).toEqual([
      'tmux',
      'attach-session',
      '-t',
      `=${SESSION}`,
    ])
  })
})

describe('attachToMuseTerminal', () => {
  it('refuses local-process configs before touching any manager', async () => {
    const manager = new RecordingTerminalManager()
    const err = await attachToMuseTerminal({ sandboxKind: 'local-process', manager, target: TARGET }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).message).toContain('sandbox.kind: docker')
    expect(manager.calls).toEqual([])
  })

  it('ensures the session, spawns the interactive attach and returns the child exit code', async () => {
    const manager = new RecordingTerminalManager()
    const spawned: string[][] = []
    const outcome = await attachToMuseTerminal({
      sandboxKind: 'docker',
      manager,
      target: TARGET,
      spawnAttach: (argv) => {
        spawned.push(argv)
        return Promise.resolve(7)
      },
    })

    expect(manager.calls).toEqual([`ensureSession:${CONTAINER}:${SESSION}`])
    expect(spawned).toEqual([
      ['docker', 'exec', '-it', CONTAINER, 'tmux', 'attach-session', '-t', `=${SESSION}`],
    ])
    expect(outcome).toEqual({
      containerName: CONTAINER,
      sessionName: SESSION,
      windowName: null,
      sessionCreated: true,
      exitCode: 7,
    })
  })

  it('ensures the window after the session and targets =session:=window', async () => {
    const manager = new RecordingTerminalManager()
    const spawned: string[][] = []
    const outcome = await attachToMuseTerminal({
      sandboxKind: 'docker',
      manager,
      target: { ...TARGET, windowName: WINDOW },
      spawnAttach: (argv) => {
        spawned.push(argv)
        return Promise.resolve(0)
      },
    })

    expect(manager.calls).toEqual([
      `ensureSession:${CONTAINER}:${SESSION}`,
      `ensureWindow:${CONTAINER}:${SESSION}:${WINDOW}`,
    ])
    expect(spawned[0]?.at(-1)).toBe(`=${SESSION}:=${WINDOW}`)
    expect(outcome.windowName).toBe(WINDOW)
    expect(outcome.exitCode).toBe(0)
  })

  it('plan mode (no spawn fn) ensures the session but never spawns', async () => {
    const manager = new RecordingTerminalManager()
    const outcome = await attachToMuseTerminal({ sandboxKind: 'docker', manager, target: TARGET })

    expect(outcome.exitCode).toBeNull()
    expect(manager.calls).toEqual([`ensureSession:${CONTAINER}:${SESSION}`])
  })

  it('maps a spawn failure to a fixable terminal_unavailable', async () => {
    const manager = new RecordingTerminalManager()
    const err = await attachToMuseTerminal({
      sandboxKind: 'docker',
      manager,
      target: TARGET,
      spawnAttach: () => Promise.reject(new Error('spawn docker ENOENT')),
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(TerminalUnavailableError)
    expect((err as TerminalUnavailableError).details).toMatchObject({ reason: 'exec_failed' })
    expect((err as Error).message).toContain('could not start docker exec')
    expect((err as Error).message).toContain('docker version')
  })

  it('supports sandboxKind native in plan mode without Docker', async () => {
    const manager = new RecordingTerminalManager()
    const outcome = await attachToMuseTerminal({
      sandboxKind: 'native',
      manager,
      target: { containerName: 'host', sessionName: SESSION },
    })

    expect(outcome).toEqual({
      containerName: 'host',
      sessionName: SESSION,
      windowName: null,
      sessionCreated: true,
      exitCode: null,
    })
    expect(manager.calls).toEqual([`ensureSession:host:${SESSION}`])
  })

  it('supports sandboxKind native in interactive spawn mode', async () => {
    const manager = new RecordingTerminalManager()
    const spawned: string[][] = []
    const outcome = await attachToMuseTerminal({
      sandboxKind: 'native',
      manager,
      target: { containerName: 'host', sessionName: SESSION, windowName: WINDOW },
      spawnAttach: (argv) => {
        spawned.push(argv)
        return Promise.resolve(0)
      },
    })

    expect(manager.calls).toEqual([
      `ensureSession:host:${SESSION}`,
      `ensureWindow:host:${SESSION}:${WINDOW}`,
    ])
    expect(spawned).toEqual([
      ['tmux', 'attach-session', '-t', `=${SESSION}:=${WINDOW}`],
    ])
    expect(outcome.exitCode).toBe(0)
  })

  it('maps spawn failure in native mode to terminal_unavailable with fix', async () => {
    const manager = new RecordingTerminalManager()
    const err = await attachToMuseTerminal({
      sandboxKind: 'native',
      manager,
      target: { containerName: 'host', sessionName: SESSION },
      spawnAttach: () => Promise.reject(new Error('spawn tmux ENOENT')),
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(TerminalUnavailableError)
    expect((err as TerminalUnavailableError).details).toMatchObject({ reason: 'tmux_not_installed' })
    expect((err as Error).message).toContain('install tmux')
  })
})

function okResult(argv: string[], stdout = ''): RunResult {
  return { argv, exitCode: 0, timedOut: false, stdout, stderr: '', truncated: false, durationMs: 5 }
}

function failResult(argv: string[], stderr: string, exitCode = 1): RunResult {
  return { argv, exitCode, timedOut: false, stdout: '', stderr, truncated: false, durationMs: 5 }
}

describe('NativeTerminalManager', () => {
  it('probes sessionExists and returns true when session is found', async () => {
    const executed: string[][] = []
    const manager = new NativeTerminalManager({
      runFn: (argv) => {
        executed.push(argv)
        return Promise.resolve(okResult(argv))
      },
    })

    const exists = await manager.sessionExists('host', SESSION)
    expect(exists).toBe(true)
    expect(executed).toEqual([['tmux', 'has-session', '-t', `=${SESSION}`]])
  })

  it('returns false when no tmux server is running', async () => {
    const manager = new NativeTerminalManager({
      runFn: (argv) => Promise.resolve(failResult(argv, 'no server running on /tmp/tmux-1000/default')),
    })

    const exists = await manager.sessionExists('host', SESSION)
    expect(exists).toBe(false)
  })

  it('throws TerminalUnavailableError with reason tmux_not_installed when tmux is missing', async () => {
    const manager = new NativeTerminalManager({
      runFn: (argv) => Promise.resolve({
        argv,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: 'spawn tmux ENOENT',
        truncated: false,
        durationMs: 2,
      }),
    })

    const err = await manager.sessionExists('host', SESSION).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TerminalUnavailableError)
    expect((err as TerminalUnavailableError).details).toMatchObject({ reason: 'tmux_not_installed' })
    expect((err as Error).message).toContain(TMUX_NOT_INSTALLED_FIX)
  })

  it('creates session and sets server-wide options on ensureSession', async () => {
    const executed: string[][] = []
    const manager = new NativeTerminalManager({
      runFn: (argv) => {
        executed.push(argv)
        if (argv[1] === 'has-session') return Promise.resolve(failResult(argv, "can't find session"))
        return Promise.resolve(okResult(argv))
      },
    })

    const res = await manager.ensureSession('host', SESSION, { cwd: '/tmp/repo' })
    expect(res).toEqual({ created: true })
    expect(executed).toEqual([
      ['tmux', 'has-session', '-t', `=${SESSION}`],
      ['tmux', 'new-session', '-d', '-s', SESSION, '-n', 'shell', '-c', '/tmp/repo'],
      ['tmux', 'set-option', '-g', 'history-limit', '20000'],
      ['tmux', 'set-window-option', '-g', 'automatic-rename', 'off'],
      ['tmux', 'set-window-option', '-g', 'allow-rename', 'off'],
    ])
  })

  it('creates a new window with ensureWindow', async () => {
    const executed: string[][] = []
    const manager = new NativeTerminalManager({
      runFn: (argv) => {
        executed.push(argv)
        if (argv[1] === 'list-windows') {
          if (argv.at(-1) === '#{window_id}:#{window_name}') {
            return Promise.resolve(okResult(argv, `@1:shell\n@2:${WINDOW}\n`))
          }
          return Promise.resolve(okResult(argv, 'shell\n'))
        }
        if (argv[1] === 'new-window') return Promise.resolve(okResult(argv, '@2\n'))
        return Promise.resolve(okResult(argv))
      },
    })

    const res = await manager.ensureWindow('host', SESSION, WINDOW)
    expect(res).toEqual({ created: true })
    expect(executed.some((c) => c[1] === 'new-window')).toBe(true)
  })

  it('captures pane scrollback with capturePane', async () => {
    const manager = new NativeTerminalManager({
      runFn: (argv) => Promise.resolve(okResult(argv, 'line 1\nline 2\n')),
    })

    const text = await manager.capturePane('host', SESSION, 'shell', { lines: 50 })
    expect(text).toBe('line 1\nline 2\n')
  })

  it('kills window with killWindow', async () => {
    const manager = new NativeTerminalManager({
      runFn: (argv) => Promise.resolve(okResult(argv)),
    })

    const res = await manager.killWindow('host', SESSION, WINDOW)
    expect(res).toBe('killed')
  })
})

describe('inheritStdioSpawn', () => {
  it('resolves the real child exit code', async () => {
    await expect(inheritStdioSpawn([process.execPath, '-e', 'process.exit(3)'])).resolves.toBe(3)
  })

  it('rejects when the binary cannot be spawned at all', async () => {
    await expect(inheritStdioSpawn(['pluton-definitely-not-a-real-binary'])).rejects.toBeInstanceOf(Error)
  })
})
