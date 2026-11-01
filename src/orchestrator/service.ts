import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseDocument, parse as parseYaml } from 'yaml'
import { bootstrapStore, shipSpecs } from '../bootstrap.ts'
import {
  engineHomesDir,
  findManager,
  loadConfig,
  validateConfig,
  workspaceDir,
  type LoadedConfig,
} from '../config/load.ts'
import type { ShipConfig } from '../config/schema.ts'
import {
  ConfigError,
  ConflictError,
  InternalError,
  NotFoundError,
  StateTransitionError,
  ValidationError,
} from '../domain/errors.ts'
import type {
  ApprovalRecord,
  ApprovalStatus,
  EventRecord,
  JsonValue,
  RunRecord,
  ShipRecord,
  TaskRecord,
} from '../domain/models.ts'
import { SHIP_ROLES } from '../domain/models.ts'
import { isPermission } from '../domain/permissions.ts'
import { isTerminalRunState, TERMINAL_TASK_STATES, type RunState } from '../domain/state.ts'
import type { EngineAdapter, McpServerSpec } from '../engines/contract/types.ts'
import { settleApprovalWaiter } from '../engines/interactive-approval.ts'
import { getEngineAdapter, listEngineKinds } from '../engines/registry.ts'
import { ModelRegistry } from '../engines/model-registry.ts'
import { ModelDiscoveryService } from '../engines/model-discovery.ts'
import { ModelHealthMonitor } from '../engines/model-health.ts'
import type { ModelFallbackConfig } from '../engines/model-fallback.ts'
import { resolveModelConfig } from '../config/model-config.ts'
import { nativeAdapterFor } from '../execution/adapter.ts'
import {
  appendExecutionEvent,
  createNativeExecutionProvider,
  nativeSpecForShip,
} from '../execution/factory.ts'
import type { ExecutionBridgeSpec, NativeExecutionProvider } from '../execution/native.ts'
import type { Store } from '../store/store.ts'
import { PlutonToolBridge, toolBridgeLimitsFromRuntime, type ToolBridgeLimits } from '../tools/bridge.ts'
import { bridgeEndpointOf, ToolHttpServer } from '../tools/http-transport.ts'
import { redactProseSecrets } from '../util/redact.ts'
import { stripControlChars } from '../util/sanitize.ts'
import { PLUTON_VERSION } from '../version.ts'
import { GitWorkspaceManager } from '../workspace/manager.ts'
import {
  integrateRun,
  approvalScopeTaskId,
  type IntegrateCommandOptions,
  type IntegrateDeps,
  type IntegrateReport,
} from './integrate.ts'
import {
  runBudgetFromRuntime,
  supervisorSettingsFromRuntime,
  usageBudgetsFromRuntime,
} from './run-setup.ts'
import {
  RunSupervisor,
  type RunOutcome,
  type SupervisorAdapterFactory,
  type WorkerLifecycleEvent,
} from './supervisor.ts'
import { UsageLedger } from './usage-ledger.ts'
import { WakeupRegistry } from './wakeups.ts'

export interface ProjectContext {
  rootDir: string
  configPath: string
  loaded: LoadedConfig
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function runByRef(store: Store, runIdOrSuffix: string): RunRecord {
  const exact = store.getRunOrNull(runIdOrSuffix)
  if (exact) return exact
  const matches = store.listRuns(500).filter((r) => r.id.endsWith(runIdOrSuffix))
  if (matches.length === 1) return matches[0] as RunRecord
  if (matches.length === 0) throw new NotFoundError('run', runIdOrSuffix)
  throw new ValidationError(`ambiguous run id: ${matches.length} runs end with '${runIdOrSuffix}'; use the full id`)
}

export function taskById(store: Store, taskIdOrSuffix: string): TaskRecord {
  const exact = store.getTaskOrNull(taskIdOrSuffix)
  if (exact) return exact
  const suffixMatches: TaskRecord[] = []
  for (const run of store.listRuns(500)) {
    for (const t of store.listTasks(run.id)) {
      if (t.id.endsWith(taskIdOrSuffix)) suffixMatches.push(t)
    }
  }
  if (suffixMatches.length === 1) return suffixMatches[0] as TaskRecord
  if (suffixMatches.length === 0) throw new NotFoundError('task', taskIdOrSuffix)
  throw new ValidationError(
    `ambiguous task id: ${suffixMatches.length} tasks end with '${taskIdOrSuffix}'; use the full id`,
  )
}

export function resolveShipByRef(store: Store, ref: string): ShipRecord {
  const byId = store.getShip(ref)
  if (byId) return byId
  const bySlug = store.listShips().find((m) => m.slug === ref)
  if (bySlug) return bySlug
  throw new NotFoundError('ship', ref)
}

export const resolveMuseByRef = resolveShipByRef

// ---------------------------------------------------------------------------
// Run cancellation and settlement
// ---------------------------------------------------------------------------

export function requestRunCancel(store: Store, runId: string, reason: string): boolean {
  const run = store.getRun(runId)
  if (isTerminalRunState(run.state)) return false
  try {
    store.setRunState(runId, 'cancelled')
  } catch (e) {
    if (!(e instanceof StateTransitionError)) throw e
    if (!isTerminalRunState(store.getRun(runId).state)) throw e
    return false
  }
  store.appendEvent({
    projectId: run.projectId,
    runId,
    type: 'run.cancel_requested',
    payload: { reason, requestedBy: 'operator:signal' },
  })
  return true
}

export function installRunCancelSignals(store: Store, runId: string): () => void {
  const handle = (signal: NodeJS.Signals): void => {
    requestRunCancel(store, runId, `signal:${signal}`)
  }
  const onSigint = (): void => handle('SIGINT')
  const onSigterm = (): void => handle('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
  }
}

export function settleRunCrashed(
  store: Store,
  projectId: string,
  runId: string,
  err: unknown,
  via: 'background_crash' | 'start_failure' = 'background_crash',
): void {
  const raw = stripControlChars((err instanceof Error ? err.message : String(err)).slice(0, 2_000))
  const prefix = via === 'background_crash' ? 'run crashed before completion' : 'supervised start failed'
  let run: RunRecord
  try {
    run = store.getRun(runId)
  } catch {
    return
  }
  if (isTerminalRunState(run.state)) return
  try {
    store.setRunState(runId, 'failed', {
      finalSummary: redactProseSecrets(`${prefix}: ${raw}`).slice(0, 2_000),
    })
  } catch {
    return
  }
  try {
    store.appendEvent({
      projectId,
      runId,
      type: 'run.finished',
      payload: { outcome: 'failure', via, error: redactProseSecrets(raw) },
    })
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Run supervisor creation & Execution
// ---------------------------------------------------------------------------

export interface RunDeps {
  adapterFor?: (ship: ShipRecord) => EngineAdapter
  onWorkerEvent?: (event: WorkerLifecycleEvent) => void
  /** Live-only publish for an already-persisted worker message. */
  onWorkerMessage?: (event: WorkerLifecycleEvent) => void
}

export interface RunSummary {
  runId: string
  state: RunState
  outcome: RunOutcome['outcome'] | null
  taskCounts: Record<string, number>
  managerSummary: string | null
  unfinishedTasks: string[]
  blockedTasks: string[]
  verificationPending: boolean
}

export interface RunCommandOptions {
  goal: string
  acceptance: string[]
  managerRef?: string
  requestId?: string
}

export interface StartRunOptions {
  goal: string
  acceptance: string[]
  managerRef?: string
  requestId?: string
  workspaceRoot?: string | null
  originSessionId?: string | null
}

export interface ResumeRunOptions {
  skipManager?: boolean
}

export function resolveManager(ctx: ProjectContext, store: Store, managerRef: string | undefined): ShipRecord {
  if (managerRef !== undefined) return resolveShipByRef(store, managerRef)
  const found = findManager(ctx.loaded.config)
  if (!found) {
    throw new ConfigError(
      "no Ship with role 'supervisor' in pluton.yaml — add one or pass --manager <ship>",
    )
  }
  const ship = store.getShip(found[0])
  if (!ship) throw new NotFoundError('ship', found[0])
  return ship
}

function outcomeFromRunState(state: RunState): RunOutcome['outcome'] | null {
  switch (state) {
    case 'verifying':
      return 'pending_verification'
    case 'completed':
      return 'success'
    case 'failed':
      return 'failure'
    case 'cancelled':
      return 'cancelled'
    case 'uncertain':
      return 'unknown'
    default:
      return null
  }
}

function summaryFromRecords(store: Store, run: RunRecord): RunSummary {
  const tasks = store.listTasks(run.id)
  const taskCounts: Record<string, number> = {}
  for (const t of tasks) taskCounts[t.state] = (taskCounts[t.state] ?? 0) + 1
  return {
    runId: run.id,
    state: run.state,
    outcome: outcomeFromRunState(run.state),
    taskCounts,
    managerSummary: run.finalSummary,
    unfinishedTasks: tasks.filter((t) => !TERMINAL_TASK_STATES.has(t.state)).map((t) => t.id),
    blockedTasks: tasks
      .filter((t) => !TERMINAL_TASK_STATES.has(t.state) && t.state !== 'verifying')
      .map((t) => t.id),
    verificationPending: run.state === 'verifying',
  }
}

interface RunNativeProvider {
  provider: NativeExecutionProvider
  setRunId: (runId: string) => void
}

function collectRunExtraRoots(
  ctx: ProjectContext,
  additionalRoots: Array<string | null | undefined> = [],
): string[] {
  const extra = new Set<string>()
  const projectRoot = ctx.loaded?.rootDir
  if (projectRoot && existsSync(projectRoot)) {
    const canonicalProj = resolve(projectRoot)
    const canonicalWork = resolve(ctx.rootDir)
    if (canonicalProj.toLowerCase() !== canonicalWork.toLowerCase()) {
      extra.add(canonicalProj)
    }
    const homes = engineHomesDir(canonicalProj)
    try {
      mkdirSync(homes, { recursive: true })
    } catch {}
    if (existsSync(homes) && canonicalProj.toLowerCase() !== canonicalWork.toLowerCase()) {
      extra.add(homes)
    }
  }
  for (const root of additionalRoots) {
    if (root && existsSync(root) && statSync(root).isDirectory()) {
      const canonical = resolve(root)
      if (canonical.toLowerCase() !== resolve(ctx.rootDir).toLowerCase()) {
        extra.add(canonical)
      }
    }
  }
  return Array.from(extra)
}

function createRunNativeProvider(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  extraRoots?: string[],
): RunNativeProvider {
  let runId: string | null = null
  const provider = createNativeExecutionProvider({
    config: ctx.loaded.config,
    rootDir: ctx.rootDir,
    ...(extraRoots !== undefined && extraRoots.length > 0 ? { extraRoots } : {}),
    onEvent: (event) => {
      appendExecutionEvent(store, projectId, runId, event)
    },
  })
  return {
    provider,
    setRunId: (id) => {
      runId = id
    },
  }
}

export function createRunSupervisor(args: {
  ctx: ProjectContext
  store: Store
  projectId: string
  run: RunRecord
  limits: ToolBridgeLimits
  wakeups: WakeupRegistry
  http: ToolHttpServer
  bridgeUrl: string
  executionBridge?: ExecutionBridgeSpec
  nativeProvider?: NativeExecutionProvider | null
  deps: RunDeps
  diagnostic: (line: string) => void
  skipManager?: boolean
}): RunSupervisor {
  const { ctx, store, projectId, run, limits, wakeups, http, bridgeUrl, deps, diagnostic } = args
  const settings = supervisorSettingsFromRuntime(ctx.loaded.config.runtime)
  const budgets = usageBudgetsFromRuntime(ctx.loaded.config.runtime)
  let supervisorAdapterFor: SupervisorAdapterFactory | undefined = deps?.adapterFor
  if (supervisorAdapterFor === undefined && args.nativeProvider != null) {
    const nativeProvider = args.nativeProvider
    const extraAllowedRoots = collectRunExtraRoots(ctx, [run.workspaceRoot])
    supervisorAdapterFor = (ship, session) =>
      nativeAdapterFor(ship, {
        provider: nativeProvider,
        isolatedCheckout: session.isolatedCheckout,
        specFor: (req) =>
          nativeSpecForShip({
            config: ctx.loaded.config,
            rootDir: ctx.rootDir,
            projectId,
            ship,
            workdir: req.workdir,
            engineHome: req.configDir,
            isolatedCheckout: session.isolatedCheckout,
            sessionKind: 'run',
            ...(extraAllowedRoots.length > 0 ? { extraAllowedRoots } : {}),
            ...(args.executionBridge !== undefined ? { bridge: args.executionBridge } : {}),
          }),
      })
  }

  const workspaceManager = new GitWorkspaceManager({ workspacesRoot: workspaceDir(ctx.rootDir) })

  // PLUTON 3.3: wire model intelligence infrastructure into the supervisor.
  const modelRegistry = new ModelRegistry()
  const modelConfig = resolveModelConfig(ctx.loaded.config)
  // The mock adapter is registered for tests/dev, but production runs must
  // never discover or select its models: a mock entry with otherwise-complete
  // metadata would outrank real OpenCode models whose capability metadata is
  // still unknown.
  const discoveryEngines = listEngineKinds()
    .filter((f) => f.devOnly !== true)
    .map((f) => ({
      engineKind: f.kind,
      adapter: getEngineAdapter(f.kind),
    }))
  const modelHealthMonitor = new ModelHealthMonitor({ registry: modelRegistry })
  const discovery = new ModelDiscoveryService({
    engines: discoveryEngines,
    registry: modelRegistry,
    healthMonitor: modelHealthMonitor,
    refreshIntervalMs: (ctx.loaded.config.models && ctx.loaded.config.models.discovery) ? ctx.loaded.config.models.discovery.refreshIntervalMs : 0,
  })
  void discovery.refresh().catch(() => {})
  const modelFallbackConfig: ModelFallbackConfig = {
    maxRetriesPerModel: 2,
    cooldownMs: 300_000,
    maxTotalFallbacks: 5,
    now: Date.now,
  }

  const supervisor = new RunSupervisor({
    store,
    projectId,
    rootDir: ctx.rootDir,
    ...(ctx.loaded?.rootDir ? { projectRootDir: ctx.loaded.rootDir } : {}),
    workspacesRoot: workspaceDir(ctx.rootDir),
    runId: run.id,
    limits,
    maxConcurrentWorkers: settings.maxConcurrentWorkers,
    defaultTaskTimeoutMs: settings.defaultTaskTimeoutMs,
    runDeadlineMs: settings.runDeadlineMs,
    maxRetriesPerTask: settings.maxRetriesPerTask,
    ...(budgets !== undefined ? { usageLedger: new UsageLedger(run.id, budgets, store) } : {}),
    verificationConfigured: ctx.loaded.config.project.verification.length > 0,
    protectedPaths: ctx.loaded.config.git.protected_paths,
    ...(args.skipManager !== undefined ? { skipManager: args.skipManager } : {}),
    ...(supervisorAdapterFor !== undefined ? { adapterFor: supervisorAdapterFor } : {}),
    ...(deps.onWorkerEvent !== undefined ? { onWorkerEvent: deps.onWorkerEvent } : {}),
    ...(deps.onWorkerMessage !== undefined ? { onWorkerMessage: deps.onWorkerMessage } : {}),
    workspaceManager,
    engineEnv: () => ({}),
    modelRegistry,
    modelConfig,
    modelDiscovery: discovery,
    modelHealthMonitor,
    modelFallbackConfig,
    mcpServerFor: (ship, taskId) => {
      const bridge =
        taskId === null
          ? supervisor.managerBridge()
          : new PlutonToolBridge({
              store,
              projectId,
              rootDir: ctx.rootDir,
              runId: run.id,
              callerShipId: ship.id,
              callerTaskId: taskId,
              limits,
              leaseManager: supervisor.leaseManager,
              workspaceManager,
              wakeups,
              messageBus: supervisor.messageBus,
            })
      const { token } = http.register(bridge, {
        shipId: ship.id,
        taskId,
        runId: run.id,
        label: ship.slug,
      })
      const spec: McpServerSpec = {
        kind: 'http',
        name: 'pluton',
        url: bridgeUrl,
        headers: { Authorization: `Bearer ${token}` },
      }
      return spec
    },
    onTaskTeardown: (taskId) => {
      http.unregisterMatching((spec) => spec.taskId === taskId)
    },
    wakeups,
    diagnostic,
  })
  return supervisor
}

export function startRunInBackground(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  opts: StartRunOptions,
  deps: RunDeps = {},
  hooks?: { diagnostic?: (line: string) => void },
): { runId: string; done: Promise<RunSummary> } {
  const goal = opts.goal.trim()
  if (goal === '') {
    throw new ConfigError('--goal is required: describe what the run must achieve')
  }
  const manager = resolveManager(ctx, store, opts.managerRef)
  const runtime = ctx.loaded.config.runtime
  const budget = runBudgetFromRuntime(runtime)

  const effectiveCtx: ProjectContext = opts.workspaceRoot && opts.workspaceRoot !== ctx.rootDir
    ? { ...ctx, rootDir: opts.workspaceRoot }
    : ctx

  const extraRoots = collectRunExtraRoots(effectiveCtx, [ctx.rootDir, opts.workspaceRoot])
  const native = createRunNativeProvider(effectiveCtx, store, projectId, extraRoots)

  const payload: JsonValue = {
    goal,
    acceptanceCriteria: opts.acceptance,
    managerShipId: manager.id,
    budget: { ...budget },
  }
  const createRun = (): RunRecord =>
    store.createRun({
      projectId,
      goal,
      origin: 'cli',
      requestedBy: 'cli',
      acceptanceCriteria: opts.acceptance,
      managerShipId: manager.id,
      budget,
      workspaceRoot: opts.workspaceRoot ?? ctx.rootDir,
      originSessionId: opts.originSessionId,
    })

  let run: RunRecord
  let duplicate = false
  try {
    if (opts.requestId !== undefined) {
      const admitted = store.admitRequest({
        requestId: opts.requestId,
        projectId,
        targetKind: 'run.create',
        payload,
        create: () => {
          const created = createRun()
          return { targetId: created.id, result: { runId: created.id } }
        },
      })
      duplicate = admitted.duplicate
      const targetId = admitted.receipt.targetId
      if (targetId === null) throw new InternalError('run.create receipt has no target id')
      run = store.getRun(targetId)
    } else {
      run = createRun()
    }
  } catch (error) {
    void native.provider.close()
    throw error
  }

  if (duplicate) {
    void native.provider.close()
    store.appendEvent({
      projectId,
      runId: run.id,
      type: 'run.duplicate_request',
      payload: { requestId: opts.requestId ?? null },
    })
    return {
      runId: run.id,
      done: Promise.resolve(summaryFromRecords(store, run)),
    }
  }
  native.setRunId(run.id)

  const done = (async (): Promise<RunSummary> => {
    try {
      const limits = toolBridgeLimitsFromRuntime(runtime)
      const wakeups = new WakeupRegistry()
      const http = new ToolHttpServer({
        serverName: 'pluton-tools',
        serverVersion: PLUTON_VERSION,
        ...(process.platform === 'linux' ? { unixSocket: true } : {}),
      })
      const started = await http.start()
      const bridgeUrl = `${http.url as string}mcp`

      try {
        const supervisor = createRunSupervisor({
          ctx: effectiveCtx,
          store,
          projectId,
          run,
          limits,
          wakeups,
          http,
          bridgeUrl,
          ...(bridgeEndpointOf(started) !== undefined
            ? { executionBridge: bridgeEndpointOf(started) }
            : {}),
          nativeProvider: native.provider,
          deps,
          diagnostic: hooks?.diagnostic ?? ((line) => {
            process.stderr.write(`run ${run.id}: ${line}\n`)
          }),
        })
        const outcome = await supervisor.runToCompletion()
        return {
          runId: outcome.runId,
          state: outcome.state,
          outcome: outcome.outcome,
          taskCounts: outcome.taskCounts,
          managerSummary: outcome.managerSummary,
          unfinishedTasks: outcome.unfinishedTasks,
          blockedTasks: outcome.blockedTasks,
          verificationPending: outcome.state === 'verifying',
        }
      } finally {
        await http.stop()
      }
    } finally {
      await native.provider.close()
    }
  })()

  return { runId: run.id, done }
}

export async function runRun(
  ctx: ProjectContext,
  opts: RunCommandOptions,
  deps: RunDeps = {},
): Promise<RunSummary> {
  const goal = opts.goal.trim()
  if (goal === '') {
    throw new ConfigError('--goal is required: describe what the run must achieve')
  }
  const { store, projectId } = bootstrapStore(ctx.loaded)
  let native: RunNativeProvider | null = null
  try {
    const manager = resolveManager(ctx, store, opts.managerRef)
    const runtime = ctx.loaded.config.runtime
    const budget = runBudgetFromRuntime(runtime)

    const extraRoots = collectRunExtraRoots(ctx)
    native = createRunNativeProvider(ctx, store, projectId, extraRoots)

    const payload: JsonValue = {
      goal,
      acceptanceCriteria: opts.acceptance,
      managerShipId: manager.id,
      budget: { ...budget },
    }
    const createRun = (): RunRecord =>
      store.createRun({
        projectId,
        goal,
        origin: 'cli',
        requestedBy: 'cli',
        acceptanceCriteria: opts.acceptance,
        managerShipId: manager.id,
        budget,
        workspaceRoot: ctx.rootDir,
      })

    let run: RunRecord
    let duplicate = false
    if (opts.requestId !== undefined) {
      const admitted = store.admitRequest({
        requestId: opts.requestId,
        projectId,
        targetKind: 'run.create',
        payload,
        create: () => {
          const created = createRun()
          return { targetId: created.id, result: { runId: created.id } }
        },
      })
      duplicate = admitted.duplicate
      const targetId = admitted.receipt.targetId
      if (targetId === null) throw new InternalError('run.create receipt has no target id')
      run = store.getRun(targetId)
    } else {
      run = createRun()
    }

    if (duplicate) {
      store.appendEvent({
        projectId,
        runId: run.id,
        type: 'run.duplicate_request',
        payload: { requestId: opts.requestId ?? null },
      })
      return summaryFromRecords(store, run)
    }
    native.setRunId(run.id)

    const limits = toolBridgeLimitsFromRuntime(runtime)
    const wakeups = new WakeupRegistry()
    const http = new ToolHttpServer({
      serverName: 'pluton-tools',
      serverVersion: PLUTON_VERSION,
      ...(process.platform === 'linux' ? { unixSocket: true } : {}),
    })
    const started = await http.start()
    const bridgeUrl = `${http.url as string}mcp`
    try {
      const supervisor = createRunSupervisor({
        ctx,
        store,
        projectId,
        run,
        limits,
        wakeups,
        http,
        bridgeUrl,
        ...(bridgeEndpointOf(started) !== undefined
          ? { executionBridge: bridgeEndpointOf(started) }
          : {}),
        nativeProvider: native.provider,
        deps,
        diagnostic: (line) => {
          process.stderr.write(`run ${run.id}: ${line}\n`)
        },
      })
      const dispose = installRunCancelSignals(store, run.id)
      let outcome: RunOutcome
      try {
        outcome = await supervisor.runToCompletion()
      } finally {
        dispose()
      }
      return {
        runId: outcome.runId,
        state: outcome.state,
        outcome: outcome.outcome,
        taskCounts: outcome.taskCounts,
        managerSummary: outcome.managerSummary,
        unfinishedTasks: outcome.unfinishedTasks,
        blockedTasks: outcome.blockedTasks,
        verificationPending: outcome.state === 'verifying',
      }
    } finally {
      await http.stop()
    }
  } finally {
    await native?.provider.close()
    store.close()
  }
}

export async function resumeRun(
  ctx: ProjectContext,
  runId: string,
  opts: ResumeRunOptions = {},
  deps: RunDeps = {},
): Promise<RunSummary> {
  const { store, projectId } = bootstrapStore(ctx.loaded)
  let native: RunNativeProvider | null = null
  try {
    const run = store.getRun(runId)
    if (isTerminalRunState(run.state)) {
      throw new ValidationError(`run ${runId} is '${run.state}'; cannot resume a terminated run`)
    }

    const effectiveCtx: ProjectContext = run.workspaceRoot && run.workspaceRoot !== ctx.rootDir
      ? { ...ctx, rootDir: run.workspaceRoot }
      : ctx

    const runtime = effectiveCtx.loaded.config.runtime
    const extraRoots = collectRunExtraRoots(effectiveCtx, [ctx.rootDir, run.workspaceRoot])
    native = createRunNativeProvider(effectiveCtx, store, projectId, extraRoots)
    native.setRunId(run.id)

    const limits = toolBridgeLimitsFromRuntime(runtime)
    const wakeups = new WakeupRegistry()
    const http = new ToolHttpServer({
      serverName: 'pluton-tools',
      serverVersion: PLUTON_VERSION,
      ...(process.platform === 'linux' ? { unixSocket: true } : {}),
    })
    const started = await http.start()
    const bridgeUrl = `${http.url as string}mcp`

    try {
      const supervisor = createRunSupervisor({
        ctx: effectiveCtx,
        store,
        projectId,
        run,
        limits,
        wakeups,
        http,
        bridgeUrl,
        ...(bridgeEndpointOf(started) !== undefined
          ? { executionBridge: bridgeEndpointOf(started) }
          : {}),
        nativeProvider: native.provider,
        deps,
        skipManager: opts.skipManager ?? true,
        diagnostic: (line) => {
          process.stderr.write(`run ${run.id}: ${line}\n`)
        },
      })
      const outcome = await supervisor.runToCompletion()
      return {
        runId: outcome.runId,
        state: outcome.state,
        outcome: outcome.outcome,
        taskCounts: outcome.taskCounts,
        managerSummary: outcome.managerSummary,
        unfinishedTasks: outcome.unfinishedTasks,
        blockedTasks: outcome.blockedTasks,
        verificationPending: outcome.state === 'verifying',
      }
    } finally {
      await http.stop()
    }
  } finally {
    await native?.provider.close()
    store.close()
  }
}

// ---------------------------------------------------------------------------
// Ship Management (createShip)
// ---------------------------------------------------------------------------

export interface CreateShipSpec {
  id: string
  displayName?: string
  role?: string
  engine: string
  model: string
  instructionsFile?: string
  workspacePolicy?: string
  approvalMode?: string
  permissions?: string[]
}

export function createShip(ctx: ProjectContext, spec: CreateShipSpec): { configPath: string; ship: ShipConfig } {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(spec.id)) {
    throw new ValidationError(
      `invalid ship id '${spec.id}': ids are lowercase slugs (a-z, 0-9, -), starting with a letter`,
    )
  }
  if (ctx.loaded.config.ships[spec.id]) {
    throw new ValidationError(`ship '${spec.id}' already exists in pluton.yaml`)
  }
  getEngineAdapter(spec.engine)
  if (spec.role !== undefined && !(SHIP_ROLES as readonly string[]).includes(spec.role)) {
    throw new ValidationError(`unknown role '${spec.role}'; known roles: ${SHIP_ROLES.join(', ')}`)
  }
  for (const p of spec.permissions ?? []) {
    if (!isPermission(p)) throw new ValidationError(`unknown permission '${p}' (see docs/SHIPS_CONFIGURATION.md)`)
  }

  const role = (spec.role as ShipConfig['role']) ?? 'custom'
  const defaultWorkspace: ShipConfig['workspace_policy'] =
    role === 'supervisor' ? 'coordinator-read-only' : 'isolated-task-checkout'

  const ship: ShipConfig = {
    display_name: spec.displayName ?? spec.id,
    role,
    engine: spec.engine,
    model: spec.model,
    workspace_policy: (spec.workspacePolicy as ShipConfig['workspace_policy']) ?? defaultWorkspace,
    approval_mode: (spec.approvalMode as ShipConfig['approval_mode']) ?? 'ask-for-sensitive-actions',
    ...(spec.instructionsFile ? { instructions_file: spec.instructionsFile } : {}),
    ...(spec.permissions ? { permissions: spec.permissions as ShipConfig['permissions'] } : {}),
  }

  const doc = parseDocument(readFileSync(ctx.configPath, 'utf8'))
  const key = doc.has('ships') ? 'ships' : 'muses'
  doc.setIn([key, spec.id], ship)
  const nextRaw = parseYaml(doc.toString())
  validateConfig(nextRaw, ctx.rootDir, ctx.configPath)
  writeFileSync(ctx.configPath, doc.toString({ lineWidth: 0 }))

  return { configPath: ctx.configPath, ship }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface ApprovalDecideOptions {
  approvalRef: string
  decision: 'approve' | 'deny'
  requestId?: string
  autoContinue?: boolean
}

export interface ApprovalDecideDeps {
  integrateRunFn?: (ctx: ProjectContext, opts: IntegrateCommandOptions) => Promise<IntegrateReport>
  resumeRunFn?: (ctx: ProjectContext, runId: string, opts?: ResumeRunOptions) => Promise<RunSummary>
}

export interface ApprovalDecideReport {
  approval: { id: string; action: string; status: 'approved' | 'denied'; decidedBy: string; decidedAt: string }
  applied: {
    shipId: string
    museId?: string
    configPath: string
    container: { containerName: string; created: boolean } | null
    containerWarning: string | null
  } | null
  integrationReport: IntegrateReport | null
  run: {
    id: string
    stateBefore: RunState
    stateAfter: RunState
    resumed: boolean
    parked: boolean
    recordedOutcome: string | null
    resumeSummary?: RunSummary | null
  } | null
  expiredSwept: string[]
}

export function sweepExpiredApprovals(store: Store, projectId: string, nowIso: string): ApprovalRecord[] {
  const swept = store.expirePendingApprovals(nowIso, projectId)
  for (const row of swept) {
    store.appendEvent({
      projectId,
      runId: row.runId,
      taskId: row.taskId,
      type: 'approval.expired',
      payload: { approvalId: row.id, action: row.action, expiresAt: row.expiresAt },
    })
    settleApprovalWaiter(row.id, 'expired', 'expiry')
  }
  return swept
}

function resolveApprovalByRef(store: Store, projectId: string, ref: string): ApprovalRecord {
  const exact = store.getApprovalOrNull(ref)
  if (exact !== null) {
    if (exact.projectId !== projectId) throw new NotFoundError('approval', ref)
    return exact
  }
  const matches = store.listApprovalsByProject(projectId, { limit: 1_000 }).filter((a) => a.id.endsWith(ref))
  if (matches.length === 1) return matches[0] as ApprovalRecord
  if (matches.length === 0) throw new NotFoundError('approval', ref)
  throw new ConflictError(`ambiguous approval id: ${matches.length} approvals end with '${ref}'; use the full id`, {
    ref,
  })
}

function parseShipCreateScope(approval: ApprovalRecord): {
  shipId: string
  displayName: string
  role: string
  engine: string
  model: string
} {
  const record =
    approval.scope !== null && typeof approval.scope === 'object' && !Array.isArray(approval.scope)
      ? (approval.scope as Record<string, JsonValue>)
      : null
  if (record === null) {
    throw new ValidationError(
      `approval ${approval.id} has a malformed ship.create scope: expected an object with shipId (or legacy museId), displayName, role, engine, model`,
    )
  }
  const field = (key: string): string => {
    const value = record[key]
    if (typeof value !== 'string' || value.length === 0) {
      throw new ValidationError(
        `approval ${approval.id} has a malformed ship.create scope: '${key}' must be a non-empty string`,
      )
    }
    return value
  }
  const shipId = (record['shipId'] as string | undefined) ?? field('museId')
  return {
    shipId,
    displayName: field('displayName'),
    role: field('role'),
    engine: field('engine'),
    model: field('model'),
  }
}

function recordedOutcomeFrom(event: EventRecord | undefined): string | null {
  if (event === undefined) return null
  const payload = event.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const outcome = (payload as Record<string, JsonValue>)['outcome']
  return outcome === undefined || outcome === null ? null : String(outcome)
}

async function applyShipCreate(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  approval: ApprovalRecord,
): Promise<NonNullable<ApprovalDecideReport['applied']>> {
  const scope = parseShipCreateScope(approval)
  const created = createShip(ctx, {
    id: scope.shipId,
    displayName: scope.displayName,
    role: scope.role,
    engine: scope.engine,
    model: scope.model,
  })
  const reloaded = loadConfig(ctx.rootDir)
  store.syncShips(projectId, shipSpecs(reloaded))
  const ship = store.getShip(scope.shipId)
  if (ship === null) {
    throw new InternalError(`approved ship '${scope.shipId}' disappeared after syncing the store`)
  }
  mkdirSync(ship.engineHome, { recursive: true })
  const isLegacyMuse = approval.action === 'muse.create'
  store.appendEvent({
    projectId,
    runId: approval.runId,
    type: isLegacyMuse ? 'muse.applied_from_proposal' : 'ship.applied_from_proposal',
    payload: {
      approvalId: approval.id,
      shipId: scope.shipId,
      museId: scope.shipId,
      engine: scope.engine,
      configPath: created.configPath,
    },
  })

  return {
    shipId: scope.shipId,
    museId: scope.shipId,
    configPath: created.configPath,
    container: null,
    containerWarning: null,
  }
}

function unParkRun(
  store: Store,
  projectId: string,
  approval: ApprovalRecord,
  runBefore: RunRecord,
): NonNullable<ApprovalDecideReport['run']> {
  const stateBefore = runBefore.state
  let stateAfter = stateBefore
  let resumed = false
  let parked = false
  let recordedOutcome: string | null = null
  if (stateBefore === 'awaiting_approval') {
    const stillPending = store.listApprovals(runBefore.id).some((a) => a.status === 'pending')
    if (!stillPending) {
      const finished = store.listEvents(runBefore.id, { type: 'run.finished', limit: 1 })
      if (finished.length === 0) {
        try {
          stateAfter = store.setRunState(runBefore.id, 'active').state
          resumed = true
          store.appendEvent({
            projectId,
            runId: runBefore.id,
            type: 'run.resumed_after_approval',
            payload: { approvalId: approval.id },
          })
        } catch (e) {
          if (!(e instanceof StateTransitionError)) throw e
          const fresh = store.getRun(runBefore.id)
          if (!isTerminalRunState(fresh.state)) throw e
          stateAfter = fresh.state
          const lateFinished = store.listEvents(runBefore.id, { type: 'run.finished', limit: 1 })
          if (lateFinished.length > 0) {
            parked = true
            recordedOutcome = recordedOutcomeFrom(lateFinished[0])
          }
        }
      } else {
        parked = true
        recordedOutcome = recordedOutcomeFrom(finished[0])
      }
    }
  }
  return { id: runBefore.id, stateBefore, stateAfter, resumed, parked, recordedOutcome }
}

function reportFromCurrentRows(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  approvalId: string,
  expiredSwept: string[],
): ApprovalDecideReport {
  const current = store.getApproval(approvalId)
  if (current.status !== 'approved' && current.status !== 'denied') {
    throw new ConflictError(
      `approval ${current.id} is ${current.status}; the recorded decision request did not settle it`,
      { approvalId: current.id, status: current.status },
    )
  }
  let applied: ApprovalDecideReport['applied'] = null
  if ((current.action === 'ship.create' || current.action === 'muse.create') && current.status === 'approved') {
    const scope = parseShipCreateScope(current)
    const sandbox = store.getSandboxForShip(projectId, scope.shipId)
    applied = {
      shipId: scope.shipId,
      configPath: ctx.configPath,
      container:
        sandbox !== null && sandbox.containerName !== null
          ? { containerName: sandbox.containerName, created: false }
          : null,
      containerWarning: null,
    }
  }
  let run: ApprovalDecideReport['run'] = null
  if (current.runId !== null) {
    const record = store.getRun(current.runId)
    const stillPending = store.listApprovals(record.id).some((a) => a.status === 'pending')
    const finished = store.listEvents(record.id, { type: 'run.finished', limit: 1 })
    run = {
      id: record.id,
      stateBefore: record.state,
      stateAfter: record.state,
      resumed: false,
      parked: record.state === 'awaiting_approval' && !stillPending,
      recordedOutcome: recordedOutcomeFrom(finished[0]),
    }
  }
  return {
    approval: {
      id: current.id,
      action: current.action,
      status: current.status,
      decidedBy: current.decidedBy ?? 'operator',
      decidedAt: current.decidedAt ?? current.createdAt,
    },
    applied,
    integrationReport: null,
    run,
    expiredSwept,
  }
}

export async function decideApproval(
  ctx: ProjectContext,
  opts: ApprovalDecideOptions,
  deps: ApprovalDecideDeps = {},
): Promise<ApprovalDecideReport> {
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const now = new Date().toISOString()
    const expiredSwept = sweepExpiredApprovals(store, projectId, now).map((row) => row.id)

    const approval = resolveApprovalByRef(store, projectId, opts.approvalRef)

    if (opts.requestId !== undefined) {
      const admitted = store.admitRequest({
        requestId: opts.requestId,
        projectId,
        targetKind: 'approval.decide',
        payload: { approvalId: approval.id, decision: opts.decision },
        create: () => ({
          targetId: approval.id,
          result: { approvalId: approval.id, decision: opts.decision },
        }),
      })
      if (admitted.duplicate) {
        return reportFromCurrentRows(ctx, store, projectId, approval.id, expiredSwept)
      }
    }

    if (approval.status !== 'pending') {
      throw new ConflictError(`approval ${approval.id} is already ${approval.status}`, {
        approvalId: approval.id,
        status: approval.status,
      })
    }

    const runBefore = approval.runId !== null ? store.getRun(approval.runId) : null

    const decided = store.setApprovalStatus(approval.id, opts.decision === 'approve' ? 'approved' : 'denied', {
      decidedBy: 'operator',
    })
    store.appendEvent({
      projectId,
      runId: approval.runId,
      taskId: approval.taskId,
      type: 'approval.decided',
      payload: { approvalId: approval.id, action: approval.action, status: decided.status },
    })

    settleApprovalWaiter(decided.id, decided.status, 'decision')

    let applied: ApprovalDecideReport['applied'] = null
    if (decided.status === 'approved' && (decided.action === 'ship.create' || decided.action === 'muse.create')) {
      applied = await applyShipCreate(ctx, store, projectId, decided)
    }

    const run = runBefore !== null ? unParkRun(store, projectId, decided, runBefore) : null

    let integrationReport: IntegrateReport | null = null
    if (decided.status === 'approved' && decided.action === 'integration.apply' && opts.autoContinue) {
      const scopeTaskId = approvalScopeTaskId(decided.scope)
      if (decided.runId !== null && scopeTaskId !== null) {
        store.close()
        const integrateFn = deps.integrateRunFn ?? integrateRun
        integrationReport = await integrateFn(ctx, { runRef: decided.runId, taskRefs: [scopeTaskId] })
      }
    }

    if (run !== null && run.resumed && opts.autoContinue) {
      store.close()
      const resumeFn = deps.resumeRunFn ?? resumeRun
      try {
        run.resumeSummary = await resumeFn(ctx, run.id, { skipManager: true })
      } catch (e) {
        if (e instanceof ConflictError && e.code === 'request_conflict') {
          run.resumeSummary = null
        } else {
          throw e
        }
      }
    }

    return {
      approval: {
        id: decided.id,
        action: decided.action,
        status: decided.status === 'approved' ? 'approved' : 'denied',
        decidedBy: decided.decidedBy ?? 'operator',
        decidedAt: decided.decidedAt ?? now,
      },
      applied,
      integrationReport,
      run,
      expiredSwept,
    }
  } finally {
    store.close()
  }
}
