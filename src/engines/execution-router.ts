import { ValidationError } from '../domain/errors.ts'
import type { ApprovalMode, ShipRole } from '../domain/models.ts'
import type { AcpSpawnFn } from './acp/client.ts'
import { engineAdapterForShip } from './approval.ts'
import type {
  EngineAdapter,
  EngineSession,
  StartSessionRequest,
} from './contract/types.ts'
import { getEngineAdapter, type EngineCreateOptions } from './registry.ts'
import {
  credentialHint,
  hasProviderCredential,
  listProviders,
} from '../providers/store.ts'
import { importOpenCodeProviders } from '../providers/opencode-import.ts'
import { isValidProviderId, type ProviderConfig } from '../providers/types.ts'

/**
 * Composite identity of a model (PLUTON 4.2, Phase 1).
 *
 * Model identity is always a triplet: (engineKind, providerId, modelId).
 * A model ID alone must never determine its execution adapter.
 * A provider's model must never be passed to an unrelated engine.
 */
export interface ModelIdentity {
  /** Execution engine kind (e.g. 'opencode', 'openai-compatible'). */
  engineKind: string
  /** Provider identifier (e.g. '9router', 'ollama', or 'opencode'). */
  providerId: string
  /** Exact model identifier as reported by the provider. */
  modelId: string
}

/**
 * Resolved execution route providing everything needed to launch an engine session.
 */
export interface ResolvedExecutionRoute {
  /** Canonical composite model identity. */
  identity: ModelIdentity
  /** Provider configuration if an external provider, or null for built-in engine. */
  provider: ProviderConfig | null
  /** Model id exactly as the selected engine/provider expects it (provider prefix stripped). */
  providerModelId: string
  /** Engine adapter configured for this provider. */
  adapter: EngineAdapter
  /** Filesystem path or identifier for credentials. */
  credentialsReference: string | null
  /** Whether valid credentials are confirmed present. */
  hasCredentials: boolean
  /** Setup hint shown if credentials or provider configuration are missing. */
  credentialHint: string
  /** Session factory for creating engine sessions directly. */
  startSession: (req: StartSessionRequest) => Promise<EngineSession>
}

export interface ResolveExecutionRouteOptions {
  /** Project root directory. */
  rootDir: string
  /** Selected model ID (e.g. '9router/ag/gemini-3.8-flash-high', 'opencode/deepseek-v4.1-flash-free'). */
  model: string
  /** Optional provider ID hint from Ship configuration or UI selection. */
  providerId?: string | null
  /** Optional engine kind hint from Ship configuration or UI selection. */
  engineKind?: string | null
  /** Optional ship role for approval / capability configuration. */
  shipRole?: ShipRole
  /** Optional approval mode. */
  approvalMode?: ApprovalMode
  /** Whether running inside an isolated checkout. */
  isolatedCheckout?: boolean
  /** Test/container spawn function injection. */
  spawnFn?: AcpSpawnFn
  /** Platform override for test/container seams. */
  platform?: NodeJS.Platform
  /** Test seam: explicit OpenCode config files to scan for provider import. */
  opencodeConfigPaths?: string[]
}

/**
 * A model prefix that names a built-in engine, not an external provider.
 *
 * These win over an inherited Ship provider hint: selecting
 * `opencode/<model>` from the picker must not be rejected because the Ship was
 * previously on an external provider.
 */
export const BUILTIN_MODEL_PREFIXES = new Set(['opencode', 'mock'])

function modelPrefix(modelId: string): string {
  const slashIndex = modelId.indexOf('/')
  return slashIndex !== -1 ? modelId.slice(0, slashIndex).toLowerCase() : ''
}

function refreshProviderMap(rootDir: string): Map<string, ProviderConfig> {
  return new Map(listProviders(rootDir).map((provider) => [provider.id, provider]))
}

/**
 * Resolve the execution route for a model request.
 *
 * Enforces:
 * 1. An external provider's model is never passed to an unrelated engine.
 * 2. Model identity includes engineKind, providerId, and modelId.
 * 3. Exact credentials reference and engine adapter are determined safely.
 */
export function resolveExecutionRoute(opts: ResolveExecutionRouteOptions): ResolvedExecutionRoute {
  const rootDir = opts.rootDir
  const modelId = opts.model.trim()
  if (!modelId) {
    throw new ValidationError('cannot resolve execution route: model id is empty')
  }

  const prefix = modelPrefix(modelId)
  const builtinPrefix = prefix !== '' && BUILTIN_MODEL_PREFIXES.has(prefix) ? prefix : null
  let providerById = refreshProviderMap(rootDir)

  let resolvedProvider: ProviderConfig | null = null
  let resolvedEngine: string | null = opts.engineKind?.trim() || null
  let resolvedProviderId: string | null = opts.providerId?.trim() || null

  // 0. A built-in model prefix wins over an inherited provider hint. The
  // picker can switch a Ship from an external provider back to OpenCode
  // without the request carrying an explicit "provider: null".
  if (builtinPrefix !== null) {
    resolvedProviderId = null
    if (
      resolvedEngine === null ||
      resolvedEngine === 'openai-compatible' ||
      (builtinPrefix === 'mock' && !resolvedEngine.includes('mock'))
    ) {
      resolvedEngine = builtinPrefix
    }
  }

  // 0b. A model prefix that is not a configured provider may still exist in
  // the operator's OpenCode configuration. Import it once; never overwrite an
  // existing PLUTON credential.
  if (
    prefix !== '' &&
    builtinPrefix === null &&
    !providerById.has(prefix) &&
    isValidProviderId(prefix)
  ) {
    const report = importOpenCodeProviders(rootDir, {
      ...(opts.opencodeConfigPaths !== undefined ? { configPaths: opts.opencodeConfigPaths } : {}),
    })
    if (report.imported.length > 0 || report.skipped.some((entry) => entry.credentialImported)) {
      providerById = refreshProviderMap(rootDir)
    }
  }

  // 1. Explicit provider ID supplied
  if (resolvedProviderId) {
    if (resolvedProviderId === 'opencode') {
      resolvedEngine = 'opencode'
      resolvedProvider = null
    } else {
      const prov = providerById.get(resolvedProviderId)
      if (!prov) {
        const known = [...providerById.keys()].sort().join(', ') || '(none configured)'
        throw new ValidationError(
          `unknown provider '${resolvedProviderId}'; configured providers: ${known}`,
        )
      }
      resolvedProvider = prov
      if (resolvedEngine && resolvedEngine !== prov.engine) {
        throw new ValidationError(
          `provider '${resolvedProviderId}' targets engine '${prov.engine}', not '${resolvedEngine}'`,
        )
      }
      resolvedEngine = prov.engine
    }
  }

  // 2. No explicit provider ID: inspect model prefix against configured providers
  if (!resolvedProvider && (!resolvedProviderId || resolvedProviderId === '') && builtinPrefix === null) {
    if (prefix && providerById.has(prefix)) {
      resolvedProvider = providerById.get(prefix)!
      resolvedProviderId = resolvedProvider.id
      resolvedEngine = resolvedProvider.engine
    } else if ([...providerById.values()].filter((p) => p.engine === 'openai-compatible').length === 1 && resolvedEngine === 'openai-compatible') {
      resolvedProvider = [...providerById.values()].find((p) => p.engine === 'openai-compatible')!
      resolvedProviderId = resolvedProvider.id
      resolvedEngine = resolvedProvider.engine
    }
  }

  // 2b. An explicit provider and a differently-prefixed model are contradictory.
  if (resolvedProvider && builtinPrefix === null && prefix !== '') {
    const prefixProvider = providerById.get(prefix)
    if (prefixProvider !== undefined && prefixProvider.id !== resolvedProvider.id) {
      throw new ValidationError(
        `model '${modelId}' belongs to provider '${prefixProvider.id}' but provider '${resolvedProvider.id}' was selected`,
      )
    }
  }

  // 3. Fallback to opencode if no external provider matched and engine is opencode
  if (!resolvedProvider) {
    if (resolvedEngine === 'openai-compatible') {
      const candidates = [...providerById.values()].filter((p) => p.engine === 'openai-compatible')
      if (candidates.length === 1) {
        resolvedProvider = candidates[0]!
        resolvedProviderId = resolvedProvider.id
      } else if (candidates.length === 0) {
        throw new ValidationError(
          `no provider configured for engine 'openai-compatible'; add one via \`pluton provider add <id>\``,
        )
      } else {
        const ids = candidates.map((p) => p.id).join(', ')
        throw new ValidationError(
          `multiple providers configured for engine 'openai-compatible' (${ids}); disambiguate with provider ID`,
        )
      }
    } else {
      if (
        resolvedEngine === null &&
        builtinPrefix === null &&
        prefix !== '' &&
        isValidProviderId(prefix)
      ) {
        throw new ValidationError(
          `no provider '${prefix}' configured; import it from OpenCode with \`pluton provider import\` ` +
            `or add it with \`pluton provider add ${prefix} --engine openai-compatible --base-url <url>\``,
        )
      }
      resolvedEngine = resolvedEngine ?? 'opencode'
      // Built-in engines report themselves as their own provider identity; only
      // an explicitly configured provider counts as external.
      resolvedProviderId = resolvedEngine
    }
  }

  // 4. Invariant: An external provider's model must NEVER be routed to an unrelated engine
  if (resolvedProvider && resolvedEngine !== resolvedProvider.engine) {
    throw new ValidationError(
      `model '${modelId}' belongs to provider '${resolvedProvider.id}' (engine '${resolvedProvider.engine}') and cannot be executed by engine '${resolvedEngine}'`,
    )
  }

  // Also verify: if model starts with a configured provider prefix, it must not run on OpenCode
  if (resolvedEngine === 'opencode') {
    if (prefix && prefix !== 'opencode' && providerById.has(prefix)) {
      const targetProv = providerById.get(prefix)!
      throw new ValidationError(
        `model '${modelId}' belongs to provider '${targetProv.id}' (engine '${targetProv.engine}') and cannot be executed by engine 'opencode'`,
      )
    }
  }

  const identity: ModelIdentity = {
    engineKind: resolvedEngine ?? 'opencode',
    providerId: resolvedProvider ? resolvedProvider.id : (resolvedProviderId ?? resolvedEngine ?? 'opencode'),
    modelId,
  }

  // The provider API receives its own model id, never the composite identity.
  const providerModelId =
    resolvedProvider !== null && modelId.startsWith(`${resolvedProvider.id}/`)
      ? modelId.slice(resolvedProvider.id.length + 1)
      : modelId

  // 5. Credentials reference and status
  let credentialsReference: string | null = null
  let hasCredentials = true
  let hint = ''

  if (resolvedProvider) {
    credentialsReference = `.pluton/provider-homes/${resolvedProvider.id}/credential.json`
    hasCredentials = hasProviderCredential(rootDir, resolvedProvider.id)
    hint = credentialHint(resolvedProvider.id)
  }

  // 6. Engine adapter resolution
  const adapterOptions: EngineCreateOptions = {
    rootDir,
    providerId: resolvedProvider?.id,
    isolatedCheckout: opts.isolatedCheckout === true,
    spawnFn: opts.spawnFn,
    platform: opts.platform,
  }

  let adapter: EngineAdapter
  if (resolvedEngine === 'opencode') {
    adapter = engineAdapterForShip(
      {
        engineKind: 'opencode',
        approvalMode: opts.approvalMode ?? 'ask-for-sensitive-actions',
      },
      adapterOptions,
    )
  } else {
    adapter = getEngineAdapter(resolvedEngine ?? 'opencode', adapterOptions)
  }

  return {
    identity,
    provider: resolvedProvider,
    providerModelId,
    adapter,
    credentialsReference,
    hasCredentials,
    credentialHint: hint,
    startSession: (req: StartSessionRequest) => {
      const routed: StartSessionRequest = {
        ...req,
        ...(req.ship !== undefined ? { ship: { ...req.ship, model: providerModelId } } : {}),
        ...(req.muse !== undefined ? { muse: { ...req.muse, model: providerModelId } } : {}),
      }
      return adapter.startSession(routed)
    },
  }
}
