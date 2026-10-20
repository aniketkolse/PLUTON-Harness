import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ConflictError,
  InternalError,
  NotFoundError,
  OwnershipLostError,
  StateTransitionError,
} from '../domain/errors.ts'
import type { ApprovalRecord, JsonValue, MuseRecord, RunRecord, TaskRecord } from '../domain/models.ts'
import { engineAdapterForMuse, type EngineIsolationFacts } from '../engines/approval.ts'
import { stripControlChars } from '../util/sanitize.ts'
import {
  createEngineApprovalChannel,
  type EngineApprovalSettlement,
  type EnginePermissionChannel,
} from '../engines/interactive-approval.ts'
import type {
  EngineAdapter,
  EngineEvent,
  EngineSession,
  McpServerSpec,
  PromptRequest,
} from '../engines/contract/types.ts'
import { SESSION_BACKED_TASK_STATES, TERMINAL_TASK_STATES, isTerminal, type RunState, type TaskState } from '../domain/state.ts'
import type { Store, SupervisorFence } from '../store/store.ts'
import type { GitWorkspaceManager } from '../workspace/manager.ts'
import { KeyedMutex } from './mutex.ts'
import { notifyTaskSettled, taskAncestorIds, WakeupRegistry, wakeupChannelFor } from './wakeups.ts'
import { PlutonToolBridge, type ToolBridgeLimits } from '../tools/bridge.ts'
import { FileLeaseManager } from './lease-manager.ts'
import { CircuitBreaker } from './circuit-breaker.ts'
import { UsageLedger } from './usage-ledger.ts'
import { newId } from '../domain/ids.ts'

/**
 * Run supervisor (Phase 6, ADR-0006/0007).
 *
 * One supervisor drives one run: it opens the manager session (the Manager Muse
 * plans and delegates through the restricted tool bridge), dispatches every
 * ready task to its assignee's engine in its own checkout, records results
 * durably, and finalizes the run from what the durable records actually say —
 * never from what an engine claimed.
 *
 * Honesty rules encoded here:
 * - A task reaches `completed` only from `verifying` with no verification
 *   checks configured; when checks exist the task stops in `verifying` for the
 *   Phase-7 gate. A task is never completed because an engine said "done".
 * - A prompt that times out is `unknown` — never success, never auto-replayed.
 * - Tasks that can no longer run (failed dependency) stay visibly `queued`;
 *   the run fails instead of pretending they were skipped.
 * - Engine/session/workspace errors are recorded on the task (`failed`) with a
 *   bounded failure payload; the supervisor never swallows them silently.
 *
 * Scope: engine processes run on the host here (mock/dev). The CLI wires real
 * engines and containers on top; `adapterFor` and `mcpServerFor` are the seams.
 */

/** Builds the per-Muse adapter; `session.isolatedCheckout` is a proven runtime fact. */
export type SupervisorAdapterFactory = (muse: MuseRecord, session: EngineIsolationFacts) => EngineAdapter

/**
 * Live inspector event for one worker (task). The server maps these onto the
 * durable `worker.*` event log + SSE frames; the supervisor only describes what
 * really happened (session start, tool step, settled state), never a guess.
 */
export interface WorkerLifecycleEvent {
  type:
    | 'worker.started'
    | 'worker.progress'
    | 'worker.question'
    | 'worker.waiting'
    | 'worker.report'
    | 'worker.completed'
    | 'worker.failed'
    | 'worker.cancelled'
  runId: string
  taskId: string
  role: string
  model?: string
  workspace?: string
  payload?: Record<string, unknown>
}

export interface SupervisorOptions {
  store: Store
  projectId: string
  /** The user's repository (read-only to Pluton; clone source for checkouts). */
  rootDir: string
  /** Where per-task checkouts live (`.pluton/workspaces`). */
  workspacesRoot: string
  runId: string
  /** Bridge limits for the manager session (from runtime config). */
  limits: ToolBridgeLimits
  maxConcurrentWorkers: number
  defaultTaskTimeoutMs: number
  runDeadlineMs: number
  /** true → successful tasks stop in `verifying` (Phase-7 gate owns completion). */
  verificationConfigured: boolean
  /** Cheapest honest re-scan cadence for the dispatch loop. */
  loopPollMs?: number
  /**
   * CS-9 bounded shutdown: how long the post-loop drain may wait for in-flight
   * task executors and the manager prompt before the run finalizes without
   * them (default {@link DEFAULT_DRAIN_BOUND_MS}).
   */
  drainBoundMs?: number
  /**
   * Run-ownership lease TTL in ms (default {@link DEFAULT_OWNERSHIP_TTL_MS}).
   * A live owner renews at `ttl / 3`; a claim whose heartbeat is older than the
   * TTL may be taken over by another process. Test seam for deterministic
   * ownership-loss scenarios.
   */
  ownershipTtlMs?: number
  adapterFor?: SupervisorAdapterFactory
  workspaceManager?: GitWorkspaceManager
  /** Extra environment variables per Muse (allowlisted by the caller; never secrets here). */
  engineEnv?: (muse: MuseRecord) => Record<string, string>
  /** MCP server spec handed to engine sessions; null = engines get no tools (dev/mock). */
  mcpServerFor?: (muse: MuseRecord, taskId: string | null) => McpServerSpec | null
  wakeups?: WakeupRegistry
  now?: () => number
  /**
   * Observer for live per-worker inspector events (SSE). Called synchronously
   * on the run's hot path, so an observer failure must never break the run:
   * {@link RunSupervisor} isolates it. Absent in CLI/headless runs.
   */
  onWorkerEvent?: (event: WorkerLifecycleEvent) => void
  diagnostic?: (line: string) => void
  leaseManager?: FileLeaseManager
  circuitBreaker?: CircuitBreaker
  usageLedger?: UsageLedger
  maxRetriesPerTask?: number
  skipManager?: boolean
}

export interface RunOutcome {
  runId: string
  state: RunState
  outcome: 'success' | 'failure' | 'cancelled' | 'unknown' | 'timeout' | 'pending_verification' | 'superseded'
  managerSummary: string | null
  taskCounts: Record<string, number>
  /** Tasks left non-terminal when the run finished (e.g. blocked by a failed dep). */
  unfinishedTasks: string[]
  /**
   * Non-terminal tasks that are NOT awaiting verification: they cannot progress
   * because a dependency has not been verified yet. A run in `verifying` with
   * blocked tasks can never be closed by `pluton verify` — the operator must
   * decide what to do with the blocked work (Phase-7 follow-up).
   */
  blockedTasks: string[]
}

/** Task tallies shared by `finalize()` and the read-only `superseded` outcome. */
interface DurableRunCounts {
  taskCounts: Record<string, number>
  unfinishedTasks: string[]
  blockedTasks: string[]
}

interface PromptOutcome {
  outcome: 'success' | 'failure' | 'cancelled' | 'unknown'
  summary: string | null
  errorCode: string | null
  textChars: number
}

/**
 * Task states that imply an active engine session: they gate run quiescence (a
 * run is only settled once none of them is present) and they are exactly the
 * states restart recovery must reconcile, because a new process cannot resume
 * a session the dead one owned. The canonical list lives in the domain
 * (`SESSION_BACKED_TASK_STATES`) so recovery must never keep its own copy.
 */
const ACTIVELY_RUNNING: ReadonlySet<TaskState> = SESSION_BACKED_TASK_STATES
const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(['completed', 'failed', 'cancelled', 'uncertain'])
/**
 * Run states that deliberately park the supervisor's finalize write for an
 * operator decision: a concurrent write in the finalize window that leaves one
 * of these is benign — the guard would have skipped the write had it read the
 * fresh row.
 */
const OPERATOR_WAIT_RUN_STATES: ReadonlySet<RunState> = new Set(['verifying', 'awaiting_approval', 'awaiting_input'])
const DEFAULT_LOOP_POLL_MS = 200
/** CS-9: how long the post-loop drain may wait before finalizing anyway. */
const DEFAULT_DRAIN_BOUND_MS = 5_000
/** CS-9: `interruptSent` sentinel for the manager session (task ids are `task_…`). */
const MANAGER_INTERRUPT_KEY = 'manager-session'
/**
 * Durable run-ownership lease: a claim whose heartbeat is older than this may
 * be taken over (renewals every `ttl / 3` keep a live owner's claim fresh).
 */
export const DEFAULT_OWNERSHIP_TTL_MS = 90_000

function boundedSummary(text: string | undefined, max = 2_000): string | null {
  if (text === undefined) return null
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Read a JSON object value without trusting its shape. */
function jsonObject(value: JsonValue | null): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null
}

/**
 * The outcome a terminal durable run state implies (mirrors the CLI's mapping).
 * Used when a control-plane terminal write wins the finalize window, so the
 * returned outcome and the `run.finished` payload can never contradict the
 * durable state label.
 */
function outcomeFromRunState(state: RunState): RunOutcome['outcome'] | null {
  switch (state) {
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

/**
 * The manager's revision feedback when the task's last recorded failure is a
 * CS-5 revision requeue (`task.request_revision`); null for real failures and
 * for malformed payloads, so only the revision path can inject a section into
 * the next attempt's prompt.
 */
function revisionFeedbackOf(task: TaskRecord): string | null {
  const failure = task.failure
  if (failure === null || typeof failure !== 'object' || Array.isArray(failure)) return null
  const record = failure as { [key: string]: JsonValue }
  if (record['code'] !== 'revision_requested') return null
  const feedback = record['feedback']
  return typeof feedback === 'string' ? feedback : null
}

export function buildTaskPrompt(task: TaskRecord, muse: MuseRecord, maxChars: number): string {
  const lines = [
    `You are ${muse.displayName}, a ${muse.role} Muse of the Pluton-Harness control plane.`,
    '',
    `Task: ${task.title}`,
    '',
    'Brief:',
    task.brief,
  ]
  if (task.acceptanceCriteria.length > 0) {
    lines.push('', 'Acceptance criteria:', ...task.acceptanceCriteria.map((c) => `- ${c}`))
  }
  const revisionFeedback = revisionFeedbackOf(task)
  if (revisionFeedback !== null) {
    lines.push('', 'Revision feedback from the manager (address it in this attempt):', revisionFeedback)
  }
  lines.push(
    '',
    'Rules:',
    "- Work only inside your assigned workspace; never touch the user's repository or Pluton's runtime state.",
    '- Pluton tools (task.*, diff.inspect, …) are available when configured; never claim work you did not do.',
    '- When done, end your turn with a concise summary: what changed, how it was verified, what remains.',
  )
  const text = lines.join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[truncated by Pluton: prompt exceeded max_prompt_chars]`
}

export function buildManagerPrompt(
  goal: string,
  managerMuse: MuseRecord,
  muses: MuseRecord[],
  acceptanceCriteria: string[],
  maxChars: number,
): string {
  const team = muses.map((m) => `- ${m.slug} (${m.role}, engine ${m.engineKind}, model ${m.model}, workspace ${m.workspacePolicy})`)
  const lines = [
    `You are ${managerMuse.displayName}, the Manager Muse of one Pluton-Harness run.`,
    '',
    'Goal:',
    goal,
  ]
  if (acceptanceCriteria.length > 0) {
    lines.push('', 'Acceptance criteria for the whole run:', ...acceptanceCriteria.map((c) => `- ${c}`))
  }
  lines.push(
    '',
    'Team:',
    ...team,
    '',
    'Rules:',
    '- Plan first: create the minimal set of tasks with the task.create tool (assign each to the right Muse; use dependsOn for ordering; an assignee may never own an ancestor task).',
    '- Delegate only through the Pluton tools; Pluton state, not your prose, is authoritative.',
    '- Use task.wait to wait for your team: it returns once every requested task has settled (completed, failed, cancelled, or awaiting verification).',
    "- A task in 'verifying' has finished its work and awaits the operator's verification gate — report it as awaiting verification; never keep waiting for it to become completed.",
    '- Finish by collecting the settled tasks with task.get_result, then end your turn with a concise report: what is done, what is awaiting verification, what remains. Never claim a result the task records do not support.',
  )
  const text = lines.join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[truncated by Pluton: prompt exceeded max_prompt_chars]`
}

const activeSupervisors = new Map<string, RunSupervisor>()

export function getActiveSupervisor(runId: string): RunSupervisor | undefined {
  return activeSupervisors.get(runId)
}

export function wakeSupervisor(runId: string): void {
  const supervisor = activeSupervisors.get(runId)
  if (supervisor) {
    supervisor.wake()
  }
}

export class RunSupervisor {
  private readonly store: Store
  private readonly projectId: string
  private readonly rootDir: string
  private readonly runId: string
  private readonly limits: ToolBridgeLimits
  private readonly maxConcurrentWorkers: number
  private readonly defaultTaskTimeoutMs: number
  private readonly runDeadlineMs: number
  private readonly verificationConfigured: boolean
  private readonly loopPollMs: number
  private readonly drainBoundMs: number
  /**
   * The per-Muse engine factory actually used: the injected seam, or the
   * approval-aware default ({@link engineAdapterForMuse}). Public so the
   * default path itself is testable without spawning engines.
   */
  readonly adapterFor: SupervisorAdapterFactory
  private readonly workspaceManager: GitWorkspaceManager | null
  private readonly engineEnv: (muse: MuseRecord) => Record<string, string>
  private readonly mcpServerFor: (muse: MuseRecord, taskId: string | null) => McpServerSpec | null
  private readonly wakeups: WakeupRegistry
  private readonly now: () => number
  private readonly diagnostic: (line: string) => void
  private readonly onWorkerEvent: ((event: WorkerLifecycleEvent) => void) | null
  readonly leaseManager: FileLeaseManager
  readonly circuitBreaker: CircuitBreaker
  readonly usageLedger: UsageLedger
  private readonly maxRetriesPerTask: number
  private readonly skipManager: boolean
  private readonly mutex = new KeyedMutex()
  private bridgeInstance: PlutonToolBridge | null = null
  private timedOut = false
  private readonly inFlight = new Map<string, Promise<void>>()
  /** CS-9: live task-scoped engine sessions, by task id (interrupt targets). */
  private readonly liveSessions = new Map<string, EngineSession>()
  /** CS-9: the manager session while its prompt is in flight, or null. */
  private managerSessionRef: EngineSession | null = null
  /** CS-9: sessions already interrupted (task ids + the manager sentinel): interrupt exactly once. */
  private readonly interruptSent = new Set<string>()
  /**
   * Durable-run-ownership state. `fence` is the proven claim this process
   * drives with; every supervisor duty write carries it. `ownershipLost` turns
   * the loss into a single read-only outcome, and `ownershipLossAnnounced`
   * makes the loss bookkeeping idempotent (several call sites can observe it).
   */
  private fence: SupervisorFence | null = null
  private ownershipLost = false
  private ownershipLossAnnounced = false
  private readonly ownershipTtlMs: number
  private readonly ownershipRenewIntervalMs: number
  private lastRenewMs = 0

  constructor(opts: SupervisorOptions) {
    const run = opts.store.getRun(opts.runId)
    if (run.projectId !== opts.projectId) {
      throw new InternalError(`run '${run.id}' belongs to project ${run.projectId}, not ${opts.projectId}`)
    }
    this.store = opts.store
    this.projectId = opts.projectId
    this.rootDir = opts.rootDir
    this.runId = opts.runId
    this.limits = opts.limits
    this.maxConcurrentWorkers = opts.maxConcurrentWorkers
    this.defaultTaskTimeoutMs = opts.defaultTaskTimeoutMs
    this.runDeadlineMs = opts.runDeadlineMs
    this.verificationConfigured = opts.verificationConfigured
    this.loopPollMs = opts.loopPollMs ?? DEFAULT_LOOP_POLL_MS
    this.drainBoundMs = opts.drainBoundMs ?? DEFAULT_DRAIN_BOUND_MS
    this.adapterFor =
      opts.adapterFor ?? ((muse, session) => engineAdapterForMuse(muse, { isolatedCheckout: session.isolatedCheckout }))
    this.workspaceManager = opts.workspaceManager ?? null
    this.engineEnv = opts.engineEnv ?? (() => ({}))
    this.mcpServerFor = opts.mcpServerFor ?? (() => null)
    this.wakeups = opts.wakeups ?? new WakeupRegistry()
    this.now = opts.now ?? Date.now
    this.diagnostic = opts.diagnostic ?? (() => {})
    this.onWorkerEvent = opts.onWorkerEvent ?? null
    this.leaseManager = opts.leaseManager ?? new FileLeaseManager()
    this.circuitBreaker = opts.circuitBreaker ?? new CircuitBreaker()
    this.usageLedger = opts.usageLedger ?? new UsageLedger(opts.runId, undefined, opts.store)
    this.maxRetriesPerTask = opts.maxRetriesPerTask ?? 2
    this.skipManager = opts.skipManager ?? false
    this.ownershipTtlMs = opts.ownershipTtlMs ?? DEFAULT_OWNERSHIP_TTL_MS
    this.ownershipRenewIntervalMs = Math.max(1, Math.floor(this.ownershipTtlMs / 3))
  }

  /** The manager session's bridge (in-process; the HTTP/stdio transports wrap the same bridge). */
  managerBridge(): PlutonToolBridge {
    if (!this.bridgeInstance) {
      const run = this.store.getRun(this.runId)
      this.bridgeInstance = new PlutonToolBridge({
        store: this.store,
        projectId: this.projectId,
        rootDir: this.rootDir,
        runId: this.runId,
        callerMuseId: run.managerMuseId,
        callerTaskId: null,
        limits: this.limits,
        leaseManager: this.leaseManager,
        workspaceManager: this.workspaceManager ?? undefined,
        wakeups: this.wakeups,
        now: this.now,
      })
    }
    return this.bridgeInstance
  }

  private managerChannel(): string {
    return wakeupChannelFor(null, this.runId)
  }

  /**
   * Duty-path events carry the fence: a stale process's append is a no-op
   * proof-of-loss, never a record of the new owner's run. The one deliberately
   * unfenced write is `run.started`, appended immediately after the claim-scoped
   * `created → active` transition (same synchronous span as that fenced write,
   * so no takeover can interleave before the heartbeat ages past the TTL).
   */
  private appendEvent(type: string, payload: JsonValue, taskId?: string, museId?: string): void {
    this.store.appendEvent(
      {
        projectId: this.projectId,
        runId: this.runId,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(museId !== undefined ? { museId } : {}),
        type,
        payload,
      },
      this.fence ?? undefined,
    )
  }

  /** An event written before the claim exists (or as one): deliberately unfenced. */
  private appendEventUnfenced(type: string, payload: JsonValue, taskId?: string, museId?: string): void {
    this.store.appendEvent({
      projectId: this.projectId,
      runId: this.runId,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(museId !== undefined ? { museId } : {}),
      type,
      payload,
    })
  }

  private notifySettled(task: TaskRecord): void {
    notifyTaskSettled(this.wakeups, this.runId, task, taskAncestorIds(this.store, task))
    this.emitSettledWorkerEvent(task)
  }

  /** Role/model snapshot captured at claim time (never later muse config edits). */
  private assignmentFields(task: TaskRecord): { role: string; model?: string } {
    const assignment = jsonObject(task.assignment)
    const role = assignment !== null && typeof assignment['role'] === 'string' ? assignment['role'] : 'worker'
    const model = assignment !== null && typeof assignment['model'] === 'string' ? assignment['model'] : undefined
    return { role, ...(model !== undefined ? { model } : {}) }
  }

  /** Tell the live inspector what durable state the task actually settled in. */
  private emitSettledWorkerEvent(task: TaskRecord): void {
    const base = { runId: this.runId, taskId: task.id, ...this.assignmentFields(task) }
    const result = jsonObject(task.result)
    const failure = jsonObject(task.failure)
    const summary = typeof result?.['summary'] === 'string' ? result['summary'].slice(0, 2_000) : undefined
    const failureMessage =
      typeof failure?.['message'] === 'string'
        ? failure['message'].slice(0, 2_000)
        : typeof failure?.['reason'] === 'string'
          ? failure['reason'].slice(0, 2_000)
          : undefined
    switch (task.state) {
      case 'completed':
        this.emitWorkerEvent({
          ...base,
          type: 'worker.completed',
          ...(summary !== undefined ? { payload: { summary } } : {}),
        })
        return
      case 'verifying':
        this.emitWorkerEvent({
          ...base,
          type: 'worker.report',
          ...(summary !== undefined ? { payload: { summary } } : {}),
        })
        return
      case 'failed':
        this.emitWorkerEvent({ ...base, type: 'worker.failed', payload: { error: failureMessage ?? 'task failed' } })
        return
      case 'cancelled':
        this.emitWorkerEvent({
          ...base,
          type: 'worker.cancelled',
          ...(summary !== undefined ? { payload: { summary } } : {}),
        })
        return
      case 'unknown_outcome':
        this.emitWorkerEvent({
          ...base,
          type: 'worker.failed',
          payload: { error: failureMessage ?? 'unknown outcome' },
        })
        return
      default:
        return
    }
  }

  /** One live inspector event; an observer failure never breaks the run. */
  private emitWorkerEvent(event: WorkerLifecycleEvent): void {
    if (this.onWorkerEvent === null) return
    try {
      this.onWorkerEvent(event)
    } catch (e) {
      this.diagnostic(
        `worker event '${event.type}' for task ${event.taskId} failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  private instructionsFor(muse: MuseRecord): string | undefined {
    if (!muse.instructionsFile) return undefined
    try {
      return readFileSync(join(this.rootDir, muse.instructionsFile), 'utf8')
    } catch {
      this.diagnostic(`instructions file for muse '${muse.id}' could not be read: ${muse.instructionsFile}`)
      return undefined
    }
  }

  /** Collect one prompt's stream with an honest hard bound. */
  private async runPrompt(
    session: EngineSession,
    prompt: PromptRequest,
    context?: {
      taskId?: string
      museId?: string
      onTool?: (tool: { name: string; phase: 'start' | 'end'; summary?: string; isError?: boolean }) => void
    },
  ): Promise<PromptOutcome> {
    let result: { outcome: PromptOutcome['outcome']; summary?: string } | null = null
    let errorCode: string | null = null
    let textChars = 0
    let timedOut = false
    const timer =
      prompt.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true
            void session.interrupt()
          }, prompt.timeoutMs)
        : null
    try {
      for await (const ev of session.sendPrompt(prompt)) {
        this.absorbEvent(ev, {
          onText: (n) => {
            textChars += n
          },
          onResult: (r) => {
            result = r
          },
          onError: (code) => {
            errorCode = code
          },
          onApproval: (a) => {
            // Durable record of an engine permission request and Pluton's
            // answer (the decision text lives in `description`). Distinct from
            // `approval.requested`, which records a Muse filing an approval
            // through the tool bridge: this event is the ENGINE asking and the
            // host deciding (host-mode smoke finding: denials used to vanish,
            // leaving a "successful" no-op task). Description is bounded and
            // control-stripped like every other model-controlled string before
            // it reaches the store.
            this.appendEvent(
              'approval.engine_decision',
              { requestId: a.requestId, description: stripControlChars(a.description).slice(0, 1_000) },
              context?.taskId,
              context?.museId,
            )
          },
          onUsage: (u) => {
            if (context?.museId) {
              const res = this.usageLedger.record(
                {
                  museId: context.museId,
                  taskId: context.taskId,
                  inputTokens: u.inputTokens,
                  outputTokens: u.outputTokens,
                  cachedTokens: 0,
                  costUsd: u.costUsd,
                },
                this.fence ?? undefined,
              )
              if (!res.withinBudget) {
                this.diagnostic(`usage budget exceeded: ${res.limitExceededReason ?? 'hard limit'}`)
                void session.interrupt()
              }
            }
          },
          onTool: (t) => {
            context?.onTool?.(t)
          },
        })
      }
    } catch (e) {
      errorCode = `stream_error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500)
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
    if (timedOut) {
      return { outcome: 'unknown', summary: 'prompt exceeded its time bound', errorCode: 'prompt_timeout', textChars }
    }
    if (result === null) {
      return { outcome: 'unknown', summary: 'engine stream ended without a result event', errorCode, textChars }
    }
    const r: { outcome: PromptOutcome['outcome']; summary?: string } = result
    return {
      outcome: r.outcome,
      summary: boundedSummary(r.summary ?? undefined),
      errorCode,
      textChars,
    }
  }

  private absorbEvent(
    ev: EngineEvent,
    hooks: {
      onText: (n: number) => void
      onResult: (r: { outcome: PromptOutcome['outcome']; summary?: string }) => void
      onError: (code: string) => void
      onApproval?: (a: { requestId: string; description: string }) => void
      onUsage?: (u: { inputTokens: number; outputTokens: number; costUsd: number }) => void
      onTool?: (t: { name: string; phase: 'start' | 'end'; summary?: string; isError?: boolean }) => void
    },
  ): void {
    switch (ev.kind) {
      case 'text':
        hooks.onText(ev.text.length)
        break
      case 'tool':
        hooks.onTool?.({
          name: ev.name,
          phase: ev.phase,
          ...(ev.summary !== undefined ? { summary: ev.summary } : {}),
          ...(ev.isError !== undefined ? { isError: ev.isError } : {}),
        })
        break
      case 'result':
        hooks.onResult({ outcome: ev.outcome, ...(ev.summary !== undefined ? { summary: ev.summary } : {}) })
        break
      case 'error':
        hooks.onError(`${ev.code}: ${ev.message}`.slice(0, 500))
        break
      case 'approval_request':
        hooks.onApproval?.({ requestId: ev.requestId, description: ev.description })
        break
      case 'usage':
        hooks.onUsage?.({
          inputTokens: ev.inputTokens ?? 0,
          outputTokens: ev.outputTokens ?? 0,
          costUsd: ev.costUsd ?? 0,
        })
        break
      default:
        break // status/tool events
    }
  }

  /** Record `failed` on a task through only legal transitions; never fabricate. */
  private failTask(taskId: string, failure: JsonValue, eventType = 'task.failed'): void {
    const fence = this.fence ?? undefined
    try {
      const task = this.store.getTask(taskId)
      if (TERMINAL_TASK_STATES.has(task.state)) return
      let current = task
      if (current.state === 'created') current = this.store.setTaskState(taskId, 'queued', {}, fence)
      if (current.state === 'queued') current = this.store.setTaskState(taskId, 'admitted', {}, fence)
      if (current.state === 'waiting_for_children') current = this.store.setTaskState(taskId, 'running', {}, fence)
      if (current.state === 'needs_approval' || current.state === 'needs_input') {
        current = this.store.setTaskState(taskId, 'failed', { failure }, fence)
      } else if (current.state === 'admitted' || current.state === 'running' || current.state === 'verifying') {
        current = this.store.setTaskState(taskId, 'failed', { failure }, fence)
      } else {
        this.diagnostic(`task ${taskId}: cannot record failure from state '${current.state}'`)
      }
      if (current.state === 'failed') {
        this.appendEvent(eventType, { failure }, taskId)
        this.notifySettled(current)
      }
    } catch (e) {
      // A concurrent control-plane terminal write is the honest winner: the
      // task is already settled by someone else's decision — never fabricate a
      // failure on top of it, and never crash the drain for it.
      if (!(e instanceof StateTransitionError)) throw e
      const fresh = this.store.getTask(taskId).state
      if (!TERMINAL_TASK_STATES.has(fresh)) throw e
      this.diagnostic(`task ${taskId}: not recording a failure — already ${fresh} (control-plane decision won)`)
    }
  }

  /**
   * Provision the task's isolated checkout, or recover the one a previous
   * process left behind. A stale directory at the task's dest is NEVER
   * overwritten or deleted: it is either reattached (its marker proves the same
   * branch + base commit as the durable workspace row — the worker continues in
   * place, dirty state intact) or archived under `.pluton/workspaces-attic/`
   * and replaced by a fresh checkout.
   */
  private async ensureTaskCheckout(
    task: TaskRecord,
    muse: MuseRecord,
  ): Promise<{ workspaceId: string; workdir: string }> {
    const manager = this.workspaceManager
    if (!manager) {
      throw new InternalError('isolated-task-checkout requires a workspace manager')
    }
    const dest = manager.resolveCheckoutPath(task.id)
    // Invariant: an active task workspace row's `path` always equals
    // `resolveCheckoutPath(task.id)` — this supervisor is the only task-row
    // `createWorkspace` caller and it passes `destName: task.id`, which
    // `createCheckout` resolves the same way — so the branches below may treat
    // `dest` as the row's path.
    const existing = this.store.getWorkspaceByTask(task.id)
    const marker = existsSync(dest) ? manager.readCheckoutMarker(dest) : null

    if (
      existing !== null &&
      existsSync(existing.path) &&
      marker !== null &&
      marker.kind === 'task-checkout' &&
      marker.branch === existing.branch &&
      marker.baseCommit === existing.baseCommit
    ) {
      // Same checkout, still owned by this task: re-attach instead of
      // recreating, so uncommitted (possibly unrecoverable) work survives.
      this.appendEvent(
        'task.workspace_reattached',
        { workspaceId: existing.id, branch: existing.branch },
        task.id,
      )
      return { workspaceId: existing.id, workdir: existing.path }
    }

    if (existsSync(dest)) {
      // A directory is there but is not provably this task's checkout (no
      // marker, wrong branch, wrong base commit). Archive it to the attic —
      // never delete it — and provision a fresh checkout below.
      const archivePath = await manager.archiveCheckout(
        dest,
        join(this.rootDir, '.pluton', 'workspaces-attic'),
        `${task.id}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`,
      )
      this.appendEvent(
        'task.workspace_archived',
        { path: dest, archivePath, workspaceId: existing?.id ?? null },
        task.id,
      )
      if (existing !== null) this.store.updateWorkspace(existing.id, { state: 'archived' }, this.fence ?? undefined)
    } else if (existing !== null && !existsSync(existing.path)) {
      // The row claims a checkout that is already gone; record that honestly
      // instead of leaving a live-looking row behind.
      this.store.updateWorkspace(existing.id, { state: 'removed' }, this.fence ?? undefined)
    }

    const info = await manager.createCheckout({
      repoPath: this.rootDir,
      kind: 'task-checkout',
      runId: this.runId,
      slug: task.title,
      destName: task.id,
    })
    const ws = this.store.createWorkspace(
      {
        projectId: this.projectId,
        runId: this.runId,
        taskId: task.id,
        museId: muse.id,
        kind: 'task-checkout',
        path: info.path,
        branch: info.branch,
        baseCommit: info.baseCommit,
      },
      this.fence ?? undefined,
    )
    return { workspaceId: ws.id, workdir: info.path }
  }

  private async executeTask(task: TaskRecord): Promise<void> {
    const store = this.store
    let lostClaim = false
    try {
      if (!task.assigneeMuseId) {
        this.failTask(task.id, { code: 'no_assignee', message: 'task has no assignee Muse' })
        return
      }
      const muse = store.getMuse(task.assigneeMuseId)
      if (!muse || !muse.enabled) {
        this.failTask(task.id, { code: 'muse_unavailable', message: `assignee '${task.assigneeMuseId}' is not an enabled Muse` })
        return
      }
      const claimed = store.setTaskStateIf(
        task.id,
        'queued',
        'admitted',
        {
          // Snapshot the assignment exactly as it is for THIS claim (retries
          // refresh it): later muse config edits must never rewrite history.
          assignment: { museId: muse.id, role: muse.role, engine: muse.engineKind, model: muse.model },
        },
        this.fence ?? undefined,
      )
      if (!claimed) {
        // Lost the claim race (repeated dispatch / another supervisor): stay
        // silent and event-free. The winner owns the task's recorded lease
        // rows; the finally below must not touch them.
        lostClaim = true
        return
      }

      let workspaceId: string | null = null
      let workdir = this.rootDir
      if (muse.workspacePolicy === 'isolated-task-checkout') {
        const ensured = await this.ensureTaskCheckout(task, muse)
        workspaceId = ensured.workspaceId
        workdir = ensured.workdir
      }

      const adapter = this.adapterFor(muse, { isolatedCheckout: workspaceId !== null })
      const mcpSpec = this.mcpServerFor(muse, task.id)
      const instructions = this.instructionsFor(muse)
      const session = await adapter.startSession({
        muse: { id: muse.id, slug: muse.slug, role: muse.role, model: muse.model },
        workdir,
        env: this.engineEnv(muse),
        configDir: muse.engineHome,
        ...(instructions !== undefined ? { instructions } : {}),
        ...(mcpSpec !== null ? { mcpServers: [mcpSpec] } : {}),
        approvals: this.approvalChannel(muse.id, task.id),
      })
      this.liveSessions.set(task.id, session)
      try {
        store.setTaskState(
          task.id,
          'running',
          {
            workspaceId,
            engineSessionId: session.info.nativeSessionId ?? session.info.id,
          },
          this.fence ?? undefined,
        )
        this.appendEvent('task.started', { museId: muse.id, engine: adapter.kind, workspaceId }, task.id)
        this.emitWorkerEvent({
          type: 'worker.started',
          runId: this.runId,
          taskId: task.id,
          role: muse.role,
          model: muse.model,
          workspace: workdir,
          payload: { step: `session started (${adapter.kind})` },
        })
      } catch (e) {
        // A control-plane cancel (or a lost fence) can land after engine startup
        // but before these post-start writes commit. The prompt `finally` below
        // is never reached on that path, so close the session here; the outer
        // finally still owns registry cleanup as the backstop.
        await session.close().catch((closeErr: unknown) => {
          this.diagnostic(
            `task ${task.id}: session close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
          )
        })
        throw e
      }

      const promptText = buildTaskPrompt(task, muse, this.limits.maxBriefChars)
      let out: PromptOutcome
      try {
        out = await this.runPrompt(
          session,
          { text: promptText, timeoutMs: this.defaultTaskTimeoutMs },
          {
            taskId: task.id,
            museId: muse.id,
            onTool: (tool) => {
              if (tool.phase !== 'start') return
              const label =
                tool.summary !== undefined && tool.summary !== '' ? `${tool.name}: ${tool.summary}` : tool.name
              this.emitWorkerEvent({
                type: 'worker.progress',
                runId: this.runId,
                taskId: task.id,
                role: muse.role,
                model: muse.model,
                workspace: workdir,
                payload: { step: stripControlChars(label).slice(0, 300) },
              })
            },
          },
        )
      } finally {
        // CS-9: the session is no longer an interrupt target, and the task's
        // interrupt slot is free again (a later attempt must be interruptible).
        this.liveSessions.delete(task.id)
        this.interruptSent.delete(task.id)
        await session.close().catch((e: unknown) => {
          this.diagnostic(`task ${task.id}: session close failed: ${e instanceof Error ? e.message : String(e)}`)
        })
      }

      const resultPayload: JsonValue = {
        summary: out.summary,
        outcome: out.outcome,
        engine: adapter.kind,
        textChars: out.textChars,
        ...(out.errorCode !== null ? { error: out.errorCode } : {}),
      }
      // CS-4/CS-9 seam: the session teardown above aborts any pending ask without
      // mirroring the flip back, so a task can still read `needs_approval` while its
      // outcome arrives. The outcome writer's premise is a live `running` task —
      // reconcile first (a no-op when nothing was parked).
      store.setTaskStateIf(task.id, 'needs_approval', 'running', {}, this.fence ?? undefined)
      try {
        if (out.outcome === 'success') {
          const verifying = store.setTaskState(task.id, 'verifying', { result: resultPayload }, this.fence ?? undefined)
          if (this.verificationConfigured) {
            this.appendEvent('task.awaiting_verification', { outcome: out.outcome }, task.id)
            this.notifySettled(verifying)
            return
          }
          const done = store.setTaskState(task.id, 'completed', {}, this.fence ?? undefined)
          this.appendEvent('task.completed', { outcome: out.outcome, summary: out.summary }, task.id)
          this.notifySettled(done)
          return
        }
        if (out.outcome === 'failure') {
          const retryDecision = this.circuitBreaker.recordFailure(task.id, resultPayload)
          if (retryDecision.shouldRetry && task.attempt < this.maxRetriesPerTask) {
            const retrying = store.setTaskState(
              task.id,
              'queued',
              {
                attempt: task.attempt + 1,
                failure: resultPayload,
              },
              this.fence ?? undefined,
            )
            this.appendEvent(
              'task.retry_scheduled',
              {
                taskId: task.id,
                attempt: retrying.attempt,
                reason: retryDecision.reason,
              },
              task.id,
            )
            this.wakeups.notify(this.managerChannel(), task.id, retrying.state)
            return
          }
          this.failTask(task.id, { ...resultPayload, reason: retryDecision.reason })
          return
        }
        if (out.outcome === 'cancelled') {
          const cancelled = store.setTaskState(task.id, 'cancelled', { failure: resultPayload }, this.fence ?? undefined)
          this.appendEvent('task.cancelled', { outcome: 'cancelled', summary: out.summary }, task.id)
          this.notifySettled(cancelled)
          return
        }
        const unknown = store.setTaskState(
          task.id,
          'unknown_outcome',
          { failure: resultPayload },
          this.fence ?? undefined,
        )
        this.appendEvent('task.unknown_outcome', { outcome: 'unknown', summary: out.summary }, task.id)
        this.notifySettled(unknown)
      } catch (e) {
        if (!(e instanceof StateTransitionError)) throw e
        // Only an outcome that lost to a *terminal* state is a discarded late
        // result; any other transition error keeps flowing to the outer catch.
        const currentState = store.getTask(task.id).state
        if (!isTerminal(currentState)) throw e
        // The task reached a terminal state while its prompt was still in
        // flight: the outcome arrived too late to apply. Record it durably —
        // routing it to failTask would silently drop it (terminal tasks are
        // never touched again).
        this.appendEvent(
          'task.late_result_discarded',
          { taskId: task.id, outcome: out.outcome, currentState },
          task.id,
        )
        return
      }
    } catch (e) {
      // Losing the run is not a task failure: never convert it into a
      // fabricated `task_setup_failed`. The read-only `superseded` outcome is
      // produced at the top of `runToCompletion`.
      if (e instanceof OwnershipLostError) throw e
      const message = e instanceof Error ? e.message : String(e)
      this.diagnostic(`task ${task.id} failed: ${message}`)
      this.failTask(task.id, { code: 'task_setup_failed', message: message.slice(0, 2_000) })
    } finally {
      // CS-9: backstop — the executor owns its session until it returns, so the
      // interrupt registry must be clean on EVERY path. The prompt's finally
      // already deregisters on the normal path; this also covers the narrow path
      // where the `running` write (or a later write) throws after registration,
      // leaving a session no later tick should ever see again.
      this.liveSessions.delete(task.id)
      this.interruptSent.delete(task.id)
      if (lostClaim) {
        // Only drop this process's in-memory hold: the winner's DB lease rows,
        // the `scope.released` event, and wakeups all belong to the winner.
        this.leaseManager.releaseScope(task.id)
      } else {
        const released = this.leaseManager.releaseScope(task.id)
        this.store.releaseLeasesForTask(task.id, this.fence ?? undefined)
        if (released.length > 0) {
          this.appendEvent('scope.released', { taskId: task.id, paths: released }, task.id)
          this.wakeups.notify(this.managerChannel(), task.id, task.state)
        }
      }
    }
  }

  private dispatchReadyTasks(): void {
    if (this.circuitBreaker.isTripped()) {
      // Semantics (CS-5): an explicit, capped manager revision overrides the
      // automatic-retry guard. The breaker exists to stop AUTOMATIC retry
      // loops; when a ready task carries a revision requeue the manager
      // deliberately asked for one more attempt, so reset the breaker and fall
      // through to the normal dispatch loop. Attempt counters and
      // max_revisions_per_task still bound execution, and the breaker trips
      // again if the revised attempt produces new identical failures.
      const hasRevisionRequeue = this.store.listReadyTasks(this.runId).some((t) => revisionFeedbackOf(t) !== null)
      if (!hasRevisionRequeue) {
        this.diagnostic(this.circuitBreaker.getTripReason() ?? 'circuit breaker tripped')
        return
      }
      // Capture the reason BEFORE reset clears it.
      const tripReason = this.circuitBreaker.getTripReason() ?? 'circuit breaker tripped'
      this.circuitBreaker.reset()
      this.diagnostic(`circuit breaker reset for a manager-requested revision (was: ${tripReason})`)
    }
    for (const task of this.store.listReadyTasks(this.runId)) {
      // Same-tick repeats: a task already in flight must never be dispatched
      // twice. The store CAS in executeTask is the hard guarantee; this keeps
      // a repeated tick/wakeup from even trying to spawn a second executor.
      if (this.inFlight.has(task.id)) continue
      if (this.inFlight.size >= this.maxConcurrentWorkers) return

      const writeScope = task.writeScope ?? []
      let hasConflict = false
      for (const p of writeScope) {
        const conflict = this.leaseManager.hasConflict(this.runId, task.id, p)
        if (conflict.conflicted) {
          hasConflict = true
          this.appendEvent(
            'task.blocked_by_lease',
            { taskId: task.id, path: p, reason: conflict.reason ?? 'lease conflict' },
            task.id,
          )
          break
        }
      }
      if (hasConflict) {
        continue
      }

      if (writeScope.length > 0) {
        const declared = this.leaseManager.declareScope(
          this.runId,
          task.id,
          task.assigneeMuseId ?? 'unassigned',
          writeScope,
        )
        if (declared.conflicts.length > 0) {
          continue
        }
        for (const path of declared.acquired) {
          this.store.recordLease(
            {
              id: newId('attempt'),
              runId: this.runId,
              taskId: task.id,
              museId: task.assigneeMuseId ?? 'unassigned',
              path,
            },
            this.fence ?? undefined,
          )
        }
      }

      const key = task.assigneeMuseId ?? `unassigned:${task.id}`
      const promise = this.mutex.withLock(key, () => this.executeTask(task))
      this.inFlight.set(task.id, promise)
      promise.then(
        () => this.inFlight.delete(task.id),
        () => this.inFlight.delete(task.id),
      )
    }
  }

  wake(): void {
    this.wakeups.notify(this.managerChannel(), `wake:${this.runId}`, 'running')
    this.dispatchReadyTasks()
  }

  private allQuiescent(managerSettled: boolean): boolean {
    if (!managerSettled) return false
    if (this.inFlight.size > 0) return false
    if (this.store.listReadyTasks(this.runId).length > 0) return false
    return !this.store.listTasks(this.runId).some((t) => ACTIVELY_RUNNING.has(t.state))
  }

  /**
   * Operator approval channel for one engine session: engine permission
   * requests become durable approvals bound to this run/task/Muse, visible to
   * every operator surface (TUI inbox, SPA banner) through the shared store.
   * Fail-closed defaults hold: TTL from config, expiry/abort answer deny.
   *
   * A task-scoped channel also mirrors the wait into task state (CS-4): the
   * engine is blocked on an operator answer, so the task is `needs_approval`,
   * not `running`. Both flips are CAS-ed and only a successful flip appends its
   * event — a second concurrent request while already waiting is a no-op (no
   * duplicate event), and a settle for a task that already moved on
   * (multi-request interleave) never forces an edge.
   *
   * `abort` is deliberately not mirrored: it means session teardown, and the
   * task's real state is then decided by the normal prompt-outcome path that
   * the same teardown produces — flipping to `running` there would fabricate a
   * live turn. `decision`/`expiry` mean the engine received an answer and the
   * turn continues, so the task goes back to `running` only while it still
   * waits (`needs_approval`). Manager/chat/SPA channels pass `taskId === null`
   * and keep their session-scoped behavior: no task state is involved. Each
   * successful flip appends a durable `task.approval_waiting` /
   * `task.approval_settled` event, so the CS-8 SSE derivation sees the park
   * and its release like any other task transition.
   */
  private approvalChannel(museId: string, taskId: string | null): EnginePermissionChannel {
    return createEngineApprovalChannel({
      store: this.store,
      projectId: this.projectId,
      runId: this.runId,
      taskId,
      museId,
      ttlMinutes: this.limits.approvalTtlMinutes,
      now: this.now,
      // Ownership: a stale channel must never mint an approval or flip task
      // state. `createApproval`/`appendEvent` inside the channel throw on a
      // missed fence (the request resolves fail-closed `deny`); the task-state
      // flips below are try/caught here so an `OwnershipLostError` cannot
      // escape into an engine event pump as a rejection.
      fence: this.fence ?? undefined,
      ...(taskId !== null
        ? {
            onRequested: (approval: ApprovalRecord) => {
              try {
                if (this.store.setTaskStateIf(taskId, 'running', 'needs_approval', {}, this.fence ?? undefined) !== null) {
                  this.appendEvent('task.approval_waiting', { approvalId: approval.id }, taskId)
                  this.wakeups.notify(this.managerChannel(), taskId, 'needs_approval')
                }
              } catch (e) {
                if (!(e instanceof OwnershipLostError)) throw e
                this.markOwnershipLost('run ownership moved while a task approval wait was being mirrored')
              }
            },
            onSettled: (approval: ApprovalRecord, settlement: EngineApprovalSettlement) => {
              if (settlement === 'abort') return
              try {
                const isQuestion =
                  approval.action === 'qa.question' ||
                  approval.action.includes('question') ||
                  approval.selectedOption !== undefined ||
                  approval.answer !== undefined

                if (isQuestion && approval.status === 'approved') {
                  if (this.store.setTaskStateIf(taskId, 'needs_approval', 'running', {}, this.fence ?? undefined) !== null) {
                    this.store.setTaskStateIf(
                      taskId,
                      'running',
                      'completed',
                      {
                        result: {
                          approvalId: approval.id,
                          resolved: true,
                          selectedOption: approval.selectedOption ?? null,
                          answer: approval.answer ?? null,
                        },
                      },
                      this.fence ?? undefined,
                    )
                  }
                  this.appendEvent(
                    'task.approval_settled',
                    {
                      approvalId: approval.id,
                      action: approval.action,
                      selectedOption: approval.selectedOption ?? null,
                      answer: approval.answer ?? null,
                    },
                    taskId,
                  )
                  this.wakeups.notify(this.managerChannel(), taskId, 'completed')
                  this.dispatchReadyTasks()
                  return
                }

                if (this.store.setTaskStateIf(taskId, 'needs_approval', 'running', {}, this.fence ?? undefined) !== null) {
                  this.appendEvent('task.approval_settled', { approvalId: approval.id }, taskId)
                  this.wakeups.notify(this.managerChannel(), taskId, 'running')
                }
                this.dispatchReadyTasks()
              } catch (e) {
                if (!(e instanceof OwnershipLostError)) throw e
                this.markOwnershipLost('run ownership moved while a task approval wait was being settled')
              }
            },
          }
        : {}),
    })
  }

  private async runManagerSession(): Promise<PromptOutcome> {
    const run = this.store.getRun(this.runId)
    const muse = this.store.getMuse(run.managerMuseId)
    if (!muse || !muse.enabled) {
      throw new NotFoundError('manager muse', run.managerMuseId)
    }
    const adapter = this.adapterFor(muse, { isolatedCheckout: false })
    const mcpSpec = this.mcpServerFor(muse, null)
    const instructions = this.instructionsFor(muse)
    const session = await adapter.startSession({
      muse: { id: muse.id, slug: muse.slug, role: muse.role, model: muse.model },
      workdir: this.rootDir, // coordinator-read-only: read the tree, never write
      env: this.engineEnv(muse),
      configDir: muse.engineHome,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(mcpSpec !== null ? { mcpServers: [mcpSpec] } : {}),
      approvals: this.approvalChannel(muse.id, null),
    })
    // CS-9: register the manager session as an interrupt target while its prompt
    // is in flight (a terminal run must stop its manager too).
    this.managerSessionRef = session
    const prompt = buildManagerPrompt(
      run.goal,
      muse,
      this.store.listMuses().filter((m) => m.enabled),
      run.acceptanceCriteria,
      this.limits.maxBriefChars,
    )
    try {
      return await this.runPrompt(session, { text: prompt, timeoutMs: this.runDeadlineMs }, { museId: muse.id })
    } finally {
      // CS-9: deregister before closing — the session is no longer an interrupt
      // target, and the manager's interrupt slot is free for nothing else to use.
      this.managerSessionRef = null
      this.interruptSent.delete(MANAGER_INTERRUPT_KEY)
      // The manager session owns a live engine process inside its container;
      // leaving it open leaked one ACP process per run (container-mode smoke
      // finding, 2026-10-17: two finished runs, two lingering
      // `docker exec … opencode acp` processes). Close on every path.
      await session.close().catch((e: unknown) => {
        this.diagnostic(`manager session close failed: ${e instanceof Error ? e.message : String(e)}`)
      })
    }
  }

  /**
   * CS-9 — state-driven interrupt: ANY cancel source (the manager's
   * `task.cancel`/`run.stop` tools, another process flipping the durable rows,
   * or the operator's SIGINT/SIGTERM path) only writes state; this control tick
   * is what stops the engines. Sessions whose task is terminal have no reason to
   * keep running, and a terminal run stops everything — including the manager.
   * Called at the top of every loop iteration, so the flip lands within ≤
   * `loopPollMs`; each session is interrupted exactly once, and the call sites
   * swallow rejection (a stopping engine must never crash the supervisor).
   */
  private interruptStoppingSessions(run: RunRecord): void {
    const runTerminal = TERMINAL_RUN_STATES.has(run.state)
    if (runTerminal && this.managerSessionRef !== null && !this.interruptSent.has(MANAGER_INTERRUPT_KEY)) {
      this.interruptSent.add(MANAGER_INTERRUPT_KEY)
      this.interruptSession(this.managerSessionRef)
    }
    for (const [taskId, session] of this.liveSessions) {
      if (!runTerminal && !isTerminal(this.store.getTask(taskId).state)) continue
      if (this.interruptSent.has(taskId)) continue
      this.interruptSent.add(taskId)
      this.interruptSession(session)
    }
  }

  /** Fire-and-forget one session interrupt; a stopping engine must never crash the supervisor. */
  private interruptSession(session: EngineSession): void {
    void session.interrupt().catch(() => {})
  }

  /**
   * Ownership loss is a single, idempotent piece of bookkeeping: record it,
   * stop the engines this process still owns, and mark the loss so the top of
   * `runToCompletion` returns the read-only `superseded` outcome. Detection
   * latency (the loop tick / renew CAS) can never corrupt state — the atomic
   * fence at the mutation boundary is what makes a stale write a no-op — but
   * the moment the loss IS observed, the stale owner's engines go quiet.
   */
  private markOwnershipLost(reason: string): void {
    this.ownershipLost = true
    if (this.ownershipLossAnnounced) return
    this.ownershipLossAnnounced = true
    this.diagnostic(`${reason}; this process will stop without writing (superseded)`)
    // Same exactly-once bookkeeping as `interruptStoppingSessions`: a later
    // control tick sees the sentinels and never interrupts these again.
    if (this.managerSessionRef !== null && !this.interruptSent.has(MANAGER_INTERRUPT_KEY)) {
      this.interruptSent.add(MANAGER_INTERRUPT_KEY)
      this.interruptSession(this.managerSessionRef)
    }
    for (const [taskId, session] of this.liveSessions) {
      if (this.interruptSent.has(taskId)) continue
      this.interruptSent.add(taskId)
      this.interruptSession(session)
    }
  }

  /**
   * Per-loop-tick ownership maintenance: a fast token check against the cached
   * run row (bounded by the tick — `loopPollMs`), plus a throttled heartbeat
   * renew (`ttl / 3`). A failed renew is proof of a takeover; a token mismatch
   * is the earliest detection of one. Both go through `markOwnershipLost` and
   * then throw so the fixed body stops at the next `await`-free boundary. A
   * loss already recorded elsewhere (a swallowed approval-callback fence miss)
   * also throws here on the next tick, so a stale owner exits tick-bounded
   * instead of churning rejected writes until the deadline.
   */
  private maintainOwnership(current: RunRecord): void {
    if (this.fence === null) return
    if (this.ownershipLost) throw new OwnershipLostError(this.runId, { runId: this.runId })
    if (current.supervisorToken !== this.fence.token) {
      this.markOwnershipLost('run ownership moved to another supervisor')
      throw new OwnershipLostError(this.runId, { runId: this.runId })
    }
    if (this.now() - this.lastRenewMs >= this.ownershipRenewIntervalMs) {
      this.lastRenewMs = this.now()
      if (!this.store.renewRunSupervisor(this.runId, this.fence.token, this.now())) {
        this.markOwnershipLost('run supervisor heartbeat renewal failed (ownership moved)')
        throw new OwnershipLostError(this.runId, { runId: this.runId })
      }
    }
  }

  /**
   * CS-9 — bounded drain: after the loop, no NEW work starts, but task
   * executors and the manager prompt may still be running. Await them only up to
   * `drainBoundMs`: an engine that ignores `interrupt()` must not be able to
   * hold the supervisor (and its process) open. Ordering constraint: the manager
   * caches are assigned by the caller AFTER this returns, so a bound-expired
   * drain leaves them null — an honest "manager unsettled" summary for a
   * cancelled run — while the detached prompt stays bounded by its own timeout.
   */
  private async drainInFlight(managerCompletion: Promise<void>): Promise<void> {
    const drained = Promise.all([...this.inFlight.values(), managerCompletion].map((p) => p.catch(() => {})))
    let timer: ReturnType<typeof setTimeout> | null = null
    const bound = new Promise<void>((resolveBound) => {
      timer = setTimeout(resolveBound, this.drainBoundMs)
    })
    try {
      await Promise.race([drained, bound])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /**
   * Drive the run: claim ownership FIRST (a live owner refuses this process
   * with a ConflictError), then run the manager session concurrently with task
   * dispatch until nothing can make progress — and finalize from durable
   * records only. Every duty write carries the ownership fence; a takeover
   * turns the next tick into a read-only `superseded` outcome.
   */
  async runToCompletion(): Promise<RunOutcome> {
    try {
      const started = this.now()
      const deadline = started + this.runDeadlineMs

      // 1. Claim before ANY state write: the durable exclusion is what makes
      // "at most one live supervisor per run" true. Fail closed on a live owner.
      const previousRow = this.store.getRun(this.runId)
      const claim = this.store.claimRunSupervisor(this.runId, {
        pid: process.pid,
        ttlMs: this.ownershipTtlMs,
        nowMs: this.now(),
      })
      if (claim === null) {
        const holder = this.store.getRunOrNull(this.runId) ?? previousRow
        throw new ConflictError(
          `run '${this.runId}' is already owned by a live supervisor (pid ${holder.supervisorPid ?? 'unknown'}); refusing a second owner`,
          { runId: this.runId, supervisorPid: holder.supervisorPid },
        )
      }
      this.fence = { runId: this.runId, token: claim.token }
      this.lastRenewMs = this.now()
      activeSupervisors.set(this.runId, this)
      if (claim.tookOver) {
        this.diagnostic(
          `took over run ownership from pid ${claim.previousPid ?? 'unknown'} (its heartbeat expired)`,
        )
      }
      // Durable record of who drives this run. Claim-scoped, so it is written
      // with the fresh fence; the unfenced `run.started` below is appended right
      // after the claim-scoped `created → active` write.
      this.appendEvent('run.supervisor_claimed', {
        pid: process.pid,
        tookOver: claim.tookOver,
        ...(claim.tookOver ? { previousPid: claim.previousPid } : {}),
      })

      const run = previousRow
      // A control-plane terminal write can win the startup window: the claim is
      // deliberately state-blind, so `created -> active` may CAS-miss against a
      // fresh `cancelled`. That is the operator's decision, not a crash — stop
      // driving, skip recovery/manager startup, and let the loop below settle
      // leftovers and finalize from the durable winner (A-F2).
      let startupTerminal = false
      if (run.state === 'created') {
        try {
          this.store.setRunState(this.runId, 'active', { supervisorPid: process.pid }, this.fence)
          this.appendEventUnfenced('run.started', { goal: run.goal, managerMuseId: run.managerMuseId })
        } catch (e) {
          if (!(e instanceof StateTransitionError)) throw e
          const fresh = this.store.getRun(this.runId)
          if (!TERMINAL_RUN_STATES.has(fresh.state)) throw e
          startupTerminal = true
          this.diagnostic(
            `run '${this.runId}' became ${fresh.state} before this supervisor could activate it; skipping startup and finalizing from the durable winner`,
          )
        }
      }

      // Interrupted run recovery: reap orphaned leases and reconcile session-backed tasks
      const activeRunning = new Set(
        this.store.listTasks(this.runId).filter((t) => ACTIVELY_RUNNING.has(t.state)).map((t) => t.id),
      )
      this.leaseManager.recoverLeases(activeRunning)
      this.store.reapOrphanedLeases(activeRunning, this.fence)

      // Session-backed recovery: before the process died, every ACTIVELY_RUNNING
      // state meant a live engine session for the task. A restarted process
      // cannot resume any of them, so requeue is the only non-stranding recovery;
      // an exhausted recovery attempt (maxRetriesPerTask) terminalizes as
      // `unknown_outcome` — never success, never a silent strand. Skipped for a
      // terminal startup: requeuing would mint misleading `task.recovered`
      // events for a run that never started. Every write is a from-state CAS: a
      // task the control plane already terminated (or moved) is the honest
      // winner and is skipped without an event of our own.
      if (!startupTerminal) {
        for (const t of this.store.listTasks(this.runId)) {
          if (!ACTIVELY_RUNNING.has(t.state) || this.inFlight.has(t.id)) continue
          if (t.attempt >= this.maxRetriesPerTask) {
            const terminal = this.store.setTaskStateIf(
              t.id,
              t.state,
              'unknown_outcome',
              {
                failure: {
                  code: 'recovery_exhausted',
                  message:
                    `no recovery budget left: task was left in state '${t.state}' by a process that died ` +
                    `(attempt ${t.attempt} of ${this.maxRetriesPerTask}); the engine session cannot be resumed`,
                },
              },
              this.fence,
            )
            if (terminal === null) continue
            this.appendEvent(
              'task.recovery_exhausted',
              { taskId: t.id, priorState: t.state, attempt: t.attempt },
              t.id,
            )
            continue
          }
          const abandonedSessionId = t.engineSessionId
          const requeued = this.store.setTaskStateIf(
            t.id,
            t.state,
            'queued',
            { attempt: t.attempt + 1, engineSessionId: null },
            this.fence,
          )
          if (requeued === null) continue
          this.appendEvent('task.recovered', { taskId: t.id, priorState: t.state, attempt: t.attempt + 1 }, t.id)
          if (abandonedSessionId !== null) {
            this.appendEvent('task.session_abandoned', { sessionId: abandonedSessionId }, t.id)
          }
        }
      }

      let managerOutcome: PromptOutcome | null = null
      let managerError: string | null = null
      // A terminal startup skips the manager entirely: its run is over before a
      // manager session could do any honest work.
      const managerCompletion =
        this.skipManager || startupTerminal
          ? Promise.resolve()
          : this.runManagerSession().then(
            (o) => {
              managerOutcome = o
            },
            (e: unknown) => {
              const details = e && typeof e === 'object' && 'details' in e ? JSON.stringify((e as { details: unknown }).details) : ''
              managerError = ((e instanceof Error ? e.message : String(e)) + (details ? ' :: ' + details : '')).slice(0, 2_000)
            },
          )

      for (;;) {
        const current = this.store.getRun(this.runId)
        // Ownership first: a taken-over run stops this process before it writes
        // anything for the new owner (the fixed body is `await`-free up to the
        // loop's wait, so the throw lands before further duty writes).
        this.maintainOwnership(current)
        // CS-9: the loop is the control plane for cancellation — a state flip made
        // by anyone (tool, signal, another process) stops this tick's engines.
        this.interruptStoppingSessions(current)
        if (TERMINAL_RUN_STATES.has(current.state)) {
          for (const t of this.store.listTasks(this.runId)) {
            if (!TERMINAL_TASK_STATES.has(t.state)) {
              // Tolerant settle: the control plane may already have terminalized
              // (or moved) this task — that write is the honest winner, and the
              // CAS miss must never crash the cancellation drain.
              this.store.setTaskStateIf(
                t.id,
                t.state,
                'cancelled',
                {
                  failure: { code: 'run_cancelled', reason: `run is ${current.state}` },
                },
                this.fence,
              )
              this.leaseManager.releaseScope(t.id)
              this.store.releaseLeasesForTask(t.id, this.fence)
            }
          }
          break
        }
        this.dispatchReadyTasks()
        const managerSettled = this.skipManager || managerOutcome !== null || managerError !== null
        if (this.allQuiescent(managerSettled)) break
        const remaining = deadline - this.now()
        if (remaining <= 0) {
          this.timedOut = true
          break
        }
        await this.wakeups.waitFor(this.managerChannel(), Math.min(this.loopPollMs, Math.max(remaining, 1)))
      }
      await this.drainInFlight(managerCompletion)
      this.managerOutcomeCache = managerOutcome
      this.managerErrorCache = managerError
      return this.finalize(started)
    } catch (e) {
      if (e instanceof OwnershipLostError || this.ownershipLost) {
        // Another supervisor owns the run now: mark the loss (idempotent — it
        // also stops this process's engines and makes the `finally` skip the
        // doomed release attempt), then report it read-only. NOTHING is written
        // on this path — no finalize, no events, no drain, no release.
        this.markOwnershipLost('run ownership lost (fenced write refused)')
        return this.supersededOutcome()
      }
      throw e
    } finally {
      activeSupervisors.delete(this.runId)
      if (this.fence !== null && !this.ownershipLost) {
        const fence = this.fence
        try {
          this.appendEvent('run.supervisor_released', { pid: process.pid })
          if (!this.store.releaseRunSupervisor(this.runId, fence.token)) {
            this.diagnostic('run supervisor release CAS missed (claim already cleared or reassigned)')
          }
        } catch (e) {
          // Release failure is a diagnostic, never a mask: the claim expires by
          // heartbeat TTL even when this write fails.
          const message = e instanceof Error ? e.message : String(e)
          this.diagnostic(`run supervisor release failed: ${message}`)
        }
      }
    }
  }

  /**
   * Read-only outcome for a superseded process: every field comes from the
   * durable rows the new owner now controls. Shares the task tally logic with
   * `finalize()` so the two can never disagree.
   */
  private supersededOutcome(): RunOutcome {
    const state = this.store.getRunOrNull(this.runId)?.state ?? this.store.getRun(this.runId).state
    const counts = this.durableRunCounts()
    this.diagnostic(`run '${this.runId}' was taken over by another supervisor; this process stopped without writing`)
    return {
      runId: this.runId,
      state,
      outcome: 'superseded',
      managerSummary: null,
      taskCounts: counts.taskCounts,
      unfinishedTasks: counts.unfinishedTasks,
      blockedTasks: counts.blockedTasks,
    }
  }

  /**
   * Task tallies straight from the durable rows: state counts, tasks left
   * non-terminal, and non-terminal tasks that are not awaiting verification
   * (they are blocked behind unverified dependencies).
   */
  private durableRunCounts(): DurableRunCounts {
    const tasks = this.store.listTasks(this.runId)
    const taskCounts: Record<string, number> = {}
    for (const t of tasks) taskCounts[t.state] = (taskCounts[t.state] ?? 0) + 1
    const unfinishedTasks = tasks.filter((t) => !TERMINAL_TASK_STATES.has(t.state)).map((t) => t.id)
    // Dependents are only admissible once their dependency is `completed`, so
    // tasks stuck behind unverified dependencies are not awaiting verification
    // themselves — name them separately or the record overstates the gate.
    const blockedTasks = tasks
      .filter((t) => !TERMINAL_TASK_STATES.has(t.state) && t.state !== 'verifying')
      .map((t) => t.id)
    return { taskCounts, unfinishedTasks, blockedTasks }
  }

  private finalize(startedMs: number): RunOutcome {
    const tasks = this.store.listTasks(this.runId)
    const { taskCounts, unfinishedTasks: unfinished, blockedTasks: blocked } = this.durableRunCounts()
    const anyBad = tasks.some((t) => t.state === 'failed' || t.state === 'unknown_outcome')
    const anyVerifying = tasks.some((t) => t.state === 'verifying')

    const managerOutcome = this.managerOutcomeCache
    const managerError = this.managerErrorCache
    const managerSummary = this.skipManager
      ? 'resumed worker dispatch'
      : boundedSummary(managerOutcome?.summary ?? undefined)

    let outcome: RunOutcome['outcome']
    let runState: RunState
    if (this.timedOut) {
      outcome = 'timeout'
      runState = 'uncertain'
    } else if (managerError !== null) {
      outcome = 'failure'
      runState = 'failed'
    } else if (this.skipManager || managerOutcome?.outcome === 'success') {
      if (anyBad) {
        outcome = 'failure'
        runState = 'failed' // durable records disagree with the "success" claim
      } else if (anyVerifying) {
        outcome = 'pending_verification'
        runState = 'verifying'
      } else if (unfinished.length > 0) {
        outcome = 'failure'
        runState = 'failed' // blocked tasks (e.g. failed dependency) are never silently skipped
      } else {
        outcome = 'success'
        runState = 'completed'
      }
    } else if (managerOutcome?.outcome === 'cancelled') {
      outcome = 'cancelled'
      runState = 'cancelled'
    } else {
      outcome = managerOutcome === null && managerError === null ? 'timeout' : 'failure'
      runState = 'failed'
    }

    const current = this.store.getRun(this.runId)
    // Never force a transition the state machine forbids: while the run waits on
    // an operator (approval/input) the supervisor records the outcome and leaves
    // the decision to the operator.
    if (
      !TERMINAL_RUN_STATES.has(current.state) &&
      current.state !== 'verifying' &&
      current.state !== 'awaiting_approval' &&
      current.state !== 'awaiting_input'
    ) {
      try {
        this.store.setRunState(
          this.runId,
          runState,
          { finalSummary: managerSummary ?? undefined },
          this.fence ?? undefined,
        )
      } catch (e) {
        // A concurrent terminal write won the finalize window (A-F2/A-F3):
        // adopt the durable winner. A non-terminal fresh state in the
        // operator-wait set is equally benign — the guard above would have
        // skipped the write had it read the fresh row — but anything else is a
        // genuine loss and stays honest.
        if (!(e instanceof StateTransitionError)) throw e
        const fresh = this.store.getRun(this.runId)
        if (!TERMINAL_RUN_STATES.has(fresh.state) && !OPERATOR_WAIT_RUN_STATES.has(fresh.state)) throw e
        this.diagnostic(`run '${this.runId}': finalize write lost to a concurrent ${fresh.state} write; adopting it`)
      }
    }
    const actualState = this.store.getRun(this.runId).state
    // The durable state labels the outcome: a concurrent terminal winner must
    // never be described with the outcome computed from the loser's pre-read.
    if (TERMINAL_RUN_STATES.has(actualState) && actualState !== runState) {
      outcome = outcomeFromRunState(actualState) ?? outcome
    }
    const eventPayload: JsonValue = {
      outcome,
      state: actualState,
      taskCounts,
      ...(blocked.length > 0 ? { blockedTasks: blocked } : {}),
      ...(managerSummary !== null ? { managerSummary } : {}),
      ...(managerError !== null ? { managerError } : {}),
      durationMs: this.now() - startedMs,
    }
    this.appendEvent(actualState === 'uncertain' ? 'run.uncertain' : 'run.finished', eventPayload)
    return {
      runId: this.runId,
      state: actualState,
      outcome,
      managerSummary,
      taskCounts,
      unfinishedTasks: unfinished,
      blockedTasks: blocked,
    }
  }

  private managerOutcomeCache: PromptOutcome | null = null
  private managerErrorCache: string | null = null
}
