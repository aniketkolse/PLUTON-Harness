import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { ConflictError, ExternalToolError, NotFoundError, PolicyDeniedError, ValidationError } from '../domain/errors.ts'
import type { JsonValue, MuseRecord, TaskRecord } from '../domain/models.ts'
import { TERMINAL_TASK_STATES, type RunState, type TaskState } from '../domain/state.ts'
import { admitTask } from '../orchestrator/task-graph.ts'
import { wakeupChannelFor, type WakeupRegistry } from '../orchestrator/wakeups.ts'
import type { Store } from '../store/store.ts'
import { firstLine, run } from '../util/exec.ts'
import { TOOL_SCHEMAS, type PlutonToolName } from './catalog.ts'
import type { ToolBridgeLimits } from './bridge.ts'

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
  runId: string
  callerMuseId: string
  callerTaskId: string | null
  limits: ToolBridgeLimits
  wakeups: WakeupRegistry
  now: () => number
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
/** A workspace base commit must be a plain hex object id before it reaches git. */
const BASE_COMMIT_RE = /^[0-9a-fA-F]{7,64}$/

type TaskSummary = {
  id: string
  title: string
  state: TaskState
  depth: number
  parentTaskId: string | null
  assigneeMuseId: string | null
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
    assigneeMuseId: t.assigneeMuseId,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  }
}

function tasksById(env: ToolEnv): Map<string, TaskRecord> {
  return new Map(env.store.listTasks(env.runId).map((t) => [t.id, t]))
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

/** Accepts a Muse id or its project slug; anything else is a config-level mistake, not a guess. */
function resolveMuse(env: ToolEnv, ref: string): MuseRecord {
  const direct = env.store.getMuse(ref)
  if (direct && direct.projectId === env.projectId && direct.enabled) return direct
  const bySlug = env.store
    .listMuses()
    .find((m) => m.projectId === env.projectId && m.slug === ref && m.enabled)
  if (bySlug) return bySlug
  throw new ValidationError(`unknown or disabled Muse '${ref}': use an id or slug from the project's team`)
}

function assertInsideRoot(rootDir: string, path: string): void {
  const root = resolve(rootDir)
  const abs = resolve(path)
  const rel = relative(root, abs)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  throw new ExternalToolError('path guard', `stored path escapes the project root: ${path}`, { path })
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

function scopeMuseId(scope: JsonValue): string | null {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return null
  const value = (scope as Record<string, JsonValue>)['museId']
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

export const TOOL_HANDLERS: ToolHandlers = {
  'task.create': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['task.create'].parse(args)
    const assignee = resolveMuse(env, a.assigneeMuseId)
    assertDependenciesVisible(env, a.dependsOn)
    const task = admitTask(
      env.store,
      {
        runId: env.runId,
        parentTaskId: null,
        title: a.title,
        brief: a.brief,
        acceptanceCriteria: a.acceptanceCriteria,
        assigneeMuseId: assignee.id,
        dependsOn: a.dependsOn,
      },
      { maxChildrenPerTask: env.limits.maxChildrenPerTask, maxBriefChars: env.limits.maxBriefChars },
    )
    return { task: summarizeTask(task) }
  },

  'task.delegate': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['task.delegate'].parse(args)
    if (env.callerTaskId === null) {
      throw new PolicyDeniedError('task.delegate requires a task-scoped Muse session; use task.create for top-level tasks')
    }
    const assignee = resolveMuse(env, a.assigneeMuseId)
    const caller = env.store.getTask(env.callerTaskId)
    if (TERMINAL_TASK_STATES.has(caller.state)) {
      throw new PolicyDeniedError(
        `calling task '${caller.id}' is already ${caller.state}; a terminal task cannot delegate new work`,
      )
    }
    assertDependenciesVisible(env, a.dependsOn)
    const byId = tasksById(env)
    // Delegation must never cycle back up the task chain: reject assigning the
    // child to any Muse that already owns an ancestor (including the caller's
    // own task, whose assignee is the calling Muse).
    let ancestor: TaskRecord | undefined = caller
    const seen = new Set<string>()
    while (ancestor) {
      if (ancestor.assigneeMuseId === assignee.id) {
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
        assigneeMuseId: assignee.id,
        dependsOn: a.dependsOn,
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
    const terminal = (t: TaskRecord): boolean => TERMINAL_TASK_STATES.has(t.state)
    for (;;) {
      const current = a.taskIds.map((id) => env.store.getTask(id))
      if (current.every(terminal)) {
        return {
          timedOut: false,
          tasks: current.map((t) => ({ ...summarizeTask(t), result: t.result, failure: t.failure })),
        }
      }
      const remaining = deadline - env.now()
      if (remaining <= 0) {
        return {
          timedOut: true,
          pending: current.filter((t) => !terminal(t)).map(summarizeTask),
          tasks: current
            .filter(terminal)
            .map((t) => ({ ...summarizeTask(t), result: t.result, failure: t.failure })),
        }
      }
      // Event-driven: the runtime notifies the registry on terminal transitions;
      // a wakeup (or a heartbeat slice) simply makes us re-read durable task
      // state. The slice keeps a standalone (stdio) bridge honest when nobody
      // shares its in-process registry: it re-checks every heartbeat instead of
      // sleeping until the deadline.
      await env.wakeups.waitFor(channel, Math.min(remaining, env.limits.waitHeartbeatSeconds * 1_000))
    }
  },

  'task.get_result': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['task.get_result'].parse(args)
    const task = visibleTask(env, a.taskId)
    const ws = env.store.getWorkspaceByTask(task.id)
    return {
      task: summarizeTask(task),
      result: task.result,
      failure: task.failure,
      workspace: ws
        ? { id: ws.id, branch: ws.branch, headCommit: ws.headCommit, state: ws.state }
        : null,
    }
  },

  'task.cancel': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['task.cancel'].parse(args)
    const task = visibleTask(env, a.taskId)
    if (TERMINAL_TASK_STATES.has(task.state)) {
      throw new ConflictError(`task '${task.id}' is already ${task.state}`, { taskId: task.id, state: task.state })
    }
    const updated = env.store.setTaskState(task.id, 'cancelled')
    env.store.appendEvent({
      projectId: env.projectId,
      runId: env.runId,
      taskId: task.id,
      museId: env.callerMuseId,
      type: 'task.cancelled_by_tool',
      payload: { reason: a.reason, cancelledBy: env.callerMuseId },
    })
    return {
      task: summarizeTask(updated),
      note: 'a live engine attempt for this task is stopped cooperatively by the runtime on its next check',
    }
  },

  'muse.propose_create': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['muse.propose_create'].parse(args)
    const muses = env.store.listMuses().filter((m) => m.projectId === env.projectId)
    if (muses.some((m) => m.id === a.museId || m.slug === a.museId)) {
      throw new ConflictError(`Muse '${a.museId}' already exists in this project`, { museId: a.museId })
    }
    const enabled = muses.filter((m) => m.enabled)
    if (enabled.length + 1 > env.limits.maxTeamSize) {
      throw new PolicyDeniedError(
        `team size limit reached: ${enabled.length} enabled Muses, max_team_size ${env.limits.maxTeamSize}`,
      )
    }
    const pending = env.store.listApprovals(env.runId).filter((x) => x.status === 'pending')
    const duplicate = pending.find((x) => x.action === 'muse.create' && scopeMuseId(x.scope) === a.museId)
    if (duplicate) {
      throw new PolicyDeniedError(
        `a pending proposal for Muse '${a.museId}' already exists (${duplicate.id}); wait for the operator decision`,
      )
    }
    if (pending.length >= MAX_PENDING_APPROVALS) {
      throw new PolicyDeniedError(
        `run ${env.runId} already has ${String(pending.length)} pending approvals (limit ${String(MAX_PENDING_APPROVALS)}); resolve them before asking for more`,
      )
    }
    const enginesInUse = new Set(enabled.map((m) => m.engineKind))
    const addsEngine = !enginesInUse.has(a.engine)
    const approval = env.store.createApproval({
      projectId: env.projectId,
      runId: env.runId,
      taskId: env.callerTaskId,
      requestedByMuseId: env.callerMuseId,
      action: 'muse.create',
      reason: a.reason,
      scope: { museId: a.museId, displayName: a.displayName, role: a.role, engine: a.engine, model: a.model },
    })
    env.store.appendEvent({
      projectId: env.projectId,
      runId: env.runId,
      taskId: env.callerTaskId,
      museId: env.callerMuseId,
      type: 'muse.proposal_recorded',
      payload: { approvalId: approval.id, museId: a.museId, engine: a.engine, addsEngine },
    })
    return {
      proposalId: approval.id,
      status: 'pending_approval',
      requiresApproval: true,
      addsEngine,
      note: 'specialist Muse creation is operator-gated in this build: the proposal is validated and recorded, nothing is instantiated until the operator decides',
    }
  },

  'approval.request': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['approval.request'].parse(args)
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
      requestedByMuseId: env.callerMuseId,
      action: a.action,
      reason: a.reason,
      scope: a.scope ?? {},
    })
    env.store.appendEvent({
      projectId: env.projectId,
      runId: env.runId,
      taskId: env.callerTaskId,
      museId: env.callerMuseId,
      type: 'approval.requested',
      payload: { approvalId: approval.id, action: a.action },
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
    assertInsideRoot(env.rootDir, ws.path)
    // A revision must never be parsed as a git option (`--output=…` etc.).
    if (!BASE_COMMIT_RE.test(ws.baseCommit)) {
      throw new ValidationError(`workspace ${ws.id} has a malformed base commit; refusing to pass it to git`)
    }
    const maxBytes = a.maxBytes ?? 20_000
    const opts = { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: maxBytes }
    const [status, diff, log] = await Promise.all([
      run(['git', '-C', ws.path, 'status', '--porcelain=v1', '-b'], opts),
      run(['git', '-C', ws.path, 'diff', '--stat', '--end-of-options', ws.baseCommit], opts),
      run(['git', '-C', ws.path, 'log', '--oneline', '--no-decorate', '--end-of-options', `${ws.baseCommit}..HEAD`], opts),
    ])
    if (status.exitCode !== 0) {
      throw new ExternalToolError('git status', firstLine(status.stderr, 300) || `exit ${String(status.exitCode)}`, {
        workspaceId: ws.id,
      })
    }
    return {
      taskId: task.id,
      workspaceId: ws.id,
      branch: ws.branch,
      baseCommit: ws.baseCommit,
      headCommit: ws.headCommit,
      status: status.stdout,
      diffStat: diff.exitCode === 0 ? diff.stdout : null,
      recentCommits: log.exitCode === 0 ? log.stdout : null,
      truncated: { status: status.truncated, diffStat: diff.truncated, recentCommits: log.truncated },
    }
  },

  'project.read': async (env, args): Promise<JsonValue> => {
    const a = TOOL_SCHEMAS['project.read'].parse(args)
    const rel = a.path ?? ''
    if (rel !== '' && (isAbsolute(rel) || rel.split(/[\\/]+/).includes('..'))) {
      throw new PolicyDeniedError(`path must be relative and inside the project (no absolute paths, no '..'): '${rel}'`)
    }
    const root = resolve(env.rootDir)
    const abs = resolve(root, rel)
    const relFromRoot = relative(root, abs)
    if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
      throw new PolicyDeniedError(`path escapes the project root: '${rel}'`)
    }
    const refused = refusedRelativePath(relFromRoot)
    if (refused !== null) {
      throw new PolicyDeniedError(`'${relFromRoot}' is inside a refused area ('${refused}') and can never be read through Pluton tools`)
    }
    // Canonicalize through the real filesystem before trusting the path:
    // junctions/symlinks (`link -> C:\elsewhere`), case variants (`.PLUTON`)
    // and 8.3 aliases (`PLUTON~1`) must not smuggle anything out of the root or
    // into a refused area. Both sides are realpath'd so the comparison is
    // apples-to-apples; the lexical checks above stay as the cheap pre-filter.
    const canonicalRoot = await realpath(root)
    const canonical = await realpath(abs).catch(() => null)
    if (canonical === null) throw new NotFoundError('path', rel === '' ? '.' : rel)
    const canonicalRel = relative(canonicalRoot, canonical)
    if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) {
      throw new PolicyDeniedError(`path resolves outside the project root (via a link): '${rel}'`)
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
      throw new ConflictError(`run '${record.id}' is already ${record.state}`, { runId: record.id, state: record.state })
    }
    const updated = env.store.setRunState(record.id, 'cancelled')
    env.store.appendEvent({
      projectId: env.projectId,
      runId: record.id,
      taskId: env.callerTaskId,
      museId: env.callerMuseId,
      type: 'run.stop_requested',
      payload: { reason: a.reason, requestedBy: env.callerMuseId },
    })
    return { runId: updated.id, state: updated.state }
  },
}
