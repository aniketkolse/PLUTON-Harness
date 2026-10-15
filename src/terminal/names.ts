import { createHash } from 'node:crypto'
import { ValidationError } from '../domain/errors.ts'
import { isId, shortId, slugify } from '../domain/ids.ts'

/**
 * tmux naming rules (ADR-0005). Session/window names are produced ONLY by the
 * helpers below and re-validated at every manager entry point — callers can
 * never smuggle a target-syntax metacharacter (`:`, `.`, `$`, prefixes) into a
 * tmux invocation. Names are deterministic so a crashed runtime can recompute
 * them, and they carry the muse/task id tail for per-project uniqueness.
 */

export const TMUX_NAME_MAX = 64
export const TMUX_SESSION_PREFIX = 'pluton_'
export const TMUX_SHELL_WINDOW = 'shell'

/** tmux target grammar treats `:` and `.` as separators; we allow nothing near them. */
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

const PROJECT_PART_MAX = 40
const MUSE_PART_MAX = 12

export type TmuxNameKind = 'session' | 'window'

export function assertSafeTmuxName(kind: TmuxNameKind, name: string): string {
  if (!SAFE_NAME_RE.test(name) || name.length > TMUX_NAME_MAX) {
    throw new ValidationError(
      `unsafe tmux ${kind} name '${name}': names must match ${String(SAFE_NAME_RE)} and be at most ${TMUX_NAME_MAX} chars`,
    )
  }
  return name
}

/**
 * Deterministic, collision-resistant cap: when a slug is truncated we append a
 * short hash of the full input, so two long names sharing a prefix can never
 * collapse into the same tmux name.
 */
function capSlug(s: string, max: number): string {
  if (s.length <= max) return s
  const hash = createHash('sha1').update(s).digest('hex').slice(0, 6)
  return `${s.slice(0, max - 7).replace(/-+$/, '')}-${hash}`
}

/** `pluton_<project>_<muse-tail>` — stable for a given project/muse pair. */
export function tmuxSessionName(projectName: string, museId: string): string {
  const project = capSlug(slugify(projectName), PROJECT_PART_MAX)
  const muse = capSlug(isId(museId) ? shortId(museId) : slugify(museId), MUSE_PART_MAX)
  return assertSafeTmuxName('session', `${TMUX_SESSION_PREFIX}${project}_${muse}`)
}

/** One window per task: `task-<id tail>` — stable for a given task id. */
export function taskWindowName(taskId: string): string {
  const token = isId(taskId) ? shortId(taskId) : capSlug(slugify(taskId), 12)
  return assertSafeTmuxName('window', `task-${token}`)
}

/** Parse `tmux list-windows -F '#{window_name}'` output (one name per line). */
export function parseWindowList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0)
}
