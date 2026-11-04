import type { EngineAdapter, EngineModel } from './contract/types.ts'
import { ModelRegistry, type ModelRegistryChange } from './model-registry.ts'
import type { ModelHealthMonitor } from './model-health.ts'
import { getEngineAdapter, listEngineKinds, type EngineCreateOptions } from './registry.ts'

/**
 * Adapter-driven model discovery (PLUTON 3.2, Phase 2).
 *
 * Every registered adapter remains the source of truth for the models it
 * offers. Discovery never parses ids, never infers capabilities from names, and
 * never treats a successful list as proof that the provider is healthy.
 *
 * Failure isolation is per adapter: a probe that throws leaves that adapter's
 * previous inventory untouched while every other adapter's result is applied.
 */

export interface ModelDiscoveryEngine {
  /** Stable engine adapter kind (part of the registry's composite identity). */
  engineKind: string
  /** Explicit provider identifier when this probe targets a specific provider. */
  providerId?: string
  /** Explicit connection identifier when this probe targets a specific connection. */
  connectionId?: string
  adapter: EngineAdapter
}

export interface ModelDiscoveryTimers {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

export interface ModelDiscoveryOptions {
  /** Adapters to probe. Duplicate kinds are collapsed (last one wins). */
  engines: Iterable<ModelDiscoveryEngine>
  /** Registry to populate; a fresh one is created when omitted. */
  registry?: ModelRegistry
  /** Health monitor to update when models recover on rediscovery; optional. */
  healthMonitor?: ModelHealthMonitor
  /** Periodic refresh cadence in ms; 0 or omitted disables periodic refresh. */
  refreshIntervalMs?: number
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number
  /** Injectable timers for deterministic lifecycle tests. */
  timers?: ModelDiscoveryTimers
}

/** Outcome for one adapter probe. */
export interface EngineDiscoveryResult {
  engineKind: string
  providerId?: string
  connectionId?: string
  /** False when the adapter threw or its result could not be applied. */
  ok: boolean
  /** Number of valid models reported by the adapter this pass. */
  modelCount: number
  /** Entries discarded because they lacked a non-empty opaque id. */
  invalidCount: number
  /** Isolated error text when `ok` is false. */
  error?: string
  /** Registry changes applied for this adapter (empty when `ok` is false). */
  changes: ModelRegistryChange[]
  startedAt: string
  finishedAt: string
}

export interface ModelDiscoveryReport {
  startedAt: string
  finishedAt: string
  results: EngineDiscoveryResult[]
  /** Flattened changes across all adapters, in adapter order. */
  changes: ModelRegistryChange[]
  /** True when this caller joined an in-flight refresh instead of starting one. */
  coalesced: boolean
}

interface EngineProbe {
  engineKind: string
  providerId?: string
  connectionId?: string
  ok: boolean
  models: EngineModel[]
  invalidCount: number
  error?: string
  startedAt: string
  finishedAt: string
}

const DEFAULT_TIMERS: ModelDiscoveryTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

function unrefHandle(handle: unknown): void {
  if (handle === null || typeof handle !== 'object' || !('unref' in handle)) return
  const unref = (handle as { unref?: unknown }).unref
  if (typeof unref === 'function') unref.call(handle)
}

function validModels(models: unknown): { models: EngineModel[]; invalidCount: number } {
  if (!Array.isArray(models)) {
    throw new TypeError('listModels() did not return an array')
  }
  const valid: EngineModel[] = []
  let invalidCount = 0
  for (const model of models) {
    if (
      model !== null &&
      typeof model === 'object' &&
      typeof (model as { id?: unknown }).id === 'string' &&
      (model as { id: string }).id.length > 0
    ) {
      valid.push(model as EngineModel)
    } else {
      invalidCount += 1
    }
  }
  return { models: valid, invalidCount }
}

export class ModelDiscoveryService {
  readonly registry: ModelRegistry
  private readonly engines: ModelDiscoveryEngine[]
  private readonly healthMonitor: ModelHealthMonitor | null
  private readonly intervalMs: number
  private readonly clock: () => number
  private readonly timers: ModelDiscoveryTimers
  private inFlight: Promise<ModelDiscoveryReport> | null = null
  private timer: unknown = null

  constructor(options: ModelDiscoveryOptions) {
    const byKey = new Map<string, ModelDiscoveryEngine>()
    for (const engine of options.engines) {
      if (typeof engine.engineKind !== 'string' || engine.engineKind.length === 0) continue
      if (typeof engine.adapter?.listModels !== 'function') continue
      const key = engine.providerId ? `${engine.engineKind}:${engine.providerId}` : engine.engineKind
      byKey.set(key, engine)
    }
    this.engines = [...byKey.values()]
    this.registry = options.registry ?? new ModelRegistry({ now: options.now })
    this.healthMonitor = options.healthMonitor ?? null
    this.intervalMs = options.refreshIntervalMs ?? 0
    this.clock = options.now ?? Date.now
    this.timers = options.timers ?? DEFAULT_TIMERS
  }

  /** Adapter kinds this service will probe, in registration order. */
  get engineKinds(): readonly string[] {
    return Object.freeze([...new Set(this.engines.map((engine) => engine.engineKind))])
  }

  /** True while a refresh is in flight. */
  get discovering(): boolean {
    return this.inFlight !== null
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString()
  }

  /**
   * Discover every adapter and apply the results. Concurrent callers join the
   * in-flight refresh (`coalesced: true`) rather than probing twice. Per-adapter
   * failures are reported, never thrown; the returned promise rejects only on
   * an unexpected registry/programming error.
   */
  refresh(): Promise<ModelDiscoveryReport> {
    if (this.inFlight !== null) {
      return this.inFlight.then((report) => ({ ...report, coalesced: true }))
    }
    const startedAt = this.nowIso()
    const run = this.runRefresh(startedAt).finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  /** Alias for the initial discovery pass. */
  discoverAll(): Promise<ModelDiscoveryReport> {
    return this.refresh()
  }

  private async probe(engine: ModelDiscoveryEngine): Promise<EngineProbe> {
    const startedAt = this.nowIso()
    try {
      const listed = await engine.adapter.listModels()
      const { models, invalidCount } = validModels(listed)
      if (engine.connectionId !== undefined) {
        for (const m of models) {
          m.connectionId = engine.connectionId
        }
      }
      return {
        engineKind: engine.engineKind,
        ...(engine.providerId !== undefined ? { providerId: engine.providerId } : {}),
        ...(engine.connectionId !== undefined ? { connectionId: engine.connectionId } : {}),
        ok: true,
        models,
        invalidCount,
        startedAt,
        finishedAt: this.nowIso(),
      }
    } catch (error) {
      return {
        engineKind: engine.engineKind,
        ...(engine.providerId !== undefined ? { providerId: engine.providerId } : {}),
        ...(engine.connectionId !== undefined ? { connectionId: engine.connectionId } : {}),
        ok: false,
        models: [],
        invalidCount: 0,
        error: errorText(error),
        startedAt,
        finishedAt: this.nowIso(),
      }
    }
  }

  private async runRefresh(startedAt: string): Promise<ModelDiscoveryReport> {
    const probes = await Promise.all(this.engines.map((engine) => this.probe(engine)))
    const results: EngineDiscoveryResult[] = []
    const changes: ModelRegistryChange[] = []

    // Apply phase is synchronous. Each adapter is applied independently so one
    // malformed result can never roll back another adapter's successful probe.
    for (const probe of probes) {
      let ok = probe.ok
      let error = probe.error
      let applied: ModelRegistryChange[] = []
      if (ok) {
        try {
          applied = this.registry.replaceEngineModels(
            probe.engineKind,
            probe.models,
            probe.finishedAt,
            probe.providerId,
            probe.connectionId,
          )
          if (this.healthMonitor !== null) {
            for (const model of probe.models) {
              const currentHealth = this.healthMonitor.getModelHealth(probe.engineKind, model.id)
              if (currentHealth.state === 'unavailable') {
                this.healthMonitor.recordSuccess({
                  engineKind: probe.engineKind,
                  modelId: model.id,
                })
              }
            }
          }
        } catch (applyError) {
          ok = false
          error = `registry update failed: ${errorText(applyError)}`
          applied = []
        }
      }
      results.push({
        engineKind: probe.engineKind,
        ...(probe.providerId !== undefined ? { providerId: probe.providerId } : {}),
        ...(probe.connectionId !== undefined ? { connectionId: probe.connectionId } : {}),
        ok,
        modelCount: probe.models.length,
        invalidCount: probe.invalidCount,
        error,
        changes: applied,
        startedAt: probe.startedAt,
        finishedAt: probe.finishedAt,
      })
      changes.push(...applied)
    }

    return {
      startedAt,
      finishedAt: this.nowIso(),
      results,
      changes,
      coalesced: false,
    }
  }

  /**
   * Start periodic refresh (when configured) and perform one initial discovery.
   * The timer is unref'd when the runtime supports it, so discovery never keeps
   * the process alive on its own. Resolves to the initial report.
   */
  async start(): Promise<ModelDiscoveryReport> {
    if (this.timer === null && this.intervalMs > 0) {
      const handle = this.timers.setInterval(() => {
        void this.refresh().catch(() => {
          // Background refresh is best-effort; the next tick retries.
        })
      }, this.intervalMs)
      unrefHandle(handle)
      this.timer = handle
    }
    return this.refresh()
  }

  /** Stop periodic refresh; idempotent. An in-flight pass is allowed to finish. */
  stop(): void {
    if (this.timer === null) return
    this.timers.clearInterval(this.timer)
    this.timer = null
  }
}

export interface RegisteredModelDiscoveryOptions {
  /** Restrict discovery to these engine kinds; default: every registered engine. */
  only?: readonly string[]
  /**
   * Include engines registered as `devOnly` (the deterministic mock adapter).
   * Default false: production selection must never see a dev-only model.
   * Naming a dev-only kind explicitly in `only` opts it in for tests/tools.
   */
  includeDevOnly?: boolean
  /** Options threaded to real adapter factories (binary pinning, spawn fakes). */
  createOptions?: EngineCreateOptions
  registry?: ModelRegistry
  healthMonitor?: ModelHealthMonitor
  refreshIntervalMs?: number
  now?: () => number
  timers?: ModelDiscoveryTimers
}

/**
 * Compose a discovery service from the existing engine-factory registry.
 * Construction is side-effect free: no process is spawned and no timer runs
 * until `refresh()` or `start()` is called.
 */
export function registeredEngineModelDiscovery(
  options: RegisteredModelDiscoveryOptions = {},
): ModelDiscoveryService {
  const { only, createOptions, ...rest } = options
  const allowed = only === undefined ? null : new Set(only)
  const engines = listEngineKinds()
    .filter((factory) => allowed === null || allowed.has(factory.kind))
    .filter(
      (factory) =>
        factory.devOnly !== true ||
        options.includeDevOnly === true ||
        (allowed !== null && allowed.has(factory.kind)),
    )
    .map((factory) => ({
      engineKind: factory.kind,
      adapter: getEngineAdapter(factory.kind, createOptions),
    }))
  return new ModelDiscoveryService({ ...rest, engines })
}
