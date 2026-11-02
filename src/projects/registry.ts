import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig } from '../config/load.ts'
import { bootstrapStore } from '../bootstrap.ts'
import { NotFoundError, ValidationError } from '../domain/errors.ts'
import { slugify } from '../domain/ids.ts'
import type { ProjectRegistry, ProjectRegistryEntry } from './types.ts'

export type { ProjectRegistry, ProjectRegistryEntry } from './types.ts'

export function plutonHomeDir(customHome?: string): string {
  if (customHome) return resolve(customHome)
  if (process.env.PLUTON_HOME) return resolve(process.env.PLUTON_HOME)
  return join(homedir(), '.pluton')
}

function projectsFilePath(home: string): string {
  return join(home, 'projects.json')
}

function activeProjectFilePath(home: string): string {
  return join(home, 'active-project')
}

function atomicWriteFile(filePath: string, content: string): void {
  const dir = resolve(filePath, '..')
  mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmpPath, content, 'utf8')
  renameSync(tmpPath, filePath)
}

export function getProjectRegistry(customHome?: string): ProjectRegistry {
  const home = plutonHomeDir(customHome)
  const file = projectsFilePath(home)
  if (!existsSync(file)) {
    return { version: 1, activeProjectId: null, projects: {} }
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProjectRegistry>
    if (raw && typeof raw === 'object' && raw.version === 1 && typeof raw.projects === 'object' && raw.projects !== null) {
      return {
        version: 1,
        activeProjectId: typeof raw.activeProjectId === 'string' ? raw.activeProjectId : null,
        projects: raw.projects as Record<string, ProjectRegistryEntry>,
      }
    }
  } catch {
    // If corrupted, fallback gracefully
  }
  return { version: 1, activeProjectId: null, projects: {} }
}

function saveRegistry(reg: ProjectRegistry, home: string): void {
  atomicWriteFile(projectsFilePath(home), JSON.stringify(reg, null, 2))
  if (reg.activeProjectId) {
    atomicWriteFile(activeProjectFilePath(home), reg.activeProjectId + '\n')
  } else {
    const activeFile = activeProjectFilePath(home)
    if (existsSync(activeFile)) {
      try {
        unlinkSync(activeFile)
      } catch {
        // Tolerated
      }
    }
  }
}

export function registerProject(rootDir: string, customHome?: string): ProjectRegistryEntry {
  const home = plutonHomeDir(customHome)
  const canonicalRoot = realpathSync.native(resolve(rootDir))
  const loaded = loadConfig(canonicalRoot)
  const { store, projectId } = bootstrapStore(loaded)
  store.close()

  const now = new Date().toISOString()
  const slug = slugify(loaded.config.project.name || projectId)

  const reg = getProjectRegistry(home)
  const existing = reg.projects[projectId]

  const entry: ProjectRegistryEntry = {
    id: projectId,
    name: loaded.config.project.name,
    slug,
    rootDir: canonicalRoot,
    configPath: loaded.configPath,
    defaultBranch: loaded.config.project.default_branch,
    registeredAt: existing ? existing.registeredAt : now,
    lastOpenedAt: now,
  }

  reg.projects[projectId] = entry
  if (!reg.activeProjectId || !reg.projects[reg.activeProjectId]) {
    reg.activeProjectId = projectId
  }

  saveRegistry(reg, home)
  return entry
}

export function findProjectEntry(query: string, reg: ProjectRegistry): ProjectRegistryEntry | null {
  const trimmed = query.trim()
  if (!trimmed) return null

  // Match by canonical ID
  if (reg.projects[trimmed]) return reg.projects[trimmed]!

  // Match by slug (case-insensitive)
  const lowerQuery = trimmed.toLowerCase()
  for (const entry of Object.values(reg.projects)) {
    if (entry.slug.toLowerCase() === lowerQuery) return entry
  }

  // Match by name (case-insensitive)
  for (const entry of Object.values(reg.projects)) {
    if (entry.name.toLowerCase() === lowerQuery) return entry
  }

  // Match by normalized root path
  try {
    const canon = realpathSync.native(resolve(trimmed))
    for (const entry of Object.values(reg.projects)) {
      if (entry.rootDir === canon) return entry
    }
  } catch {
    // If not a path, ignore
  }

  return null
}

export function setActiveProject(projectIdOrSlug: string, customHome?: string): ProjectRegistryEntry {
  const home = plutonHomeDir(customHome)
  const reg = getProjectRegistry(home)
  const entry = findProjectEntry(projectIdOrSlug, reg)
  if (!entry) {
    throw new NotFoundError('project', projectIdOrSlug)
  }

  entry.lastOpenedAt = new Date().toISOString()
  reg.activeProjectId = entry.id
  saveRegistry(reg, home)
  return entry
}

export function getActiveProjectId(customHome?: string): string | null {
  const home = plutonHomeDir(customHome)
  const reg = getProjectRegistry(home)
  if (!reg.activeProjectId) return null
  if (!reg.projects[reg.activeProjectId]) return null
  return reg.activeProjectId
}

export function unregisterProject(projectIdOrSlug: string, customHome?: string): boolean {
  const home = plutonHomeDir(customHome)
  const reg = getProjectRegistry(home)
  const entry = findProjectEntry(projectIdOrSlug, reg)
  if (!entry) return false

  delete reg.projects[entry.id]
  if (reg.activeProjectId === entry.id) {
    const remaining = Object.keys(reg.projects)
    reg.activeProjectId = remaining.length > 0 ? remaining[0]! : null
  }

  saveRegistry(reg, home)
  return true
}
