import { TerminalUnavailableError, ValidationError } from '../domain/errors.ts'
import { firstLine, run, type RunOptions, type RunResult } from '../util/exec.ts'
import { assertSafeTmuxName, parseWindowIdList, parseWindowList } from './names.ts'
import {
  type TerminalCaptureOptions,
  type TerminalEnsureOptions,
  type TerminalEnsureResult,
  type TerminalFailureReason,
  type TerminalKillOutcome,
  type TerminalManager,
} from './types.ts'

export const TMUX_NOT_INSTALLED_FIX =
  'install tmux (e.g. apt install tmux, brew install tmux, or choco install tmux)'

export type NativeTerminalRunFn = (argv: string[], options?: RunOptions) => Promise<RunResult>

export interface NativeTerminalManagerOptions {
  tmuxBin?: string
  runFn?: NativeTerminalRunFn
}

const EXEC_TIMEOUT_MS = 15_000
const HISTORY_LIMIT = 20_000
const DEFAULT_CAPTURE_LINES = 200
const MAX_CAPTURE_LINES = 5_000

const ABSENT_SESSION_RE = /no server running|can't find session|error connecting to/i
const ABSENT_WINDOW_RE = /can't find (window|session)|no server running|error connecting to/i
const DUPLICATE_SESSION_RE = /duplicate session/i
const TMUX_NOT_INSTALLED_RE =
  /executable file not found|not found in \$PATH|no such file or directory|command not found|is not recognized|cannot find/i

interface TmuxContext {
  containerName: string
  sessionName: string
  windowName?: string
}

function isTmuxNotInstalled(r: RunResult): boolean {
  if (r.timedOut) return false
  if (r.exitCode === 127 || r.exitCode === 9009) return true
  const stderr = r.stderr.trim()
  if (r.exitCode === null && /ENOENT/i.test(stderr)) return true
  if (/ENOENT/i.test(stderr) && /tmux/i.test(stderr)) return true
  if (TMUX_NOT_INSTALLED_RE.test(stderr) && (/tmux/i.test(stderr) || /ENOENT/i.test(stderr) || r.exitCode === null)) {
    return true
  }
  return false
}

function classifyFailure(r: RunResult, ctx: TmuxContext): TerminalUnavailableError {
  const stderr = r.stderr.trim()
  let reason: TerminalFailureReason = 'exec_failed'
  let fix: string | undefined
  if (r.timedOut) {
    reason = 'timeout'
    fix = 'the host tmux command timed out; check system load and re-run'
  } else if (isTmuxNotInstalled(r)) {
    reason = 'tmux_not_installed'
    fix = TMUX_NOT_INSTALLED_FIX
  }
  const detail = r.timedOut ? `timed out after ${EXEC_TIMEOUT_MS}ms` : firstLine(stderr, 300)
  return new TerminalUnavailableError(
    `tmux ${reason.replaceAll('_', ' ')} for session '${ctx.sessionName}'` +
      (ctx.windowName ? ` window '${ctx.windowName}'` : '') +
      ` on host: ${detail || `exit ${String(r.exitCode)}`}`,
    {
      details: { reason, ...ctx, exitCode: r.exitCode, stderr: stderr.slice(0, 2_000) },
      fix,
    },
  )
}

function windowIdNumber(id: string): number {
  return Number.parseInt(id.slice(1), 10)
}

export class NativeTerminalManager implements TerminalManager {
  private readonly runFn: NativeTerminalRunFn
  private readonly tmuxBin: string

  constructor(opts: NativeTerminalManagerOptions = {}) {
    this.runFn = opts.runFn ?? run
    this.tmuxBin = opts.tmuxBin ?? 'tmux'
  }

  private exec(args: string[], options: { cwd?: string } = {}): Promise<RunResult> {
    return this.runFn([this.tmuxBin, ...args], {
      timeoutMs: EXEC_TIMEOUT_MS,
      cwd: options.cwd,
    })
  }

  private sessionTarget(sessionName: string): string {
    return `=${sessionName}`
  }

  private windowTarget(sessionName: string, windowName: string): string {
    return `=${sessionName}:=${windowName}`
  }

  async sessionExists(containerName: string, sessionName: string): Promise<boolean> {
    assertSafeTmuxName('session', sessionName)
    const r = await this.exec(['has-session', '-t', this.sessionTarget(sessionName)])
    if (r.exitCode === 0 && !r.timedOut) return true
    if (!r.timedOut && ABSENT_SESSION_RE.test(r.stderr)) return false
    throw classifyFailure(r, { containerName, sessionName })
  }

  async ensureSession(
    containerName: string,
    sessionName: string,
    options: TerminalEnsureOptions = {},
  ): Promise<TerminalEnsureResult> {
    assertSafeTmuxName('session', sessionName)
    let created = false
    if (!(await this.sessionExists(containerName, sessionName))) {
      const args = ['new-session', '-d', '-s', sessionName, '-n', 'shell']
      if (options.cwd !== undefined) args.push('-c', options.cwd)
      const r = await this.exec(args)
      if (r.exitCode !== 0 || r.timedOut) {
        if (!r.timedOut && DUPLICATE_SESSION_RE.test(r.stderr)) created = false
        else throw classifyFailure(r, { containerName, sessionName })
      } else {
        created = true
      }
    }
    for (const argv of [
      ['set-option', '-g', 'history-limit', String(HISTORY_LIMIT)],
      ['set-window-option', '-g', 'automatic-rename', 'off'],
      ['set-window-option', '-g', 'allow-rename', 'off'],
    ]) {
      const opt = await this.exec(argv)
      if (opt.exitCode !== 0 || opt.timedOut) throw classifyFailure(opt, { containerName, sessionName })
    }
    return { created }
  }

  async listWindows(containerName: string, sessionName: string): Promise<string[]> {
    assertSafeTmuxName('session', sessionName)
    const r = await this.exec(['list-windows', '-t', this.sessionTarget(sessionName), '-F', '#{window_name}'])
    if (r.exitCode === 0 && !r.timedOut) return parseWindowList(r.stdout)
    if (!r.timedOut && ABSENT_SESSION_RE.test(r.stderr)) {
      throw new TerminalUnavailableError(
        `tmux session '${sessionName}' does not exist on host`,
        {
          details: { reason: 'session_missing', containerName, sessionName },
          fix: 're-create it with `pluton attach` or start a run',
        },
      )
    }
    throw classifyFailure(r, { containerName, sessionName })
  }

  async ensureWindow(
    containerName: string,
    sessionName: string,
    windowName: string,
    options: TerminalEnsureOptions = {},
  ): Promise<TerminalEnsureResult> {
    assertSafeTmuxName('session', sessionName)
    assertSafeTmuxName('window', windowName)
    const windows = await this.listWindows(containerName, sessionName)
    if (windows.includes(windowName)) return { created: false }
    const args = [
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{window_id}',
      '-t',
      this.sessionTarget(sessionName),
      '-n',
      windowName,
    ]
    if (options.cwd !== undefined) args.push('-c', options.cwd)
    const r = await this.exec(args)
    if (r.exitCode !== 0 || r.timedOut) throw classifyFailure(r, { containerName, sessionName, windowName })
    const newId = r.stdout.trim()
    if (newId === '') {
      throw new TerminalUnavailableError(
        `tmux new-window for '${windowName}' returned no window id on host`,
        { details: { reason: 'exec_failed', containerName, sessionName, windowName } },
      )
    }
    const after = await this.exec([
      'list-windows',
      '-t',
      this.sessionTarget(sessionName),
      '-F',
      '#{window_id}:#{window_name}',
    ])
    if (after.exitCode !== 0 || after.timedOut) throw classifyFailure(after, { containerName, sessionName, windowName })
    const entries = parseWindowIdList(after.stdout)
    const mine = entries.find((w) => w.id === newId)
    if (mine === undefined) return { created: false }
    const sameName = entries.filter((w) => w.name === windowName)
    if (sameName.length > 1) {
      const winner = sameName.reduce((a, b) => (windowIdNumber(a.id) <= windowIdNumber(b.id) ? a : b))
      if (winner.id !== newId) {
        const k = await this.exec(['kill-window', '-t', newId])
        if (k.exitCode !== 0 && !k.timedOut && !ABSENT_WINDOW_RE.test(k.stderr)) {
          throw classifyFailure(k, { containerName, sessionName, windowName })
        }
        return { created: false }
      }
    }
    return { created: true }
  }

  async capturePane(
    containerName: string,
    sessionName: string,
    windowName: string,
    options: TerminalCaptureOptions = {},
  ): Promise<string> {
    assertSafeTmuxName('session', sessionName)
    assertSafeTmuxName('window', windowName)
    const lines = options.lines ?? DEFAULT_CAPTURE_LINES
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES) {
      throw new ValidationError(`capturePane lines must be an integer in 1..${MAX_CAPTURE_LINES}, got ${String(lines)}`)
    }
    const r = await this.exec([
      'capture-pane',
      '-p',
      '-t',
      this.windowTarget(sessionName, windowName),
      '-S',
      `-${String(lines)}`,
    ])
    if (r.exitCode === 0 && !r.timedOut) return r.stdout
    if (!r.timedOut && /can't find window/i.test(r.stderr)) {
      const windows = await this.listWindows(containerName, sessionName)
      const matches = windows.filter((w) => w === windowName).length
      if (matches > 1) {
        throw new TerminalUnavailableError(
          `tmux window name '${windowName}' is ambiguous in session '${sessionName}': ${String(matches)} windows share it on host`,
          {
            details: { reason: 'window_ambiguous', containerName, sessionName, windowName, matches },
            fix: 'identify and kill the duplicates by window id (`tmux kill-window -t @N`)',
          },
        )
      }
      throw new TerminalUnavailableError(
        `tmux window '${windowName}' does not exist in session '${sessionName}' on host`,
        { details: { reason: 'window_missing', containerName, sessionName, windowName } },
      )
    }
    if (!r.timedOut && ABSENT_SESSION_RE.test(r.stderr)) {
      throw new TerminalUnavailableError(
        `tmux session '${sessionName}' does not exist on host`,
        { details: { reason: 'session_missing', containerName, sessionName, windowName } },
      )
    }
    throw classifyFailure(r, { containerName, sessionName, windowName })
  }

  async killWindow(containerName: string, sessionName: string, windowName: string): Promise<TerminalKillOutcome> {
    assertSafeTmuxName('session', sessionName)
    assertSafeTmuxName('window', windowName)
    const r = await this.exec(['kill-window', '-t', this.windowTarget(sessionName, windowName)])
    if (r.exitCode === 0 && !r.timedOut) return 'killed'
    if (!r.timedOut && ABSENT_WINDOW_RE.test(r.stderr)) {
      return (await this.windowNameCount(containerName, sessionName, windowName)) > 1 ? 'ambiguous' : 'absent'
    }
    throw classifyFailure(r, { containerName, sessionName, windowName })
  }

  private async windowNameCount(containerName: string, sessionName: string, windowName: string): Promise<number> {
    const r = await this.exec(['list-windows', '-t', this.sessionTarget(sessionName), '-F', '#{window_name}'])
    if (r.exitCode !== 0 || r.timedOut) return 0
    return parseWindowList(r.stdout).filter((w) => w === windowName).length
  }
}
