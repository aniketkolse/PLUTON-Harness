import { ZodError } from 'zod'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { InternalError, NotFoundError, PolicyDeniedError, PlutonError } from '../domain/errors.ts'
import type { JsonValue } from '../domain/models.ts'
import type { Store } from '../store/store.ts'
import type { WorkerMessageBus } from '../orchestrator/messages.ts'
import { WakeupRegistry } from '../orchestrator/wakeups.ts'
import type { FileLeaseManager } from '../orchestrator/lease-manager.ts'
import type { GitWorkspaceManager } from '../workspace/manager.ts'
import { getToolDef, toolInfosForMcp } from './catalog.ts'
import type { McpToolCallResult, McpToolHost, McpToolInfo } from './mcp-server.ts'
import { TOOL_HANDLERS, type ToolEnv } from './handlers.ts'
import {
  getOperatorToolDef,
  OPERATOR_TOOL_HANDLERS,
  operatorToolInfosForMcp,
  type OperatorToolEnv,
} from './operator-catalog.ts'

export { wakeupChannelFor } from './handlers.ts'

/**
 * The authorization core of the Pluton tool bridge (ADR-0007, ADR-0012). Identity is
 * server-side: the caller Ship, its task/run scope and its permissions are bound
 * when the bridge is constructed for one engine session — nothing the model
 * says can widen them. Every call is validated, executed inside the run's (or operator's)
 * budget/graph rules, and audited as an event; failures are typed results, not
 * silent successes.
 */

export interface ToolBridgeLimits {
  /** runtime.max_child_tasks_per_task */
  maxChildrenPerTask: number
  /** runtime bound for task briefs (chars). */
  maxBriefChars: number
  /** runtime.max_team_size */
  maxTeamSize: number
  /** Hard cap for a serialized tool result handed back to the engine. */
  maxToolResultChars: number
  /** Default task.wait timeout when the caller does not pass one. */
  defaultWaitSeconds: number
  /**
   * Longest single wakeup wait inside task.wait before durable state is
   * re-read. In-process runtimes wake immediately via the shared registry; a
   * standalone bridge process (stdio child) falls back to this cadence.
   */
  waitHeartbeatSeconds: number
  /** runtime.approval_timeout_minutes: pending approvals expire after this TTL (0 = never). */
  approvalTtlMinutes: number
  /** runtime.max_revisions_per_task: per-task cap on manager-requested revisions (0 = disabled). */
  maxRevisionsPerTask: number
}

export const DEFAULT_TOOL_RESULT_CHARS = 120_000
export const DEFAULT_WAIT_SECONDS = 120
export const DEFAULT_WAIT_HEARTBEAT_SECONDS = 15
export const DEFAULT_APPROVAL_TTL_MINUTES = 60

/** Map the validated runtime config onto bridge limits (single source of truth). */
export function toolBridgeLimitsFromRuntime(runtime: {
  max_child_tasks_per_task: number
  max_team_size: number
  max_prompt_chars: number
  max_tool_result_chars: number
  heartbeat_seconds: number
  approval_timeout_minutes: number
  max_revisions_per_task: number
}): ToolBridgeLimits {
  return {
    maxChildrenPerTask: runtime.max_child_tasks_per_task,
    maxBriefChars: runtime.max_prompt_chars,
    maxTeamSize: runtime.max_team_size,
    maxToolResultChars: runtime.max_tool_result_chars,
    defaultWaitSeconds: DEFAULT_WAIT_SECONDS,
    waitHeartbeatSeconds: runtime.heartbeat_seconds,
    approvalTtlMinutes: runtime.approval_timeout_minutes,
    maxRevisionsPerTask: runtime.max_revisions_per_task,
  }
}

export interface PlutonToolBridgeOptions {
  store: Store
  projectId: string
  rootDir: string
  runId?: string | null
  callerShipId?: string
  /** @deprecated Use `callerShipId`; kept for backward compatibility. */
  callerMuseId?: string
  /** The caller's own task when its session is task-scoped (null for the manager or operator). */
  callerTaskId?: string | null
  /**
   * Filesystem roots this session's read tools may resolve against. Derived
   * server-side: a task-scoped session gets only its own checkout, while the
   * manager sees the project root. Callers cannot widen this through tool
   * arguments.
   */
  readRoots?: string[]
  limits: ToolBridgeLimits
  leaseManager?: FileLeaseManager
  /** The project's workspace manager, so result reads can diff real checkouts. */
  workspaceManager?: GitWorkspaceManager
  /** Shared per-run registry; the runtime notifies it when tasks reach terminal states. */
  wakeups?: WakeupRegistry
  /** Direct worker-to-worker messaging bus for this run (absent = tool not usable). */
  messageBus?: WorkerMessageBus
  now?: () => number
  /** Injected by pluton chat: create + drive a supervised run in the background. Required when runId is null/omitted. */
  startRun?: (input: { goal: string; acceptance: string[]; requestId?: string }) => Promise<{ runId: string }>
}

function errorDetails(e: unknown): JsonValue | undefined {
  const details = (e as { details?: unknown }).details
  if (details === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(details)) as JsonValue
  } catch {
    return { unserializable: true }
  }
}

function canonical(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : resolve(path)
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Read scope is derived from durable identity, never from tool arguments:
 * a task-scoped session may read only its own checkout; the manager (or any
 * task-less session) reads the project root it was constructed for.
 */
function resolveSessionReadRoots(opts: PlutonToolBridgeOptions): string[] {
  const projectRoot = canonical(opts.rootDir)
  let candidates: string[]
  if (opts.readRoots !== undefined) {
    candidates = opts.readRoots
  } else if (opts.callerTaskId !== undefined && opts.callerTaskId !== null) {
    const workspace = opts.store.getWorkspaceByTask(opts.callerTaskId)
    candidates = workspace === null ? [] : [workspace.path]
  } else {
    candidates = [opts.rootDir]
  }
  const roots: string[] = []
  for (const candidate of candidates) {
    const real = canonical(candidate)
    // A session root may never escape the project root it is scoped to: this
    // keeps a wiring bug or a malicious workspace row from widening reads.
    if (!inside(projectRoot, real)) continue
    if (!roots.includes(real)) roots.push(real)
  }
  return roots
}

export class PlutonToolBridge implements McpToolHost {
  private readonly store: Store
  private readonly projectId: string
  private readonly rootDir: string
  private readonly callerShipId: string
  private readonly now: () => number
  private readonly permissions: readonly string[]
  private readonly maxToolResultChars: number
  private readonly isOperator: boolean
  private readonly runEnv: ToolEnv | null
  private readonly operatorEnv: OperatorToolEnv | null

  constructor(opts: PlutonToolBridgeOptions) {
    const callerShipId = opts.callerShipId ?? opts.callerMuseId
    if (!callerShipId) {
      throw new PolicyDeniedError('callerShipId is required')
    }
    const ship = opts.store.getShip(callerShipId)
    if (!ship || !ship.enabled) {
      throw new PolicyDeniedError(`caller ship '${callerShipId}' is not an enabled Ship of this project`)
    }
    if (ship.projectId !== opts.projectId) {
      throw new InternalError(`ship '${ship.id}' belongs to project ${ship.projectId}, not ${opts.projectId}`)
    }

    this.store = opts.store
    this.projectId = opts.projectId
    this.rootDir = opts.rootDir
    this.callerShipId = callerShipId
    this.now = opts.now ?? Date.now
    this.permissions = ship.permissions
    this.maxToolResultChars = opts.limits.maxToolResultChars

    if (opts.runId === undefined || opts.runId === null) {
      // Operator scope
      if (!opts.startRun) {
        throw new InternalError('startRun callback is required for operator-scoped bridge (runId is null/undefined)')
      }
      this.isOperator = true
      this.runEnv = null
      this.operatorEnv = {
        store: opts.store,
        projectId: opts.projectId,
        rootDir: opts.rootDir,
        callerShipId,
        now: this.now,
        startRun: opts.startRun,
      }
    } else {
      // Run scope
      const run = opts.store.getRunOrNull(opts.runId)
      if (!run) throw new NotFoundError('run', opts.runId)
      if (run.projectId !== opts.projectId) {
        throw new InternalError(`run '${run.id}' belongs to project ${run.projectId}, not ${opts.projectId}`)
      }
      this.isOperator = false
      this.operatorEnv = null
      this.runEnv = {
        store: opts.store,
        projectId: opts.projectId,
        rootDir: opts.rootDir,
        readRoots: resolveSessionReadRoots(opts),
        runId: opts.runId,
        callerShipId,
        callerTaskId: opts.callerTaskId ?? null,
        limits: opts.limits,
        leaseManager: opts.leaseManager,
        workspaceManager: opts.workspaceManager,
        wakeups: opts.wakeups ?? new WakeupRegistry(),
        messageBus: opts.messageBus,
        now: this.now,
      }
    }
  }

  /** Only tools this caller could actually call; the per-call check is authoritative. */
  listTools(): McpToolInfo[] {
    if (this.isOperator) {
      return operatorToolInfosForMcp().filter((info) => {
        const def = getOperatorToolDef(info.name)
        return def !== null && this.permissions.includes(def.permission)
      })
    }
    return toolInfosForMcp().filter((info) => {
      const def = getToolDef(info.name)
      return def !== null && this.permissions.includes(def.permission)
    })
  }

  /**
   * Task-aware tool selection (Batch 6).
   *
   * Filters the caller's permitted tools down to those relevant for a specific
   * task, based on the task's writeScope and acceptance criteria. This is a
   * narrowing filter only: it never grants permission for a tool the caller
   * does not already have, and it never hides a tool the caller is authorized
   * to use unless the task's scope makes it clearly irrelevant.
   *
   * Selection rules:
   * - `task.inspect`, `task.get_result`, `task.cancel`, `task.wait` are always
   *   available (task lifecycle tools).
   * - `task.create`, `task.delegate` are always available (delegation tools).
   * - `diff.inspect`, `project.read` are always available (read-only inspection).
   * - `ship.message`, `ship.inbox` are always available (peer coordination).
   * - `approval.request`, `review.report`, `ship.propose_create`,
   *   `task.request_revision` are always available (governance tools).
   * - `scope.declare`, `scope.release` are included only if the task has a
   *   non-empty writeScope (they are scope-management tools).
   * - `run.stop` is always available (emergency stop).
   *
   * Returns the subset of `candidateTools` that are relevant for this task.
   * Does not mutate state; never adds tools the caller lacks permission for.
   */
  selectToolsForTask(taskId: string, availableTools: McpToolInfo[]): McpToolInfo[] {
    const task = this.runEnv ? this.runEnv.store.getTaskOrNull(taskId) : null
    const writeScope = task?.writeScope ?? []
    const acceptanceCriteria = task?.acceptanceCriteria ?? []
    const hasWriteScope = writeScope.length > 0
    const hasAcceptanceCriteria = acceptanceCriteria.length > 0

    // Always-available tools (task lifecycle, read-only inspection, governance)
    const alwaysAvailable = new Set([
      'task.inspect',
      'task.get_result',
      'task.cancel',
      'task.wait',
      'task.create',
      'task.delegate',
      'diff.inspect',
      'project.read',
      'ship.message',
      'ship.inbox',
      'approval.request',
      'review.report',
      'ship.propose_create',
      'task.request_revision',
      'run.stop',
    ])

    // Scope-management tools: only relevant when the task has a write scope
    const scopeTools = new Set(['scope.declare', 'scope.release'])

    const result: McpToolInfo[] = []
    for (const tool of availableTools) {
      // Never include tools the caller lacks permission for
      const def = getToolDef(tool.name)
      if (!def || !this.permissions.includes(def.permission)) continue

      // Always-available tools are always included
      if (alwaysAvailable.has(tool.name)) {
        result.push(tool)
        continue
      }

      // Scope-management tools require a write scope
      if (scopeTools.has(tool.name)) {
        if (hasWriteScope) result.push(tool)
        continue
      }

      // Anything else (shouldn't happen with the current catalog) is included
      // only if the task's acceptance criteria mention one of its write scopes,
      // otherwise excluded as irrelevant.
      const hasRelevantKeyword = acceptanceCriteria.some((c) =>
        writeScope.some((ws) => c.toLowerCase().includes(ws.toLowerCase()))
      )
      if (hasRelevantKeyword) result.push(tool)
    }

    return result
  }

  async call(name: string, args: unknown, opts?: { signal?: AbortSignal }): Promise<McpToolCallResult> {
    const started = this.now()
    const displayName = name.length > 200 ? `${name.slice(0, 200)}…` : name

    if (this.isOperator) {
      const def = getOperatorToolDef(name)
      if (!def) {
        this.audit('tool.denied', { tool: displayName, reason: 'unknown_tool' })
        return this.failure('not_found', `unknown Pluton tool '${displayName}'`)
      }
      if (!this.permissions.includes(def.permission)) {
        this.audit('tool.denied', { tool: def.name, reason: 'permission_missing', permission: def.permission })
        return this.failure(
          'policy_denied',
          `ship '${this.callerShipId}' lacks permission '${def.permission}' for tool '${def.name}'`,
        )
      }
      const env: OperatorToolEnv = opts?.signal !== undefined ? { ...this.operatorEnv!, signal: opts.signal } : this.operatorEnv!
      try {
        const data = await OPERATOR_TOOL_HANDLERS[def.name]!(env, args)
        const result: McpToolCallResult = { ok: true, data: this.bound(data) }
        this.audit('tool.call', { tool: def.name, ok: true, mutating: def.mutating, durationMs: this.now() - started })
        return result
      } catch (e) {
        this.audit('tool.call', {
          tool: def.name,
          ok: false,
          mutating: def.mutating,
          errorCode: e instanceof ZodError ? 'invalid_arguments' : e instanceof PlutonError ? e.code : 'internal_error',
          durationMs: this.now() - started,
        })
        if (e instanceof ZodError) {
          return this.failure(
            'invalid_arguments',
            `invalid arguments for '${def.name}': ${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`.slice(0, 2_000),
            { issues: e.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })) },
          )
        }
        if (e instanceof PlutonError) {
          return this.failure(e.code, e.message, errorDetails(e))
        }
        const message = e instanceof Error ? e.message : String(e)
        return this.failure('internal_error', message.slice(0, 1_000))
      }
    }

    // Run scope
    const env = opts?.signal !== undefined ? { ...this.runEnv!, signal: opts.signal } : this.runEnv!
    const def = getToolDef(name)
    if (!def) {
      this.audit('tool.denied', { tool: displayName, reason: 'unknown_tool' })
      return this.failure('not_found', `unknown Pluton tool '${displayName}'`)
    }
    if (!this.permissions.includes(def.permission)) {
      this.audit('tool.denied', { tool: def.name, reason: 'permission_missing', permission: def.permission })
      return this.failure(
        'policy_denied',
        `ship '${this.runEnv!.callerShipId}' lacks permission '${def.permission}' for tool '${def.name}'`,
      )
    }

    // Batch 6: record tool invocation start (durable, before execution)
    this.audit('tool.invoked', {
      tool: def.name,
      taskId: this.runEnv?.callerTaskId ?? null,
      shipId: this.callerShipId,
      startedAt: this.now(),
      argsKeys: args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : undefined,
    } as JsonValue)

    try {
      const data = await TOOL_HANDLERS[def.name](env, args)
      const result: McpToolCallResult = { ok: true, data: this.bound(data) }
      // Batch 6: record tool completion (durable)
    this.audit('tool.completed', {
      tool: def.name,
      taskId: this.runEnv?.callerTaskId ?? null,
      shipId: this.callerShipId,
      durationMs: this.now() - started,
      resultTruncated: result.data === undefined ? undefined : JSON.stringify(result.data).length > this.maxToolResultChars,
    } as JsonValue)
    this.audit('tool.call', { tool: def.name, ok: true, mutating: def.mutating, durationMs: this.now() - started })
    return result
  } catch (e) {
    // Batch 6: record tool failure (durable)
    this.audit('tool.failed', {
      tool: def.name,
      taskId: this.runEnv?.callerTaskId ?? null,
      shipId: this.callerShipId,
      durationMs: this.now() - started,
      errorCode: e instanceof ZodError ? 'invalid_arguments' : e instanceof PlutonError ? e.code : 'internal_error',
      errorMessage: e instanceof Error ? e.message.slice(0, 1_000) : String(e),
    } as JsonValue)
    this.audit('tool.call', {
        tool: def.name,
        ok: false,
        mutating: def.mutating,
        errorCode: e instanceof ZodError ? 'invalid_arguments' : e instanceof PlutonError ? e.code : 'internal_error',
        durationMs: this.now() - started,
      })
      if (e instanceof ZodError) {
        return this.failure(
          'invalid_arguments',
          `invalid arguments for '${def.name}': ${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`.slice(0, 2_000),
          { issues: e.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })) },
        )
      }
      if (e instanceof PlutonError) {
        return this.failure(e.code, e.message, errorDetails(e))
      }
      const message = e instanceof Error ? e.message : String(e)
      return this.failure('internal_error', message.slice(0, 1_000))
    }
  }

  private failure(code: string, message: string, details?: JsonValue): McpToolCallResult {
    const error: { code: string; message: string; details?: JsonValue } = { code, message }
    if (details !== undefined) {
      const text = JSON.stringify(details)
      error.details = text !== undefined && text.length > this.maxToolResultChars ? { truncated: true, chars: text.length } : details
    }
    return { ok: false, error }
  }

  private bound(data: unknown): JsonValue {
    const text = JSON.stringify(data ?? null)
    if (text === undefined) return { serializationError: true }
    if (text.length <= this.maxToolResultChars) return JSON.parse(text) as JsonValue
    return { truncated: true, originalChars: text.length, preview: text.slice(0, this.maxToolResultChars) }
  }

  private audit(type: string, payload: JsonValue): void {
    this.store.appendEvent({
      projectId: this.projectId,
      runId: this.runEnv?.runId ?? null,
      taskId: this.runEnv?.callerTaskId ?? null,
      shipId: this.callerShipId,
      type,
      payload,
    })
  }
}
