import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getProvider,
  hasProviderCredential,
  saveProvider,
  writeProviderCredential,
} from './store.ts'
import {
  isValidCredentialValue,
  isValidProviderId,
  providerConfigSchema,
  type ProviderConfig,
} from './types.ts'

/**
 * Import OpenAI-compatible providers from an OpenCode configuration.
 *
 * OpenCode config is operator-owned input, never authority: this importer only
 * copies metadata and model ids into PLUTON's own registry, and moves the API
 * key into PLUTON's private credential file. The key is never copied into
 * `providers.json`, and an existing PLUTON credential is never overwritten.
 */
export interface OpenCodeImportOptions {
  /** Explicit config files to read. Defaults to global + project OpenCode configs. */
  configPaths?: string[]
  /** Test/home override; defaults to the current user's home directory. */
  homeDir?: string
  /** Optional project root for project-local OpenCode configs. */
  rootDir?: string
}

export interface OpenCodeImportEntry {
  id: string
  configPath: string
  models: number
  credentialImported: boolean
}

export interface OpenCodeImportFailure {
  id?: string
  configPath: string
  reason: string
}

export interface OpenCodeImportReport {
  configPaths: string[]
  imported: OpenCodeImportEntry[]
  skipped: OpenCodeImportEntry[]
  failed: OpenCodeImportFailure[]
}

const OPENAI_COMPATIBLE_PACKAGES = new Set(['@ai-sdk/openai-compatible'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/** Strip `//` and block comments plus trailing commas without touching strings. */
export function stripJsonComments(input: string): string {
  let out = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!
    const next = input[i + 1]

    if (lineComment) {
      if (ch === '\n' || ch === '\r') {
        lineComment = false
        out += ch
      }
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false
        i += 1
      }
      continue
    }
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      lineComment = true
      i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      blockComment = true
      i += 1
      continue
    }
    out += ch
  }

  return out.replace(/,\s*([}\]])/g, '$1')
}

function parseJsonConfig(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return JSON.parse(stripJsonComments(raw))
  }
}

function defaultConfigPaths(homeDir: string, rootDir: string | undefined): string[] {
  const paths: string[] = []
  const add = (path: string | undefined): void => {
    if (path !== undefined && path !== '' && !paths.includes(path)) paths.push(path)
  }

  add(process.env['OPENCODE_CONFIG'])
  const xdg = process.env['XDG_CONFIG_HOME']
  if (xdg !== undefined && xdg !== '') add(join(xdg, 'opencode', 'opencode.json'))
  add(join(homeDir, '.config', 'opencode', 'opencode.json'))
  add(join(homeDir, '.config', 'opencode', 'opencode.jsonc'))
  const appData = process.env['APPDATA']
  if (appData !== undefined && appData !== '') {
    add(join(appData, 'opencode', 'opencode.json'))
    add(join(appData, 'opencode', 'opencode.jsonc'))
  }
  add(join(homeDir, '.opencode', 'opencode.json'))
  add(join(homeDir, '.opencode', 'opencode.jsonc'))
  if (rootDir !== undefined) {
    add(join(rootDir, 'opencode.json'))
    add(join(rootDir, 'opencode.jsonc'))
    add(join(rootDir, '.opencode', 'opencode.json'))
    add(join(rootDir, '.opencode', 'opencode.jsonc'))
  }
  return paths
}

function normalizePackage(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return undefined
  return raw.replace(/^aisdk:/i, '')
}

function providerEntries(value: unknown): Array<[string, Record<string, unknown>]> {
  if (!isRecord(value)) return []
  const entries: Array<[string, Record<string, unknown>]> = []
  for (const [id, raw] of Object.entries(value)) {
    if (isRecord(raw)) entries.push([id, raw])
  }
  return entries
}

function modelIds(value: unknown): string[] {
  const ids: string[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim() !== '') ids.push(item.trim())
    }
  } else if (isRecord(value)) {
    for (const id of Object.keys(value)) {
      if (id.trim() !== '') ids.push(id.trim())
    }
  }
  return [...new Set(ids)].slice(0, 5000)
}

function extractProvider(
  id: string,
  entry: Record<string, unknown>,
): { config?: ProviderConfig; apiKey?: string; reason?: string } {
  const pkg = normalizePackage(entry['npm'] ?? entry['package'])
  if (pkg === undefined || !OPENAI_COMPATIBLE_PACKAGES.has(pkg)) {
    return { reason: 'not an OpenAI-compatible provider package' }
  }

  const settings = isRecord(entry['settings']) ? entry['settings'] : {}
  const options = isRecord(entry['options']) ? entry['options'] : {}
  const baseUrlRaw = pickString(
    settings['baseURL'],
    settings['baseUrl'],
    options['baseURL'],
    options['baseUrl'],
    entry['baseURL'],
    entry['baseUrl'],
  )
  if (baseUrlRaw === undefined) return { reason: 'provider has no base URL' }

  if (!isValidProviderId(id)) {
    return { reason: `invalid provider id '${id}'` }
  }

  const apiKey = pickString(settings['apiKey'], settings['api_key'], options['apiKey'], options['api_key'])
  const models = modelIds(entry['models'])
  const displayName = pickString(entry['name'], entry['display_name'], id) ?? id

  try {
    const config = providerConfigSchema.parse({
      id,
      engine: 'openai-compatible',
      display_name: displayName,
      base_url: baseUrlRaw.replace(/\/+$/, ''),
      auth: { style: 'bearer' },
      ...(models.length > 0 ? { models } : {}),
    })
    return apiKey !== undefined && isValidCredentialValue(apiKey) ? { config, apiKey } : { config }
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) }
  }
}

export function importOpenCodeProviders(
  rootDir: string,
  options: OpenCodeImportOptions = {},
): OpenCodeImportReport {
  const homeDir = options.homeDir ?? homedir()
  const configPaths = options.configPaths ?? defaultConfigPaths(homeDir, options.rootDir ?? rootDir)
  const report: OpenCodeImportReport = {
    configPaths: configPaths.filter((path) => existsSync(path)),
    imported: [],
    skipped: [],
    failed: [],
  }

  for (const configPath of report.configPaths) {
    let parsed: unknown
    try {
      parsed = parseJsonConfig(readFileSync(configPath, 'utf8'))
    } catch {
      report.failed.push({ configPath, reason: 'could not parse OpenCode config' })
      continue
    }
    if (!isRecord(parsed)) {
      report.failed.push({ configPath, reason: 'OpenCode config is not a JSON object' })
      continue
    }

    const providers = [
      ...providerEntries(parsed['provider']),
      ...providerEntries(parsed['providers']),
    ]
    for (const [id, entry] of providers) {
      const extracted = extractProvider(id, entry)
      if (extracted.config === undefined) {
        if (extracted.reason === 'not an OpenAI-compatible provider package') {
          report.skipped.push({ id, configPath, models: 0, credentialImported: false })
        } else {
          report.failed.push({ id, configPath, reason: extracted.reason ?? 'provider could not be imported' })
        }
        continue
      }

      const existing = getProvider(rootDir, id)
      if (existing !== null) {
        let credentialImported = false
        if (extracted.apiKey !== undefined && !hasProviderCredential(rootDir, id)) {
          writeProviderCredential(rootDir, id, extracted.apiKey)
          credentialImported = true
        }
        report.skipped.push({
          id,
          configPath,
          models: existing.models?.length ?? 0,
          credentialImported,
        })
        continue
      }

      saveProvider(rootDir, extracted.config)
      let credentialImported = false
      if (extracted.apiKey !== undefined) {
        writeProviderCredential(rootDir, id, extracted.apiKey)
        credentialImported = true
      }
      report.imported.push({
        id,
        configPath,
        models: extracted.config.models?.length ?? 0,
        credentialImported,
      })
    }
  }

  return report
}
