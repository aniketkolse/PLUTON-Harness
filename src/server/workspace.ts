/**
 * Session workspace resolution (ADR-0014 extension).
 *
 * A chat session owns an absolute workspace root. Sessions created before the
 * v9 migration inherit the server project root; new sessions persist their own
 * root. Every consumer (file APIs, engine workdir, tool bridge, native
 * provider) resolves through this module so there is exactly one containment
 * rule and no path is trusted purely because a client sent it.
 */

import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { ValidationError } from '../domain/errors.ts'

export interface ResolvedWorkspace {
  /** Canonical absolute path (symlinks/junctions resolved). */
  rootDir: string
  /** Display name (the directory's basename). */
  name: string
  /** True when the session overrides the server project root. */
  sessionScoped: boolean
}

/**
 * Validate an operator-selected directory. Rejects relative paths, missing
 * paths, files, and unreadable directories with an explicit reason. Returns
 * the canonical path so later containment checks cannot be bypassed by a
 * symlink swapped in after validation.
 */
export function resolveWorkspaceRoot(candidate: string): string {
  const trimmed = candidate.trim()
  if (trimmed === '') {
    throw new ValidationError('workspace path is required')
  }
  if (!isAbsolute(trimmed)) {
    throw new ValidationError(`workspace path must be absolute: ${trimmed}`)
  }
  const absolute = resolve(trimmed)
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    throw new ValidationError(`workspace folder does not exist: ${absolute}`)
  }
  if (!stat.isDirectory()) {
    throw new ValidationError(`workspace path is not a directory: ${absolute}`)
  }
  let canonical: string
  try {
    canonical = realpathSync.native(absolute)
  } catch {
    throw new ValidationError(`workspace folder cannot be resolved: ${absolute}`)
  }
  try {
    accessSync(canonical, constants.R_OK | constants.X_OK)
  } catch {
    throw new ValidationError(`workspace folder is not readable: ${canonical}`)
  }
  return canonical
}

export function describeWorkspace(rootDir: string, projectRoot: string): ResolvedWorkspace {
  return {
    rootDir,
    name: basename(rootDir) || rootDir,
    sessionScoped: rootDir !== resolve(projectRoot),
  }
}
