import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { ConfigError, ValidationError } from '../domain/errors.ts'
import {
  emptyProviderRegistry,
  isValidCredentialValue,
  isValidProviderId,
  isValidConnectionId,
  providerConfigSchema,
  connectionConfigSchema,
  providerToConnection,
  connectionToProvider,
  PROVIDER_REGISTRY_VERSION,
  type ProviderConfig,
  type ConnectionConfig,
  type ManualModelEntry,
  type ProviderRegistryFile,
} from './types.ts'

/**
 * Project-local provider metadata and credential store.
 *
 * Metadata (`providers.json`) is never a secret store. Credentials live in
 * `.pluton/provider-homes/<id>/credential.json`, created 0600 inside a 0700
 * directory, with best-effort Windows ACL hardening. Every failure message
 * names the path only — never a credential value or file contents.
 */

const CREDENTIAL_FILENAME = 'credential.json'

const registrySchema = z
  .object({
    version: z.literal(PROVIDER_REGISTRY_VERSION),
    providers: z.record(z.string(), providerConfigSchema).optional(),
    connections: z.record(z.string(), connectionConfigSchema).optional(),
  })
  .strict()

const credentialSchema = z
  .object({
    version: z.literal(1),
    api_key: z.string(),
  })
  .strict()

export function providerRegistryPath(rootDir: string): string {
  return join(resolve(rootDir), '.pluton', 'providers.json')
}

export function providerHomesDir(rootDir: string): string {
  return join(resolve(rootDir), '.pluton', 'provider-homes')
}

export function providerHomeDir(rootDir: string, providerId: string): string {
  assertProviderId(providerId)
  return join(providerHomesDir(rootDir), providerId)
}

export function providerCredentialPath(rootDir: string, providerId: string): string {
  return join(providerHomeDir(rootDir, providerId), CREDENTIAL_FILENAME)
}

function assertProviderId(providerId: string): void {
  if (!isValidProviderId(providerId) && !isValidConnectionId(providerId)) {
    throw new ValidationError(
      `invalid provider id '${providerId}': ids are lowercase slugs (a-z, 0-9, -), starting with a letter or digit, and must not look like a credential`,
    )
  }
}

let cachedUserSid: string | null | undefined

/**
 * Resolve the current Windows account's SID once. Granting by SID is stable
 * across localized account names and domain/local ambiguity, which is what
 * makes `icacls` reliable enough to be worth running at all.
 */
function currentUserSid(): string | null {
  if (cachedUserSid !== undefined) return cachedUserSid
  cachedUserSid = null
  if (process.platform !== 'win32') return cachedUserSid
  try {
    const result = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
      windowsHide: true,
      encoding: 'utf8',
    })
    if (result.status !== 0 || typeof result.stdout !== 'string') return cachedUserSid
    const fields = result.stdout.replace(/"/g, '').trim().split(',')
    const sid = fields[fields.length - 1]?.trim()
    if (sid !== undefined && /^S-1-\d+(-\d+)+$/.test(sid)) cachedUserSid = sid
  } catch {
    // No `whoami` (unusual Windows image): skip ACL hardening rather than guess.
  }
  return cachedUserSid
}

/**
 * Best-effort Windows ACL hardening: after this call the provider home grants
 * full control to the current user, SYSTEM and Administrators only, and no
 * longer inherits parent permissions.
 *
 * The grants are applied BEFORE inheritance is removed, in one `icacls`
 * invocation, so a failed grant leaves the inherited ACL intact instead of
 * locking the owner out. Any non-zero exit is ignored: POSIX mode bits and the
 * project directory's ACL remain the effective protection.
 */
function applyWindowsAcl(path: string, directory: boolean): void {
  if (process.platform !== 'win32') return
  const sid = currentUserSid()
  if (sid === null) return
  const flags = directory ? '(OI)(CI)F' : 'F'
  const args = [
    path,
    '/grant:r',
    `*${sid}:${flags}`,
    '/grant:r',
    `*S-1-5-18:${flags}`,
    '/grant:r',
    `*S-1-5-32-544:${flags}`,
    '/inheritance:r',
  ]
  try {
    const result = spawnSync('icacls', args, { windowsHide: true, stdio: 'ignore' })
    if (result.status !== 0) return
  } catch {
    // ACL tooling is not guaranteed on every host; hardening is optional.
  }
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try {
    chmodSync(path, 0o700)
  } catch {
    // Windows and some filesystems do not implement POSIX modes.
  }
  applyWindowsAcl(path, true)
}

function atomicWrite(path: string, contents: string, mode: number): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, contents, { encoding: 'utf8', mode, flag: 'wx' })
    try {
      chmodSync(tmp, mode)
    } catch {
      // See ensurePrivateDir.
    }
    renameSync(tmp, path)
    try {
      chmodSync(path, mode)
    } catch {
      // See ensurePrivateDir.
    }
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Load and validate the project's provider registry. Missing file = empty. */
export function loadProviderRegistry(rootDir: string): ProviderRegistryFile {
  const path = providerRegistryPath(rootDir)
  if (!existsSync(path)) return emptyProviderRegistry()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new ConfigError(`could not parse provider registry ${path}`)
  }
  const parsed = registrySchema.safeParse(raw)
  if (!parsed.success) {
    const fields = parsed.error.issues
      .slice(0, 10)
      .map((issue) => issue.path.join('.') || '(root)')
      .join(', ')
    throw new ConfigError(`invalid provider registry ${path}: ${fields}`)
  }

  const providers = { ...(parsed.data.providers ?? {}) }
  const connections = parsed.data.connections ? { ...parsed.data.connections } : undefined

  for (const [key, provider] of Object.entries(providers)) {
    if (provider.id !== key) {
      throw new ConfigError(
        `invalid provider registry ${path}: provider key '${key}' has id '${provider.id}'; id must match its registry key`,
      )
    }
  }

  if (connections !== undefined) {
    for (const [key, conn] of Object.entries(connections)) {
      if (conn.id !== key) {
        throw new ConfigError(
          `invalid provider registry ${path}: connection key '${key}' has id '${conn.id}'; id must match its registry key`,
        )
      }
      if (!providers[key]) {
        providers[key] = connectionToProvider(conn)
      }
    }
  }

  const result: ProviderRegistryFile = {
    version: parsed.data.version,
    providers,
  }
  if (connections !== undefined) {
    result.connections = connections
  }
  return result
}

export function listProviders(rootDir: string): ProviderConfig[] {
  return Object.values(loadProviderRegistry(rootDir).providers).sort((a, b) => a.id.localeCompare(b.id))
}

export function getProvider(rootDir: string, providerId: string): ProviderConfig | null {
  return loadProviderRegistry(rootDir).providers[providerId] ?? null
}

export function listConnections(rootDir: string): ConnectionConfig[] {
  const registry = loadProviderRegistry(rootDir)
  if (registry.connections) {
    const map = new Map<string, ConnectionConfig>()
    for (const [id, prov] of Object.entries(registry.providers)) {
      map.set(id, providerToConnection(prov))
    }
    for (const [id, conn] of Object.entries(registry.connections)) {
      map.set(id, conn)
    }
    return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id))
  }
  return Object.values(registry.providers).map(providerToConnection).sort((a, b) => a.id.localeCompare(b.id))
}

export function getConnection(rootDir: string, connectionId: string): ConnectionConfig | null {
  const registry = loadProviderRegistry(rootDir)
  if (registry.connections?.[connectionId]) {
    return registry.connections[connectionId]
  }
  if (registry.providers[connectionId]) {
    return providerToConnection(registry.providers[connectionId])
  }
  return null
}

export function saveConnection(rootDir: string, input: ConnectionConfig): void {
  const connection = connectionConfigSchema.parse(input)
  assertProviderId(connection.id)
  const registry = loadProviderRegistry(rootDir)
  if (!registry.connections) registry.connections = {}
  registry.connections[connection.id] = connection
  registry.providers[connection.id] = connectionToProvider(connection)
  ensurePrivateDir(providerHomeDir(rootDir, connection.id))
  atomicWrite(providerRegistryPath(rootDir), `${JSON.stringify(registry, null, 2)}\n`, 0o600)
}

export function removeConnection(rootDir: string, connectionId: string): boolean {
  assertProviderId(connectionId)
  const registry = loadProviderRegistry(rootDir)
  const hadConn = registry.connections?.[connectionId] !== undefined
  const hadProv = registry.providers[connectionId] !== undefined
  if (!hadConn && !hadProv) return false
  if (registry.connections) delete registry.connections[connectionId]
  delete registry.providers[connectionId]
  atomicWrite(providerRegistryPath(rootDir), `${JSON.stringify(registry, null, 2)}\n`, 0o600)
  rmSync(providerHomeDir(rootDir, connectionId), { recursive: true, force: true })
  return true
}

export function readConnectionCredential(rootDir: string, connectionId: string): string | null {
  return readProviderCredential(rootDir, connectionId)
}

export function writeConnectionCredential(rootDir: string, connectionId: string, apiKey: string): void {
  writeProviderCredential(rootDir, connectionId, apiKey)
}

export function removeConnectionCredential(rootDir: string, connectionId: string): boolean {
  return removeProviderCredential(rootDir, connectionId)
}

export function manualModelsPath(rootDir: string): string {
  return join(rootDir, '.pluton', 'manual-models.json')
}

export function listManualModels(rootDir: string, connectionId?: string): ManualModelEntry[] {
  const p = manualModelsPath(rootDir)
  if (!existsSync(p)) return []
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    if (!Array.isArray(raw)) return []
    if (connectionId !== undefined) {
      return raw.filter((m) => m && m.connectionId === connectionId)
    }
    return raw
  } catch {
    return []
  }
}

export function saveManualModel(rootDir: string, entry: ManualModelEntry): void {
  const current = listManualModels(rootDir)
  const filtered = current.filter(
    (m) => !(m.connectionId === entry.connectionId && m.modelId === entry.modelId),
  )
  filtered.push(entry)
  const p = manualModelsPath(rootDir)
  ensurePrivateDir(dirname(p))
  atomicWrite(p, `${JSON.stringify(filtered, null, 2)}\n`, 0o600)
}

export function removeManualModel(rootDir: string, connectionId: string, modelId: string): boolean {
  const current = listManualModels(rootDir)
  const remaining = current.filter(
    (m) => !(m.connectionId === connectionId && m.modelId === modelId),
  )
  if (remaining.length === current.length) return false
  const p = manualModelsPath(rootDir)
  ensurePrivateDir(dirname(p))
  atomicWrite(p, `${JSON.stringify(remaining, null, 2)}\n`, 0o600)
  return true
}

/** Create or replace provider metadata. The credential (if any) is untouched. */
export function saveProvider(rootDir: string, input: ProviderConfig): void {
  const provider = providerConfigSchema.parse(input)
  assertProviderId(provider.id)
  const registry = loadProviderRegistry(rootDir)
  registry.providers[provider.id] = provider
  if (!registry.connections) registry.connections = {}
  registry.connections[provider.id] = providerToConnection(provider)
  ensurePrivateDir(providerHomeDir(rootDir, provider.id))
  atomicWrite(providerRegistryPath(rootDir), `${JSON.stringify(registry, null, 2)}\n`, 0o600)
}

/** Remove metadata and the provider's private home (credential included). */
export function removeProvider(rootDir: string, providerId: string): boolean {
  assertProviderId(providerId)
  const registry = loadProviderRegistry(rootDir)
  if (registry.providers[providerId] === undefined && registry.connections?.[providerId] === undefined) return false
  delete registry.providers[providerId]
  if (registry.connections) delete registry.connections[providerId]
  atomicWrite(providerRegistryPath(rootDir), `${JSON.stringify(registry, null, 2)}\n`, 0o600)
  rmSync(providerHomeDir(rootDir, providerId), { recursive: true, force: true })
  return true
}

/**
 * Resolve the provider for an engine. A named provider wins; without one the
 * engine must have exactly one configured provider. Ambiguity is an explicit
 * error — Phase 3 owns provider-aware routing, so Phase 1 never guesses.
 */
export function resolveProviderForEngine(
  rootDir: string,
  engineKind: string,
  providerId?: string,
): ProviderConfig {
  if (providerId !== undefined) {
    const provider = getProvider(rootDir, providerId)
    if (provider === null) {
      const known = listProviders(rootDir).map((p) => p.id).join(', ') || '(none configured)'
      throw new ValidationError(`unknown provider '${providerId}'; configured providers: ${known}`)
    }
    if (provider.engine !== engineKind) {
      throw new ValidationError(
        `provider '${providerId}' targets engine '${provider.engine}', not '${engineKind}'`,
      )
    }
    return provider
  }
  const candidates = listProviders(rootDir).filter((provider) => provider.engine === engineKind)
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length === 0) {
    throw new ConfigError(
      `no provider is configured for engine '${engineKind}'; run \`pluton provider add <id> --base-url <url>\` and set the Ship's provider`,
    )
  }
  throw new ConfigError(
    `ambiguous provider for engine '${engineKind}': ${candidates.map((p) => p.id).join(', ')}; ` +
      "set each Ship's provider explicitly (provider-aware model routing is Phase 3)",
  )
}

function readCredentialFile(rootDir: string, providerId: string): string | null {
  const path = providerCredentialPath(rootDir, providerId)
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new ConfigError(`could not parse provider credential file ${path}`)
  }
  const parsed = credentialSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ConfigError(`malformed provider credential file ${path}`)
  }
  if (!isValidCredentialValue(parsed.data.api_key)) {
    throw new ConfigError(`malformed provider credential file ${path}`)
  }
  return parsed.data.api_key
}

/** Presence read. Returns null only when no credential exists. */
export function readProviderCredential(rootDir: string, providerId: string): string | null {
  assertProviderId(providerId)
  return readCredentialFile(rootDir, providerId)
}

export function hasProviderCredential(rootDir: string, providerId: string): boolean {
  return readProviderCredential(rootDir, providerId) !== null
}

/** Store a credential. Only the caller that captured it holds the plaintext. */
export function writeProviderCredential(rootDir: string, providerId: string, apiKey: string): void {
  assertProviderId(providerId)
  if (!isValidCredentialValue(apiKey)) {
    throw new ValidationError(
      'provider credential is invalid: expected a non-empty single-line value of at most 16384 characters',
    )
  }
  ensurePrivateDir(providerHomeDir(rootDir, providerId))
  const path = providerCredentialPath(rootDir, providerId)
  atomicWrite(path, `${JSON.stringify({ version: 1, api_key: apiKey }, null, 2)}\n`, 0o600)
  applyWindowsAcl(path, false)
}

export function removeProviderCredential(rootDir: string, providerId: string): boolean {
  assertProviderId(providerId)
  const path = providerCredentialPath(rootDir, providerId)
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  try {
    const home = providerHomeDir(rootDir, providerId)
    if (readdirSync(home).length === 0) rmdirSync(home)
  } catch {
    // The home may still hold engine scratch state; leave it in place.
  }
  return true
}

export function credentialHint(providerId: string): string {
  return `run \`pluton provider key ${providerId}\` and provide the key on stdin (never as a command argument)`
}

/** A credential file must remain readable only by its owner when the OS allows it. */
export function credentialFileIsPrivate(rootDir: string, providerId: string): boolean {
  const path = providerCredentialPath(rootDir, providerId)
  if (!existsSync(path)) return false
  if (process.platform === 'win32') return true
  try {
    return (statSync(path).mode & 0o777) === 0o600
  } catch {
    return false
  }
}
