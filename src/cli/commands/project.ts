import { resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { findProjectRoot } from '../../config/load.ts'
import { NotFoundError } from '../../domain/errors.ts'
import {
  findProjectEntry,
  getActiveProjectId,
  getProjectRegistry,
  registerProject,
  setActiveProject,
  unregisterProject,
} from '../../projects/registry.ts'
import { renameProjectIdentity } from '../../projects/rename.ts'
import { resolveProjectContext } from '../../projects/resolution.ts'
import type { ProjectRegistryEntry, ResolvedProjectContext } from '../../projects/types.ts'

export interface ProjectListOptions {
  json?: boolean
}

export interface ProjectListItem extends ProjectRegistryEntry {
  isActive: boolean
  isCwd: boolean
  accessible: boolean
}

export interface ProjectListResult {
  ok: true
  activeProjectId: string | null
  projects: ProjectListItem[]
}

export function projectList(
  cwd: string,
  _opts: ProjectListOptions = {},
  customHome?: string,
): ProjectListResult {
  const reg = getProjectRegistry(customHome)
  const activeId = getActiveProjectId(customHome)

  let cwdRoot: string | null = null
  const potentialRoot = findProjectRoot(cwd)
  if (potentialRoot && existsSync(potentialRoot)) {
    cwdRoot = realpathSync.native(resolve(potentialRoot))
  }

  const items: ProjectListItem[] = Object.values(reg.projects).map((entry) => ({
    ...entry,
    isActive: entry.id === activeId,
    isCwd: cwdRoot !== null && entry.rootDir === cwdRoot,
    accessible: existsSync(entry.rootDir),
  }))

  return {
    ok: true,
    activeProjectId: activeId,
    projects: items,
  }
}

export function formatProjectListHuman(res: ProjectListResult): string {
  if (res.projects.length === 0) {
    return 'No projects registered. Run `pluton project add <path>` or run inside a directory with pluton.yaml.'
  }
  const lines: string[] = ['Registered Pluton Projects:']
  for (const p of res.projects) {
    const markers: string[] = []
    if (p.isActive) markers.push('active')
    if (p.isCwd) markers.push('cwd')
    if (!p.accessible) markers.push('missing directory')
    const markerStr = markers.length > 0 ? ` (${markers.join(', ')})` : ''
    lines.push(`  * ${p.name} [${p.id}]${markerStr}\n      path: ${p.rootDir}\n      branch: ${p.defaultBranch}`)
  }
  return lines.join('\n')
}

export function projectSwitch(
  projectIdOrSlug: string,
  customHome?: string,
): ProjectRegistryEntry {
  return setActiveProject(projectIdOrSlug, customHome)
}

export function projectCurrent(
  cwd: string,
  explicitIdOrPath?: string,
  customHome?: string,
): ResolvedProjectContext {
  return resolveProjectContext(cwd, explicitIdOrPath, customHome)
}

export function formatProjectCurrentHuman(resolved: ResolvedProjectContext): string {
  return `Active Project: ${resolved.name} [${resolved.id}]\n  Source: ${resolved.source}\n  Root: ${resolved.rootDir}\n  Branch: ${resolved.defaultBranch}`
}

export function projectAdd(
  dirPath: string,
  customHome?: string,
): ProjectRegistryEntry {
  const canonical = existsSync(dirPath) ? realpathSync.native(resolve(dirPath)) : resolve(dirPath)
  if (!existsSync(canonical)) {
    throw new NotFoundError('project directory', dirPath)
  }
  return registerProject(canonical, customHome)
}

export function projectRemove(
  projectIdOrSlug: string,
  customHome?: string,
): { ok: true; removed: boolean } {
  const removed = unregisterProject(projectIdOrSlug, customHome)
  if (!removed) {
    throw new NotFoundError('project', projectIdOrSlug)
  }
  return { ok: true, removed: true }
}

export function projectRename(
  projectIdOrSlug: string,
  newName: string,
  customHome?: string,
): ProjectRegistryEntry {
  const reg = getProjectRegistry(customHome)
  const entry = findProjectEntry(projectIdOrSlug, reg)
  if (!entry) {
    throw new NotFoundError('project', projectIdOrSlug)
  }
  return renameProjectIdentity(entry.rootDir, newName, customHome)
}
