import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml, parseDocument } from 'yaml'
import { bootstrapStore } from '../bootstrap.ts'
import { loadConfig, validateConfig } from '../config/load.ts'
import { NotFoundError, ValidationError } from '../domain/errors.ts'
import { findProjectEntry, getProjectRegistry, renameProjectEntry } from './registry.ts'
import type { ProjectRegistryEntry } from './types.ts'

export { renameProjectEntry } from './registry.ts'

/**
 * Rename a project's operator-visible identity without moving it.
 *
 * Three durable sources must agree, and the filesystem path is identity:
 *   1. `pluton.yaml` `project.name` (YAML document edit, comments preserved)
 *   2. SQLite `projects.name`
 *   3. `~/.pluton/projects.json` entry `name`/`slug`
 *
 * The complete resulting config is validated before any write, so a rejected
 * name never leaves a half-renamed project behind.
 */
export function renameProjectIdentity(
  rootDir: string,
  newName: string,
  customHome?: string,
): ProjectRegistryEntry {
  const trimmed = newName.trim()
  if (trimmed === '') throw new ValidationError('project name must not be empty')

  const resolvedRoot = realpathSync.native(resolve(rootDir))
  const loaded = loadConfig(resolvedRoot)

  const doc = parseDocument(readFileSync(loaded.configPath, 'utf8'))
  doc.setIn(['project', 'name'], trimmed)
  const nextRaw = parseYaml(doc.toString())
  const next = validateConfig(nextRaw, loaded.rootDir, loaded.configPath)

  // Fail before writing if the project was never registered: the registry has
  // no row to update, so the rename cannot be completed.
  const registryEntry = findProjectEntry(resolvedRoot, getProjectRegistry(customHome))
  if (!registryEntry) throw new NotFoundError('project', resolvedRoot)

  writeFileSync(loaded.configPath, doc.toString({ lineWidth: 0 }), 'utf8')

  const { store, projectId } = bootstrapStore(next)
  try {
    store.renameProject(projectId, trimmed)
  } finally {
    store.close()
  }

  return renameProjectEntry(projectId, trimmed, customHome)
}
