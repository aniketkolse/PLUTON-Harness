import {
  ConfigError,
  EngineAuthMissingError,
  ValidationError,
} from '../../domain/errors.ts'
import type { EngineModel } from '../../engines/contract/types.ts'
import { getEngineAdapter } from '../../engines/registry.ts'
import {
  credentialHint,
  getProvider,
  hasProviderCredential,
  listProviders,
  removeProvider,
  removeProviderCredential,
  saveProvider,
  writeProviderCredential,
} from '../../providers/store.ts'
import {
  providerConfigSchema,
  type ProviderAuthConfig,
  type ProviderConfig,
} from '../../providers/types.ts'
import {
  importOpenCodeProviders,
  type OpenCodeImportReport,
} from '../../providers/opencode-import.ts'

export interface ProviderSummary {
  id: string
  engine: string
  displayName: string
  baseUrl: string
  authStyle: string
  hasCredential: boolean
  modelsPath: string
  chatPath: string
}

export function providerList(rootDir: string): ProviderSummary[] {
  return listProviders(rootDir).map((p) => ({
    id: p.id,
    engine: p.engine,
    displayName: p.display_name,
    baseUrl: p.base_url,
    authStyle: p.auth.style,
    hasCredential: hasProviderCredential(rootDir, p.id),
    modelsPath: p.models_path,
    chatPath: p.chat_path,
  }))
}

export interface AddProviderSpec {
  id: string
  engine: string
  displayName?: string
  baseUrl: string
  authStyle?: 'bearer' | 'header'
  authHeader?: string
  authPrefix?: string
  modelsPath?: string
  chatPath?: string
  headers?: Record<string, string>
  timeoutMs?: number
}

export function providerAdd(rootDir: string, spec: AddProviderSpec): { provider: ProviderConfig } {
  const auth: ProviderAuthConfig =
    spec.authStyle === 'header'
      ? {
          style: 'header',
          header: spec.authHeader ?? 'x-api-key',
          ...(spec.authPrefix !== undefined ? { prefix: spec.authPrefix } : {}),
        }
      : {
          style: 'bearer',
          ...(spec.authPrefix !== undefined ? { prefix: spec.authPrefix } : {}),
        }

  const raw = {
    id: spec.id,
    engine: spec.engine,
    display_name: spec.displayName ?? spec.id,
    base_url: spec.baseUrl,
    auth,
    ...(spec.modelsPath !== undefined ? { models_path: spec.modelsPath } : {}),
    ...(spec.chatPath !== undefined ? { chat_path: spec.chatPath } : {}),
    ...(spec.headers !== undefined ? { headers: spec.headers } : {}),
    ...(spec.timeoutMs !== undefined ? { timeout_ms: spec.timeoutMs } : {}),
  }

  const parsed = providerConfigSchema.parse(raw)
  saveProvider(rootDir, parsed)
  return { provider: parsed }
}

export function providerRemove(rootDir: string, id: string): { id: string; removed: boolean } {
  const removed = removeProvider(rootDir, id)
  if (!removed) {
    throw new ValidationError(`provider '${id}' not found`)
  }
  return { id, removed: true }
}

export function providerSetKey(rootDir: string, id: string, key: string): { id: string; configured: boolean } {
  const provider = getProvider(rootDir, id)
  if (provider === null) {
    throw new ValidationError(`provider '${id}' not found; add it with \`pluton provider add\` first`)
  }
  writeProviderCredential(rootDir, id, key)
  return { id, configured: true }
}

export function providerRemoveKey(rootDir: string, id: string): { id: string; removed: boolean } {
  const provider = getProvider(rootDir, id)
  if (provider === null) {
    throw new ValidationError(`provider '${id}' not found`)
  }
  const removed = removeProviderCredential(rootDir, id)
  return { id, removed }
}

export interface ProviderValidationReport {
  id: string
  engine: string
  hasCredential: boolean
  installed: boolean
  authConfigured: boolean
  liveCheck: 'passed' | 'failed' | 'not-attempted'
  detail: string
  modelsCount?: number
}

export async function providerValidate(
  rootDir: string,
  id: string,
): Promise<ProviderValidationReport> {
  const provider = getProvider(rootDir, id)
  if (provider === null) {
    throw new ValidationError(`provider '${id}' not found`)
  }
  const hasKey = hasProviderCredential(rootDir, id)
  const adapter = getEngineAdapter(provider.engine, { rootDir, providerId: id })
  const discovery = await adapter.discover()
  const auth = await adapter.authStatus(rootDir)

  if (!hasKey) {
    return {
      id,
      engine: provider.engine,
      hasCredential: false,
      installed: discovery.installed,
      authConfigured: false,
      liveCheck: 'not-attempted',
      detail: `no credential stored; ${credentialHint(id)}`,
    }
  }

  try {
    const models = await adapter.listModels()
    return {
      id,
      engine: provider.engine,
      hasCredential: true,
      installed: true,
      authConfigured: true,
      liveCheck: 'passed',
      detail: `connected to ${provider.base_url} successfully`,
      modelsCount: models.length,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      id,
      engine: provider.engine,
      hasCredential: true,
      installed: discovery.installed,
      authConfigured: auth.configured,
      liveCheck: 'failed',
      detail: msg,
    }
  }
}

export async function providerModels(rootDir: string, id: string): Promise<EngineModel[]> {
  const provider = getProvider(rootDir, id)
  if (provider === null) {
    throw new ValidationError(`provider '${id}' not found`)
  }
  const adapter = getEngineAdapter(provider.engine, { rootDir, providerId: id })
  return adapter.listModels()
}

/**
 * Read credential strictly from standard input.
 * Rejects empty input or values containing newlines.
 */
export async function readKeyFromStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  const trimmed = raw.replace(/[\r\n]+$/, '')
  if (trimmed.length === 0) {
    throw new ValidationError(
      'credential value is empty; pipe or paste the API key on stdin and finish with EOF / enter',
    )
  }
  return trimmed
}

export function providerImport(
  rootDir: string,
  options: { configPath?: string } = {},
): OpenCodeImportReport {
  return importOpenCodeProviders(rootDir, {
    ...(options.configPath !== undefined ? { configPaths: [options.configPath] } : {}),
  })
}
