import { describe, expect, it } from 'vitest'
import { TerminalUnavailableError, ValidationError } from '../../src/domain/errors.ts'
import {
  attachToMuseTerminal,
  buildAttachArgv,
  inheritStdioSpawn,
  type AttachTarget,
} from '../../src/terminal/attach.ts'
import type {
  TerminalEnsureResult,
  TerminalKillOutcome,
  TerminalManager,
} from '../../src/terminal/types.ts'

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
})

describe('inheritStdioSpawn', () => {
  it('resolves the real child exit code', async () => {
    await expect(inheritStdioSpawn([process.execPath, '-e', 'process.exit(3)'])).resolves.toBe(3)
  })

  it('rejects when the binary cannot be spawned at all', async () => {
    await expect(inheritStdioSpawn(['pluton-definitely-not-a-real-binary'])).rejects.toBeInstanceOf(Error)
  })
})
