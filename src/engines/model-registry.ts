import { isDeepStrictEqual } from 'node:util'
import type { EngineModel, ModelAvailability, ModelCapabilityDeclaration } from './contract/types.ts'

/**
 * Runtime inventory of discovered models (PLUTON 3.2, Phase 2; PLUTON 6.0 Multi-Connection).
 *
 * Identity is composite: `(connectionId ?? engineKind, modelId)`. Multiple
 * connections or adapters may legitimately expose the same opaque model id,
 * so neither part alone is a key. Model ids are stored exactly as the adapter
 * reports them and are never parsed to infer provider, capabilities, cost, or latency.
 *
 * Refresh semantics:
 * - A successful refresh replaces a connection/adapter's inventory and removes entries
 *   the probe no longer reports (reported as `removed` changes).
 * - A failed refresh never reaches the registry; the previous inventory is
 *   retained by the discovery service.
 * - Results older than the newest observation for an adapter are ignored, so a
 *   late-arriving stale probe cannot roll metadata backwards.
 */

/** Composite identity of one discovered model. */
export interface ModelRegistryKey {
  /** Engine adapter kind that reported the model. */
  engineKind: string
  /** Exact opaque model id as reported by the adapter. */
  modelId: string
  /** Explicit connection id when associated with a connection. */
  connectionId?: string
}

/** A discovered model plus registry bookkeeping. */
export interface ModelRegistryEntry extends EngineModel {
  /** Engine adapter kind that reported this model (part of the composite identity). */
  engineKind: string
  /** Explicit connection id when associated with a connection. */
  connectionId?: string
  /** Capability declaration when declared or verified. */
  capabilityDeclaration?: ModelCapabilityDeclaration
  /** Last availability observation supplied by the adapter, when known. */
  availability?: ModelAvailability
  /** First observation of this `(engineKind, id)` pair. */
  discoveredAt: string
  /** Last successful observation of this `(engineKind, id)` pair. */
  lastRefreshedAt: string
}

export type ModelRegistryChangeType = 'added' | 'updated' | 'removed'

/** One change produced by a registry update. */
export interface ModelRegistryChange {
  type: ModelRegistryChangeType
  engineKind: string
  connectionId?: string
  modelId: string
  /** Entry after the change; null for `removed`. */
  entry: ModelRegistryEntry | null
  /** Entry before the change; null for `added`. */
  previous: ModelRegistryEntry | null
  /** Top-level fields that changed (empty for add/remove). */
  changedFields: string[]
}

export interface ModelRegistryOptions {
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number
}

/** Model metadata fields compared for change detection (bookkeeping excluded). */
const MODEL_FIELDS = [
  'provider',
  'label',
  'source',
  'connectionId',
  'capabilityDeclaration',
  'capabilities',
  'contextWindow',
  'toolCalling',
  'multimodal',
  'codingCapable',
  'reasoningCapable',
  'costUsdPerMillionTokens',
  'latencyMs',
  'availability',
] as const

/** Defensive deep copy of JSON-safe metadata; never aliases adapter-owned objects. */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = cloneValue(item)
    }
    return copy as T
  }
  return value
}

function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      freezeValue((value as Record<string, unknown>)[key])
    }
  }
  return value
}

function freezeEntry(entry: ModelRegistryEntry): ModelRegistryEntry {
  return freezeValue(entry)
}

function changedFields(previous: ModelRegistryEntry, next: ModelRegistryEntry): string[] {
  const changed: string[] = []
  for (const field of MODEL_FIELDS) {
    if (!isDeepStrictEqual(previous[field], next[field])) changed.push(field)
  }
  return changed
}

function isValidModel(model: unknown): model is EngineModel {
  if (model === null || typeof model !== 'object') return false
  const id = (model as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0
}

function makeCompositeKey(scope: string, modelId: string): string {
  return `${scope}\0${modelId}`
}

export class ModelRegistry {
  private readonly clock: () => number
  /** compositeKey -> frozen entry */
  private readonly entries = new Map<string, ModelRegistryEntry>()

  constructor(options: ModelRegistryOptions = {}) {
    this.clock = options.now ?? Date.now
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString()
  }

  /** Total number of discovered models. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Look up one model by adapter/connection and opaque id.
   */
  get(engineKindOrConnection: string, modelId: string): ModelRegistryEntry | null {
    const direct = this.entries.get(makeCompositeKey(engineKindOrConnection, modelId))
    if (direct !== undefined) return direct

    for (const entry of this.entries.values()) {
      if (
        (entry.engineKind === engineKindOrConnection ||
          entry.connectionId === engineKindOrConnection ||
          entry.provider === engineKindOrConnection) &&
        entry.id === modelId
      ) {
        return entry
      }
    }
    return null
  }

  /**
   * Look up one model specifically by connection id.
   */
  getByConnection(connectionId: string, modelId: string): ModelRegistryEntry | null {
    const direct = this.entries.get(makeCompositeKey(connectionId, modelId))
    if (direct !== undefined && direct.connectionId === connectionId) return direct

    for (const entry of this.entries.values()) {
      if (entry.connectionId === connectionId && entry.id === modelId) {
        return entry
      }
    }
    return null
  }

  /**
   * Entries for one connection, sorted by opaque id.
   */
  listByConnection(connectionId: string): readonly ModelRegistryEntry[] {
    const matches: ModelRegistryEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.connectionId === connectionId) matches.push(entry)
    }
    return Object.freeze(matches.sort(compareEntries))
  }

  /**
   * All entries carrying an opaque model id, across adapters. Returned in
   * deterministic `(engineKind, id)` order.
   */
  findById(modelId: string): readonly ModelRegistryEntry[] {
    const matches: ModelRegistryEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.id === modelId) matches.push(entry)
    }
    return Object.freeze(matches.sort(compareEntries))
  }

  /** Entries for one adapter or connection, sorted by opaque id; all entries when omitted. */
  list(engineKindOrConnection?: string): readonly ModelRegistryEntry[] {
    const matches: ModelRegistryEntry[] = []
    if (engineKindOrConnection === undefined) {
      matches.push(...this.entries.values())
    } else {
      for (const entry of this.entries.values()) {
        if (
          entry.engineKind === engineKindOrConnection ||
          entry.connectionId === engineKindOrConnection ||
          entry.provider === engineKindOrConnection
        ) {
          matches.push(entry)
        }
      }
    }
    return Object.freeze(matches.sort(compareEntries))
  }

  /** Immutable snapshot of the whole inventory in deterministic order. */
  snapshot(): readonly ModelRegistryEntry[] {
    return this.list()
  }

  /**
   * Apply one adapter/connection's complete, successful model list. Models omitted from a
   * successful result are removed. Entries are frozen before storage.
   *
   * A result whose observation time predates the newest stored observation is
   * ignored entirely (stale probe safety) and returns no changes.
   */
  replaceEngineModels(
    engineKind: string,
    models: readonly EngineModel[],
    observedAt = this.nowIso(),
    providerScope?: string,
    connectionId?: string,
  ): ModelRegistryChange[] {
    if (engineKind.length === 0) return []
    const targetScope = connectionId ?? providerScope ?? engineKind

    // Scope check: look for newest observation in this specific scope
    let newest: string | null = null
    for (const entry of this.entries.values()) {
      const entryScope = entry.connectionId ?? entry.provider ?? entry.engineKind
      if (entryScope !== targetScope) continue
      if (newest === null || entry.lastRefreshedAt > newest) newest = entry.lastRefreshedAt
    }
    if (newest !== null && observedAt < newest) return []

    const changes: ModelRegistryChange[] = []
    const seen = new Set<string>()

    for (const model of models) {
      if (!isValidModel(model) || seen.has(model.id)) continue
      seen.add(model.id)

      const key = makeCompositeKey(targetScope, model.id)
      const previous = this.entries.get(key)
      const next = freezeEntry({
        ...cloneValue(model),
        engineKind,
        connectionId: model.connectionId ?? connectionId ?? (providerScope ? targetScope : undefined),
        ...(model.provider ? { provider: model.provider } : providerScope ? { provider: providerScope } : {}),
        availability:
          previous?.availability ??
          (model.availability !== undefined ? cloneValue(model.availability) : undefined),
        discoveredAt: previous?.discoveredAt ?? observedAt,
        lastRefreshedAt: observedAt,
      })
      this.entries.set(key, next)

      if (previous === undefined) {
        changes.push({
          type: 'added',
          engineKind,
          connectionId: next.connectionId,
          modelId: model.id,
          entry: next,
          previous: null,
          changedFields: [],
        })
        continue
      }

      const fields = changedFields(previous, next)
      if (fields.length > 0) {
        changes.push({
          type: 'updated',
          engineKind,
          connectionId: next.connectionId,
          modelId: model.id,
          entry: next,
          previous,
          changedFields: fields,
        })
      }
    }

    // Remove models in this scope that were not in the updated list
    for (const [key, previous] of Array.from(this.entries.entries())) {
      const entryScope = previous.connectionId ?? previous.provider ?? previous.engineKind
      if (entryScope !== targetScope) continue
      if (seen.has(previous.id)) continue

      this.entries.delete(key)
      changes.push({
        type: 'removed',
        engineKind,
        connectionId: previous.connectionId,
        modelId: previous.id,
        entry: null,
        previous,
        changedFields: [],
      })
    }

    return changes
  }

  /**
   * Register or update one model without replacing the adapter's inventory.
   * Returns null for an invalid id, an unchanged observation, or a stale one.
   */
  upsertModel(
    engineKind: string,
    model: EngineModel,
    observedAt = this.nowIso(),
    connectionId?: string,
  ): ModelRegistryChange | null {
    if (engineKind.length === 0 || !isValidModel(model)) return null
    const targetScope = model.connectionId ?? connectionId ?? model.provider ?? engineKind
    const key = makeCompositeKey(targetScope, model.id)
    const previous = this.entries.get(key)
    if (previous !== undefined && observedAt < previous.lastRefreshedAt) return null

    const next = freezeEntry({
      ...cloneValue(model),
      engineKind,
      connectionId: model.connectionId ?? connectionId,
      availability:
        previous?.availability ??
        (model.availability !== undefined ? cloneValue(model.availability) : undefined),
      discoveredAt: previous?.discoveredAt ?? observedAt,
      lastRefreshedAt: observedAt,
    })

    this.entries.set(key, next)

    if (previous === undefined) {
      return {
        type: 'added',
        engineKind,
        connectionId: next.connectionId,
        modelId: model.id,
        entry: next,
        previous: null,
        changedFields: [],
      }
    }

    const fields = changedFields(previous, next)
    if (fields.length === 0) return null
    return {
      type: 'updated',
      engineKind,
      connectionId: next.connectionId,
      modelId: model.id,
      entry: next,
      previous,
      changedFields: fields,
    }
  }

  /**
   * Register a manual model with user-declared capabilities.
   */
  registerManualModel(
    connectionId: string,
    model: EngineModel,
    caps: ModelCapabilityDeclaration,
    observedAt = this.nowIso(),
  ): ModelRegistryChange | null {
    const fullModel: EngineModel = {
      ...model,
      connectionId,
      capabilityDeclaration: caps,
      toolCalling: caps.toolCalling,
      contextWindow: caps.contextWindow,
      codingCapable: caps.coding,
      reasoningCapable: caps.reasoning,
    }
    return this.upsertModel(
      model.provider ?? 'openai-compatible',
      fullModel,
      observedAt,
      connectionId,
    )
  }

  /**
   * Store an availability observation for an already-discovered model.
   * Availability for an unknown model is ignored (the registry never invents
   * inventory from a health probe). Returns null when unchanged or unknown.
   */
  setAvailability(
    engineKindOrConnection: string,
    modelId: string,
    availability: ModelAvailability,
  ): ModelRegistryChange | null {
    let targetKey: string | null = null
    const directKey = makeCompositeKey(engineKindOrConnection, modelId)
    if (this.entries.has(directKey)) {
      targetKey = directKey
    } else {
      for (const [key, entry] of this.entries.entries()) {
        if (
          (entry.engineKind === engineKindOrConnection ||
            entry.connectionId === engineKindOrConnection ||
            entry.provider === engineKindOrConnection) &&
          entry.id === modelId
        ) {
          targetKey = key
          break
        }
      }
    }

    if (targetKey === null) return null
    const previous = this.entries.get(targetKey)!
    if (isDeepStrictEqual(previous.availability, availability)) return null

    const next = freezeEntry({ ...previous, availability: freezeValue(cloneValue(availability)) })
    this.entries.set(targetKey, next)
    return {
      type: 'updated',
      engineKind: previous.engineKind,
      connectionId: previous.connectionId,
      modelId,
      entry: next,
      previous,
      changedFields: ['availability'],
    }
  }

  /** Remove one model explicitly (adapter removal is normally handled by replace). */
  removeModel(engineKindOrConnection: string, modelId: string): ModelRegistryChange | null {
    let targetKey: string | null = null
    const directKey = makeCompositeKey(engineKindOrConnection, modelId)
    if (this.entries.has(directKey)) {
      targetKey = directKey
    } else {
      for (const [key, entry] of this.entries.entries()) {
        if (
          (entry.engineKind === engineKindOrConnection ||
            entry.connectionId === engineKindOrConnection ||
            entry.provider === engineKindOrConnection) &&
          entry.id === modelId
        ) {
          targetKey = key
          break
        }
      }
    }

    if (targetKey === null) return null
    const previous = this.entries.get(targetKey)!
    this.entries.delete(targetKey)
    return {
      type: 'removed',
      engineKind: previous.engineKind,
      connectionId: previous.connectionId,
      modelId,
      entry: null,
      previous,
      changedFields: [],
    }
  }
}

function compareEntries(a: ModelRegistryEntry, b: ModelRegistryEntry): number {
  const connA = a.connectionId ?? ''
  const connB = b.connectionId ?? ''
  if (connA !== connB) return connA.localeCompare(connB)
  if (a.engineKind !== b.engineKind) return a.engineKind.localeCompare(b.engineKind)
  return a.id.localeCompare(b.id)
}
