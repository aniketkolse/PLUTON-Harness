import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Shared path-identity helpers for security boundaries.
 *
 * A lexical `relative()` check is not enough on Windows or macOS:
 * - Win32 strips trailing dots/spaces (`.git.` → `.git`) and resolves 8.3
 *   aliases (`PROGRA~1`), so those names can reach a different directory than
 *   the string suggests;
 * - NTFS/APFS/HFS+ are case-insensitive by default, so `.GIT` is `.git`;
 * - a junction/symlink inside the workspace can point anywhere on the host.
 *
 * These helpers make the platform semantics explicit instead of relying on the
 * host filesystem to reject the surprising spelling.
 */

/** Workspace segments that hold Pluton state, Git metadata or dependencies. */
export const PROTECTED_WORKSPACE_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  '.pluton',
  'node_modules',
])

export function caseInsensitivePlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

export function foldPath(path: string, platform: NodeJS.Platform): string {
  return caseInsensitivePlatform(platform) ? path.toLowerCase() : path
}

/** Return the normalized spelling used to compare one path segment. */
export function normalizedPathSegment(segment: string, platform: NodeJS.Platform): string {
  const stripped = platform === 'win32' ? segment.replace(/[. ]+$/, '') : segment
  return caseInsensitivePlatform(platform) ? stripped.toLowerCase() : stripped
}

/** First protected segment in a workspace-relative path, or null. */
export function protectedWorkspaceSegment(
  relativePath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const segment of relativePath.split(/[\\/]+/)) {
    if (segment.length === 0) continue
    if (PROTECTED_WORKSPACE_SEGMENTS.has(normalizedPathSegment(segment, platform))) return segment
  }
  return null
}

/** First segment from `reserved` that matches under the platform's rules. */
export function reservedPathSegment(
  relativePath: string,
  reserved: ReadonlySet<string>,
  platform: NodeJS.Platform,
): string | null {
  for (const segment of relativePath.split(/[\\/]+/)) {
    if (segment.length === 0) continue
    if (reserved.has(normalizedPathSegment(segment, platform))) return segment
  }
  return null
}

/**
 * Win32 collapses trailing dots and spaces in every component. A path that
 * contains one is never safe to compare as text: `.git.` and `.git ` both open
 * `.git`. Reject instead of trying to normalize the alias away.
 */
export function unstableWindowsSegment(path: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32') return null
  for (const segment of path.split(/[\\/]+/)) {
    if (segment.length === 0) continue
    if (/^[A-Za-z]:$/.test(segment)) continue
    if (/[. ]$/.test(segment)) return segment
  }
  return null
}

/**
 * Win32 short names (`PLUTON~1`, `PROGRA~1`) can alias a long directory. The
 * alias mapping depends on the volume, so it cannot be evaluated lexically;
 * refuse any tilde-number component rather than guess what it resolves to.
 */
export function shortNameAliasSegment(path: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32') return null
  for (const segment of path.split(/[\\/]+/)) {
    if (segment.length === 0) continue
    if (/~\d+/.test(segment)) return segment
  }
  return null
}

export type PathContainmentProblem =
  | 'control-character'
  | 'unstable-segment'
  | 'short-name-alias'
  | 'outside'

export interface PathContainmentResult {
  ok: boolean
  /** Canonical absolute path when `ok`. */
  path: string | null
  /** Canonical absolute root used for comparison when `ok`. */
  root: string | null
  problem: PathContainmentProblem | null
  /** The offending component for unstable/short-name findings. */
  segment: string | null
}

function failure(
  problem: PathContainmentProblem,
  segment: string | null = null,
): PathContainmentResult {
  return { ok: false, path: null, root: null, problem, segment }
}

/** True when `candidate` is `root` or below it under platform semantics. */
export function isPathInside(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const rel = relative(foldPath(root, platform), foldPath(candidate, platform))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../')
}

/** Platform-aware relative path with forward slashes (safe for display/match). */
export function relativeWithin(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return relative(foldPath(root, platform), foldPath(candidate, platform))
    .split(sep)
    .join('/')
}

/**
 * Canonicalize the longest existing prefix of `absolute` with realpath, then
 * re-append the missing tail. This catches a junction/symlink ancestor even
 * when the leaf being written does not exist yet.
 */
function canonicalizeExistingPrefix(absolute: string): string {
  const tail: string[] = []
  let current = absolute
  for (let depth = 0; depth < 128; depth += 1) {
    try {
      const real = realpathSync.native(current)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.unshift(basename(current))
      current = parent
    }
  }
  return absolute
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Resolve `candidate` (absolute or relative to `root`) and prove that both its
 * lexical and canonical forms are contained in `root`.
 *
 * Returns the canonical path so callers never re-resolve the raw input after a
 * security decision.
 */
export function canonicalizePathWithin(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): PathContainmentResult {
  if (candidate.includes('\0') || /[\u0000-\u001f]/.test(candidate)) {
    return failure('control-character')
  }
  const rootResolved = resolve(root)
  const candidateResolved = resolve(rootResolved, candidate)

  const unstable = unstableWindowsSegment(candidateResolved, platform)
  if (unstable !== null) return failure('unstable-segment', unstable)
  const shortName = shortNameAliasSegment(candidateResolved, platform)
  if (shortName !== null) return failure('short-name-alias', shortName)

  if (!isPathInside(rootResolved, candidateResolved, platform)) return failure('outside')

  const canonicalRoot = realpathOrResolved(rootResolved)
  const canonicalCandidate = canonicalizeExistingPrefix(candidateResolved)
  if (!isPathInside(canonicalRoot, canonicalCandidate, platform)) return failure('outside')

  return { ok: true, path: canonicalCandidate, root: canonicalRoot, problem: null, segment: null }
}
