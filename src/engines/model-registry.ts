import { isDeepStrictEqual } from 'node:util'
import type { EngineModel, ModelAvailability } from './contract/types.ts'

/**
 * Runtime inventory of discovered models (PLUTON 3.2, Phase 2).
 *
 * Identity is composite: `(engineKind, modelId)`. Two adapters may legitimately
 * expose the same opaque model id, so neither part alone is a key. Model ids
 * are stored exactly as the adapter reports them and are never parsed to infer
 * provider, capabilities, cost, or latency.
 *
 * Refresh semantics:
 * - A successful refresh replaces an adapter's inventory and removes entries
 *   the adapter no longer reports (reported as `removed` changes).
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
}

/** A discovered model plus registry bookkeeping. */
export interface ModelRegistryEntry extends EngineModel {
  /** Engine adapter kind that reported this model (part of the composite identity). */
  engineKind: string
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

export class ModelRegistry {
  private readonly clock: () => number
  /** engineKind -> modelId -> frozen entry */
  private readonly byEngine = new Map<string, Map<string, ModelRegistryEntry>>()

  constructor(options: ModelRegistryOptions = {}) {
    this.clock = options.now ?? Date.now
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString()
  }

  /** Total number of discovered `(engineKind, modelId)` entries. */
  get size(): number {
    let total = 0
    for (const models of this.byEngine.values()) total += models.size
    return total
  }

  /**
   * Look up one model by adapter and opaque id. Returns null when that exact
   * pair was never discovered (the same id may still exist under another engine).
   */
  get(engineKind: string, modelId: string): ModelRegistryEntry | null {
    return this.byEngine.get(engineKind)?.get(modelId) ?? null
  }

  /**
   * All entries carrying an opaque model id, across adapters. Returned in
   * deterministic `(engineKind, id)` order.
   */
  findById(modelId: string): readonly ModelRegistryEntry[] {
    const matches: ModelRegistryEntry[] = []
    for (const models of this.byEngine.values()) {
      const entry = models.get(modelId)
      if (entry !== undefined) matches.push(entry)
    }
    return Object.freeze(matches.sort(compareEntries))
  }

  /** Entries for one adapter, sorted by opaque id; all entries when omitted. */
  list(engineKind?: string): readonly ModelRegistryEntry[] {
    const entries: ModelRegistryEntry[] = []
    if (engineKind === undefined) {
      for (const models of this.byEngine.values()) entries.push(...models.values())
    } else {
      const models = this.byEngine.get(engineKind)
      if (models !== undefined) entries.push(...models.values())
    }
    return Object.freeze(entries.sort(compareEntries))
  }

  /** Immutable snapshot of the whole inventory in deterministic order. */
  snapshot(): readonly ModelRegistryEntry[] {
    return this.list()
  }

  /**
   * Apply one adapter's complete, successful model list. Models omitted from a
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
  ): ModelRegistryChange[] {
    if (engineKind.length === 0) return []
    const existing = this.byEngine.get(engineKind)

    if (existing !== undefined) {
      let newest: string | null = null
      for (const entry of existing.values()) {
        if (providerScope !== undefined && entry.provider !== providerScope) continue
        if (newest === null || entry.lastRefreshedAt > newest) newest = entry.lastRefreshedAt
      }
      if (newest !== null && observedAt < newest) return []
    }

    const target = existing ?? new Map<string, ModelRegistryEntry>()
    const changes: ModelRegistryChange[] = []
    const seen = new Set<string>()

    for (const model of models) {
      if (!isValidModel(model) || seen.has(model.id)) continue
      seen.add(model.id)
      const previous = target.get(model.id)
      const next = freezeEntry({
        ...cloneValue(model),
        engineKind,
        ...(model.provider ? { provider: model.provider } : providerScope ? { provider: providerScope } : {}),
        availability:
          previous?.availability ??
          (model.availability !== undefined ? cloneValue(model.availability) : undefined),
        discoveredAt: previous?.discoveredAt ?? observedAt,
        lastRefreshedAt: observedAt,
      })
      target.set(model.id, next)

      if (previous === undefined) {
        changes.push({
          type: 'added',
          engineKind,
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
          modelId: model.id,
          entry: next,
          previous,
          changedFields: fields,
        })
      }
    }

    for (const [modelId, previous] of target) {
      if (providerScope !== undefined && previous.provider !== providerScope) continue
      if (seen.has(modelId)) continue
      target.delete(modelId)
      changes.push({
        type: 'removed',
        engineKind,
        modelId,
        entry: null,
        previous,
        changedFields: [],
      })
    }

    if (target.size === 0) this.byEngine.delete(engineKind)
    else this.byEngine.set(engineKind, target)
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
  ): ModelRegistryChange | null {
    if (engineKind.length === 0 || !isValidModel(model)) return null
    const target = this.byEngine.get(engineKind)
    const previous = target?.get(model.id)
    if (previous !== undefined && observedAt < previous.lastRefreshedAt) return null

    const next = freezeEntry({
      ...cloneValue(model),
      engineKind,
      availability:
        previous?.availability ??
        (model.availability !== undefined ? cloneValue(model.availability) : undefined),
      discoveredAt: previous?.discoveredAt ?? observedAt,
      lastRefreshedAt: observedAt,
    })

    if (previous === undefined) {
      if (target === undefined) this.byEngine.set(engineKind, new Map([[model.id, next]]))
      else target.set(model.id, next)
      return {
        type: 'added',
        engineKind,
        modelId: model.id,
        entry: next,
        previous: null,
        changedFields: [],
      }
    }

    target?.set(model.id, next)
    const fields = changedFields(previous, next)
    if (fields.length === 0) return null
    return {
      type: 'updated',
      engineKind,
      modelId: model.id,
      entry: next,
      previous,
      changedFields: fields,
    }
  }

  /**
   * Store an availability observation for an already-discovered model.
   * Availability for an unknown model is ignored (the registry never invents
   * inventory from a health probe). Returns null when unchanged or unknown.
   */
  setAvailability(
    engineKind: string,
    modelId: string,
    availability: ModelAvailability,
  ): ModelRegistryChange | null {
    const target = this.byEngine.get(engineKind)
    const previous = target?.get(modelId)
    if (target === undefined || previous === undefined) return null
    if (isDeepStrictEqual(previous.availability, availability)) return null

    const next = freezeEntry({ ...previous, availability: freezeValue(cloneValue(availability)) })
    target.set(modelId, next)
    return {
      type: 'updated',
      engineKind,
      modelId,
      entry: next,
      previous,
      changedFields: ['availability'],
    }
  }

  /** Remove one model explicitly (adapter removal is normally handled by replace). */
  removeModel(engineKind: string, modelId: string): ModelRegistryChange | null {
    const target = this.byEngine.get(engineKind)
    const previous = target?.get(modelId)
    if (target === undefined || previous === undefined) return null
    target.delete(modelId)
    if (target.size === 0) this.byEngine.delete(engineKind)
    return {
      type: 'removed',
      engineKind,
      modelId,
      entry: null,
      previous,
      changedFields: [],
    }
  }
}

function compareEntries(a: ModelRegistryEntry, b: ModelRegistryEntry): number {
  if (a.engineKind !== b.engineKind) return a.engineKind.localeCompare(b.engineKind)
  return a.id.localeCompare(b.id)
}
