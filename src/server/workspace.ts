/**
 * Session workspace resolution (ADR-0014 extension).
 *
 * A chat session owns an absolute workspace root. Sessions created before the
 * v9 migration inherit the server project root; new sessions persist their own
 * root. Every consumer (file APIs, engine workdir, tool bridge, native
 * provider) resolves through this module so there is exactly one containment
 * rule and no path is trusted purely because a client sent it.
 */

import { basename, resolve } from 'node:path'

export { resolveWorkspaceRoot } from '../util/workspace-root.ts'

export interface ResolvedWorkspace {
  /** Canonical absolute path (symlinks/junctions resolved). */
  rootDir: string
  /** Display name (the directory's basename). */
  name: string
  /** True when the session overrides the server project root. */
  sessionScoped: boolean
}

export function describeWorkspace(rootDir: string, projectRoot: string): ResolvedWorkspace {
  return {
    rootDir,
    name: basename(rootDir) || rootDir,
    sessionScoped: rootDir !== resolve(projectRoot),
  }
}
