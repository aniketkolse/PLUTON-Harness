import { bootstrapStore } from '../../bootstrap.ts'
import { findManager, workspaceDir } from '../../config/load.ts'
import {
  ConfigError,
  InternalError,
  NotFoundError,
  SandboxUnavailableError,
  StateTransitionError,
  ValidationError,
} from '../../domain/errors.ts'
import type { JsonValue, ShipRecord, RunRecord } from '../../domain/models.ts'
import { isTerminalRunState, TERMINAL_TASK_STATES, type RunState } from '../../domain/state.ts'
import { redactProseSecrets } from '../../util/redact.ts'
import { stripControlChars } from '../../util/sanitize.ts'
import type { AcpSpawnFn } from '../../engines/acp/client.ts'
import { engineAdapterForShip, type EngineIsolationFacts } from '../../engines/approval.ts'
import type { EngineAdapter, McpServerSpec } from '../../engines/contract/types.ts'
import { dockerExecSpawn, mapHostPathToContainer, type DockerExecContext } from '../../engines/docker-exec.ts'
import { nativeAdapterFor } from '../../execution/adapter.ts'
import {
  appendExecutionEvent,
  createNativeExecutionProvider,
  nativeSpecForShip,
} from '../../execution/factory.ts'
import type { NativeExecutionProvider } from '../../execution/native.ts'
import {
  runBudgetFromRuntime,
  supervisorSettingsFromRuntime,
  usageBudgetsFromRuntime,
} from '../../orchestrator/run-setup.ts'
import { UsageLedger } from '../../orchestrator/usage-ledger.ts'
import {
  RunSupervisor,
  type RunOutcome,
  type SupervisorAdapterFactory,
  type WorkerLifecycleEvent,
} from '../../orchestrator/supervisor.ts'
import { WakeupRegistry } from '../../orchestrator/wakeups.ts'
import { createSandboxManager } from '../../sandbox/factory.ts'
import {
  DEFAULT_WORKER_IMAGE_TAG,
  dispatchReadiness,
  WorkerImageManager,
  type WorkerImageProbe,
} from '../../sandbox/image.ts'
import { HOST_GATEWAY_HOSTNAME } from '../../sandbox/ship-containers.ts'
import type { ShipContainerSpec } from '../../sandbox/ship-containers.ts'
import { planShipNetwork, verifyRestrictedEgress } from '../../sandbox/network.ts'
import { sandboxContainerName, type SandboxManager } from '../../sandbox/types.ts'
import type { Store } from '../../store/store.ts'
import { PlutonToolBridge, toolBridgeLimitsFromRuntime, type ToolBridgeLimits } from '../../tools/bridge.ts'
import { ToolHttpServer } from '../../tools/http-transport.ts'
import { PLUTON_VERSION } from '../../version.ts'
import { GitWorkspaceManager } from '../../workspace/manager.ts'
import type { ProjectContext } from '../context.ts'
import { resolveShipByRef } from './mcp.ts'
import { shipContainerMounts, provisionShipContainer } from './ship-provision.ts'

/**
 * `pluton run` — the CLI entry into supervised execution (Phase 6, ADR-0006/0007).
 *
 * Wiring decisions:
 * - One loopback ToolHttpServer per run; every engine session gets its own
 *   bearer-token'd bridge (identity fixed server-side at registration). The
 *   token lives only in the ACP session params handed to that engine — never
 *   in config, events or logs.
 * - Budgets and timeouts come from `runtime.*` config (single source of truth).
 * - `--request-id` routes run creation through durable request receipts, so a
 *   retried command can never create a second run.
 * - Engine auth lives in per-Ship engine homes (ADR-0008); `engineEnv` adds
 *   nothing on top of each adapter's own allowlist.
 * - `sandbox.kind: native` (the default) runs engines as host processes under
 *   the native execution provider. Legacy `sandbox.kind: docker` runs engines
 *   inside per-Ship containers through `docker exec`, with pinned in-image
 *   binaries and the bridge exposed on the host gateway; the acknowledged
 *   dev-only `local-process` mode keeps host child processes.
 */

export interface RunCommandOptions {
  goal: string
  acceptance: string[]
  managerRef?: string
  requestId?: string
}

export interface RunDeps {
  /** Test seam: adapter per Ship; default = the built-in engine registry. */
  adapterFor?: (ship: ShipRecord) => EngineAdapter
  /** Test seam: replaces the Docker sandbox manager in container mode. */
  sandboxManager?: SandboxManager
  /** Test seam: replaces the worker-image probe in container mode. */
  workerImageProbe?: (rootDir: string) => Promise<WorkerImageProbe>
  /** Test seam: replaces the process spawn behind `docker exec` children. */
  dockerSpawn?: AcpSpawnFn
  /**
   * Live inspector sink (the SPA server wires this to its SSE broadcaster).
   * Headless CLI runs leave it unset.
   */
  onWorkerEvent?: (event: WorkerLifecycleEvent) => void
}

export interface RunSummary {
  runId: string
  state: RunState
  /** null only for a duplicate request whose run has not finished yet. */
  outcome: RunOutcome['outcome'] | null
  taskCounts: Record<string, number>
  managerSummary: string | null
  unfinishedTasks: string[]
  /** Non-terminal tasks stuck behind unverified dependencies (cannot progress without a verdict). */
  blockedTasks: string[]
  verificationPending: boolean
}

/** Engine binaries pinned by the worker image's `engines` profile (docker/worker/Dockerfile). */
const CONTAINER_ENGINE_BINARIES: Readonly<Record<string, string>> = {
  opencode: '/usr/local/bin/opencode',
}

const CONTAINER_PIDS_LIMIT = 512

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

/** Summary built from durable records only (duplicate requests never re-drive a run). */
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

/**
 * CS-9: the operator's cancel path — SIGINT/SIGTERM resolve to the SAME durable
 * cancel the manager's `run.stop` tool uses. Durability only: this flips the run
 * to `cancelled` and records why; the supervisor loop's next control tick
 * (state-driven, ≤ `loopPollMs`) turns the flip into engine interrupts plus a
 * bounded drain, and a later `pluton run --request-id <id>` resume sees the
 * terminal state from the records. Idempotent: a terminal run is a no-op
 * (`false`), so repeated signals can never mint a conflict or a second event.
 */
export function requestRunCancel(store: Store, runId: string, reason: string): boolean {
  const run = store.getRun(runId)
  if (isTerminalRunState(run.state)) return false
  try {
    store.setRunState(runId, 'cancelled')
  } catch (e) {
    // A concurrent terminal write (another cancel source) won the CAS: the
    // cancel intent is already satisfied — still a no-op, and never a second
    // `run.cancel_requested` event.
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

/**
 * CS-9: bind operator SIGINT/SIGTERM to {@link requestRunCancel} for one run.
 * One listener per signal (`process.once`): the FIRST signal rides the durable
 * cancel path, where the supervisor interrupts in-flight engines and finalizes
 * through its bounded drain even if an engine refuses to stop. A SECOND signal
 * after the handler was consumed falls back to Node's default terminate — that
 * is the deliberate bounded-shutdown escape hatch for a wedged process, not an
 * accident. Returns an idempotent disposer that removes both listeners.
 */
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

/**
 * Container mode: fail closed before any run row exists — daemon probe, worker
 * image readiness (the `engines` profile is required), then one long-lived
 * container and a `docker exec` spawn context per enabled Ship. Mount
 * construction and provisioning live in `ship-provision.ts` (shared with the
 * approvals inbox); the once-per-run probe/readiness checks stay here.
 */
export async function prepareContainerMode(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  manager: SandboxManager,
  imageProbeOverride: ((rootDir: string) => Promise<WorkerImageProbe>) | undefined,
  opts?: { shipIds?: string[] },
): Promise<Map<string, DockerExecContext>> {
  const probe = await manager.probe()
  if (!probe.available) {
    throw new SandboxUnavailableError(`container-mode runs need a reachable sandbox: ${probe.detail}`, {
      fix: probe.fix,
    })
  }
  const imageTag = ctx.loaded.config.sandbox.image ?? DEFAULT_WORKER_IMAGE_TAG
  const imageProbe =
    imageProbeOverride !== undefined
      ? await imageProbeOverride(ctx.rootDir)
      : await new WorkerImageManager().probe(ctx.rootDir, imageTag)
  const readiness = dispatchReadiness(true, imageProbe, { requireEngines: true })
  if (!readiness.ready) {
    throw new SandboxUnavailableError(
      `worker image '${imageTag}' is not ready for container-mode runs:\n  - ${readiness.warnings.join('\n  - ')}`,
    )
  }

  const runtime = ctx.loaded.config.runtime
  const workspacesRoot = workspaceDir(ctx.rootDir)
  const byShip = new Map<string, DockerExecContext>()
  const ensuredNetworks = new Set<string>()
  const allowed = opts?.shipIds ? new Set(opts.shipIds) : null
  for (const ship of store.listShips()) {
    if (!ship.enabled) continue
    if (allowed !== null && !allowed.has(ship.id)) continue
    const mounts = shipContainerMounts({ ship, rootDir: ctx.rootDir, workspacesRoot })
    const plan = await planShipNetwork({
      manager,
      config: ctx.loaded.config,
      shipId: ship.id,
      projectId,
      ensured: ensuredNetworks,
    })
    await provisionShipContainer({
      manager,
      store,
      projectId,
      ship,
      image: imageTag,
      ...(imageProbe.imageId !== null ? { imageId: imageProbe.imageId } : {}),
      limits: {
        cpus: runtime.default_cpu_limit,
        memoryMb: runtime.default_memory_mb,
        pids: CONTAINER_PIDS_LIMIT,
      },
      network: plan.policy,
      ...(plan.customNetwork !== undefined ? { customNetwork: plan.customNetwork } : {}),
      rootDir: ctx.rootDir,
      workspacesRoot,
    })
    const containerName = sandboxContainerName(projectId, ship.id)
    // Prove the kernel/Docker denial from inside before any engine session
    // starts. A container that can still reach the internet must never be
    // used for a `restricted` run.
    if (plan.policy === 'restricted') await verifyRestrictedEgress(manager, containerName)
    byShip.set(ship.id, {
      containerName,
      mounts: mounts.map((mount) => ({ hostPath: mount.hostPath, containerPath: mount.containerPath })),
      env: {},
    })
  }
  return byShip
}

/**
 * The container-mode adapter per Ship: pinned in-image binaries, `docker exec`
 * as the process spawn, Linux platform env construction (the engine process
 * runs inside the container, never on the host). `session` carries the proven
 * isolation fact through to the approval policy — a container alone is not
 * isolation (chat/SPA sessions are mounted at the project root inside it).
 */
export function containerAdapterFor(
  ship: ShipRecord,
  contexts: Map<string, DockerExecContext>,
  dockerSpawn: AcpSpawnFn | undefined,
  session: EngineIsolationFacts = { isolatedCheckout: false },
): EngineAdapter {
  const exec = contexts.get(ship.id)
  if (exec === undefined) {
    throw new InternalError(`container mode: no container was prepared for Ship '${ship.id}'`)
  }
  const binaryPath = CONTAINER_ENGINE_BINARIES[ship.engineKind]
  if (binaryPath === undefined && ship.engineKind !== 'mock') {
    throw new ValidationError(
      `engine '${ship.engineKind}' cannot run in container mode: the worker image pins no binary for it (available: opencode)`,
    )
  }
  return engineAdapterForShip(ship, {
    spawnFn: dockerExecSpawn(exec, dockerSpawn),
    platform: 'linux',
    isolatedCheckout: session.isolatedCheckout,
    // The ACP session cwd must name a container path; the process spawn cwd
    // (a host path) is mapped independently inside dockerExecSpawn.
    mapWorkdir: (hostPath: string) => mapHostPathToContainer(hostPath, exec.mounts),
    ...(binaryPath !== undefined ? { binaryPath } : {}),
  })
}

/**
 * Create the per-run native provider before any run row exists. Config gates
 * (acknowledgements, network policy) throw here, so a rejected native config
 * never leaves a started run behind. The event sink is bound to the run id once
 * the row is created; session preparation happens later.
 */
interface RunNativeProvider {
  provider: NativeExecutionProvider
  setRunId: (runId: string) => void
}

function createRunNativeProvider(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
): RunNativeProvider | null {
  if (ctx.loaded.config.sandbox.kind !== 'native') return null
  let runId: string | null = null
  const provider = createNativeExecutionProvider({
    config: ctx.loaded.config,
    rootDir: ctx.rootDir,
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
  containerContexts: Map<string, DockerExecContext> | null
  nativeProvider?: NativeExecutionProvider | null
  deps: RunDeps
  diagnostic: (line: string) => void
  skipManager?: boolean
}): RunSupervisor {
  const { ctx, store, projectId, run, limits, wakeups, http, bridgeUrl, containerContexts, deps, diagnostic } = args
  const settings = supervisorSettingsFromRuntime(ctx.loaded.config.runtime)
  const budgets = usageBudgetsFromRuntime(ctx.loaded.config.runtime)
  let supervisorAdapterFor: SupervisorAdapterFactory | undefined = deps.adapterFor
  if (supervisorAdapterFor === undefined && containerContexts !== null) {
    const contexts = containerContexts
    supervisorAdapterFor = (ship, session) => containerAdapterFor(ship, contexts, deps.dockerSpawn, session)
  } else if (supervisorAdapterFor === undefined && args.nativeProvider != null) {
    const nativeProvider = args.nativeProvider
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
          }),
      })
  }
  // One manager instance for both the supervisor's checkout provisioning and
  // the per-task bridges' result reads (changed files from real checkouts).
  const workspaceManager = new GitWorkspaceManager({ workspacesRoot: workspaceDir(ctx.rootDir) })
  const supervisor = new RunSupervisor({
    store,
    projectId,
    rootDir: ctx.rootDir,
    workspacesRoot: workspaceDir(ctx.rootDir),
    runId: run.id,
    limits,
    maxConcurrentWorkers: settings.maxConcurrentWorkers,
    defaultTaskTimeoutMs: settings.defaultTaskTimeoutMs,
    runDeadlineMs: settings.runDeadlineMs,
    maxRetriesPerTask: settings.maxRetriesPerTask,
    ...(budgets !== undefined ? { usageLedger: new UsageLedger(run.id, budgets, store) } : {}),
    verificationConfigured: ctx.loaded.config.project.verification.length > 0,
    ...(args.skipManager !== undefined ? { skipManager: args.skipManager } : {}),
    ...(supervisorAdapterFor !== undefined ? { adapterFor: supervisorAdapterFor } : {}),
    ...(deps.onWorkerEvent !== undefined ? { onWorkerEvent: deps.onWorkerEvent } : {}),
    workspaceManager,
    engineEnv: () => ({}),
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
    wakeups,
    diagnostic,
  })
  return supervisor
}

export interface StartRunOptions {
  goal: string
  acceptance: string[]
  managerRef?: string
  requestId?: string
}

/** Create a run (same admission path as runRun) and drive it in the background. */
export function startRunInBackground(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  opts: StartRunOptions,
  deps: RunDeps,
  hooks?: { diagnostic?: (line: string) => void },
): { runId: string; done: Promise<RunSummary> } {
  const goal = opts.goal.trim()
  if (goal === '') {
    throw new ConfigError('--goal is required: describe what the run must achieve')
  }
  const manager = resolveManager(ctx, store, opts.managerRef)
  const runtime = ctx.loaded.config.runtime
  const budget = runBudgetFromRuntime(runtime)

  let native: RunNativeProvider | null = null
  if (ctx.loaded.config.sandbox.kind === 'native') {
    native = createRunNativeProvider(ctx, store, projectId)
  } else if (ctx.loaded.config.sandbox.kind === 'local-process') {
    // Gate only: throws unless local_process_acknowledged is set.
    createSandboxManager(ctx.loaded.config)
  }

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
    if (native !== null) void native.provider.close()
    throw error
  }

  if (duplicate) {
    if (native !== null) void native.provider.close()
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
  native?.setRunId(run.id)

  const done = (async (): Promise<RunSummary> => {
    try {
    let containerContexts: Map<string, DockerExecContext> | null = null
    if (ctx.loaded.config.sandbox.kind === 'docker') {
      const sandboxManager = deps.sandboxManager ?? createSandboxManager(ctx.loaded.config)
      containerContexts = await prepareContainerMode(ctx, store, projectId, sandboxManager, deps.workerImageProbe)
    }

    const limits = toolBridgeLimitsFromRuntime(runtime)
    const wakeups = new WakeupRegistry()
    const http = new ToolHttpServer({
      serverName: 'pluton-tools',
      serverVersion: PLUTON_VERSION,
      ...(containerContexts !== null ? { host: '::' } : {}),
    })
    const started = await http.start()
    const bridgeUrl =
      containerContexts !== null
        ? `http://${HOST_GATEWAY_HOSTNAME}:${String(started.port)}/mcp`
        : `${http.url as string}mcp`

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
        containerContexts,
        nativeProvider: native?.provider ?? null,
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
      await native?.provider.close()
    }
  })()

  return { runId: run.id, done }
}

/**
 * Settle a run whose background driver crashed, from OUTSIDE the supervisor.
 *
 * The supervisor only finalizes while its loop is alive; a rejection of the
 * background promise (sandbox preparation failed, transport could not start,
 * or a supervisor crash that never reached `finalize`) is durable evidence
 * there is no live driver left. Without this settlement the row stays
 * `created`/`active` forever (defect 2026-10-21, live record
 * `run_mvgh70nha675003a`). Idempotent and terminal-safe: an already-terminal
 * run is left exactly as it is, and a concurrent owner winning the terminal
 * write makes this a no-op.
 *
 * Shared by the API route (which adds its own SSE frame broadcast) and the
 * CLI chat (which adds its own transcript line).
 */
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
    // A concurrent owner already moved the run to a terminal state; the
    // durable state is the record and there is nothing left to settle.
    return
  }
  try {
    // The event log is what the SSE log-watcher derives the terminal
    // `run_state` frame from; deterministic arrival is not required.
    store.appendEvent({
      projectId,
      runId,
      type: 'run.finished',
      payload: { outcome: 'failure', via, error: redactProseSecrets(raw) },
    })
  } catch {
    // Best-effort: the durable run state is the record of record.
  }
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
    const settings = supervisorSettingsFromRuntime(runtime)

    // Container mode (sandbox.kind: docker — the legacy container provider)
    // provisions the per-Ship containers before the run row exists, so a daemon
    // or image failure never leaves a started run behind. Native creates its
    // provider and validates acknowledgements/network policy here too; an
    // unacknowledged local-process config is refused the same way every sandbox
    // consumer refuses it.
    let containerContexts: Map<string, DockerExecContext> | null = null
    if (ctx.loaded.config.sandbox.kind === 'native') {
      native = createRunNativeProvider(ctx, store, projectId)
    } else if (ctx.loaded.config.sandbox.kind === 'docker') {
      const sandboxManager = deps.sandboxManager ?? createSandboxManager(ctx.loaded.config)
      containerContexts = await prepareContainerMode(ctx, store, projectId, sandboxManager, deps.workerImageProbe)
    } else {
      // Gate only: throws unless local_process_acknowledged is set.
      createSandboxManager(ctx.loaded.config)
    }

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
    native?.setRunId(run.id)

    const limits = toolBridgeLimitsFromRuntime(runtime)
    const wakeups = new WakeupRegistry()
    const http = new ToolHttpServer({
      serverName: 'pluton-tools',
      serverVersion: PLUTON_VERSION,
      // Container mode: the bridge must be reachable through the host
      // gateway from inside the containers (per-session bearer tokens still
      // guard every request); host mode stays loopback-only.
      ...(containerContexts !== null ? { host: '0.0.0.0' } : {}),
    })
    const started = await http.start()
    const bridgeUrl =
      containerContexts !== null
        ? `http://${HOST_GATEWAY_HOSTNAME}:${String(started.port)}/mcp`
        : `${http.url as string}mcp`
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
        containerContexts,
        nativeProvider: native?.provider ?? null,
        deps,
        diagnostic: (line) => {
          process.stderr.write(`run ${run.id}: ${line}\n`)
        },
      })
      const dispose = installRunCancelSignals(store, run.id)
      let outcome: RunOutcome
      try {
        // CS-9: Ctrl-C / SIGTERM ride the same durable cancel path as the
        // manager's run.stop (requestRunCancel); the supervisor's next control
        // tick interrupts live engines and its bounded drain finalizes the run
        // even if one refuses to stop.
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

export interface ResumeRunOptions {
  skipManager?: boolean
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

    const runtime = ctx.loaded.config.runtime
    let containerContexts: Map<string, DockerExecContext> | null = null
    if (ctx.loaded.config.sandbox.kind === 'native') {
      native = createRunNativeProvider(ctx, store, projectId)
      native?.setRunId(run.id)
    } else if (ctx.loaded.config.sandbox.kind === 'docker') {
      const sandboxManager = deps.sandboxManager ?? createSandboxManager(ctx.loaded.config)
      containerContexts = await prepareContainerMode(ctx, store, projectId, sandboxManager, deps.workerImageProbe)
    } else {
      createSandboxManager(ctx.loaded.config)
    }

    const limits = toolBridgeLimitsFromRuntime(runtime)
    const wakeups = new WakeupRegistry()
    const http = new ToolHttpServer({
      serverName: 'pluton-tools',
      serverVersion: PLUTON_VERSION,
      ...(containerContexts !== null ? { host: '::' } : {}),
    })
    const started = await http.start()
    const bridgeUrl =
      containerContexts !== null
        ? `http://${HOST_GATEWAY_HOSTNAME}:${String(started.port)}/mcp`
        : `${http.url as string}mcp`

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
        containerContexts,
        nativeProvider: native?.provider ?? null,
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
