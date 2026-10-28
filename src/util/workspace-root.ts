/**
 * Workspace root validation shared by the server and import paths.
 *
 * Imports must never persist an unchecked absolute path from another machine:
 * a foreign path either does not exist (every prompt fails) or happens to
 * exist and points the engine at an unrelated directory. Callers that restore
 * from another host pass an explicit local override.
 */

import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { ValidationError } from '../domain/errors.ts'

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
