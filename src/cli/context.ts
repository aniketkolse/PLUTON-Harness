import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { ConfigError } from '../domain/errors.ts'
import { loadConfig } from '../config/load.ts'
import { resolveProjectContext } from '../projects/resolution.ts'
import type { ProjectContext } from '../orchestrator/service.ts'

export type { ProjectContext }

export function requireProject(cwd: string, explicitIdOrConfigPath?: string): ProjectContext {
  const explicit = explicitIdOrConfigPath ?? process.env.PLUTON_PROJECT
  const resolvedConfig = explicitIdOrConfigPath ?? process.env.PLUTON_CONFIG
  if (resolvedConfig && (resolvedConfig.endsWith('.yaml') || resolvedConfig.endsWith('.yml'))) {
    const root = findProjectRootFromFile(resolvedConfig)
    if (!root) {
      throw new ConfigError(`config file '${resolvedConfig}' not found`)
    }
    const loaded = loadConfig(root)
    return { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
  }

  const resolved = resolveProjectContext(cwd, explicit)
  const loaded = loadConfig(resolved.rootDir)
  return { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
}

export function optionalProject(cwd: string, explicitIdOrConfigPath?: string): ProjectContext | null {
  try {
    return requireProject(cwd, explicitIdOrConfigPath)
  } catch {
    return null
  }
}

/** Resolve the project root from an explicit config file path (the file's directory). */
function findProjectRootFromFile(configPath: string): string | null {
  if (!existsSync(configPath)) return null
  return dirname(configPath)
}
