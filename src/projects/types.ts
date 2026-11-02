/**
 * Project registry types for Pluton 4.1 Phase 3.
 */

export interface ProjectRegistryEntry {
  /** Canonical SQLite project ID (e.g. project_xxxx) */
  id: string
  /** Project display name from pluton.yaml */
  name: string
  /** Human-readable slug (e.g. my-app) */
  slug: string
  /** Normalized absolute filesystem path */
  rootDir: string
  /** Normalized absolute path to pluton.yaml */
  configPath: string
  /** Git default branch */
  defaultBranch: string
  /** Registration timestamp in ISO-8601 */
  registeredAt: string
  /** Last opened or activated timestamp in ISO-8601 */
  lastOpenedAt: string
}

export interface ProjectRegistry {
  version: 1
  activeProjectId: string | null
  projects: Record<string, ProjectRegistryEntry>
}

export type ProjectResolutionSource = 'explicit' | 'cwd' | 'global-active'

export interface ResolvedProjectContext {
  id: string
  name: string
  rootDir: string
  configPath: string
  defaultBranch: string
  source: ProjectResolutionSource
}
