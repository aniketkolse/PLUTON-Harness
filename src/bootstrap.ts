import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { engineHomesDir, stateDir, type LoadedConfig } from './config/load.ts'
import { slugify } from './domain/ids.ts'
import { openDatabase } from './store/db.ts'
import { migrate } from './store/migrations.ts'
import { Store, type MuseSyncSpec } from './store/store.ts'

/**
 * Opens (creating if needed) the project's durable store:
 * ensure .pluton/state exists → open SQLite → migrate → ensure the project row
 * → mirror the config's muses into the muses table (disabled, not deleted,
 * when they disappear from config).
 *
 * Every CLI command that needs durable state goes through this single path.
 */
export interface Bootstrapped {
  store: Store
  projectId: string
}

export function bootstrapStore(loaded: LoadedConfig): Bootstrapped {
  const dir = stateDir(loaded.rootDir)
  mkdirSync(dir, { recursive: true })
  const db = openDatabase(join(dir, 'pluton.sqlite'))
  try {
    migrate(db)
  } catch (e) {
    db.close()
    throw e
  }
  const store = new Store(db)
  const project = store.ensureProject({
    name: loaded.config.project.name,
    rootPath: loaded.rootDir,
    configPath: loaded.configPath,
    defaultBranch: loaded.config.project.default_branch,
  })
  store.syncMuses(project.id, museSpecs(loaded))
  return { store, projectId: project.id }
}

export function museSpecs(loaded: LoadedConfig): MuseSyncSpec[] {
  return Object.entries(loaded.config.muses).map(([id, m]) => ({
    id,
    slug: slugify(id),
    displayName: m.display_name,
    role: m.role,
    engineKind: m.engine,
    model: m.model,
    instructionsFile: m.instructions_file ?? null,
    workspacePolicy: m.workspace_policy,
    permissions: m.permissions ?? [],
    approvalMode: m.approval_mode,
    engineHome: join(engineHomesDir(loaded.rootDir), id),
  }))
}
