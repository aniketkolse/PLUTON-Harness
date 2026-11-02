import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { findProjectRoot } from '../config/load.ts'
import { NotFoundError, PlutonError } from '../domain/errors.ts'
import {
  findProjectEntry,
  getActiveProjectId,
  getProjectRegistry,
  registerProject,
} from './registry.ts'
import type { ResolvedProjectContext } from './types.ts'

export class ProjectRequiredError extends PlutonError {
  constructor(message = 'no active project found — select a project with `pluton project switch <id>` or run from inside a project directory with pluton.yaml') {
    super('not_found', message)
    this.name = 'ProjectRequiredError'
  }
}

/**
 * Resolves the target project context using Pluton's 4-tier hybrid resolution strategy:
 * 1. Explicit project ID, slug, or path argument (`--project <id>`)
 * 2. Current working directory if inside a registered PLUTON project
 * 3. Global active project (`~/.pluton/active-project`)
 * 4. Fails closed with `ProjectRequiredError` (or auto-registers if CWD contains a fresh pluton.yaml and no active project exists)
 */
export function resolveProjectContext(
  cwd: string,
  explicitIdOrPath?: string,
  customHome?: string,
): ResolvedProjectContext {
  const reg = getProjectRegistry(customHome)

  // 1. Explicit project argument
  if (explicitIdOrPath && explicitIdOrPath.trim() !== '') {
    const query = explicitIdOrPath.trim()
    const found = findProjectEntry(query, reg)
    if (found) {
      if (!existsSync(found.rootDir)) {
        throw new NotFoundError(
          'project directory',
          `${found.name} (${found.id}) at '${found.rootDir}' does not exist on disk; remove with \`pluton project remove ${found.id}\``,
        )
      }
      return {
        id: found.id,
        name: found.name,
        rootDir: found.rootDir,
        configPath: found.configPath,
        defaultBranch: found.defaultBranch,
        source: 'explicit',
      }
    }

    // Check if the query is a direct directory path containing pluton.yaml
    const potentialRoot = findProjectRoot(query)
    if (potentialRoot && existsSync(potentialRoot)) {
      const entry = registerProject(potentialRoot, customHome)
      return {
        id: entry.id,
        name: entry.name,
        rootDir: entry.rootDir,
        configPath: entry.configPath,
        defaultBranch: entry.defaultBranch,
        source: 'explicit',
      }
    }

    throw new NotFoundError('project', query)
  }

  // 2. Current working directory if inside a REGISTERED PLUTON project
  const cwdRoot = findProjectRoot(cwd)
  if (cwdRoot && existsSync(cwdRoot)) {
    const canonicalCwd = realpathSync.native(resolve(cwdRoot))
    const registered = findProjectEntry(canonicalCwd, reg)
    if (registered && existsSync(registered.rootDir)) {
      return {
        id: registered.id,
        name: registered.name,
        rootDir: registered.rootDir,
        configPath: registered.configPath,
        defaultBranch: registered.defaultBranch,
        source: 'cwd',
      }
    }
  }

  // 3. Global active project if current directory is not inside a registered project
  const activeId = getActiveProjectId(customHome)
  if (activeId && reg.projects[activeId]) {
    const activeEntry = reg.projects[activeId]!
    if (existsSync(activeEntry.rootDir)) {
      return {
        id: activeEntry.id,
        name: activeEntry.name,
        rootDir: activeEntry.rootDir,
        configPath: activeEntry.configPath,
        defaultBranch: activeEntry.defaultBranch,
        source: 'global-active',
      }
    }
  }

  // If CWD has a pluton.yaml and no registered/active project was selected, auto-register CWD
  if (cwdRoot && existsSync(cwdRoot)) {
    const canonicalCwd = realpathSync.native(resolve(cwdRoot))
    const userHome = homedir()
    // Do not auto-register user home directory as a project unless CWD was literally the user home
    if (canonicalCwd !== userHome || resolve(cwd) === userHome) {
      const entry = registerProject(canonicalCwd, customHome)
      return {
        id: entry.id,
        name: entry.name,
        rootDir: entry.rootDir,
        configPath: entry.configPath,
        defaultBranch: entry.defaultBranch,
        source: 'cwd',
      }
    }
  }

  // 4. No project found
  throw new ProjectRequiredError()
}
