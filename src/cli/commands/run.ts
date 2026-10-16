import { bootstrapStore } from '../../bootstrap.ts'
import { findManager, workspaceDir } from '../../config/load.ts'
import { ConfigError, InternalError, NotFoundError } from '../../domain/errors.ts'
import type { JsonValue, MuseRecord, RunRecord } from '../../domain/models.ts'
import { TERMINAL_TASK_STATES, type RunState } from '../../domain/state.ts'
import type { EngineAdapter, McpServerSpec } from '../../engines/contract/types.ts'
import { runBudgetFromRuntime, supervisorSettingsFromRuntime } from '../../orchestrator/run-setup.ts'
import { RunSupervisor, type RunOutcome } from '../../orchestrator/supervisor.ts'
import { WakeupRegistry } from '../../orchestrator/wakeups.ts'
import type { Store } from '../../store/store.ts'
import { PlutonToolBridge, toolBridgeLimitsFromRuntime } from '../../tools/bridge.ts'
import { ToolHttpServer } from '../../tools/http-transport.ts'
import { PLUTON_VERSION } from '../../version.ts'
import { GitWorkspaceManager } from '../../workspace/manager.ts'
import type { ProjectContext } from '../context.ts'
import { resolveMuseByRef } from './mcp.ts'

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
    const http = new ToolHttpServer({ serverName: 'pluton-tools', serverVersion: PLUTON_VERSION })
    await http.start()
    const bridgeUrl = `${http.url as string}mcp`
    try {
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
        ...(deps.adapterFor !== undefined ? { adapterFor: deps.adapterFor } : {}),
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
