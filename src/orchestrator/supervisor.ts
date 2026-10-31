import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ConflictError,
  InternalError,
  NotFoundError,
  OwnershipLostError,
  StateTransitionError,
} from '../domain/errors.ts'
import type { ApprovalRecord, JsonValue, ShipRecord, RunRecord, TaskRecord, ShipRole } from '../domain/models.ts'
import { engineAdapterForShip, type EngineIsolationFacts } from '../engines/approval.ts'
import { redactProseSecrets } from '../util/redact.ts'
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
import { selectModel } from '../engines/model-selection.ts'
import type { ResolvedModelConfig, ResolvedShipModelConfig } from '../config/model-config.ts'
import { ModelRegistry } from '../engines/model-registry.ts'
import { ModelDiscoveryService } from '../engines/model-discovery.ts'
import { ModelHealthMonitor, classifyModelError, type ModelErrorContext, type ModelErrorClassification } from '../engines/model-health.ts'
import { decideFallback, createFallbackState, type ModelFallbackConfig, type ModelFallbackState } from '../engines/model-fallback.ts'
import { SESSION_BACKED_TASK_STATES, TERMINAL_TASK_STATES, isTerminal, type RunState, type TaskState } from '../domain/state.ts'
import type { Store, SupervisorFence } from '../store/store.ts'
import type { GitWorkspaceManager } from '../workspace/manager.ts'
import { KeyedMutex } from './mutex.ts'
import { notifyTaskSettled, taskAncestorIds, WakeupRegistry, wakeupChannelFor } from './wakeups.ts'
import { PlutonToolBridge, type ToolBridgeLimits } from '../tools/bridge.ts'
import { FileLeaseManager } from './lease-manager.ts'
import { CircuitBreaker } from './circuit-breaker.ts'
import { UsageLedger } from './usage-ledger.ts'
import { WorkerMessageBus, type WorkerMessage } from './messages.ts'
import { newId } from '../domain/ids.ts'

/**
 * Run supervisor (Phase 6, ADR-0006/0007).
 *
 * One supervisor drives one run: it opens the manager session (the Manager Ship
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

/** Builds the per-Ship adapter; `session.isolatedCheckout` is a proven runtime fact. */
export type SupervisorAdapterFactory = (ship: ShipRecord, session: EngineIsolationFacts) => EngineAdapter

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
    | 'worker.message'
  runId: string
  taskId: string
  role: string
  /** Configured Ship display name (e.g. "Researcher - Z"), when known. */
  shipName?: string
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
  /** Extra environment variables per Ship (allowlisted by the caller; never secrets here). */
  engineEnv?: (ship: ShipRecord) => Record<string, string>
  /** MCP server spec handed to engine sessions; null = engines get no tools (dev/mock). */
  mcpServerFor?: (ship: ShipRecord, taskId: string | null) => McpServerSpec | null
  wakeups?: WakeupRegistry
  now?: () => number
  /**
   * Observer for live per-worker inspector events (SSE). Called synchronously
   * on the run's hot path, so an observer failure must never break the run:
   * {@link RunSupervisor} isolates it. Absent in CLI/headless runs.
   */
  onWorkerEvent?: (event: WorkerLifecycleEvent) => void
  /**
   * Live observer for a persisted worker message. Unlike `onWorkerEvent`, the
   * event was already appended by {@link WorkerMessageBus}, so the observer
   * must only publish it (never persist it again).
   */
  onWorkerMessage?: (event: WorkerLifecycleEvent) => void
  diagnostic?: (line: string) => void
  leaseManager?: FileLeaseManager
  circuitBreaker?: CircuitBreaker
  usageLedger?: UsageLedger
  maxRetriesPerTask?: number
  skipManager?: boolean
  projectRootDir?: string
  /** `git.protected_paths`: engine requests touching these ask the operator. */
  protectedPaths?: readonly string[]
  /** Optional model registry for dynamic discovery. */
  modelRegistry?: ModelRegistry
  /** Optional resolved model configuration (pins, allowlists, preferences). */
  modelConfig?: ResolvedModelConfig
  /** Optional discovery service for live model inventory. */
  modelDiscovery?: ModelDiscoveryService
  /** Optional health monitor for error classification. */
  modelHealthMonitor?: ModelHealthMonitor
  /** Optional fallback config for model failure recovery. */
  modelFallbackConfig?: ModelFallbackConfig
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
  /** Total streamed assistant text across the whole turn (never capped). */
  textChars: number
  /**
   * The assistant's own answer body, retained up to
   * {@link MAX_RESULT_TEXT_CHARS} (host cap, not model-controlled). Empty when
   * the turn produced no text (tool-only turns).
   */
  text: string
  /** True when more text streamed than the host retains in `text`. */
  textTruncated: boolean
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

/**
 * Stranded-run detection for observability ONLY (never an automatic state
 * write): a non-terminal run is stranded when its supervisor heartbeat is
 * far past the ownership TTL, or when terminal evidence is still pending but
 * no heartbeat exists at all. A live supervisor loop renews every `ttl / 3`
 * even while the manager prompt runs — only driver death explains a stale
 * heartbeat, so this flag is durable evidence, not engine-slowness guessing.
 */
export function isSupervisorStale(run: RunRecord, nowMs: number): boolean {
  if (TERMINAL_RUN_STATES.has(run.state)) return false
  if (run.supervisorHeartbeatAt === null) {
    // A run nobody has started yet (created, never started, never claimed) is
    // not stranded — there is no abandoned owner, only a start that has not
    // happened. Once a run has started, a missing heartbeat means the owner
    // died before it could even renew once.
    return run.startedAt !== null
  }
  return nowMs - run.supervisorHeartbeatAt > DEFAULT_OWNERSHIP_TTL_MS * 2
}

function boundedSummary(text: string | undefined, max = 2_000): string | null {
  if (text === undefined) return null
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * How much assistant answer text one prompt may keep in durable storage
 * (results_json / final_summary). The count keeps flowing past this bound via
 * `textChars`, and the truncation flag records it — nothing is silently
 * dropped. 50k chars ≈ 4-5 pages of text, far beyond any honest final report;
 * engine-side transcripts remain the unlimited record. Exported so tests bind
 * to the real bound instead of duplicating a literal.
 */
export const MAX_RESULT_TEXT_CHARS = 50_000
/**
 * How much answer text one SSE worker-lifecycle event may carry: the inspector
 * re-renders every frame in memory, so live worker payloads stay smaller than
 * the persisted bound. Full text always remains in `result_json`.
 */
const MAX_EVENT_TEXT_CHARS = 8_000

/**
 * Retained per-turn text accumulator: keeps counting every streamed char while
 * retaining only the first {@link max} of them. The extra chars exist (log
 * files, engine-side sessions) — they are just not copied into the result row.
 */
class BoundedText {
  totalChars = 0
  private kept = ''
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  add(chunk: string): void {
    this.totalChars += chunk.length
    if (this.kept.length < this.max) {
      this.kept += chunk.length > this.max - this.kept.length ? chunk.slice(0, this.max - this.kept.length) : chunk
    }
  }

  /** Retained text (≤ max) and whether any stream text was dropped from it. */
  take(): { text: string; textTruncated: boolean } {
    return { text: this.kept, textTruncated: this.totalChars > this.kept.length }
  }
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

export function buildTaskPrompt(task: TaskRecord, ship: ShipRecord, maxChars: number): string {
  const lines = [
    `You are ${ship.displayName}, a ${ship.role} Ship of the Pluton-Harness control plane.`,
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
  if (ship.permissions.includes('worker.message')) {
    lines.push(
      '- Peer coordination: ship.message sends a finding, evidence, file path, interface contract, blocker, question or handoff to another active Ship; ship.inbox reads messages addressed to you. Check your inbox before you finish and include any handoff in your final summary.',
      '- A peer message never widens your assigned scope. If it implies more work than your brief authorizes, ask the manager instead of acting on it.',
      '- Reference the real task/file/line you mean; never send speculative claims as findings.',
    )
  }
  const text = lines.join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[truncated by Pluton: prompt exceeded max_prompt_chars]`
}

export function buildManagerPrompt(
  goal: string,
  managerShip: ShipRecord,
  ships: ShipRecord[],
  acceptanceCriteria: string[],
  maxChars: number,
): string {
  const team = ships.map((m) => `- ${m.slug} (${m.role}, engine ${m.engineKind}, model ${m.model}, workspace ${m.workspacePolicy})`)
  const lines = [
    `You are ${managerShip.displayName}, the Manager Ship of one Pluton-Harness run.`,
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
    '- Plan first: create tasks with task.create or perform direct research, coding, review, and verification within your declared permissions.',
    '- You may personally act as any specialist role when needed: Researcher, Coder (implementation), QA/Tester, or Reviewer. Direct action is appropriate for small or urgent work; delegate when parallel ownership helps.',
    '- Delegate only through the Pluton tools; Pluton state, not your prose, is authoritative.',
    '- Use task.wait to wait for your team: it returns once every requested task has settled (completed, failed, cancelled, or awaiting verification).',
    "- A task in 'verifying' has finished its work and awaits the operator's verification gate — report it as awaiting verification; never keep waiting for it to become completed.",
    '- Finish by collecting the settled tasks with task.get_result.',
    '- Never claim a result that is not backed by real task records or execution output.',
    '',
    'Parallel delegation:',
    '- Pluton dispatches every ready task concurrently up to runtime.max_concurrent_workers; a task whose dependsOn are unfinished waits. Use that: independent workstreams should be separate tasks, not one large task.',
    '- Split only where parallelism is real. Small or strictly sequential work stays one task; never invent busywork to look concurrent.',
    '- Give each task a distinct, self-contained scope and acceptance criteria that can be judged on their own evidence. State the inputs the assignee may rely on.',
    '- Assign independent workstreams to different Ships of the right role (for example two Researchers for independent investigations, two Coders for separate modules).',
    '- Express real ordering with dependsOn. Never leave an implicit ordering only in prose.',
    '- Give each coding task an explicit writeScope; tasks that must edit the same files either run sequentially through dependsOn or are coordinated before writing.',
    '- When one task needs another worker’s findings or interface contract, instruct it to use ship.message / ship.inbox to exchange them directly, and to report the handoff to you.',
    '- You own reconciliation: compare independent findings, resolve disagreements from evidence, and never present one worker’s unverified claim as consensus.',
    '',
    'Response Format Contract:',
    'Format your final report following this exact structure:',
    '### Summary',
    'Brief overview of what was requested and accomplished.',
    '',
    '### Changes',
    'List of files modified, created, or deleted, or specific changes executed.',
    '',
    '### Verification',
    'Checks, tests, or validations performed, and their real outcomes. Never claim a result that was not actually verified.',
    '',
    '### Remaining issues',
    'Any known limitations, unresolved items, or next steps (or "None" if all tasks succeeded).',
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
   * The per-Ship engine factory actually used: the injected seam, or the
   * approval-aware default ({@link engineAdapterForShip}). Public so the
   * default path itself is testable without spawning engines.
   */
  readonly adapterFor: SupervisorAdapterFactory
  private readonly modelRegistry: ModelRegistry | null
  private readonly modelConfig: ResolvedModelConfig | null
  private readonly modelDiscovery: ModelDiscoveryService | null
  private readonly modelHealthMonitor: ModelHealthMonitor | null
  private readonly modelFallbackConfig: ModelFallbackConfig | null
  private readonly workspaceManager: GitWorkspaceManager | null
  private readonly engineEnv: (ship: ShipRecord) => Record<string, string>
  private readonly mcpServerFor: (ship: ShipRecord, taskId: string | null) => McpServerSpec | null
  private readonly wakeups: WakeupRegistry
  private readonly now: () => number
  private readonly diagnostic: (line: string) => void
  private readonly onWorkerEvent: ((event: WorkerLifecycleEvent) => void) | null
  private readonly onWorkerMessage: ((event: WorkerLifecycleEvent) => void) | null
  /** Durable, at-most-once worker-to-worker message channel for this run. */
  readonly messageBus: WorkerMessageBus
  readonly leaseManager: FileLeaseManager
  readonly circuitBreaker: CircuitBreaker
  readonly usageLedger: UsageLedger
  private readonly maxRetriesPerTask: number
  private readonly skipManager: boolean
  private readonly projectRootDir?: string
  private readonly protectedPaths: readonly string[]
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
    this.projectRootDir = opts.projectRootDir
    this.runId = opts.runId
    this.limits = opts.limits
    this.maxConcurrentWorkers = opts.maxConcurrentWorkers
    this.defaultTaskTimeoutMs = opts.defaultTaskTimeoutMs
    this.runDeadlineMs = opts.runDeadlineMs
    this.verificationConfigured = opts.verificationConfigured
    this.loopPollMs = opts.loopPollMs ?? DEFAULT_LOOP_POLL_MS
    this.drainBoundMs = opts.drainBoundMs ?? DEFAULT_DRAIN_BOUND_MS
    this.adapterFor =
      opts.adapterFor ?? ((ship, session) => engineAdapterForShip(ship, { isolatedCheckout: session.isolatedCheckout }))
    this.workspaceManager = opts.workspaceManager ?? null
    this.engineEnv = opts.engineEnv ?? (() => ({}))
    this.mcpServerFor = opts.mcpServerFor ?? (() => null)
    this.modelRegistry = opts.modelRegistry ?? null
    this.modelConfig = opts.modelConfig ?? null
    this.modelDiscovery = opts.modelDiscovery ?? null
    this.modelHealthMonitor = opts.modelHealthMonitor ?? null
    this.modelFallbackConfig = opts.modelFallbackConfig ?? null
    this.wakeups = opts.wakeups ?? new WakeupRegistry()
    this.now = opts.now ?? Date.now
    this.diagnostic = opts.diagnostic ?? (() => {})
    this.onWorkerEvent = opts.onWorkerEvent ?? null
    this.onWorkerMessage = opts.onWorkerMessage ?? null
    this.messageBus = new WorkerMessageBus({
      store: this.store,
      projectId: this.projectId,
      runId: this.runId,
      wakeups: this.wakeups,
      now: this.now,
      ...(this.onWorkerMessage !== null ? { onMessage: (message) => this.emitWorkerMessage(message) } : {}),
    })
    this.leaseManager = opts.leaseManager ?? new FileLeaseManager()
    this.circuitBreaker = opts.circuitBreaker ?? new CircuitBreaker()
    this.usageLedger = opts.usageLedger ?? new UsageLedger(opts.runId, undefined, opts.store)
    this.maxRetriesPerTask = opts.maxRetriesPerTask ?? 2
    this.skipManager = opts.skipManager ?? false
    this.protectedPaths = opts.protectedPaths ?? []
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
        callerShipId: run.managerShipId,
        callerTaskId: null,
        limits: this.limits,
        leaseManager: this.leaseManager,
        workspaceManager: this.workspaceManager ?? undefined,
        wakeups: this.wakeups,
        messageBus: this.messageBus,
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
  private appendEvent(type: string, payload: JsonValue, taskId?: string, shipId?: string): void {
    this.store.appendEvent(
      {
        projectId: this.projectId,
        runId: this.runId,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(shipId !== undefined ? { shipId } : {}),
        type,
        payload,
      },
      this.fence ?? undefined,
    )
  }

  /** An event written before the claim exists (or as one): deliberately unfenced. */
  private appendEventUnfenced(type: string, payload: JsonValue, taskId?: string, shipId?: string): void {
    this.store.appendEvent({
      projectId: this.projectId,
      runId: this.runId,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(shipId !== undefined ? { shipId } : {}),
      type,
      payload,
    })
  }

  private notifySettled(task: TaskRecord): void {
    notifyTaskSettled(this.wakeups, this.runId, task, taskAncestorIds(this.store, task))
    this.emitSettledWorkerEvent(task)
  }

  /** Role/model snapshot captured at claim time (never later ship config edits). */
  private assignmentFields(task: TaskRecord): { role: string; model?: string; shipName?: string } {
    const assignment = jsonObject(task.assignment)
    const role = assignment !== null && typeof assignment['role'] === 'string' ? assignment['role'] : 'worker'
    const model = assignment !== null && typeof assignment['model'] === 'string' ? assignment['model'] : undefined
    const shipId =
      assignment !== null && typeof assignment['shipId'] === 'string'
        ? assignment['shipId']
        : assignment !== null && typeof assignment['museId'] === 'string'
          ? assignment['museId']
          : undefined
    // Display name is presentation only; the claim-time role/model stay the
    // authoritative snapshot even if the Ship is renamed later.
    const ship = shipId !== undefined ? this.store.getShip(shipId) : null
    return {
      role,
      ...(model !== undefined ? { model } : {}),
      ...(ship !== null ? { shipName: ship.displayName } : {}),
    }
  }

  /** Tell the live inspector what durable state the task actually settled in. */
  private emitSettledWorkerEvent(task: TaskRecord): void {
    const base = { runId: this.runId, taskId: task.id, ...this.assignmentFields(task) }
    const result = jsonObject(task.result)
    const failure = jsonObject(task.failure)
    const summary = typeof result?.['summary'] === 'string' ? result['summary'].slice(0, 2_000) : undefined
    // The settled event carries the persisted result body too: what the
    // inspector shows is what `task.get_result` will keep returning after the
    // worker (and even the host) is gone. Bounded smaller than the stored
    // bound so one frame never floods a client's replay buffer.
    const resultText =
      typeof result?.['text'] === 'string' && result['text'] !== '' ? (result['text'] as string) : undefined
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
          payload: {
            ...(summary !== undefined ? { summary } : {}),
            ...(resultText !== undefined ? { text: resultText.slice(0, MAX_EVENT_TEXT_CHARS) } : {}),
          },
        })
        return
      case 'verifying':
        this.emitWorkerEvent({
          ...base,
          type: 'worker.report',
          payload: {
            ...(summary !== undefined ? { summary } : {}),
            ...(resultText !== undefined ? { text: resultText.slice(0, MAX_EVENT_TEXT_CHARS) } : {}),
          },
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

  /**
   * Publish a message that {@link WorkerMessageBus} already persisted. The
   * observer is live-only: persisting here again would double the history.
   */
  private emitWorkerMessage(message: WorkerMessage): void {
    if (this.onWorkerMessage === null) return
    const event: WorkerLifecycleEvent = {
      type: 'worker.message',
      runId: this.runId,
      taskId: message.senderTaskId ?? message.recipientTaskId ?? 'manager',
      role: 'worker',
      shipName: message.senderLabel,
      payload: {
        messageId: message.id,
        seq: message.seq,
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
      },
    }
    try {
      this.onWorkerMessage(event)
    } catch (e) {
      this.diagnostic(`worker message ${message.id} publish failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private instructionsFor(ship: ShipRecord): string | undefined {
    if (!ship.instructionsFile) return undefined
    const candidatePaths = [
      join(this.rootDir, ship.instructionsFile),
      ...(this.projectRootDir && this.projectRootDir !== this.rootDir
        ? [join(this.projectRootDir, ship.instructionsFile)]
        : []),
    ]
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        try {
          return readFileSync(p, 'utf8')
        } catch {}
      }
    }
    this.diagnostic(`instructions file for ship '${ship.id}' could not be read: ${ship.instructionsFile}`)
    return undefined
  }

  /** Collect one prompt's stream with an honest hard bound. */
  private async runPrompt(
    session: EngineSession,
    prompt: PromptRequest,
    context?: {
      taskId?: string
      shipId?: string
      onTool?: (tool: { name: string; phase: 'start' | 'end'; summary?: string; isError?: boolean }) => void
    },
  ): Promise<PromptOutcome> {
    let result: { outcome: PromptOutcome['outcome']; summary?: string } | null = null
    let errorCode: string | null = null
    // The assistant's own answer: counted in full, retained up to
    // MAX_RESULT_TEXT_CHARS (defect 2026-10-21: only a char count was kept,
    // so the final answer and worker results were never durably storable).
    const answer = new BoundedText(MAX_RESULT_TEXT_CHARS)
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
          onText: (chunk) => {
            answer.add(chunk)
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
            // `approval.requested`, which records a Ship filing an approval
            // through the tool bridge: this event is the ENGINE asking and the
            // host deciding (host-mode smoke finding: denials used to vanish,
            // leaving a "successful" no-op task). Description is bounded and
            // control-stripped like every other model-controlled string before
            // it reaches the store.
            this.appendEvent(
              'approval.engine_decision',
              { requestId: a.requestId, description: stripControlChars(a.description).slice(0, 1_000) },
              context?.taskId,
              context?.shipId,
            )
          },
          onUsage: (u) => {
            if (context?.shipId) {
              const res = this.usageLedger.record(
                {
                  shipId: context.shipId,
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
    // Single redaction choke point for every prompt's retained prose (manager
    // answer and worker result bodies alike): a model echoing a credential
    // into free text must not persist it (prompt §2.7). Char counts stay raw.
    const taken = answer.take()
    const answerBody = { ...taken, text: redactProseSecrets(taken.text) }
    if (timedOut) {
      return {
        outcome: 'unknown',
        summary: 'prompt exceeded its time bound',
        errorCode: 'prompt_timeout',
        textChars: answer.totalChars,
        ...answerBody,
      }
    }
    if (result === null) {
      return {
        outcome: 'unknown',
        summary: 'engine stream ended without a result event',
        errorCode,
        textChars: answer.totalChars,
        ...answerBody,
      }
    }
    const r: { outcome: PromptOutcome['outcome']; summary?: string } = result
    return {
      outcome: r.outcome,
      summary: boundedSummary(r.summary ?? undefined),
      errorCode,
      textChars: answer.totalChars,
      ...answerBody,
    }
  }

  private absorbEvent(
    ev: EngineEvent,
    hooks: {
      onText: (chunk: string) => void
      onResult: (r: { outcome: PromptOutcome['outcome']; summary?: string }) => void
      onError: (code: string) => void
      onApproval?: (a: { requestId: string; description: string }) => void
      onUsage?: (u: { inputTokens: number; outputTokens: number; costUsd: number }) => void
      onTool?: (t: { name: string; phase: 'start' | 'end'; summary?: string; isError?: boolean }) => void
    },
  ): void {
    switch (ev.kind) {
      case 'text':
        hooks.onText(ev.text)
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
    ship: ShipRecord,
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
        shipId: ship.id,
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
      if (!task.assigneeShipId) {
        this.failTask(task.id, { code: 'no_assignee', message: 'task has no assignee Ship' })
        return
      }
      const ship = store.getShip(task.assigneeShipId)
      if (!ship || !ship.enabled) {
        this.failTask(task.id, { code: 'ship_unavailable', message: `assignee '${task.assigneeShipId}' is not an enabled Ship` })
        return
      }
      const resolvedModel = resolveTaskModelFor(ship, task, this.modelRegistry, this.modelConfig, (line) => this.diagnostic(line))
      const claimed = store.setTaskStateIf(
        task.id,
        'queued',
        'admitted',
        {
          // Snapshot the assignment exactly as it is for THIS claim (retries
          // refresh it): later ship config edits must never rewrite history.
          assignment: { shipId: ship.id, museId: ship.id, role: ship.role, engine: ship.engineKind, model: resolvedModel },
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
      if (ship.workspacePolicy === 'isolated-task-checkout') {
        const ensured = await this.ensureTaskCheckout(task, ship)
        workspaceId = ensured.workspaceId
        workdir = ensured.workdir
      }

      const adapter = this.adapterFor(ship, { isolatedCheckout: workspaceId !== null })
      const mcpSpec = this.mcpServerFor(ship, task.id)
      const instructions = this.instructionsFor(ship)
      const session = await adapter.startSession({
        ship: { id: ship.id, slug: ship.slug, role: ship.role, model: resolvedModel },
        workdir,
        env: this.engineEnv(ship),
        configDir: ship.engineHome,
        ...(instructions !== undefined ? { instructions } : {}),
        ...(mcpSpec !== null ? { mcpServers: [mcpSpec] } : {}),
        approvals: this.approvalChannel(ship, task.id, workdir),
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
        this.appendEvent('task.started', { shipId: ship.id, engine: adapter.kind, workspaceId }, task.id)
        this.emitWorkerEvent({
          type: 'worker.started',
          runId: this.runId,
          taskId: task.id,
          role: ship.role,
          shipName: ship.displayName,
          model: resolvedModel,
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

      const promptText = buildTaskPrompt(task, ship, this.limits.maxBriefChars)
      let out: PromptOutcome
      try {
        out = await this.runPrompt(
          session,
          { text: promptText, timeoutMs: this.defaultTaskTimeoutMs },
          {
            taskId: task.id,
            shipId: ship.id,
            onTool: (tool) => {
              if (tool.phase !== 'start') return
              const label =
                tool.summary !== undefined && tool.summary !== '' ? `${tool.name}: ${tool.summary}` : tool.name
              this.emitWorkerEvent({
                type: 'worker.progress',
                runId: this.runId,
                taskId: task.id,
                role: ship.role,
                shipName: ship.displayName,
                model: resolvedModel,
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

      // PLUTON 3.3: bounded model fallback. On model failure, classify the
      // error, update health, and decide fallback via decideFallback(). If the
      // decision is to switch, close the current session and start a new one
      // with the replacement model, then re-run the prompt. The loop is bounded
      // by modelFallbackConfig.maxTotalFallbacks to prevent endless switching.
      // Only runs when registry and fallback config are available; otherwise
      // falls through to the existing circuit breaker handling below.
      if (this.modelRegistry !== null && this.modelFallbackConfig !== null) {
        let currentModelId = resolvedModel
        let fallbacksUsed = 0
        let currentSession: EngineSession = session
        const maxTotalFallbacks = this.modelFallbackConfig.maxTotalFallbacks

        for (let fb = 0; fb <= maxTotalFallbacks; fb++) {
          if (out.outcome !== 'failure') break

          // Classify the error and update health monitor
          const errorContext: ModelErrorContext = {
            engineKind: adapter.kind,
            modelId: currentModelId,
            providerMessage: out.errorCode || out.summary || 'unknown error',
            scopeHint: 'task',
          }
          const classification = classifyModelError(errorContext)
          this.modelHealthMonitor?.recordFailure(errorContext, classification)

          // Decide fallback via the bounded fallback engine
          const fallbackState = createFallbackState(currentModelId)
          fallbackState.fallbacksUsed = fallbacksUsed

          const decision = decideFallback({
            taskInput: {
              task: { title: task.title, brief: task.brief, acceptanceCriteria: task.acceptanceCriteria },
              shipRole: ship.role as ShipRole,
              hint: this.modelConfig?.ships[ship.id]?.taskHints,
              costPreference: this.modelConfig?.ships[ship.id]?.preferences?.costPreference,
              latencyPreference: this.modelConfig?.ships[ship.id]?.preferences?.latencyPreference,
              maxCostUsdPerMillionTokens: this.modelConfig?.ships[ship.id]?.preferences?.maxCostUsdPerMillionTokens,
              maxLatencyMs: this.modelConfig?.ships[ship.id]?.preferences?.maxLatencyMs,
              minContextWindow: this.modelConfig?.ships[ship.id]?.preferences?.minContextWindow,
              providerAllowlist: this.modelConfig?.ships[ship.id]?.providerAllowlist ?? [],
              providerDenylist: this.modelConfig?.ships[ship.id]?.providerDenylist ?? [],
            },
            currentModelId,
            error: classification,
            bufferedEvents: [],
            state: fallbackState,
            registry: this.modelRegistry,
            selector: selectModel,
            healthMonitor: this.modelHealthMonitor ?? undefined,
            config: this.modelFallbackConfig,
          })

          if (decision.action === 'switch' && decision.toModelId) {
            currentModelId = decision.toModelId
            fallbacksUsed = decision.fallbacksUsed
            this.diagnostic(`task ${task.id}: ${decision.reason}`)

            // Close the current session and start a new one with the replacement model
            await currentSession.close().catch((e: unknown) => {
              this.diagnostic(`task ${task.id}: fallback session close failed: ${e instanceof Error ? e.message : String(e)}`)
            })

            currentSession = await adapter.startSession({
              ship: { id: ship.id, slug: ship.slug, role: ship.role, model: currentModelId },
              workdir,
              env: this.engineEnv(ship),
              configDir: ship.engineHome,
              ...(instructions !== undefined ? { instructions } : {}),
              ...(mcpSpec !== null ? { mcpServers: [mcpSpec] } : {}),
              approvals: this.approvalChannel(ship, task.id, workdir),
            })
            this.liveSessions.set(task.id, currentSession)

            try {
              // Only transition to 'running' if not already running (guards against
              // re-entry on repeated fallback attempts)
              const currentState = store.getTask(task.id).state
              if (currentState !== 'running') {
                store.setTaskState(
                  task.id,
                  'running',
                  {
                    workspaceId,
                    engineSessionId: currentSession.info.nativeSessionId ?? currentSession.info.id,
                  },
                  this.fence ?? undefined,
                )
                this.appendEvent('task.started', { shipId: ship.id, engine: adapter.kind, workspaceId }, task.id)
                this.emitWorkerEvent({
                  type: 'worker.started',
                  runId: this.runId,
                  taskId: task.id,
                  role: ship.role,
                  shipName: ship.displayName,
                  model: currentModelId,
                  workspace: workdir,
                  payload: { step: `model switched to ${currentModelId}` },
                })
              }

              out = await this.runPrompt(
                currentSession,
                { text: promptText, timeoutMs: this.defaultTaskTimeoutMs },
                {
                  taskId: task.id,
                  shipId: ship.id,
                  onTool: (tool) => {
                    if (tool.phase !== 'start') return
                    const label =
                      tool.summary !== undefined && tool.summary !== '' ? `${tool.name}: ${tool.summary}` : tool.name
                    this.emitWorkerEvent({
                      type: 'worker.progress',
                      runId: this.runId,
                      taskId: task.id,
                      role: ship.role,
                      shipName: ship.displayName,
                      model: currentModelId,
                      workspace: workdir,
                      payload: { step: stripControlChars(label).slice(0, 300) },
                    })
                  },
                },
              )
            } finally {
              this.liveSessions.delete(task.id)
              this.interruptSent.delete(task.id)
              await currentSession.close().catch((e: unknown) => {
                this.diagnostic(`task ${task.id}: fallback session close failed: ${e instanceof Error ? e.message : String(e)}`)
              })
            }

            // If the fallback attempt also failed, loop again (bounded by maxTotalFallbacks)
            // If it succeeded, break out to success handling below
            continue
          }

          // retry-same, exhausted, unsafe, or no-action: fall through to
          // existing circuit breaker / failure handling below
          break
        }
      }

      // Result contract
      const resultPayload: JsonValue = {
        summary: out.summary,
        outcome: out.outcome,
        engine: adapter.kind,
        textChars: out.textChars,
        text: out.text,
        textTruncated: out.textTruncated,
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
          task.assigneeShipId ?? 'unassigned',
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
              shipId: task.assigneeShipId ?? 'unassigned',
              path,
            },
            this.fence ?? undefined,
          )
        }
      }

      const key = task.assigneeShipId ?? `unassigned:${task.id}`
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
   * requests become durable approvals bound to this run/task/Ship, visible to
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
  private approvalChannel(ship: ShipRecord, taskId: string | null, workdir: string): EnginePermissionChannel {
    return createEngineApprovalChannel({
      store: this.store,
      projectId: this.projectId,
      runId: this.runId,
      taskId,
      shipId: ship.id,
      ttlMinutes: this.limits.approvalTtlMinutes,
      now: this.now,
      permissionPolicy: {
        approvalMode: ship.approvalMode,
        workspacePolicy: ship.workspacePolicy,
        workdir,
        projectRoot: this.rootDir,
        isManager: taskId === null,
        ...(this.protectedPaths.length > 0 ? { protectedPaths: this.protectedPaths } : {}),
      },
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
    const ship = this.store.getShip(run.managerShipId)
    if (!ship || !ship.enabled) {
      throw new NotFoundError('manager ship', run.managerShipId)
    }
    const adapter = this.adapterFor(ship, { isolatedCheckout: false })
    const mcpSpec = this.mcpServerFor(ship, null)
    const instructions = this.instructionsFor(ship)
    const session = await adapter.startSession({
      ship: { id: ship.id, slug: ship.slug, role: ship.role, model: ship.model },
      workdir: this.rootDir, // coordinator-read-only: read the tree, never write
      env: this.engineEnv(ship),
      configDir: ship.engineHome,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(mcpSpec !== null ? { mcpServers: [mcpSpec] } : {}),
      approvals: this.approvalChannel(ship, null, this.rootDir),
    })
    // CS-9: register the manager session as an interrupt target while its prompt
    // is in flight (a terminal run must stop its manager too).
    this.managerSessionRef = session
    this.emitWorkerEvent({
      type: 'worker.started',
      runId: this.runId,
      taskId: 'manager',
      role: 'supervisor',
      shipName: ship.displayName,
      model: ship.model,
      workspace: this.rootDir,
      payload: { step: `session started (${adapter.kind})` },
    })
    const prompt = buildManagerPrompt(
      run.goal,
      ship,
      this.store.listShips().filter((m) => m.enabled),
      run.acceptanceCriteria,
      this.limits.maxBriefChars,
    )
    try {
      const out = await this.runPrompt(
        session,
        { text: prompt, timeoutMs: this.runDeadlineMs },
        {
          shipId: ship.id,
          onTool: (tool) => {
            const label =
              tool.summary !== undefined && tool.summary !== '' ? `${tool.name}: ${tool.summary}` : tool.name
            this.emitWorkerEvent({
              type: 'worker.progress',
              runId: this.runId,
              taskId: 'manager',
              role: 'supervisor',
              shipName: ship.displayName,
              model: ship.model,
              workspace: this.rootDir,
              payload: {
                step: tool.phase === 'end' ? `${label} (finished${tool.isError ? ' with error' : ''})` : label,
                phase: tool.phase,
                tool: tool.name,
                isError: tool.isError,
              },
            })
          },
        },
      )
      if (out.outcome === 'success') {
        this.emitWorkerEvent({
          type: 'worker.completed',
          runId: this.runId,
          taskId: 'manager',
          role: 'supervisor',
          shipName: ship.displayName,
          model: ship.model,
          workspace: this.rootDir,
          payload: {
            ...(out.summary !== null ? { summary: out.summary } : {}),
            ...(out.text ? { text: out.text.slice(0, 4_000) } : {}),
          },
        })
      } else if (out.outcome === 'cancelled') {
        this.emitWorkerEvent({
          type: 'worker.cancelled',
          runId: this.runId,
          taskId: 'manager',
          role: 'supervisor',
          shipName: ship.displayName,
          model: ship.model,
          workspace: this.rootDir,
          ...(out.summary !== null ? { payload: { summary: out.summary } } : {}),
        })
      } else {
        this.emitWorkerEvent({
          type: 'worker.failed',
          runId: this.runId,
          taskId: 'manager',
          role: 'supervisor',
          shipName: ship.displayName,
          model: ship.model,
          workspace: this.rootDir,
          payload: { error: out.errorCode ?? 'manager session failed' },
        })
      }
      return out
    } catch (err) {
      this.emitWorkerEvent({
        type: 'worker.failed',
        runId: this.runId,
        taskId: 'manager',
        role: 'supervisor',
        shipName: ship.displayName,
        model: ship.model,
        workspace: this.rootDir,
        payload: { error: err instanceof Error ? err.message : String(err) },
      })
      throw err
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
          this.appendEventUnfenced('run.started', { goal: run.goal, managerShipId: run.managerShipId })
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
    // The real answer: the manager's own streamed text (bounded by runPrompt at
    // the same MAX_RESULT_TEXT_CHARS cap, so no second truncation). `summary`
    // is engine metadata (`stopReason: end_turn`) and is persisted as metadata
    // only — defect 2026-10-21 mistakenly stored it as the whole final summary.
    const managerAnswer = managerOutcome !== null && managerOutcome.text !== '' ? managerOutcome.text : null
    const managerSummary = this.skipManager
      ? 'resumed worker dispatch'
      : boundedSummary(managerOutcome?.summary ?? undefined)
    const errorSummary = managerError !== null ? boundedSummary(managerError) : undefined
    // What the run REPORTS (event payload / CLI / RunOutcome): the answer when
    // one exists, else the engine result summary, else the manager error.
    const reportedSummary = managerAnswer ?? managerSummary ?? errorSummary

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
    // What final_summary should hold for THIS terminal state — branch-specific:
    // a completed/verifying run persists the actual answer and NOTHING ELSE
    // (never the `stopReason` metadata string); a successful turn that
    // produced no text leaves final_summary NULL (an honest empty answer —
    // the stopReason stays in the event payload as metadata); failed/cancelled
    // runs prefer the manager's own streamed explanation (real content, e.g.
    // the plan narrative or the failure diagnosis), then the manager error,
    // and fall back to the engine result summary (metadata) only when nothing
    // better exists — metadata must never substitute for available content.
    let persistedSummary: string | undefined
    if (this.skipManager) {
      persistedSummary = managerSummary ?? undefined
    } else if (runState === 'completed' || runState === 'verifying') {
      persistedSummary = managerAnswer ?? undefined
    } else if (managerError !== null) {
      persistedSummary = errorSummary ?? managerAnswer ?? managerSummary ?? undefined
    } else {
      persistedSummary = managerAnswer ?? errorSummary ?? managerSummary ?? undefined
    }
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
          { finalSummary: persistedSummary },
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
      // The streamed stopReason is engine metadata, never the answer: it stays
      // in this event payload so a completed run with an empty answer remains
      // distinguishable from a fabricated/dropped one.
      ...(managerOutcome?.summary !== undefined && managerOutcome.summary !== null
        ? { stopReason: managerOutcome.summary }
        : {}),
      ...(reportedSummary !== undefined && reportedSummary !== null ? { managerSummary: reportedSummary } : (managerSummary !== null ? { managerSummary } : {})),
      ...(managerOutcome?.textTruncated === true ? { answerTruncated: true } : {}),
      ...(managerError !== null ? { managerError } : {}),
      durationMs: this.now() - startedMs,
    }
    this.appendEvent(actualState === 'uncertain' ? 'run.uncertain' : 'run.finished', eventPayload)
    return {
      runId: this.runId,
      state: actualState,
      outcome,
      managerSummary: reportedSummary ?? managerSummary,
      taskCounts,
      unfinishedTasks: unfinished,
      blockedTasks: blocked,
    }
  }

  private managerOutcomeCache: PromptOutcome | null = null
  private managerErrorCache: string | null = null
}

export function resolveTaskModelFor(
  ship: ShipRecord,
  task: TaskRecord,
  registry: ModelRegistry | null,
  config: ResolvedModelConfig | null,
  diagnostic?: (line: string) => void,
): string {
  const cfg = config?.ships[ship.id]
  if (cfg?.pin) return cfg.pin
  if (registry !== null) {
    const outcome = selectModel(registry, {
      task: { title: task.title, brief: task.brief, acceptanceCriteria: task.acceptanceCriteria },
      shipRole: ship.role as ShipRole,
      hint: cfg?.taskHints,
      costPreference: cfg?.preferences?.costPreference,
      latencyPreference: cfg?.preferences?.latencyPreference,
      maxCostUsdPerMillionTokens: cfg?.preferences?.maxCostUsdPerMillionTokens,
      maxLatencyMs: cfg?.preferences?.maxLatencyMs,
      minContextWindow: cfg?.preferences?.minContextWindow,
      providerAllowlist: cfg?.providerAllowlist ?? [],
      providerDenylist: cfg?.providerDenylist ?? [],
    })
    if (outcome.selection !== null) return outcome.selection.modelId
    diagnostic?.(
      `task ${task.id}: no eligible model from registry; falling back to ship.model '${ship.model}'`
    )
  }
  return ship.model
}
