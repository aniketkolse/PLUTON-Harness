import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { ConfigError } from '../domain/errors.ts'
import { findProjectRoot, loadConfig } from '../config/load.ts'
import type { ProjectContext } from '../orchestrator/service.ts'

export type { ProjectContext }

export function requireProject(cwd: string, configPath?: string): ProjectContext {
  const resolvedConfig = configPath ?? process.env.PLUTON_CONFIG
  const root = resolvedConfig ? findProjectRootFromFile(resolvedConfig) : findProjectRoot(cwd)
  if (!root) {
    throw new ConfigError(
      `no pluton.yaml found in ${cwd} or any parent directory — run \`pluton init\` to create one`,
    )
  }
  const loaded = loadConfig(root)
  return { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
}

export function optionalProject(cwd: string, configPath?: string): ProjectContext | null {
  const resolvedConfig = configPath ?? process.env.PLUTON_CONFIG
  const root = resolvedConfig ? findProjectRootFromFile(resolvedConfig) : findProjectRoot(cwd)
  if (!root) return null
  const loaded = loadConfig(root)
  return { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
}

/** Resolve the project root from an explicit config file path (the file's directory). */
function findProjectRootFromFile(configPath: string): string | null {
  if (!existsSync(configPath)) return null
  return dirname(configPath)
}
