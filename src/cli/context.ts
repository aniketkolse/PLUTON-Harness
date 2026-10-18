import { ConfigError } from '../domain/errors.ts'
import { findProjectRoot, loadConfig, type LoadedConfig } from '../config/load.ts'

export interface ProjectContext {
  rootDir: string
  configPath: string
  loaded: LoadedConfig
}

export function requireProject(cwd: string): ProjectContext {
  const root = findProjectRoot(cwd)
  if (!root) {
    throw new ConfigError(
      `no pluton.yaml found in ${cwd} or any parent directory — run \`pluton init\` to create one`,
    )
  }
  const loaded = loadConfig(root)
  return { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
}

export function optionalProject(cwd: string): ProjectContext | null {
  const root = findProjectRoot(cwd)
  if (!root) return null
  const loaded = loadConfig(root)
  return { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
}
