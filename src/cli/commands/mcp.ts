import { bootstrapStore } from '../../bootstrap.ts'
import { NotFoundError, ValidationError } from '../../domain/errors.ts'
import type { MuseRecord } from '../../domain/models.ts'
import type { Store } from '../../store/store.ts'
import { PlutonToolBridge, toolBridgeLimitsFromRuntime } from '../../tools/bridge.ts'
import { McpStdioServer } from '../../tools/mcp-server.ts'
import { WakeupRegistry } from '../../orchestrator/wakeups.ts'
import { PLUTON_VERSION } from '../../version.ts'
import type { ProjectContext } from '../context.ts'
import { runByRef, taskById } from './status.ts'

/**
 * `pluton mcp serve` — the restricted Pluton tool bridge as a standalone stdio
 * MCP server for one engine session (ADR-0007). The runtime normally serves
 * the bridge in-process (HTTP transport); this command exists for local-process
 * sessions and for driving the bridge by hand. stdout is the protocol channel:
 * diagnostics go to stderr only.
 *
 * Identity is fixed at launch: --run/--muse (and --task for a task-scoped
 * session). Nothing the engine says can widen the caller's permissions.
 *
 * Wakeups: this process has its own registry, so `task.wait` re-reads durable
 * state on a heartbeat (runtime heartbeat_seconds) instead of waking instantly
 * on another process's writes. It never claims completion early.
 */

export interface McpServeOptions {
  runRef: string
  museRef: string
  taskRef?: string
}

export function resolveMuseByRef(store: Store, ref: string): MuseRecord {
  const byId = store.getMuse(ref)
  if (byId) return byId
  const bySlug = store.listMuses().find((m) => m.slug === ref)
  if (bySlug) return bySlug
  throw new NotFoundError('muse', ref)
}

export function mcpServePlan(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  opts: McpServeOptions,
): { bridge: PlutonToolBridge; runId: string; museId: string; taskId: string | null } {
  const run = runByRef(store, opts.runRef)
  const muse = resolveMuseByRef(store, opts.museRef)
  if (muse.projectId !== projectId) {
    throw new ValidationError(`muse '${muse.id}' belongs to another project`)
  }
  let taskId: string | null = null
  if (opts.taskRef !== undefined) {
    const task = taskById(store, opts.taskRef)
    if (task.runId !== run.id) {
      throw new ValidationError(`task ${task.id} belongs to run ${task.runId}, not ${run.id}`)
    }
    if (task.assigneeMuseId !== muse.id) {
      throw new ValidationError(
        `task ${task.id} is assigned to muse ${task.assigneeMuseId ?? '(none)'}, not '${muse.id}'`,
      )
    }
    taskId = task.id
  }
  const bridge = new PlutonToolBridge({
    store,
    projectId,
    rootDir: ctx.rootDir,
    runId: run.id,
    callerMuseId: muse.id,
    callerTaskId: taskId,
    limits: toolBridgeLimitsFromRuntime(ctx.loaded.config.runtime),
    wakeups: new WakeupRegistry(),
  })
  return { bridge, runId: run.id, museId: muse.id, taskId }
}

/** Serve until stdin ends. Resolves when the engine closes the pipe. */
export async function mcpServe(ctx: ProjectContext, opts: McpServeOptions): Promise<void> {
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const plan = mcpServePlan(ctx, store, projectId, opts)
    process.stderr.write(
      `pluton mcp serve: run ${plan.runId} muse ${plan.museId}${plan.taskId ? ` task ${plan.taskId}` : ' (manager scope)'}\n`,
    )
    const server = new McpStdioServer({
      host: plan.bridge,
      serverName: 'pluton-tools',
      serverVersion: PLUTON_VERSION,
    })
    await server.runStdio()
  } finally {
    store.close()
  }
}
