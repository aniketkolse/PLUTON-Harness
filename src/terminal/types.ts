/**
 * Terminal contract (ADR-0005). Terminals are tmux sessions inside the Ship
 * container, driven through the SandboxManager — never through a host shell and
 * never on the Windows host natively (no tl;dr tmux for Windows exists here).
 *
 * Terminal lifecycle is deliberately decoupled from task lifecycle: closing a
 * window or detaching a session never fails or completes a task.
 */

export interface TerminalEnsureOptions {
  /** Working directory inside the container (created by tmux if needed). */
  cwd?: string
}

export interface TerminalCaptureOptions {
  /**
   * Scrollback lines to capture (`capture-pane -S -<lines>`), 1..5000.
   * Default 200 — bounded on purpose; callers increase it explicitly.
   */
  lines?: number
}

export interface TerminalEnsureResult {
  /** True when THIS call created the session/window; false when it already existed. */
  created: boolean
}

export type TerminalKillOutcome = 'killed' | 'absent' | 'ambiguous'

/** Machine-readable reasons carried in TerminalUnavailableError.details. */
export type TerminalFailureReason =
  | 'tmux_missing'
  | 'tmux_not_installed'
  | 'container_missing'
  | 'session_missing'
  | 'window_missing'
  | 'window_ambiguous'
  | 'timeout'
  | 'exec_failed'

export interface TerminalManager {
  /** Idempotent: creates the session (with a `shell` window) if missing. */
  ensureSession(containerName: string, sessionName: string, options?: TerminalEnsureOptions): Promise<TerminalEnsureResult>
  /** Honest probe: true/false; throws TerminalUnavailableError when tmux/container is broken. */
  sessionExists(containerName: string, sessionName: string): Promise<boolean>
  /** Idempotent per (session, window); the session must already exist. */
  ensureWindow(
    containerName: string,
    sessionName: string,
    windowName: string,
    options?: TerminalEnsureOptions,
  ): Promise<TerminalEnsureResult>
  listWindows(containerName: string, sessionName: string): Promise<string[]>
  /** Plain-text pane snapshot; throws with reason 'window_missing' if it is gone. */
  capturePane(containerName: string, sessionName: string, windowName: string, options?: TerminalCaptureOptions): Promise<string>
  /** Idempotent cleanup: 'absent' when the window/session is already gone. */
  killWindow(containerName: string, sessionName: string, windowName: string): Promise<TerminalKillOutcome>
}

export const TMUX_MISSING_FIX =
  'the Ship container image must contain tmux — rebuild it with `pluton sandbox build-image`, then re-run `pluton doctor`'
