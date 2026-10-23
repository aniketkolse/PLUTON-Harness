import { bootstrapStore } from '../../bootstrap.ts'
import { NotFoundError, ValidationError } from '../../domain/errors.ts'
import type { ShipRecord } from '../../domain/models.ts'
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
  shipRef: string
  taskRef?: string
  isLegacyMuse?: boolean
}

export function resolveShipByRef(store: Store, ref: string): ShipRecord {
  const byId = store.getShip(ref)
  if (byId) return byId
  const bySlug = store.listShips().find((m) => m.slug === ref)
  if (bySlug) return bySlug
  throw new NotFoundError('ship', ref)
}

/** @deprecated Use `resolveShipByRef`; kept for backward compatibility. */
export const resolveMuseByRef = resolveShipByRef

export function mcpServePlan(
  ctx: ProjectContext,
  store: Store,
  projectId: string,
  opts: McpServeOptions,
): { bridge: PlutonToolBridge; runId: string; shipId: string; taskId: string | null } {
  const run = runByRef(store, opts.runRef)
  const ship = resolveShipByRef(store, opts.shipRef)
  if (ship.projectId !== projectId) {
    throw new ValidationError(`ship '${ship.id}' belongs to another project`)
  }
  let taskId: string | null = null
  if (opts.taskRef !== undefined) {
    const task = taskById(store, opts.taskRef)
    if (task.runId !== run.id) {
      throw new ValidationError(`task ${task.id} belongs to run ${task.runId}, not ${run.id}`)
    }
    const assignee = task.assigneeShipId ?? task.assigneeMuseId
    if (assignee !== ship.id) {
      throw new ValidationError(
        `task ${task.id} is assigned to muse ${assignee ?? '(none)'}, not '${ship.id}'`,
      )
    }
    taskId = task.id
  }
  const bridge = new PlutonToolBridge({
    store,
    projectId,
    rootDir: ctx.rootDir,
    runId: run.id,
    callerMuseId: ship.id,
    callerTaskId: taskId,
    limits: toolBridgeLimitsFromRuntime(ctx.loaded.config.runtime),
    wakeups: new WakeupRegistry(),
  })
  return { bridge, runId: run.id, shipId: ship.id, taskId }
}

/** Serve until stdin ends. Resolves when the engine closes the pipe. */
export async function mcpServe(ctx: ProjectContext, opts: McpServeOptions): Promise<void> {
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const plan = mcpServePlan(ctx, store, projectId, opts)
    const entity = opts.isLegacyMuse ? 'muse' : 'ship'
    process.stderr.write(
      `pluton mcp serve: run ${plan.runId} ${entity} ${plan.shipId}${plan.taskId ? ` task ${plan.taskId}` : ' (manager scope)'}\n`,
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
