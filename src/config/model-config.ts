import type { PlutonConfig, ShipConfig } from './schema.ts'

/**
 * Model intelligence configuration layer (PLUTON 3.2, Phase 6).
 *
 * Translates pluton.yaml into a normalized, backward-compatible view that
 * distinguishes explicit pins from automatic selection. This module is pure
 * configuration: it never discovers models, never selects, and never imports the
 * engine layer.
 */

export type ModelSelectionMode = 'automatic' | 'pinned'

export interface ResolvedDiscoveryConfig {
  refreshIntervalMs: number
  providerAllowlist: string[]
  providerDenylist: string[]
}

export interface ResolvedSelectionConfig {
  costPreference: 'low' | 'balanced' | 'indifferent'
  latencyPreference: 'low' | 'balanced' | 'indifferent'
  taskFit: Record<string, string[]>
}

export interface ResolvedFallbackConfig {
  maxRetriesPerModel: number
  cooldownMs: number
  maxTotalFallbacks: number
  scope: 'task' | 'provider' | 'global'
}

export interface ResolvedModelsConfig {
  discovery: ResolvedDiscoveryConfig
  selection: ResolvedSelectionConfig
  fallback: ResolvedFallbackConfig
}

export interface ResolvedShipModelConfig {
  shipId: string
  /** Opaque model id when explicitly pinned; null means automatic selection. */
  pin: string | null
  selectionMode: ModelSelectionMode
  /** Task-level classification hints, when configured. */
  taskHints?: {
    taskType?: 'research' | 'coding' | 'testing' | 'simple' | 'planning'
    requiredCapabilities?: ('research' | 'coding' | 'testing' | 'simple')[]
    requiresToolCalling?: boolean
    requiresMultimodal?: boolean
    minContextWindow?: number
  }
  /** Selection preferences, when configured. */
  preferences?: {
    costPreference?: 'low' | 'balanced' | 'indifferent'
    latencyPreference?: 'low' | 'balanced' | 'indifferent'
    maxCostUsdPerMillionTokens?: number
    maxLatencyMs?: number
    minContextWindow?: number
  }
  providerAllowlist: string[]
  providerDenylist: string[]
}

export interface ResolvedModelConfig {
  models: ResolvedModelsConfig
  ships: Record<string, ResolvedShipModelConfig>
}

const DEFAULT_DISCOVERY: ResolvedDiscoveryConfig = {
  refreshIntervalMs: 0,
  providerAllowlist: [],
  providerDenylist: [],
}

const DEFAULT_SELECTION: ResolvedSelectionConfig = {
  costPreference: 'balanced',
  latencyPreference: 'balanced',
  taskFit: {},
}

const DEFAULT_FALLBACK: ResolvedFallbackConfig = {
  maxRetriesPerModel: 2,
  cooldownMs: 300_000,
  maxTotalFallbacks: 5,
  scope: 'task',
}

export function resolveModelsConfig(config: PlutonConfig): ResolvedModelsConfig {
  const raw = config.models
  const discoveryRaw = raw?.discovery
  const selectionRaw = raw?.selection
  const fallbackRaw = raw?.fallback

  return {
    discovery: {
      refreshIntervalMs: discoveryRaw?.refreshIntervalMs ?? DEFAULT_DISCOVERY.refreshIntervalMs,
      providerAllowlist: discoveryRaw?.providers?.allowlist ?? DEFAULT_DISCOVERY.providerAllowlist,
      providerDenylist: discoveryRaw?.providers?.denylist ?? DEFAULT_DISCOVERY.providerDenylist,
    },
    selection: {
      costPreference: selectionRaw?.costPreference ?? DEFAULT_SELECTION.costPreference,
      latencyPreference: selectionRaw?.latencyPreference ?? DEFAULT_SELECTION.latencyPreference,
      taskFit: selectionRaw?.taskFit ?? DEFAULT_SELECTION.taskFit,
    },
    fallback: {
      maxRetriesPerModel: fallbackRaw?.maxRetriesPerModel ?? DEFAULT_FALLBACK.maxRetriesPerModel,
      cooldownMs: fallbackRaw?.cooldownMs ?? DEFAULT_FALLBACK.cooldownMs,
      maxTotalFallbacks: fallbackRaw?.maxTotalFallbacks ?? DEFAULT_FALLBACK.maxTotalFallbacks,
      scope: fallbackRaw?.scope ?? DEFAULT_FALLBACK.scope,
    },
  }
}

export function resolveShipModelConfig(
  config: PlutonConfig,
  shipId: string,
  ship: ShipConfig,
  models: ResolvedModelsConfig,
): ResolvedShipModelConfig {
  const pin = typeof ship.model === 'string' && ship.model.trim().length > 0 ? ship.model.trim() : null

  const hints = ship.model_requirements
  const prefs = ship.model_preferences

  return {
    shipId,
    pin,
    selectionMode: pin === null ? 'automatic' : 'pinned',
    taskHints:
      hints === undefined
        ? undefined
        : {
            taskType: hints.taskType,
            requiredCapabilities: hints.requiredCapabilities,
            requiresToolCalling: hints.requiresToolCalling,
            requiresMultimodal: hints.requiresMultimodal,
            minContextWindow: hints.minContextWindow,
          },
    preferences: prefs === undefined ? undefined : { ...prefs },
    providerAllowlist: models.discovery.providerAllowlist,
    providerDenylist: models.discovery.providerDenylist,
  }
}

export function resolveModelConfig(config: PlutonConfig): ResolvedModelConfig {
  const models = resolveModelsConfig(config)
  const ships: Record<string, ResolvedShipModelConfig> = {}
  for (const [id, ship] of Object.entries(config.ships)) {
    ships[id] = resolveShipModelConfig(config, id, ship, models)
  }
  return { models, ships }
}

/** Convenience: resolve one ship's config, or null when the ship is absent. */
export function resolveShipModelConfigById(
  config: PlutonConfig,
  shipId: string,
): ResolvedShipModelConfig | null {
  const ship = config.ships[shipId]
  if (ship === undefined) return null
  const models = resolveModelsConfig(config)
  return resolveShipModelConfig(config, shipId, ship, models)
}
