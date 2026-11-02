import { existsSync } from 'node:fs'
import { bootstrapStore } from '../bootstrap.ts'
import { loadConfig, type LoadedConfig } from '../config/load.ts'
import { NotFoundError } from '../domain/errors.ts'
import { isTerminalRunState } from '../domain/state.ts'
import type { Store } from '../store/store.ts'
import { getProjectRegistry, registerProject } from '../projects/registry.ts'
import { renameProjectIdentity } from '../projects/rename.ts'
import type { ProjectRegistryEntry } from '../projects/types.ts'
import { ServerEventBroadcaster } from './events.ts'
import { ServerLogWatcher } from './log-watcher.ts'
import type { RouteContext } from './routes.ts'

export interface ProjectContextItem {
  id: string
  name: string
  rootDir: string
  configPath: string
  loaded: LoadedConfig
  store: Store
  broadcaster: ServerEventBroadcaster
  logWatcher: ServerLogWatcher
}

export interface ProjectSummaryItem extends ProjectRegistryEntry {
  isActive: boolean
  activeRunsCount: number
}

export interface ProjectContextPoolOptions {
  initialStore: Store
  initialProjectId: string
  initialLoaded: LoadedConfig
  customHome?: string
  logWatcherIntervalMs?: number
  pickFolderFn?: RouteContext['pickFolderFn']
}

export class ProjectContextPool {
  private readonly items = new Map<string, ProjectContextItem>()
  private readonly customHome?: string
  private readonly defaultProjectId: string
  private readonly logWatcherIntervalMs?: number
  private readonly pickFolderFn?: RouteContext['pickFolderFn']

  constructor(options: ProjectContextPoolOptions) {
    this.customHome = options.customHome
    this.defaultProjectId = options.initialProjectId
    this.logWatcherIntervalMs = options.logWatcherIntervalMs
    this.pickFolderFn = options.pickFolderFn

    // Initialize default project context
    const broadcaster = new ServerEventBroadcaster(15000, options.initialStore, options.initialProjectId)
    const logWatcher = new ServerLogWatcher({
      store: options.initialStore,
      projectId: options.initialProjectId,
      broadcaster,
      ...(this.logWatcherIntervalMs !== undefined ? { pollIntervalMs: this.logWatcherIntervalMs } : {}),
    })
    logWatcher.start()

    this.items.set(options.initialProjectId, {
      id: options.initialProjectId,
      name: options.initialLoaded.config.project.name,
      rootDir: options.initialLoaded.rootDir,
      configPath: options.initialLoaded.configPath,
      loaded: options.initialLoaded,
      store: options.initialStore,
      broadcaster,
      logWatcher,
    })
  }

  getDefaultProjectId(): string {
    return this.defaultProjectId
  }

  resolveContext(projectIdOrSlug?: string): ProjectContextItem {
    if (!projectIdOrSlug) {
      const defaultItem = this.items.get(this.defaultProjectId)
      if (!defaultItem) {
        throw new NotFoundError('project', this.defaultProjectId)
      }
      return defaultItem
    }

    const query = projectIdOrSlug.trim()
    // 1. Check if already active in cache
    for (const item of this.items.values()) {
      if (item.id === query || item.name.toLowerCase() === query.toLowerCase()) {
        return item
      }
    }

    // 2. Look up in project registry
    const reg = getProjectRegistry(this.customHome)
    let foundEntry: ProjectRegistryEntry | null = null
    if (reg.projects[query]) {
      foundEntry = reg.projects[query]!
    } else {
      const lower = query.toLowerCase()
      for (const entry of Object.values(reg.projects)) {
        if (entry.slug.toLowerCase() === lower || entry.name.toLowerCase() === lower) {
          foundEntry = entry
          break
        }
      }
    }

    if (!foundEntry) {
      throw new NotFoundError('project', query)
    }

    if (!existsSync(foundEntry.rootDir)) {
      throw new NotFoundError('project directory', foundEntry.rootDir)
    }

    // 3. Initialize lazily
    const loaded = loadConfig(foundEntry.rootDir)
    const { store } = bootstrapStore(loaded)
    const broadcaster = new ServerEventBroadcaster(15000, store, foundEntry.id)
    const logWatcher = new ServerLogWatcher({
      store,
      projectId: foundEntry.id,
      broadcaster,
      ...(this.logWatcherIntervalMs !== undefined ? { pollIntervalMs: this.logWatcherIntervalMs } : {}),
    })
    logWatcher.start()

    const item: ProjectContextItem = {
      id: foundEntry.id,
      name: foundEntry.name,
      rootDir: foundEntry.rootDir,
      configPath: foundEntry.configPath,
      loaded,
      store,
      broadcaster,
      logWatcher,
    }

    this.items.set(foundEntry.id, item)
    return item
  }

  listProjects(): ProjectSummaryItem[] {
    const reg = getProjectRegistry(this.customHome)
    const list: ProjectSummaryItem[] = []

    for (const entry of Object.values(reg.projects)) {
      const item = this.items.get(entry.id)
      let activeRunsCount = 0
      if (item) {
        try {
          const runs = item.store.listRuns?.(50) ?? []
          activeRunsCount = runs.filter((r) => !isTerminalRunState(r.state)).length
        } catch {
          // Store query error tolerance
        }
      }
      list.push({
        ...entry,
        isActive: entry.id === this.defaultProjectId,
        activeRunsCount,
      })
    }

    return list
  }

  registerNewProject(dirPath: string): ProjectRegistryEntry {
    return registerProject(dirPath, this.customHome)
  }

  /**
   * Rename a project and refresh the cached context so subsequent
   * `/api/workspace` reads and the SPA header see the new name immediately.
   * The workspace root never changes.
   */
  renameProject(projectIdOrSlug: string, newName: string): ProjectRegistryEntry {
    const item = this.resolveContext(projectIdOrSlug)
    const entry = renameProjectIdentity(item.rootDir, newName, this.customHome)

    item.name = entry.name
    item.loaded = {
      ...item.loaded,
      config: {
        ...item.loaded.config,
        project: {
          ...item.loaded.config.project,
          name: entry.name,
        },
      },
    }
    return entry
  }

  async close(): Promise<void> {
    for (const item of this.items.values()) {
      item.logWatcher.stop()
      try {
        item.store.close()
      } catch {
        // Tolerated on shutdown
      }
    }
    this.items.clear()
  }
}
