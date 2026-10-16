import { ZodError } from 'zod'
import { InternalError, NotFoundError, PolicyDeniedError, PlutonError } from '../domain/errors.ts'
import type { JsonValue } from '../domain/models.ts'
import type { Store } from '../store/store.ts'
import { WakeupRegistry } from '../orchestrator/wakeups.ts'
import { getToolDef, toolInfosForMcp } from './catalog.ts'
import type { McpToolCallResult, McpToolHost, McpToolInfo } from './mcp-server.ts'
import { TOOL_HANDLERS, type ToolEnv } from './handlers.ts'

export { wakeupChannelFor } from './handlers.ts'

/**
 * The authorization core of the Pluton tool bridge (ADR-0007). Identity is
 * server-side: the caller Muse, its task scope and its permissions are bound
 * when the bridge is constructed for one engine session — nothing the model
 * says can widen them. Every call is validated, executed inside the run's
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
}

export const DEFAULT_TOOL_RESULT_CHARS = 120_000
export const DEFAULT_WAIT_SECONDS = 120
export const DEFAULT_WAIT_HEARTBEAT_SECONDS = 15

/** Map the validated runtime config onto bridge limits (single source of truth). */
export function toolBridgeLimitsFromRuntime(runtime: {
  max_child_tasks_per_task: number
  max_team_size: number
  max_prompt_chars: number
  max_tool_result_chars: number
  heartbeat_seconds: number
}): ToolBridgeLimits {
  return {
    maxChildrenPerTask: runtime.max_child_tasks_per_task,
    maxBriefChars: runtime.max_prompt_chars,
    maxTeamSize: runtime.max_team_size,
    maxToolResultChars: runtime.max_tool_result_chars,
    defaultWaitSeconds: DEFAULT_WAIT_SECONDS,
    waitHeartbeatSeconds: runtime.heartbeat_seconds,
  }
}

export interface PlutonToolBridgeOptions {
  store: Store
  projectId: string
  rootDir: string
  runId: string
  callerMuseId: string
  /** The caller's own task when its session is task-scoped (null for the manager). */
  callerTaskId: string | null
  limits: ToolBridgeLimits
  /** Shared per-run registry; the runtime notifies it when tasks reach terminal states. */
  wakeups?: WakeupRegistry
  now?: () => number
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

export class PlutonToolBridge implements McpToolHost {
  private readonly env: ToolEnv
  private readonly permissions: readonly string[]
  private readonly maxToolResultChars: number

  constructor(opts: PlutonToolBridgeOptions) {
    const muse = opts.store.getMuse(opts.callerMuseId)
    if (!muse || !muse.enabled) {
      throw new PolicyDeniedError(`caller muse '${opts.callerMuseId}' is not an enabled Muse of this project`)
    }
    if (muse.projectId !== opts.projectId) {
      throw new InternalError(`muse '${muse.id}' belongs to project ${muse.projectId}, not ${opts.projectId}`)
    }
    const run = opts.store.getRunOrNull(opts.runId)
    if (!run) throw new NotFoundError('run', opts.runId)
    if (run.projectId !== opts.projectId) {
      throw new InternalError(`run '${run.id}' belongs to project ${run.projectId}, not ${opts.projectId}`)
    }
    this.permissions = muse.permissions
    const now = opts.now ?? Date.now
    this.maxToolResultChars = opts.limits.maxToolResultChars
    this.env = {
      store: opts.store,
      projectId: opts.projectId,
      rootDir: opts.rootDir,
      runId: opts.runId,
      callerMuseId: opts.callerMuseId,
      callerTaskId: opts.callerTaskId,
      limits: opts.limits,
      wakeups: opts.wakeups ?? new WakeupRegistry(),
      now,
    }
  }

  /** Only tools this caller could actually call; the per-call check is authoritative. */
  listTools(): McpToolInfo[] {
    return toolInfosForMcp().filter((info) => {
      const def = getToolDef(info.name)
      return def !== null && this.permissions.includes(def.permission)
    })
  }

  async call(name: string, args: unknown, opts?: { signal?: AbortSignal }): Promise<McpToolCallResult> {
    const started = this.env.now()
    // Per-call env: the abort signal belongs to the transport's request, not to
    // the bridge's lifetime (long waits must observe shutdown immediately).
    const env = opts?.signal !== undefined ? { ...this.env, signal: opts.signal } : this.env
    // Bound the model-controlled name BEFORE anything is audited: an oversized
    // name must never make an event payload throw and silently drop the denial
    // record (the store caps event payloads).
    const displayName = name.length > 200 ? `${name.slice(0, 200)}…` : name
    const def = getToolDef(name)
    if (!def) {
      this.audit('tool.denied', { tool: displayName, reason: 'unknown_tool' })
      return this.failure('not_found', `unknown Pluton tool '${displayName}'`)
    }
    if (!this.permissions.includes(def.permission)) {
      this.audit('tool.denied', { tool: def.name, reason: 'permission_missing', permission: def.permission })
      return this.failure(
        'policy_denied',
        `muse '${this.env.callerMuseId}' lacks permission '${def.permission}' for tool '${def.name}'`,
      )
    }
    try {
      const data = await TOOL_HANDLERS[def.name](env, args)
      const result: McpToolCallResult = { ok: true, data: this.bound(data) }
      this.audit('tool.call', { tool: def.name, ok: true, mutating: def.mutating, durationMs: this.env.now() - started })
      return result
    } catch (e) {
      this.audit('tool.call', {
        tool: def.name,
        ok: false,
        mutating: def.mutating,
        errorCode: e instanceof ZodError ? 'invalid_arguments' : e instanceof PlutonError ? e.code : 'internal_error',
        durationMs: this.env.now() - started,
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
    this.env.store.appendEvent({
      projectId: this.env.projectId,
      runId: this.env.runId,
      taskId: this.env.callerTaskId,
      museId: this.env.callerMuseId,
      type,
      payload,
    })
  }
}
