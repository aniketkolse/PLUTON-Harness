import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ConfigError } from '../domain/errors.ts'
import { CONFIG_VERSION, plutonConfigSchema, type PlutonConfig, type ShipConfig } from './schema.ts'

export const CONFIG_FILENAME = 'pluton.yaml'
export const PLUTON_DIR = '.pluton'

export interface LoadedConfig {
  config: PlutonConfig
  /** Absolute project root that contains pluton.yaml. */
  rootDir: string
  configPath: string
}

/** Walk up from startDir looking for pluton.yaml. Returns null when none found. */
export function findProjectRoot(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return null
    dir = parent
  }
}

export function loadConfig(rootDirOrPath: string): LoadedConfig {
  const isDirectFile =
    rootDirOrPath.endsWith(CONFIG_FILENAME) ||
    (existsSync(rootDirOrPath) && statSync(rootDirOrPath).isFile())
  const configPath = isDirectFile ? resolve(rootDirOrPath) : join(rootDirOrPath, CONFIG_FILENAME)
  const rootDir = isDirectFile ? dirname(resolve(rootDirOrPath)) : resolve(rootDirOrPath)
  if (!existsSync(configPath)) {
    throw new ConfigError(`no ${CONFIG_FILENAME} found in ${rootDirOrPath} — run \`pluton init\` first`)
  }
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(configPath, 'utf8'))
  } catch (e) {
    throw new ConfigError(`could not parse ${configPath}: ${(e as Error).message}`)
  }
  return validateConfig(raw, rootDir, configPath)
}

export function validateConfig(raw: unknown, rootDir: string, configPath: string): LoadedConfig {
  // Fail fast with migration guidance on unknown versions before zod's literal error.
  if (raw && typeof raw === 'object' && 'version' in raw) {
    const v = (raw as { version: unknown }).version
    if (v !== CONFIG_VERSION) {
      throw new ConfigError(
        `unsupported config version ${JSON.stringify(v)} (this build supports version ${CONFIG_VERSION}). ` +
          'Migration guidance: see docs/SHIPS_CONFIGURATION.md#versioning.',
        { details: { found: v, supported: CONFIG_VERSION } },
      )
    }
  }
  const parsed = plutonConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const lines = parsed.error.issues
      .slice(0, 20)
      .map((i) => `  - ${i.path.length > 0 ? i.path.join('.') + ': ' : ''}${i.message}`)
    throw new ConfigError(`invalid ${CONFIG_FILENAME} (${parsed.error.issues.length} issue(s)):\n${lines.join('\n')}`, {
      details: { issues: parsed.error.issues.slice(0, 20) },
    })
  }
  const config = parsed.data
  assertInside(rootDir, config.project.repository, 'project.repository')
  for (const [shipId, ship] of Object.entries(config.ships)) {
    if (ship.instructions_file) {
      assertInside(rootDir, ship.instructions_file, `ships.${shipId}.instructions_file`)
    }
  }
  return { config, rootDir: resolve(rootDir), configPath }
}

/** Reject absolute paths and any path escaping the project root (config is data, not authority). */
export function assertInside(rootDir: string, p: string, what: string): void {
  if (isAbsolute(p)) {
    throw new ConfigError(`${what}: absolute paths are not allowed in config (${p})`)
  }
  const abs = resolve(rootDir, p)
  const rel = relative(rootDir, abs)
  // rel === '' means the path is exactly the project root, which is allowed (e.g. repository: '.').
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new ConfigError(`${what}: path escapes the project root (${p})`)
  }
}

export function shipConfigsSorted(config: PlutonConfig): Array<[string, ShipConfig]> {
  return Object.entries(config.ships).sort(([a], [b]) => a.localeCompare(b))
}

/** @deprecated Use `shipConfigsSorted`; kept for backward compatibility. */
export const museConfigsSorted = shipConfigsSorted

export function findManager(config: PlutonConfig): [string, ShipConfig] | null {
  for (const entry of shipConfigsSorted(config)) {
    if (entry[1].role === 'supervisor') return entry
  }
  return null
}

export function stateDir(rootDir: string): string {
  return join(rootDir, PLUTON_DIR, 'state')
}

export function engineHomesDir(rootDir: string): string {
  return join(rootDir, PLUTON_DIR, 'engine-homes')
}

export function workspaceDir(rootDir: string): string {
  return join(rootDir, PLUTON_DIR, 'workspaces')
}
