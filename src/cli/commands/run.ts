import { bootstrapStore } from '../../bootstrap.ts'
import { findManager, workspaceDir } from '../../config/load.ts'
import {
  ConfigError,
  InternalError,
  NotFoundError,
  SandboxUnavailableError,
  ValidationError,
} from '../../domain/errors.ts'
import type { JsonValue, MuseRecord, RunRecord } from '../../domain/models.ts'
import { TERMINAL_TASK_STATES, type RunState } from '../../domain/state.ts'
import type { AcpSpawnFn } from '../../engines/acp/client.ts'
import { engineAdapterForMuse } from '../../engines/approval.ts'
import type { EngineAdapter, McpServerSpec } from '../../engines/contract/types.ts'
import { dockerExecSpawn, mapHostPathToContainer, type DockerExecContext } from '../../engines/docker-exec.ts'
import { runBudgetFromRuntime, supervisorSettingsFromRuntime } from '../../orchestrator/run-setup.ts'
import { RunSupervisor, type RunOutcome } from '../../orchestrator/supervisor.ts'
import { WakeupRegistry } from '../../orchestrator/wakeups.ts'
import { createSandboxManager } from '../../sandbox/factory.ts'
import {
  DEFAULT_WORKER_IMAGE_TAG,
  dispatchReadiness,
  WorkerImageManager,
  type WorkerImageProbe,
} from '../../sandbox/image.ts'
import { HOST_GATEWAY_HOSTNAME } from '../../sandbox/muse-containers.ts'
import { sandboxContainerName, type SandboxManager } from '../../sandbox/types.ts'
import type { Store } from '../../store/store.ts'
import { PlutonToolBridge, toolBridgeLimitsFromRuntime } from '../../tools/bridge.ts'
import { ToolHttpServer } from '../../tools/http-transport.ts'
import { PLUTON_VERSION } from '../../version.ts'
import { GitWorkspaceManager } from '../../workspace/manager.ts'
import type { ProjectContext } from '../context.ts'
import { resolveMuseByRef } from './mcp.ts'
import { museContainerMounts, provisionMuseContainer } from './muse-provision.ts'

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
 * - Engine auth lives in per-Muse engine homes (ADR-0008); `engineEnv` adds
 *   nothing on top of each adapter's own allowlist.
 * - `sandbox.kind: docker` (the default) runs engines inside per-Muse
 *   containers through `docker exec`, with pinned in-image binaries and the
 *   bridge exposed on the host gateway; the acknowledged dev-only
 *   `local-process` mode keeps host child processes.
 */

export interface RunCommandOptions {
  goal: string
  acceptance: string[]
  managerRef?: string
  requestId?: string
}

export interface RunDeps {
  /** Test seam: adapter per Muse; default = the built-in engine registry. */
  adapterFor?: (muse: MuseRecord) => EngineAdapter
  /** Test seam: replaces the Docker sandbox manager in container mode. */
  sandboxManager?: SandboxManager
  /** Test seam: replaces the worker-image probe in container mode. */
  workerImageProbe?: (rootDir: string) => Promise<WorkerImageProbe>
  /** Test seam: replaces the process spawn behind `docker exec` children. */
  dockerSpawn?: AcpSpawnFn
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
  qwen: '/usr/local/bin/qwen',
}

const CONTAINER_PIDS_LIMIT = 512

function resolveManager(ctx: ProjectContext, store: Store, managerRef: string | undefined): MuseRecord {
  if (managerRef !== undefined) return resolveMuseByRef(store, managerRef)
  const found = findManager(ctx.loaded.config)
  if (!found) {
    throw new ConfigError(
      "no Muse with role 'supervisor' in pluton.yaml — add one or pass --manager <muse>",
    )
  }
  const muse = store.getMuse(found[0])
  if (!muse) throw new NotFoundError('muse', found[0])
  return muse
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
 * Container mode: fail closed before any run row exists — daemon probe, worker
 * image readiness (the `engines` profile is required), then one long-lived
 * container and a `docker exec` spawn context per enabled Muse. Mount
 * construction and provisioning live in `muse-provision.ts` (shared with the
 * approvals inbox); the once-per-run probe/readiness checks stay here.
 */
async function prepareContainerMode(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  manager: SandboxManager,
  imageProbeOverride: ((rootDir: string) => Promise<WorkerImageProbe>) | undefined,
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
  const byMuse = new Map<string, DockerExecContext>()
  for (const muse of store.listMuses()) {
    if (!muse.enabled) continue
    const mounts = museContainerMounts({ muse, rootDir: ctx.rootDir, workspacesRoot })
    await provisionMuseContainer({
      manager,
      store,
      projectId,
      muse,
      image: imageTag,
      ...(imageProbe.imageId !== null ? { imageId: imageProbe.imageId } : {}),
      limits: {
        cpus: runtime.default_cpu_limit,
        memoryMb: runtime.default_memory_mb,
        pids: CONTAINER_PIDS_LIMIT,
      },
      network: runtime.network_policy,
      rootDir: ctx.rootDir,
      workspacesRoot,
    })
    byMuse.set(muse.id, {
      containerName: sandboxContainerName(projectId, muse.id),
      mounts: mounts.map((mount) => ({ hostPath: mount.hostPath, containerPath: mount.containerPath })),
      env: {},
    })
  }
  return byMuse
}

/**
 * The container-mode adapter per Muse: pinned in-image binaries, `docker exec`
 * as the process spawn, Linux platform env construction (the engine process
 * runs inside the container, never on the host).
 */
function containerAdapterFor(
  muse: MuseRecord,
  contexts: Map<string, DockerExecContext>,
  dockerSpawn: AcpSpawnFn | undefined,
): EngineAdapter {
  const exec = contexts.get(muse.id)
  if (exec === undefined) {
    throw new InternalError(`container mode: no container was prepared for Muse '${muse.id}'`)
  }
  const binaryPath = CONTAINER_ENGINE_BINARIES[muse.engineKind]
  if (binaryPath === undefined && muse.engineKind !== 'mock') {
    throw new ValidationError(
      `engine '${muse.engineKind}' cannot run in container mode: the worker image pins no binary for it (available: opencode, qwen)`,
    )
  }
  return engineAdapterForMuse(muse, {
    spawnFn: dockerExecSpawn(exec, dockerSpawn),
    platform: 'linux',
    // The ACP session cwd must name a container path; the process spawn cwd
    // (a host path) is mapped independently inside dockerExecSpawn.
    mapWorkdir: (hostPath: string) => mapHostPathToContainer(hostPath, exec.mounts),
    ...(binaryPath !== undefined ? { binaryPath } : {}),
  })
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
  try {
    const manager = resolveManager(ctx, store, opts.managerRef)
    const runtime = ctx.loaded.config.runtime
    const budget = runBudgetFromRuntime(runtime)
    const settings = supervisorSettingsFromRuntime(runtime)

    // Container mode (sandbox.kind: docker — the default) provisions the
    // per-Muse containers before the run row exists, so a daemon or image
    // failure never leaves a started run behind. Unacknowledged
    // local-process configs are refused the same way every sandbox consumer
    // refuses them; only the acknowledged dev-only mode runs engines on the
    // host.
    let containerContexts: Map<string, DockerExecContext> | null = null
    if (ctx.loaded.config.sandbox.kind === 'docker') {
      const sandboxManager = deps.sandboxManager ?? createSandboxManager(ctx.loaded.config)
      containerContexts = await prepareContainerMode(ctx, store, projectId, sandboxManager, deps.workerImageProbe)
    } else {
      // Gate only: throws unless local_process_acknowledged is set.
      createSandboxManager(ctx.loaded.config)
    }

    const payload: JsonValue = {
      goal,
      acceptanceCriteria: opts.acceptance,
      managerMuseId: manager.id,
      budget: { ...budget },
    }
    const createRun = (): RunRecord =>
      store.createRun({
        projectId,
        goal,
        origin: 'cli',
        requestedBy: 'cli',
        acceptanceCriteria: opts.acceptance,
        managerMuseId: manager.id,
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
      let supervisorAdapterFor = deps.adapterFor
      if (supervisorAdapterFor === undefined && containerContexts !== null) {
        const contexts = containerContexts
        supervisorAdapterFor = (muse: MuseRecord): EngineAdapter =>
          containerAdapterFor(muse, contexts, deps.dockerSpawn)
      }
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
        verificationConfigured: ctx.loaded.config.project.verification.length > 0,
        ...(supervisorAdapterFor !== undefined ? { adapterFor: supervisorAdapterFor } : {}),
        workspaceManager: new GitWorkspaceManager({ workspacesRoot: workspaceDir(ctx.rootDir) }),
        engineEnv: () => ({}),
        mcpServerFor: (muse, taskId) => {
          const bridge =
            taskId === null
              ? supervisor.managerBridge()
              : new PlutonToolBridge({
                  store,
                  projectId,
                  rootDir: ctx.rootDir,
                  runId: run.id,
                  callerMuseId: muse.id,
                  callerTaskId: taskId,
                  limits,
                  wakeups,
                })
          const { token } = http.register(bridge, {
            museId: muse.id,
            taskId,
            runId: run.id,
            label: muse.slug,
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
    store.close()
  }
}
