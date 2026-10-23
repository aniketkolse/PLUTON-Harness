import { InternalError, TerminalUnavailableError, ValidationError } from '../domain/errors.ts'
import { firstLine, type RunResult } from '../util/exec.ts'
import type { SandboxExecOptions, SandboxManager } from '../sandbox/types.ts'
import { assertSafeTmuxName, parseWindowIdList, parseWindowList } from './names.ts'
import {
  TMUX_MISSING_FIX,
  type TerminalCaptureOptions,
  type TerminalEnsureOptions,
  type TerminalEnsureResult,
  type TerminalFailureReason,
  type TerminalKillOutcome,
  type TerminalManager,
} from './types.ts'

/**
 * tmux driver (ADR-0005): every operation is `sandbox.exec(container, ['tmux', ...])`
 * — an argv array, never a shell string — inside the Ship container. The tmux
 * server lives inside the container and dies with it: terminals are convenience
 * sessions for humans, NOT the managed engine transport and NOT a sandbox.
 *
 * Failure classification is explicit (see TerminalFailureReason): "tmux is not
 * installed" is a different, fixable gap from "the window is gone", and both
 * are different from "the container no longer exists".
 */

const EXEC_TIMEOUT_MS = 15_000
const HISTORY_LIMIT = 20_000
const DEFAULT_CAPTURE_LINES = 200
const MAX_CAPTURE_LINES = 5_000

const ABSENT_SESSION_RE = /no server running|can't find session|error connecting to/i
const ABSENT_WINDOW_RE = /can't find (window|session)|no server running|error connecting to/i
const DUPLICATE_SESSION_RE = /duplicate session/i
const CONTAINER_MISSING_RE = /no such container|can't find container/i
const TMUX_MISSING_RE = /executable file not found|not found in \$PATH|no such file or directory/i

interface TmuxContext {
  containerName: string
  sessionName: string
  windowName?: string
}

/**
 * Map a failed `docker exec tmux ...` result to a typed, honest error. Called
 * only for results that are NOT an expected "absent" answer.
 */
function classifyFailure(r: RunResult, ctx: TmuxContext): TerminalUnavailableError {
  const stderr = r.stderr.trim()
  let reason: TerminalFailureReason = 'exec_failed'
  let fix: string | undefined
  if (r.timedOut) {
    reason = 'timeout'
    fix = 'the container may be overloaded or unresponsive; check `docker stats` and re-run'
  } else if (CONTAINER_MISSING_RE.test(stderr)) {
    reason = 'container_missing'
    fix = 're-create the Ship container (`pluton ship start <ship>`); its container no longer exists'
  } else if (TMUX_MISSING_RE.test(stderr) && /tmux/i.test(stderr)) {
    reason = 'tmux_missing'
    fix = TMUX_MISSING_FIX
  }
  const detail = r.timedOut ? `timed out after ${EXEC_TIMEOUT_MS}ms` : firstLine(stderr, 300)
  return new TerminalUnavailableError(
    `tmux ${reason.replaceAll('_', ' ')} for session '${ctx.sessionName}'` +
      (ctx.windowName ? ` window '${ctx.windowName}'` : '') +
      ` in container '${ctx.containerName}': ${detail || `exit ${String(r.exitCode)}`}`,
    {
      details: { reason, ...ctx, exitCode: r.exitCode, stderr: stderr.slice(0, 2_000) },
      fix,
    },
  )
}

/** tmux window ids are `@N`; compare numerically so `@10` sorts after `@9`. */
function windowIdNumber(id: string): number {
  return Number.parseInt(id.slice(1), 10)
}

export class TmuxTerminalManager implements TerminalManager {
  private readonly sandbox: SandboxManager
  private readonly tmuxBin: string

  constructor(sandbox: SandboxManager, tmuxBin = 'tmux') {
    this.sandbox = sandbox
    this.tmuxBin = tmuxBin
  }

  private exec(containerName: string, args: string[]): Promise<RunResult> {
    const options: SandboxExecOptions = { timeoutMs: EXEC_TIMEOUT_MS }
    return this.sandbox.exec(containerName, [this.tmuxBin, ...args], options)
  }

  /** `=name` forces exact session matching so prefix names can never alias. */
  private sessionTarget(sessionName: string): string {
    return `=${sessionName}`
  }

  private windowTarget(sessionName: string, windowName: string): string {
    return `=${sessionName}:=${windowName}`
  }

  async sessionExists(containerName: string, sessionName: string): Promise<boolean> {
    assertSafeTmuxName('session', sessionName)
    const r = await this.exec(containerName, ['has-session', '-t', this.sessionTarget(sessionName)])
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
      const r = await this.exec(containerName, args)
      if (r.exitCode !== 0 || r.timedOut) {
        // Another Pluton process may have created the session between our check
        // and this call; that is success for an idempotent ensure, not an error.
        if (!r.timedOut && DUPLICATE_SESSION_RE.test(r.stderr)) created = false
        else throw classifyFailure(r, { containerName, sessionName })
      } else {
        created = true
      }
    }
    // Server-wide safety defaults, re-asserted on EVERY ensure (idempotent and
    // cheap): window names are targets, not labels, so automatic/escape-driven
    // renaming must stay off even for a session this call did not create — e.g.
    // one created by hand or by a run that crashed before applying the options.
    for (const argv of [
      ['set-option', '-g', 'history-limit', String(HISTORY_LIMIT)],
      ['set-window-option', '-g', 'automatic-rename', 'off'],
      ['set-window-option', '-g', 'allow-rename', 'off'],
    ]) {
      const opt = await this.exec(containerName, argv)
      if (opt.exitCode !== 0 || opt.timedOut) throw classifyFailure(opt, { containerName, sessionName })
    }
    return { created }
  }

  async listWindows(containerName: string, sessionName: string): Promise<string[]> {
    assertSafeTmuxName('session', sessionName)
    const r = await this.exec(containerName, ['list-windows', '-t', this.sessionTarget(sessionName), '-F', '#{window_name}'])
    if (r.exitCode === 0 && !r.timedOut) return parseWindowList(r.stdout)
    if (!r.timedOut && ABSENT_SESSION_RE.test(r.stderr)) {
      throw new TerminalUnavailableError(
        `tmux session '${sessionName}' does not exist in container '${containerName}'`,
        {
          details: { reason: 'session_missing', containerName, sessionName },
          fix: 're-create it with `pluton ship start` or the next task dispatch',
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
    const r = await this.exec(containerName, args)
    if (r.exitCode !== 0 || r.timedOut) throw classifyFailure(r, { containerName, sessionName, windowName })
    const newId = r.stdout.trim()
    if (newId === '') {
      throw new TerminalUnavailableError(
        `tmux new-window for '${windowName}' returned no window id (container '${containerName}')`,
        { details: { reason: 'exec_failed', containerName, sessionName, windowName } },
      )
    }
    // tmux does NOT enforce unique window names, and an ambiguous name target
    // fails exactly like a missing one ("can't find window") — so after creating,
    // verify this is the only window with the name. On a duplicate race the
    // lowest window id wins deterministically (exactly one caller reports
    // created:true) and the loser kills its own window BY ID, which is always
    // unambiguous — no unkellable-by-name duplicates can survive an ensure.
    const after = await this.exec(containerName, [
      'list-windows',
      '-t',
      this.sessionTarget(sessionName),
      '-F',
      '#{window_id}:#{window_name}',
    ])
    if (after.exitCode !== 0 || after.timedOut) throw classifyFailure(after, { containerName, sessionName, windowName })
    const entries = parseWindowIdList(after.stdout)
    const mine = entries.find((w) => w.id === newId)
    if (mine === undefined) return { created: false } // a concurrent cleaner removed it first
    const sameName = entries.filter((w) => w.name === windowName)
    if (sameName.length > 1) {
      const winner = sameName.reduce((a, b) => (windowIdNumber(a.id) <= windowIdNumber(b.id) ? a : b))
      if (winner.id !== newId) {
        const k = await this.exec(containerName, ['kill-window', '-t', newId])
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
    const r = await this.exec(containerName, [
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
          `tmux window name '${windowName}' is ambiguous in session '${sessionName}': ${String(matches)} windows share it (container '${containerName}')`,
          {
            details: { reason: 'window_ambiguous', containerName, sessionName, windowName, matches },
            fix: 'identify and kill the duplicates by window id (`tmux kill-window -t @N` inside the container) — Pluton never creates duplicate window names, so these came from outside Pluton',
          },
        )
      }
      throw new TerminalUnavailableError(
        `tmux window '${windowName}' does not exist in session '${sessionName}' (container '${containerName}')`,
        { details: { reason: 'window_missing', containerName, sessionName, windowName } },
      )
    }
    if (!r.timedOut && ABSENT_SESSION_RE.test(r.stderr)) {
      throw new TerminalUnavailableError(
        `tmux session '${sessionName}' does not exist in container '${containerName}'`,
        { details: { reason: 'session_missing', containerName, sessionName, windowName } },
      )
    }
    throw classifyFailure(r, { containerName, sessionName, windowName })
  }

  async killWindow(containerName: string, sessionName: string, windowName: string): Promise<TerminalKillOutcome> {
    assertSafeTmuxName('session', sessionName)
    assertSafeTmuxName('window', windowName)
    const r = await this.exec(containerName, ['kill-window', '-t', this.windowTarget(sessionName, windowName)])
    if (r.exitCode === 0 && !r.timedOut) return 'killed'
    if (!r.timedOut && ABSENT_WINDOW_RE.test(r.stderr)) {
      // An ambiguous name fails like a missing one; distinguish them honestly so
      // callers never hear "already gone" while two windows still share the name.
      return (await this.windowNameCount(containerName, sessionName, windowName)) > 1 ? 'ambiguous' : 'absent'
    }
    throw classifyFailure(r, { containerName, sessionName, windowName })
  }

  /** Non-throwing duplicate probe for the idempotent kill path (session-gone → 0). */
  private async windowNameCount(containerName: string, sessionName: string, windowName: string): Promise<number> {
    const r = await this.exec(containerName, [
      'list-windows',
      '-t',
      this.sessionTarget(sessionName),
      '-F',
      '#{window_name}',
    ])
    if (r.exitCode !== 0 || r.timedOut) return 0
    return parseWindowList(r.stdout).filter((w) => w === windowName).length
  }
}

/** Guard used by callers that construct a manager from config; keeps the type honest. */
export function assertTerminalManager(value: unknown): asserts value is TerminalManager {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as TerminalManager).ensureSession !== 'function' ||
    typeof (value as TerminalManager).capturePane !== 'function'
  ) {
    throw new InternalError('value is not a TerminalManager')
  }
}
