import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { ConflictError, ExternalToolError, InternalError, NotFoundError, PolicyDeniedError, StateTransitionError, ValidationError, WorkspaceError } from '../domain/errors.ts'
import { applyTaskVerificationVerdict } from '../verify/runner.ts'
import type { JsonValue, ShipRecord, RunRecord, TaskRecord, WorkspaceRecord } from '../domain/models.ts'
import { TERMINAL_TASK_STATES, type RunState, type TaskState } from '../domain/state.ts'
import { admitTask } from '../orchestrator/task-graph.ts'
import type { WorkerMessage, WorkerMessageBus } from '../orchestrator/messages.ts'
import { wakeupChannelFor, type WakeupRegistry } from '../orchestrator/wakeups.ts'
import type { Store } from '../store/store.ts'
import { firstLine } from '../util/exec.ts'
import { stripControlChars } from '../util/sanitize.ts'
import { TOOL_SCHEMAS, type PlutonToolName } from './catalog.ts'
import type { ToolBridgeLimits } from './bridge.ts'
import type { FileLeaseManager } from '../orchestrator/lease-manager.ts'
import type { GitWorkspaceManager } from '../workspace/manager.ts'
import { diffWorktreeStat, logOneline } from '../workspace/trusted-git.ts'

/**
 * Tool implementations. Every handler receives the validated server-side
 * context (`ToolEnv`) — identity, run, limits — and returns JSON. Handlers may
 * throw typed errors (mapped by the bridge) and must never claim more than the
 * durable records say.
 */

export interface ToolEnv {
  store: Store
  projectId: string
  rootDir: string
  /**
   * Filesystem roots this session's read tools may resolve against. Derived
   * server-side from the caller's task/checkout identity; tool arguments can
   * never widen it. Empty means no read scope is available yet.
   */
  readRoots: readonly string[]
  runId: string
  callerShipId: string
  callerTaskId: string | null
  limits: ToolBridgeLimits
  wakeups: WakeupRegistry
  /** Direct worker-to-worker messaging for this run; absent in runtimes without it. */
  messageBus?: WorkerMessageBus
  now: () => number
  leaseManager?: FileLeaseManager
  /**
   * The project's workspace manager (when the caller runs inside a supervised
   * run). Result composition uses it to report a task checkout's real changed
   * files; without it that field stays honestly null.
   */
  workspaceManager?: GitWorkspaceManager
  /**
   * Set while the caller is still connected and the host is running; aborted
   * when the client disconnects or the runtime shuts the bridge down. Long
   * waits (task.wait) must observe it and return promptly — a handler must
   * never outlive the store.
   */
  signal?: AbortSignal
}

export type ToolHandler = (env: ToolEnv, args: unknown) => Promise<JsonValue>
export type ToolHandlers = Record<PlutonToolName, ToolHandler>

// The caller's wakeup channel helper lives with the registry (single source of
// truth); re-exported here so existing imports from this module keep working.
export { wakeupChannelFor }

const READ_FILE_CAP_BYTES = 512_000
const LISTING_CAP = 200
const REFUSED_SEGMENTS = new Set(['.pluton', '.git', 'node_modules'])
const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(['completed', 'failed', 'cancelled', 'uncertain'])
const GIT_TIMEOUT_MS = 30_000
/** Bounded pending approvals per run: a model loop must not grow the table without bound. */
const MAX_PENDING_APPROVALS = 3
/**
 * Approval actions Pluton's own subsystems consume from approved rows: the
 * integration gate (`integration.apply`), ship instantiation (`ship.create`)
 * and the engine permission channel (`engine.permission`). A Ship filing one
 * of these through `approval.request` would forge the provenance those
 * consumers trust, so the tool refuses them outright.
 */
const HOST_OWNED_APPROVAL_ACTIONS: ReadonlySet<string> = new Set([
  'integration.apply',
  'ship.create',
  'muse.create',
  'engine.permission',
])
/** A workspace base commit must be a plain hex object id before it reaches git. */
const BASE_COMMIT_RE = /^[0-9a-fA-F]{7,64}$/

type TaskSummary = {
  id: string
  title: string
  state: TaskState
  depth: number
  parentTaskId: string | null
  assigneeShipId: string | null
  createdAt: string
  completedAt: string | null
}

function summarizeTask(t: TaskRecord): TaskSummary {
  return {
    id: t.id,
    title: t.title,
    state: t.state,
    depth: t.depth,
    parentTaskId: t.parentTaskId,
    assigneeShipId: t.assigneeShipId,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  }
}

/** The recorded outcome summary, only when the result row really carries a string one. */
function resultSummaryOf(result: JsonValue | null): string | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null
  const summary = (result as { [k: string]: JsonValue }).summary
  return typeof summary === 'string' ? summary : null
}

/**
 * Changed files for a task checkout, lazily and fail-soft: a WorkspaceError —
 * a missing/unmarked checkout or a failed `git diff`, both raised by the
 * manager — reports null instead of failing the whole result read. `null` means
 * "not determined", never "no changes" (`[]` does). Only non-WorkspaceError
 * faults propagate.
 */
async function changedFilesFor(env: ToolEnv, ws: WorkspaceRecord | null): Promise<string[] | null> {
  if (ws === null || ws.kind !== 'task-checkout' || env.workspaceManager === undefined) return null
  try {
    return await env.workspaceManager.changedFiles(ws.path, ws.baseCommit)
  } catch (e) {
    if (e instanceof WorkspaceError) return null
    throw e
  }
}

/**
 * Unmet criteria from the latest verification row's `{criterion, status,
 * evidence}` entries; malformed rows or entries contribute nothing.
 */
function unmetCriteriaOf(verification: { criteria: JsonValue } | null): { criterion: string; reason: JsonValue }[] {
  const criteria = verification?.criteria
  if (!Array.isArray(criteria)) return []
  const unmet: { criterion: string; reason: JsonValue }[] = []
  for (const entry of criteria) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as { [k: string]: JsonValue }
    if (record['status'] === 'verified') continue
    const criterion = record['criterion']
    if (typeof criterion !== 'string') continue
    unmet.push({ criterion, reason: record['evidence'] ?? null })
  }
  return unmet
}

function tasksById(env: ToolEnv): Map<string, TaskRecord> {
  return new Map(env.store.listTasks(env.runId).map((t) => [t.id, t]))
}

/**
 * One heartbeat slice of a wait, cut short when the host signals shutdown (or
 * the client disconnects). The loop that calls this re-checks durable state
 * and the signal after every slice, so a short slice can only help.
 */
async function waitSlice(
  wakeups: WakeupRegistry,
  channel: string,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await wakeups.waitFor(channel, ms)
    return
  }
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void wakeups.waitFor(channel, ms).then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}

/** Manager scope (no caller task) sees the whole run; a task-scoped caller sees itself + descendants. */
function isVisible(env: ToolEnv, task: TaskRecord, byId: Map<string, TaskRecord>): boolean {
  if (env.callerTaskId === null) return true
  let current: TaskRecord | undefined = task
  const seen = new Set<string>()
  while (current) {
    if (current.id === env.callerTaskId) return true
    if (seen.has(current.id)) return false
    seen.add(current.id)
    current = current.parentTaskId ? byId.get(current.parentTaskId) : undefined
  }
  return false
}

function visibleTask(env: ToolEnv, taskId: string): TaskRecord {
  const task = env.store.getTaskOrNull(taskId)
  if (!task || task.runId !== env.runId) throw new NotFoundError('task', taskId)
  if (!isVisible(env, task, tasksById(env))) {
    throw new PolicyDeniedError(`task '${taskId}' is outside your scope: you may see only your own task and its descendants`)
  }
  return task
}

/** Accepts a Ship id or its project slug; anything else is a config-level mistake, not a guess. */
function resolveShip(env: ToolEnv, ref: string): ShipRecord {
  const direct = env.store.getShip(ref)
  if (direct && direct.projectId === env.projectId && direct.enabled) return direct
  const bySlug = env.store
    .listShips()
    .find((m) => m.projectId === env.projectId && m.slug === ref && m.enabled)
  if (bySlug) return bySlug
  throw new ValidationError(`unknown or disabled Ship '${ref}': use an id or slug from the project's team`)
}

function sessionReadRoots(env: ToolEnv): string[] {
  return env.readRoots.map((root) => resolve(root))
}

function assertInsideSessionRoots(env: ToolEnv, path: string): void {
  const abs = resolve(path)
  for (const root of sessionReadRoots(env)) {
    const rel = relative(root, abs)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  }
  throw new PolicyDeniedError(`stored path escapes this session's read roots: ${path}`)
}

/**
 * Refused-area check on a path relative to the (canonical) project root.
 * Case-insensitive on purpose: on case-insensitive filesystems `.PLUTON` and
 * `.pluton` are the same directory, so the refusal must not depend on spelling.
 */
function refusedRelativePath(rel: string): string | null {
  const segments = rel.split(/[\\/]+/).filter((s) => s.length > 0)
  for (const segment of segments) {
    if (REFUSED_SEGMENTS.has(segment.toLowerCase())) return segment
  }
  return null
}

function scopeShipId(scope: JsonValue): string | null {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return null
  const value = (scope as Record<string, JsonValue>)['shipId']
  return typeof value === 'string' ? value : null
}

/**
 * A task-scoped session may only depend on tasks inside its own subtree:
 * anything else is a reference to state it cannot see (rejected, not filtered).
 */
function assertDependenciesVisible(env: ToolEnv, dependsOn: string[] | undefined): void {
  if (!dependsOn || dependsOn.length === 0) return
  const byId = tasksById(env)
  for (const depId of dependsOn) {
    const dep = byId.get(depId)
    if (dep && !isVisible(env, dep, byId)) {
      throw new PolicyDeniedError(`dependency '${depId}' is outside your scope`)
    }
  }
}

/**
 * Cancel every not-yet-terminal task that transitively depends on `rootTaskId`.
 *
 * A dependent can only be dispatched after its prerequisite reaches
 * `completed`; once the prerequisite is cancelled that can never happen, so
 * leaving dependents queued strands them forever. Each dependent gets the
 * immediate cancelled prerequisite plus the cascade root in its durable failure
 * record, and an explicit audit event.
 */
function cancelDependentTasks(env: ToolEnv, rootTaskId: string, reason: string): string[] {
  const dependentsByDependency = new Map<string, string[]>()
  for (const edge of env.store.listEdges(env.runId)) {
    const list = dependentsByDependency.get(edge.toTaskId) ?? []
    list.push(edge.fromTaskId)
    dependentsByDependency.set(edge.toTaskId, list)
  }

  const cancelled: string[] = []
  const seen = new Set<string>([rootTaskId])
  const queue: Array<{ taskId: string; dependencyTaskId: string }> = [
    { taskId: rootTaskId, dependencyTaskId: rootTaskId },
  ]
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i] as { taskId: string; dependencyTaskId: string }
    for (const dependentId of dependentsByDependency.get(current.taskId) ?? []) {
      if (seen.has(dependentId)) continue
      seen.add(dependentId)
      const dependent = env.store.getTask(dependentId)
      // A completed dependent may legitimately have ready children; only a
      // cancelled/failed terminal dependent makes its subtree unreachable.
      if (TERMINAL_TASK_STATES.has(dependent.state)) continue
      try {
        env.store.setTaskState(dependent.id, 'cancelled', {
          failure: {
            code: 'dependency_cancelled',
            dependencyTaskId: current.taskId,
            rootTaskId,
            reason,
          },
        })
      } catch (e) {
        if (!(e instanceof StateTransitionError)) throw e
        // Another writer made it terminal between the read and the CAS. Its
        // subtree is no longer ours to touch; the direct cancel already won.
        if (!TERMINAL_TASK_STATES.has(env.store.getTask(dependent.id).state)) throw e
        continue
      }
      env.store.appendEvent({
        projectId: env.projectId,
        runId: env.runId,
        taskId: dependent.id,
        shipId: env.callerShipId,
        type: 'task.cancelled_by_dependency',
        payload: {
          dependencyTaskId: current.taskId,
          rootTaskId,
          reason,
          cancelledBy: env.callerShipId,
        },
      })
      cancelled.push(dependent.id)
      queue.push({ taskId: dependent.id, dependencyTaskId: current.taskId })
    }
  }
  return cancelled
}

/**
 * Approval expiry stamp from the operator's `runtime.approval_timeout_minutes`
 * (0 = approvals never expire). One helper so every creation site — specialist
 * proposals and generic approval requests — rides the same TTL.
 */
function approvalExpiresAt(nowMs: number, ttlMinutes: number): string | null {
  if (ttlMinutes <= 0) return null
  return new Date(nowMs + ttlMinutes * 60_000).toISOString()
}

async function proposeNewShip(
  env: ToolEnv,
  args: { shipId: string; displayName: string; role: string; engine: string; model: string; reason: string },
  legacyMuse = false,
): Promise<JsonValue> {
  const ships = env.store.listShips().filter((m) => m.projectId === env.projectId)
  if (ships.some((m) => m.id === args.shipId || m.slug === args.shipId)) {
    throw new ConflictError(`Ship '${args.shipId}' already exists in this project`, { shipId: args.shipId })
  }
  const enabled = ships.filter((m) => m.enabled)
  if (enabled.length + 1 > env.limits.maxTeamSize) {
    throw new PolicyDeniedError(
      `team size limit reached: ${enabled.length} enabled Ships, max_team_size ${env.limits.maxTeamSize}`,
    )
  }
  const pending = env.store.listApprovals(env.runId).filter((x) => x.status === 'pending')
  const duplicate = pending.find((x) => (x.action === 'ship.create' || x.action === 'muse.create') && (scopeShipId(x.scope) ?? (x.scope as Record<string, JsonValue>)['museId'] as string | null) === args.shipId)
  if (duplicate) {
    throw new PolicyDeniedError(
      `a pending proposal for Ship '${args.shipId}' already exists (${duplicate.id}); wait for the operator decision`,
    )
  }
  if (pending.length >= MAX_PENDING_APPROVALS) {
    throw new PolicyDeniedError(
      `run ${env.runId} already has ${String(pending.length)} pending approvals (limit ${String(MAX_PENDING_APPROVALS)}); resolve them before asking for more`,
    )
  }
  const enginesInUse = new Set(enabled.map((m) => m.engineKind))
  const addsEngine = !enginesInUse.has(args.engine)
  const approval = env.store.createApproval({
    projectId: env.projectId,
    runId: env.runId,
    taskId: env.callerTaskId,
    requestedByShipId: env.callerShipId,
    action: legacyMuse ? 'muse.create' : 'ship.create',
    reason: args.reason,
    scope: { shipId: args.shipId, museId: args.shipId, displayName: args.displayName, role: args.role, engine: args.engine, model: args.model },
    expiresAt: approvalExpiresAt(env.now(), env.limits.approvalTtlMinutes),
  })
  env.store.appendEvent({
    projectId: env.projectId,
    runId: env.runId,
    taskId: env.callerTaskId,
    shipId: env.callerShipId,
    type: legacyMuse ? 'muse.proposal_recorded' : 'ship.proposal_recorded',
    payload: { approvalId: approval.id, shipId: args.shipId, museId: args.shipId, engine: args.engine, addsEngine },
  })
  return {
    proposalId: approval.id,
    status: 'pending_approval',
    requiresApproval: true,
    addsEngine,
    note: 'specialist Ship creation is operator-gated in this build: the proposal is validated and recorded, nothing is instantiated until the operator decides',
  }
}

export const TOOL_HANDLERS: ToolHandlers = {
  'task.create': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['task.create'].parse(args)
    const assigneeRef = a.assigneeShipId ?? a.assigneeMuseId
    if (!assigneeRef) throw new ValidationError('either assigneeShipId or assigneeMuseId is required')
    const assignee = resolveShip(env, assigneeRef)
    assertDependenciesVisible(env, a.dependsOn)
    const task = admitTask(
      env.store,
      {
        runId: env.runId,
        parentTaskId: null,
        title: a.title,
        brief: a.brief,
        acceptanceCriteria: a.acceptanceCriteria,
        assigneeShipId: assignee.id,
        dependsOn: a.dependsOn,
        writeScope: a.writeScope,
      },
      { maxChildrenPerTask: env.limits.maxChildrenPerTask, maxBriefChars: env.limits.maxBriefChars },
    )
    return { task: summarizeTask(task) }
  },

  'task.delegate': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['task.delegate'].parse(args)
    if (env.callerTaskId === null) {
      throw new PolicyDeniedError('task.delegate requires a task-scoped Ship session; use task.create for top-level tasks')
    }
    const assigneeRef = a.assigneeShipId ?? a.assigneeMuseId
    if (!assigneeRef) throw new ValidationError('either assigneeShipId or assigneeMuseId is required')
    const assignee = resolveShip(env, assigneeRef)
    const caller = env.store.getTask(env.callerTaskId)
    if (TERMINAL_TASK_STATES.has(caller.state)) {
      throw new PolicyDeniedError(
        `calling task '${caller.id}' is already ${caller.state}; a terminal task cannot delegate new work`,
      )
    }
    assertDependenciesVisible(env, a.dependsOn)
    const byId = tasksById(env)
    // Delegation must never cycle back up the task chain: reject assigning the
    // child to any Ship that already owns an ancestor (including the caller's
    // own task, whose assignee is the calling Ship).
    let ancestor: TaskRecord | undefined = caller
    const seen = new Set<string>()
    while (ancestor) {
      if (ancestor.assigneeShipId === assignee.id) {
        throw new PolicyDeniedError(
          `cannot assign child of '${caller.id}' to '${assignee.id}': it already owns ancestor task '${ancestor.id}' (delegation may never cycle up its own chain)`,
        )
      }
      if (seen.has(ancestor.id)) break
      seen.add(ancestor.id)
      ancestor = ancestor.parentTaskId ? byId.get(ancestor.parentTaskId) : undefined
    }
    const task = admitTask(
      env.store,
      {
        runId: env.runId,
        parentTaskId: caller.id,
        title: a.title,
        brief: a.brief,
        acceptanceCriteria: a.acceptanceCriteria,
        assigneeShipId: assignee.id,
        dependsOn: a.dependsOn,
        writeScope: a.writeScope,
      },
      { maxChildrenPerTask: env.limits.maxChildrenPerTask, maxBriefChars: env.limits.maxBriefChars },
    )
    return { task: summarizeTask(task) }
  },

  'task.inspect': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['task.inspect'].parse(args)
    const byId = tasksById(env)
    if (a.taskId !== undefined) {
      const task = byId.get(a.taskId)
      if (!task) throw new NotFoundError('task', a.taskId)
      if (!isVisible(env, task, byId)) {
        throw new PolicyDeniedError(`task '${a.taskId}' is outside your scope`)
      }
      const children = [...byId.values()].filter((t) => t.parentTaskId === task.id).map(summarizeTask)
      const dependsOn = env.store
        .listEdges(env.runId)
        .filter((e) => e.fromTaskId === task.id)
        .map((e) => e.toTaskId)
      return {
        task: summarizeTask(task),
        brief: task.brief,
        acceptanceCriteria: task.acceptanceCriteria,
        children,
        dependsOn,
      }
    }
    const visible = [...byId.values()].filter((t) => isVisible(env, t, byId))
    return {
      count: visible.length,
      maxTasks: env.store.getRun(env.runId).budget.maxTasks,
      tasks: visible.slice(0, 200).map(summarizeTask),
      truncated: visible.length > 200,
    }
  },

  'task.wait': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['task.wait'].parse(args)
    const byId = tasksById(env)
    for (const id of a.taskIds) {
      const task = byId.get(id)
      if (!task) throw new NotFoundError('task', id)
      if (!isVisible(env, task, byId)) throw new PolicyDeniedError(`task '${id}' is outside your scope`)
    }
    const timeoutSeconds = a.timeoutSeconds ?? env.limits.defaultWaitSeconds
    const channel = wakeupChannelFor(env.callerTaskId, env.runId)
    const deadline = env.now() + timeoutSeconds * 1_000
    // Settled = no further automatic progress is possible: a terminal state, or
    // `verifying` — the work is done and only the operator's verification gate
    // can close the task. Waiting for `completed` under a configured gate
    // deadlocked the manager until the run deadline (host-mode smoke,
    // 2026-10-16); `verifying` therefore counts as settled and is reported
    // explicitly, never as success.
    const settled = (t: TaskRecord): boolean => TERMINAL_TASK_STATES.has(t.state) || t.state === 'verifying'
    const withResult = (t: TaskRecord): JsonValue => ({
      ...summarizeTask(t),
      awaitingVerification: t.state === 'verifying',
      result: t.result,
      failure: t.failure,
    })
    // `reason` distinguishes an honest deadline from a cancelled wait: an
    // aborted wait did NOT elapse its deadline (`timedOut: false`), and callers
    // must not read it as either "settled" or "timed out".
    const report = (reason: 'timeout' | 'aborted', current: TaskRecord[]): JsonValue => ({
      timedOut: reason === 'timeout',
      ...(reason === 'aborted' ? { aborted: true } : {}),
      reason,
      pending: current.filter((t) => !settled(t)).map(summarizeTask),
      tasks: current.filter((t) => settled(t)).map(withResult),
    })
    for (;;) {
      const current = a.taskIds.map((id) => env.store.getTask(id))
      if (current.every(settled)) {
        return {
          timedOut: false,
          reason: 'settled',
          tasks: current.filter((t) => settled(t)).map(withResult),
        }
      }
      if (env.signal?.aborted === true) return report('aborted', current)
      const remaining = deadline - env.now()
      if (remaining <= 0) return report('timeout', current)
      // Event-driven: the runtime notifies the registry on settling transitions
      // (terminal or awaiting verification); a wakeup (or a heartbeat slice)
      // simply makes us re-read durable task state. The slice keeps a
      // standalone (stdio) bridge honest when nobody shares its in-process
      // registry: it re-checks every heartbeat instead of sleeping until the
      // deadline. Abort (shutdown/disconnect) cuts the slice short.
      await waitSlice(env.wakeups, channel, Math.min(remaining, env.limits.waitHeartbeatSeconds * 1_000), env.signal)
    }
  },

  'task.get_result': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['task.get_result'].parse(args)
    const task = visibleTask(env, a.taskId)
    const ws = env.store.getWorkspaceByTask(task.id)
    return {
      taskId: task.id,
      status: task.state,
      summary: resultSummaryOf(task.result),
      assignment: task.assignment ?? null,
      result: task.result,
      failure: task.failure,
      changedFiles: await changedFilesFor(env, ws),
      commit: ws?.headCommit ?? null,
      tests: env.store.listVerificationChecksByTask(task.id).map((c) => ({
        name: c.name,
        status: c.status,
        exitCode: c.exitCode,
        durationMs: c.durationMs,
      })),
      blockers: {
        failure: task.failure ?? null,
        unmetCriteria: unmetCriteriaOf(env.store.getTaskVerification(task.id)),
      },
      workspace: ws
        ? {
            id: ws.id,
            branch: ws.branch,
            baseCommit: ws.baseCommit,
            state: ws.state,
            cleanup: `pluton workspace clean --run ${task.runId}`,
          }
        : null,
      task: summarizeTask(task),
    }
  },

  'task.cancel': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['task.cancel'].parse(args)
    const task = visibleTask(env, a.taskId)
    if (TERMINAL_TASK_STATES.has(task.state)) {
      // CS-9: cancelling a terminal task is an idempotent ack, never a conflict.
      // Multiple cancel sources (manager tool, operator signal, a retried call)
      // are expected to race; a repeat must be a no-op — no state write, no event.
      return {
        task: summarizeTask(task),
        alreadyTerminal: true,
        note: `task is already '${task.state}'; nothing to cancel`,
      }
    }
    let updated: TaskRecord
    try {
      updated = env.store.setTaskState(task.id, 'cancelled')
    } catch (e) {
      // The CAS lost to a concurrent terminal write (another cancel source won
      // the race): the intent is already satisfied — ack the durable winner,
      // never mint a spurious error or a second cancel event.
      if (!(e instanceof StateTransitionError)) throw e
      const fresh = env.store.getTask(task.id)
      if (!TERMINAL_TASK_STATES.has(fresh.state)) throw e
      return {
        task: summarizeTask(fresh),
        alreadyTerminal: true,
        note: `task is already '${fresh.state}'; nothing to cancel`,
      }
    }
    env.store.appendEvent({
      projectId: env.projectId,
      runId: env.runId,
      taskId: task.id,
      shipId: env.callerShipId,
      type: 'task.cancelled_by_tool',
      payload: { reason: a.reason, cancelledBy: env.callerShipId },
    })
    const cancelledDependents = cancelDependentTasks(env, task.id, a.reason)
    return {
      task: summarizeTask(updated),
      ...(cancelledDependents.length > 0 ? { cancelledDependents } : {}),
      note:
        cancelledDependents.length > 0
          ? `a live engine attempt for this task is interrupted by the runtime on its next control tick; also cancelled ${cancelledDependents.length} dependent task(s) that can no longer run`
          : 'a live engine attempt for this task is interrupted by the runtime on its next control tick',
    }
  },

  'task.request_revision': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['task.request_revision'].parse(args)
    // Manager scope is the caller's SESSION shape, not its permission set: a
    // task-scoped session is refused even when its Ship was granted the
    // permission, so no worker can ever send a task back.
    if (env.callerTaskId !== null) {
      throw new PolicyDeniedError('task.request_revision is manager-scoped (top-level manager session only)')
    }
    const task = visibleTask(env, a.taskId)
    if (task.state !== 'failed') {
      throw new PolicyDeniedError(
        `task '${task.id}' is ${task.state}; only a failed task can be sent back for revision`,
      )
    }
    // The cap is counted from durable events, never from memory: a restarted
    // process (or a second supervisor) sees exactly the same revision budget.
    // The 1_000-event bound is ample (the cap is at most 10 per task); the
    // count is filtered by taskId afterwards, so over-permissive truncation is
    // the only risk.
    const scheduled = env.store
      .listEvents(task.runId, { type: 'task.revision_scheduled', limit: 1_000 })
      .filter((e) => e.taskId === task.id).length
    if (scheduled >= env.limits.maxRevisionsPerTask) {
      throw new PolicyDeniedError(
        `revision cap reached for task '${task.id}': ${String(scheduled)} of ${String(env.limits.maxRevisionsPerTask)} already scheduled`,
      )
    }
    const feedback = stripControlChars(a.feedback).trim()
    if (feedback === '') {
      throw new ValidationError('feedback is empty after control-character stripping')
    }
    const updated = env.store.setTaskStateIf(task.id, 'failed', 'queued', {
      attempt: task.attempt + 1,
      // The revision payload must never erase the real failure: the previous
      // classification rides along under `previousFailure`.
      failure: {
        code: 'revision_requested',
        feedback,
        requestedByShipId: env.callerShipId,
        requestedByMuseId: env.callerShipId,
        previousFailure: task.failure,
      },
    })
    if (updated === null) {
      // Another writer moved the task between the eligibility check and the
      // CAS (cancel, timeout, …): report the conflict, do not retry blindly.
      throw new ConflictError(`task '${task.id}' state changed concurrently; re-inspect before retrying`)
    }
    env.store.appendEvent({
      projectId: env.projectId,
      runId: task.runId,
      taskId: task.id,
      shipId: env.callerShipId,
      type: 'task.revision_scheduled',
      payload: { attempt: updated.attempt },
    })
    // Wake the run loop exactly like the supervisor's own retry path, so the
    // requeued task is dispatched without waiting out the poll cadence.
    env.wakeups.notify(wakeupChannelFor(null, env.runId), task.id, updated.state)
    return { task: summarizeTask(updated) }
  },

'review.report': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['review.report'].parse(args)
    const task = visibleTask(env, a.taskId)
    if (task.state !== 'verifying') {
      throw new PolicyDeniedError(
        `task '${task.id}' is ${task.state}; only a task in 'verifying' can be reviewed`,
      )
    }
    // Anti-self-approval: the worker that did the work cannot be the one
    // that certifies it. The supervisor also cannot certify a task it
    // assigned to itself.
    if (env.callerShipId === task.assigneeShipId) {
      throw new PolicyDeniedError(
        `reviewer '${env.callerShipId}' cannot review its own task '${task.id}' (anti-self-approval)`,
      )
    }
    const assignment = (task.assignment !== null && typeof task.assignment === 'object' && !Array.isArray(task.assignment))
      ? (task.assignment as Record<string, unknown>)
      : null
    const assignedShipId = assignment !== null && typeof assignment['shipId'] === 'string' ? assignment['shipId'] : null
    if (assignedShipId !== null && env.callerShipId === assignedShipId) {
      throw new PolicyDeniedError(
        `reviewer '${env.callerShipId}' is the assignee of task '${task.id}'; a different Ship must review it`,
      )
    }

    const verdict = a.verdict
    const issues = a.issues ?? []

    if (verdict === 'INSUFFICIENT_EVIDENCE') {
      env.store.appendEvent({
        projectId: env.projectId,
        runId: env.runId,
        taskId: task.id,
        shipId: env.callerShipId,
        type: 'review.reported',
        payload: {
          verdict,
          summary: a.summary,
          issues,
          reviewerShipId: env.callerShipId,
          changesTaskState: false,
        },
      })
      return { task: summarizeTask(task), verdict, changedState: false }
    }

    if (verdict === 'REJECT') {
      const failed = env.store.setTaskState(task.id, 'failed', {
        failure: { code: 'review_rejected', message: a.summary, issues, reviewerShipId: env.callerShipId },
      })
      env.store.appendEvent({
        projectId: env.projectId,
        runId: env.runId,
        taskId: task.id,
        shipId: env.callerShipId,
        type: 'review.reported',
        payload: { verdict, summary: a.summary, issues, reviewerShipId: env.callerShipId, changesTaskState: true },
      })
      env.store.appendEvent({
        projectId: env.projectId,
        runId: env.runId,
        taskId: task.id,
        type: 'task.failed',
        payload: { via: 'review', summary: a.summary },
      })
      return { task: summarizeTask(failed), verdict, changedState: true }
    }

    if (verdict === 'REQUEST_CHANGES') {
      const scheduled = env.store
        .listEvents(env.runId, { type: 'review.reported', limit: 1_000 })
        .filter((e) => e.taskId === task.id && (e.payload as Record<string, unknown>)?.['verdict'] === 'REQUEST_CHANGES')
        .length
      if (scheduled >= env.limits.maxRevisionsPerTask) {
        throw new PolicyDeniedError(
          `review revision cap reached for task '${task.id}': ${String(scheduled)} of ${String(env.limits.maxRevisionsPerTask)} already requested`,
        )
      }
      const updated = env.store.setTaskStateIf(task.id, 'verifying', 'queued', {
        attempt: task.attempt + 1,
        failure: {
          code: 'review_changes_requested',
          feedback: a.summary,
          issues,
          requestedByShipId: env.callerShipId,
          previousFailure: task.failure,
        },
      })
      if (updated === null) {
        throw new ConflictError(`task '${task.id}' state changed concurrently; re-inspect before reviewing`)
      }
      env.store.appendEvent({
        projectId: env.projectId,
        runId: env.runId,
        taskId: task.id,
        shipId: env.callerShipId,
        type: 'review.reported',
        payload: { verdict, summary: a.summary, issues, reviewerShipId: env.callerShipId, changesTaskState: true },
      })
      env.store.appendEvent({
        projectId: env.projectId,
        runId: env.runId,
        taskId: task.id,
        type: 'task.revision_scheduled',
        payload: { attempt: updated.attempt, via: 'review' },
      })
      env.wakeups.notify(wakeupChannelFor(null, env.runId), task.id, updated.state)
      return { task: summarizeTask(updated), verdict, changedState: true }
    }

    // APPROVE: only when the durable evidence actually supports completion.
    try {
      const verdictResult = applyTaskVerificationVerdict(env.store, task.id, {
        diffText: '',
        changedFiles: [],
      })
      if (verdictResult.state !== 'completed') {
        throw new ValidationError(`review approval cannot complete task '${task.id}': verification verdict was ${verdictResult.state}`)
      }
    } catch (e) {
      if (e instanceof ValidationError) {
        env.store.appendEvent({
          projectId: env.projectId,
          runId: env.runId,
          taskId: task.id,
          shipId: env.callerShipId,
          type: 'review.reported',
          payload: {
            verdict: 'INSUFFICIENT_EVIDENCE',
            summary: `approval could not be applied: ${e.message}`,
            issues,
            reviewerShipId: env.callerShipId,
            changesTaskState: false,
            originalVerdict: 'APPROVE',
          },
        })
        throw new PolicyDeniedError(
          `review approval refused for task '${task.id}': ${e.message} (recorded as INSUFFICIENT_EVIDENCE)`,
        )
      }
      throw e
    }
    env.store.appendEvent({
      projectId: env.projectId,
      runId: env.runId,
      taskId: task.id,
      shipId: env.callerShipId,
      type: 'review.reported',
      payload: { verdict, summary: a.summary, issues, reviewerShipId: env.callerShipId, changesTaskState: true },
    })
    return { task: summarizeTask(env.store.getTask(task.id)), verdict, changedState: true }
  },
  'ship.propose_create': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['ship.propose_create'].parse(args)
    return proposeNewShip(env, { shipId: a.shipId, displayName: a.displayName, role: a.role, engine: a.engine, model: a.model, reason: a.reason }, false)
  },

  /** @deprecated Use `ship.propose_create`; kept for backward compatibility with engines that still file under the old name. */
  'muse.propose_create': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['muse.propose_create'].parse(args)
    return proposeNewShip(env, { shipId: a.museId, displayName: a.displayName, role: a.role, engine: a.engine, model: a.model, reason: a.reason }, true)
  },

  'approval.request': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['approval.request'].parse(args)
    // Persistence strips control characters (store.createApproval), so the
    // denylist must compare the stripped value: a raw 'ship.create\u0007'
    // would otherwise pass this check and launder into a host-owned action
    // name on the stored card.
    const action = stripControlChars(a.action)
    if (action === '') {
      throw new ValidationError('action is empty after control-character stripping')
    }
    if (HOST_OWNED_APPROVAL_ACTIONS.has(action)) {
      throw new PolicyDeniedError(
        `action '${action}' is host-owned; ships cannot file it via approval.request (Pluton subsystems create these rows)`,
      )
    }
    const record = env.store.getRun(env.runId)
    if (TERMINAL_RUN_STATES.has(record.state)) {
      throw new ConflictError(`run '${record.id}' is already ${record.state}`, { runId: record.id, state: record.state })
    }
    const pendingCount = env.store.listApprovals(env.runId).filter((x) => x.status === 'pending').length
    if (pendingCount >= MAX_PENDING_APPROVALS) {
      throw new PolicyDeniedError(
        `run ${env.runId} already has ${String(pendingCount)} pending approvals (limit ${String(MAX_PENDING_APPROVALS)}); resolve them before asking for more`,
      )
    }
    const approval = env.store.createApproval({
      projectId: env.projectId,
      runId: env.runId,
      taskId: env.callerTaskId,
      requestedByShipId: env.callerShipId,
      action,
      reason: a.reason,
      scope: a.scope ?? {},
      expiresAt: approvalExpiresAt(env.now(), env.limits.approvalTtlMinutes),
    })
    env.store.appendEvent({
      projectId: env.projectId,
      runId: env.runId,
      taskId: env.callerTaskId,
      shipId: env.callerShipId,
      type: 'approval.requested',
      payload: { approvalId: approval.id, action: approval.action },
    })
    const runState =
      record.state === 'active' ? env.store.setRunState(record.id, 'awaiting_approval').state : record.state
    return { approvalId: approval.id, status: 'pending', runState }
  },

  'diff.inspect': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['diff.inspect'].parse(args)
    const task = visibleTask(env, a.taskId)
    const ws = env.store.getWorkspaceByTask(task.id)
    if (!ws || ws.state !== 'active') {
      return { taskId: task.id, workspace: null, note: 'no active checkout for this task yet' }
    }
    assertInsideSessionRoots(env, ws.path)
    // A revision must never be parsed as a git option (`--output=…` etc.).
    if (!BASE_COMMIT_RE.test(ws.baseCommit)) {
      throw new ValidationError(`workspace ${ws.id} has a malformed base commit; refusing to pass it to git`)
    }
    const maxBytes = a.maxBytes ?? 20_000
    // Every datum comes from trusted plumbing against raw trees. `git status`,
    // `git diff` and `git log` are deliberately not used: a worker-controlled
    // `.git` (clean filters, fsmonitor, external diff, textconv) must never
    // execute just because an agent asked to inspect its own diff.
    let state: Awaited<ReturnType<typeof diffWorktreeStat>>
    let recent: Awaited<ReturnType<typeof logOneline>>
    try {
      state = await diffWorktreeStat(ws.path, ws.baseCommit, {
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: maxBytes,
      })
      recent = await logOneline(ws.path, ws.baseCommit, state.head)
    } catch (error) {
      throw new ExternalToolError(
        'git inspect',
        firstLine(error instanceof Error ? error.message : String(error), 300),
        { workspaceId: ws.id },
      )
    }
    return {
      taskId: task.id,
      workspaceId: ws.id,
      branch: ws.branch,
      baseCommit: ws.baseCommit,
      headCommit: state.head,
      status: [`## ${ws.branch}`, ...state.changes].join('\n'),
      diffStat: state.stat,
      recentCommits: recent.log,
      truncated: { status: false, diffStat: state.truncated, recentCommits: recent.truncated },
    }
  },

  'project.read': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['project.read'].parse(args)
    const rel = a.path ?? ''
    if (rel !== '' && (isAbsolute(rel) || rel.split(/[\\/]+/).includes('..'))) {
      throw new PolicyDeniedError(`path must be relative and inside the project (no absolute paths, no '..'): '${rel}'`)
    }
    const roots = sessionReadRoots(env)
    if (roots.length === 0) {
      throw new PolicyDeniedError(
        'no read scope is available for this session yet: wait for the task checkout to be provisioned',
      )
    }
    // Resolve against every root the session is allowed to read (normally one)
    // and canonicalize through the real filesystem before trusting the path:
    // junctions/symlinks (`link -> C:\elsewhere`), case variants (`.PLUTON`)
    // and 8.3 aliases (`PLUTON~1`) must not smuggle anything out of a root or
    // into a refused area. Both sides are realpath'd so the comparison is
    // apples-to-apples; the lexical checks stay as the cheap pre-filter.
    let canonicalRoot: string | null = null
    let canonical: string | null = null
    let canonicalRel = ''
    for (const root of roots) {
      const abs = resolve(root, rel)
      const lexicalRel = relative(root, abs)
      if (lexicalRel.startsWith('..') || isAbsolute(lexicalRel)) continue
      const realRoot = await realpath(root).catch(() => null)
      if (realRoot === null) continue
      const realTarget = await realpath(abs).catch(() => null)
      if (realTarget === null) continue
      const relFromRoot = relative(realRoot, realTarget)
      if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) continue
      canonicalRoot = realRoot
      canonical = realTarget
      canonicalRel = relFromRoot
      break
    }
    if (canonical === null || canonicalRoot === null) {
      const exists = await realpath(resolve(roots[0] as string, rel)).catch(() => null)
      if (exists === null) throw new NotFoundError('path', rel === '' ? '.' : rel)
      throw new PolicyDeniedError(`path resolves outside this session's read roots (via a link): '${rel}'`)
    }
    const refusedCanonical = refusedRelativePath(canonicalRel)
    if (refusedCanonical !== null) {
      throw new PolicyDeniedError(
        `'${canonicalRel}' is inside a refused area ('${refusedCanonical}') and can never be read through Pluton tools`,
      )
    }
    const display = canonicalRel === '' ? '.' : canonicalRel
    const st = await stat(canonical).catch(() => null)
    if (st === null) throw new NotFoundError('path', rel === '' ? '.' : rel)
    if (st.isDirectory()) {
      const entries = (await readdir(canonical, { withFileTypes: true }))
        .filter((e) => !REFUSED_SEGMENTS.has(e.name.toLowerCase()))
        .sort((x, y) => x.name.localeCompare(y.name))
      return {
        path: display,
        type: 'directory',
        entries: entries.slice(0, LISTING_CAP).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
        })),
        truncated: entries.length > LISTING_CAP,
      }
    }
    if (!st.isFile()) {
      return { path: display, type: 'other', note: 'not a regular file or directory' }
    }
    if (st.size > READ_FILE_CAP_BYTES) {
      return {
        path: display,
        type: 'file',
        bytes: st.size,
        tooLarge: true,
        note: `file exceeds the ${READ_FILE_CAP_BYTES}-byte read cap`,
      }
    }
    // Read through a handle with a hard bound: a file that grows between the
    // size check and the read cannot exceed the cap (no stat/read TOCTOU).
    const handle = await open(canonical, 'r')
    try {
      const fst = await handle.stat()
      if (!fst.isFile() || fst.size > READ_FILE_CAP_BYTES) {
        return {
          path: display,
          type: 'file',
          bytes: fst.size,
          tooLarge: true,
          note: `file exceeds the ${READ_FILE_CAP_BYTES}-byte read cap`,
        }
      }
      const buf = Buffer.allocUnsafe(READ_FILE_CAP_BYTES + 1)
      const read = await handle.read(buf, 0, buf.length, 0)
      if (read.bytesRead > READ_FILE_CAP_BYTES) {
        return {
          path: display,
          type: 'file',
          bytes: read.bytesRead,
          tooLarge: true,
          note: `file exceeds the ${READ_FILE_CAP_BYTES}-byte read cap`,
        }
      }
      const data = buf.subarray(0, read.bytesRead)
      if (data.subarray(0, 8_192).includes(0)) {
        return { path: display, type: 'file', bytes: read.bytesRead, binary: true }
      }
      return { path: display, type: 'file', bytes: read.bytesRead, text: data.toString('utf8') }
    } finally {
      await handle.close().catch(() => {})
    }
  },

  'run.stop': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['run.stop'].parse(args)
    const record = env.store.getRun(env.runId)
    if (TERMINAL_RUN_STATES.has(record.state)) {
      // CS-9: same idempotent ack as task.cancel — a run that already stopped is
      // not an error, and no second `run.stop_requested` event is minted.
      return {
        runId: record.id,
        state: record.state,
        alreadyTerminal: true,
        note: `run is already '${record.state}'; nothing to stop`,
      }
    }
    let updated: RunRecord
    try {
      updated = env.store.setRunState(record.id, 'cancelled')
    } catch (e) {
      // Same idempotent-ack rule as the pre-check above: a concurrent terminal
      // write won the CAS — report the durable winner, no second event.
      if (!(e instanceof StateTransitionError)) throw e
      const fresh = env.store.getRun(record.id)
      if (!TERMINAL_RUN_STATES.has(fresh.state)) throw e
      return {
        runId: fresh.id,
        state: fresh.state,
        alreadyTerminal: true,
        note: `run is already '${fresh.state}'; nothing to stop`,
      }
    }
    env.store.appendEvent({
      projectId: env.projectId,
      runId: record.id,
      taskId: env.callerTaskId,
      shipId: env.callerShipId,
      type: 'run.stop_requested',
      payload: { reason: a.reason, requestedBy: env.callerShipId },
    })
    return { runId: updated.id, state: updated.state }
  },

  'scope.declare': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['scope.declare'].parse(args)
    if (!env.callerTaskId) {
      throw new ValidationError('scope.declare must be called within a task-scoped session')
    }
    if (!env.leaseManager) {
      throw new InternalError('leaseManager is not configured on ToolEnv')
    }
    const res = env.leaseManager.declareScope(env.runId, env.callerTaskId, env.callerShipId, a.paths, a.symbols)
    if (res.conflicts.length > 0) {
      const explanation = res.conflicts.map((c) => c.reason).join('; ')
      env.store.appendEvent({
        projectId: env.projectId,
        runId: env.runId,
        taskId: env.callerTaskId,
        shipId: env.callerShipId,
        type: 'scope.conflict',
        payload: { paths: a.paths, conflicts: res.conflicts as unknown as JsonValue, explanation },
      })
      return { status: 'rejected', conflicts: res.conflicts as unknown as JsonValue, explanation }
    }
    env.store.appendEvent({
      projectId: env.projectId,
      runId: env.runId,
      taskId: env.callerTaskId,
      shipId: env.callerShipId,
      type: 'scope.declared',
      payload: { acquired: res.acquired, symbols: (a.symbols ?? null) as JsonValue },
    })
    return { status: 'acquired', acquired: res.acquired }
  },

  'scope.release': async (env, _args): Promise<JsonValue> => {
    if (!env.callerTaskId) {
      throw new ValidationError('scope.release must be called within a task-scoped session')
    }
    if (!env.leaseManager) {
      throw new InternalError('leaseManager is not configured on ToolEnv')
    }
    const released = env.leaseManager.releaseScope(env.callerTaskId)
    env.store.appendEvent({
      projectId: env.projectId,
      runId: env.runId,
      taskId: env.callerTaskId,
      shipId: env.callerShipId,
      type: 'scope.released',
      payload: { released },
    })
    return { status: 'released', released }
  },

  'ship.message': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['ship.message'].parse(args)
    if (!env.messageBus) {
      throw new PolicyDeniedError('worker messaging is not available in this runtime')
    }
    const recipient = resolveShip(env, a.recipientShipId)
    const message = env.messageBus.send({
      senderShipId: env.callerShipId,
      senderTaskId: env.callerTaskId,
      recipientShipId: recipient.id,
      recipientTaskId: a.taskId ?? null,
      kind: a.kind,
      body: a.body,
      replyTo: a.replyTo ?? null,
    })
    return { message: publicMessage(message) }
  },

  'ship.inbox': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['ship.inbox'].parse(args)
    if (!env.messageBus) {
      throw new PolicyDeniedError('worker messaging is not available in this runtime')
    }
    const messages = await env.messageBus.inbox({
      recipientShipId: env.callerShipId,
      taskId: env.callerTaskId,
      limit: a.limit ?? 20,
      waitMs: a.waitMs ?? 0,
      ...(env.signal !== undefined ? { signal: env.signal } : {}),
    })
    return {
      messages: messages.map(publicMessage),
      count: messages.length,
      note:
        messages.length === 0
          ? 'no undelivered messages'
          : 'these messages are acknowledged and will not be delivered again',
    }
  },
}

/** The wire shape returned to an engine or the detail UI (no internal fields). */
function publicMessage(message: WorkerMessage): Record<string, JsonValue> {
  return {
    id: message.id,
    seq: message.seq,
    runId: message.runId,
    senderShipId: message.senderShipId,
    senderLabel: message.senderLabel,
    senderTaskId: message.senderTaskId,
    recipientShipId: message.recipientShipId,
    recipientLabel: message.recipientLabel,
    recipientTaskId: message.recipientTaskId,
    kind: message.kind,
    body: message.body,
    replyTo: message.replyTo,
    createdAt: message.createdAt,
  }
}
