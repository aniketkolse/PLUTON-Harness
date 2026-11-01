import { StateTransitionError } from '../domain/errors.ts'
import type { JsonValue, TaskRecord } from '../domain/models.ts'
import {
  SESSION_BACKED_TASK_STATES,
  TERMINAL_TASK_STATES,
  isTerminalRunState,
  type RunState,
  type TaskState,
} from '../domain/state.ts'
import type { Store, SupervisorFence } from '../store/store.ts'
import { applyTaskVerificationVerdict, finalizeRunVerdict } from '../verify/runner.ts'

/**
 * Startup recovery (Phase A / P2).
 *
 * A supervisor claims the run before this module runs. Recovery reconciles the
 * durable rows a dead process left behind and returns a deterministic report;
 * it never resumes an engine session (a new process cannot own the dead one)
 * and never turns an unknown outcome into a success.
 *
 * Policy (mirrored in docs/optimization/07-PERSISTENCE-RECOVERY-AUDIT.md):
 *
 * - `verifying` tasks are work-complete. Completed check evidence is fed
 *   through the same verdict gate as `pluton verify`; pending or missing
 *   evidence is left visibly awaiting verification — never auto-completed.
 * - Session-backed tasks (`admitted`, `running`, `waiting_for_children`,
 *   `needs_input`, `needs_approval`) had a live engine session that is gone.
 *   They are requeued only when durable tool checkpoints prove no operation is
 *   still in flight; an unmatched tool start (or a tool error, or a granted
 *   approval whose result was never persisted) terminalizes as
 *   `unknown_outcome`. The task is never replayed in that case.
 * - Pending approvals belong to dead sessions and have no in-process waiter.
 *   They are expired with an auditable reason before their task is requeued.
 *   A task whose approval was already granted is an unknown outcome.
 * - A run parked in `awaiting_approval` is resumed once every pending approval
 *   is settled. `awaiting_input` has no durable waiter, so it stays parked and
 *   the manager is suppressed.
 * - Exhausted recovery budget (`attempt >= maxRetriesPerTask`) terminalizes as
 *   `unknown_outcome` with `recovery_exhausted`, preserving the prior state.
 *
 * Decisions are durable events (`recovery.*` / `task.recovery_*`) rather than a
 * new table: the event log already carries run/task identity, ordering and
 * retention, and recovery reads the authoritative task/approval rows.
 */

export type RecoveryAction =
  | 'requeued'
  | 'unknown_outcome'
  | 'verification_resumed'
  | 'verification_interrupted'
  | 'verification_missing'
  | 'verification_blocked'
  /** The durable row changed under the recovery write; no write was applied. */
  | 'no_action'

export interface RecoveryDecision {
  taskId: string
  priorState: TaskState
  action: RecoveryAction
  attempt: number
  reason: string
}

export interface RecoveryReport {
  runId: string
  decisions: RecoveryDecision[]
  requeued: string[]
  unknownOutcome: string[]
  verificationResumed: string[]
  verificationPending: string[]
  approvalsExpired: string[]
  runResumedFrom: RunState | null
  /** true → the supervisor must not open a manager session for this run. */
  suppressManager: boolean
  durationMs: number
}

export interface RecoveryManagerOptions {
  store: Store
  projectId: string
  runId: string
  /** Claim token of the supervisor that owns this recovery pass. */
  fence?: SupervisorFence
  maxRetriesPerTask: number
  now?: () => number
  diagnostic?: (line: string) => void
}

interface ToolCheckpoint {
  attempt: number
  callId: string | null
  name: string
  summary: string | null
  isError: boolean
}

interface ToolCheckpointAnalysis {
  anyActivity: boolean
  unknownReason: string | null
  completedTools: string[]
}

const TOOL_CHECKPOINT_TYPES = ['task.tool_started', 'task.tool_completed'] as const
const MAX_CHECKPOINT_EVENTS = 5_000
const MAX_COMPLETED_TOOLS = 12

function jsonObject(value: JsonValue | null): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null
}

function checkpointOf(event: { payload: JsonValue }): ToolCheckpoint | null {
  const payload = jsonObject(event.payload)
  if (payload === null) return null
  const attempt = payload['attempt']
  const name = payload['name']
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || typeof name !== 'string') return null
  const callId = payload['callId']
  const summary = payload['summary']
  const isError = payload['isError']
  return {
    attempt,
    callId: typeof callId === 'string' ? callId : null,
    name,
    summary: typeof summary === 'string' ? summary : null,
    isError: isError === true,
  }
}

/**
 * Fold durable tool checkpoints for one attempt. Pairing mirrors
 * `isSafeToReplay`: a call id closes its own start; anonymous events close the
 * most recent open call. Any start left open means the process died while the
 * operation's outcome was unknown.
 */
export function analyzeToolCheckpoints(
  events: readonly { type: string; payload: JsonValue }[],
  attempt: number,
): ToolCheckpointAnalysis {
  const open = new Map<string, ToolCheckpoint>()
  let anonymous = 0
  let nextAnonymous = 0
  const completedTools: string[] = []
  let unknownReason: string | null = null

  for (const event of events) {
    const checkpoint = checkpointOf(event)
    if (checkpoint === null || checkpoint.attempt !== attempt) continue
    if (event.type === 'task.tool_started') {
      const key = checkpoint.callId ?? `__anon_${anonymous++}`
      open.set(key, checkpoint)
      continue
    }
    if (event.type !== 'task.tool_completed') continue
    const key =
      checkpoint.callId !== null && open.has(checkpoint.callId)
        ? checkpoint.callId
        : [...open.keys()].pop() ?? `__done_${nextAnonymous++}`
    open.delete(key)
    if (checkpoint.isError && unknownReason === null) {
      unknownReason = `tool '${checkpoint.name}' reported an error; its external side effects cannot be ruled out`
    }
    const label =
      checkpoint.summary !== null && checkpoint.summary !== ''
        ? `${checkpoint.name}: ${checkpoint.summary}`
        : checkpoint.name
    if (completedTools.length < MAX_COMPLETED_TOOLS) completedTools.push(label)
  }

  if (unknownReason === null && open.size > 0) {
    const first = [...open.values()][0]
    unknownReason =
      first !== undefined
        ? `tool '${first.name}' started but its result was never persisted`
        : 'a tool call was in flight when the process died'
  }

  return {
    anyActivity: completedTools.length > 0 || open.size > 0 || anonymous > 0,
    unknownReason,
    completedTools,
  }
}

export class RecoveryManager {
  private readonly store: Store
  private readonly projectId: string
  private readonly runId: string
  private readonly fence: SupervisorFence | undefined
  private readonly maxRetriesPerTask: number
  private readonly now: () => number
  private readonly diagnostic: (line: string) => void

  constructor(opts: RecoveryManagerOptions) {
    this.store = opts.store
    this.projectId = opts.projectId
    this.runId = opts.runId
    this.fence = opts.fence
    this.maxRetriesPerTask = opts.maxRetriesPerTask
    this.now = opts.now ?? Date.now
    this.diagnostic = opts.diagnostic ?? (() => {})
  }

  recover(): RecoveryReport {
    const started = this.now()
    const decisions: RecoveryDecision[] = []
    const approvalsExpired: string[] = []
    let runResumedFrom: RunState | null = null

    const parked = this.reconcileParkedRun()
    approvalsExpired.push(...parked.expired)
    runResumedFrom = parked.resumedFrom

    if (!parked.terminal) {
      for (const task of this.store.listTasks(this.runId)) {
        if (TERMINAL_TASK_STATES.has(task.state)) continue
        const decision = this.reconcileTask(task)
        if (decision !== null) decisions.push(decision)
      }

      // A run already parked in `verifying` can only close through the verdict
      // engine. Recovery may have just settled its last task, so re-run the
      // authoritative finalizer here instead of leaving the run stranded.
      const beforeFinalize = this.store.getRun(this.runId)
      if (beforeFinalize.state === 'verifying') {
        try {
          finalizeRunVerdict(this.store, this.runId)
        } catch (e) {
          this.diagnostic(`recovery: run verdict finalization failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }

    const run = this.store.getRun(this.runId)
    const suppressManager =
      run.state === 'verifying' ||
      run.state === 'awaiting_input' ||
      run.state === 'awaiting_approval' ||
      isTerminalRunState(run.state)

    const requeued = decisions.filter((d) => d.action === 'requeued').map((d) => d.taskId)
    const unknownOutcome = decisions.filter((d) => d.action === 'unknown_outcome').map((d) => d.taskId)
    const verificationResumed = decisions
      .filter((d) => d.action === 'verification_resumed')
      .map((d) => d.taskId)
    const verificationPending = decisions
      .filter(
        (d) =>
          d.action === 'verification_interrupted' ||
          d.action === 'verification_missing' ||
          d.action === 'verification_blocked',
      )
      .map((d) => d.taskId)

    const report: RecoveryReport = {
      runId: this.runId,
      decisions,
      requeued,
      unknownOutcome,
      verificationResumed,
      verificationPending,
      approvalsExpired,
      runResumedFrom,
      suppressManager,
      durationMs: this.now() - started,
    }

    this.append('run.recovery_completed', {
      decisions: decisions.length,
      requeued: requeued.length,
      unknownOutcome: unknownOutcome.length,
      verificationResumed: verificationResumed.length,
      verificationPending: verificationPending.length,
      approvalsExpired: approvalsExpired.length,
      ...(runResumedFrom !== null ? { runResumedFrom } : {}),
      suppressManager,
      durationMs: report.durationMs,
    })

    if (unknownOutcome.length > 0) {
      this.diagnostic(
        `recovery: ${String(unknownOutcome.length)} task(s) have an unknown outcome; refusing to replay them (${unknownOutcome.join(', ')})`,
      )
    }
    return report
  }

  /**
   * A run parked on an operator approval has no live engine waiter after a
   * restart. Expire the run's pending approvals with an auditable reason, then
   * resume the run. If a control-plane write already terminalized the run, stop
   * and let the supervisor loop settle leftovers from the durable winner.
   */
  private reconcileParkedRun(): {
    expired: string[]
    resumedFrom: RunState | null
    terminal: boolean
  } {
    const run = this.store.getRun(this.runId)
    if (run.state !== 'awaiting_approval') {
      return { expired: [], resumedFrom: null, terminal: isTerminalRunState(run.state) }
    }

    const expired: string[] = []
    for (const approval of this.store.listApprovals(this.runId)) {
      if (approval.status !== 'pending') continue
      this.store.setApprovalStatus(approval.id, 'expired', { decidedBy: 'pluton:recovery' })
      this.store.appendEvent(
        {
          projectId: this.projectId,
          runId: this.runId,
          taskId: approval.taskId,
          ...(approval.requestedByShipId !== null ? { shipId: approval.requestedByShipId } : {}),
          type: 'approval.expired',
          payload: {
            approvalId: approval.id,
            action: approval.action,
            reason: 'supervisor_restart',
          },
        },
        this.fence,
      )
      this.append(
        'recovery.approval_expired',
        { approvalId: approval.id, action: approval.action, taskId: approval.taskId },
        approval.taskId ?? undefined,
      )
      expired.push(approval.id)
    }

    try {
      this.store.setRunState(this.runId, 'active', {}, this.fence)
    } catch (e) {
      if (!(e instanceof StateTransitionError)) throw e
      const fresh = this.store.getRun(this.runId)
      if (isTerminalRunState(fresh.state)) {
        return { expired, resumedFrom: null, terminal: true }
      }
      throw e
    }
    this.append('recovery.run_resumed', {
      priorState: 'awaiting_approval',
      expiredApprovals: expired.length,
    })
    return { expired, resumedFrom: 'awaiting_approval', terminal: false }
  }

  private reconcileTask(task: TaskRecord): RecoveryDecision | null {
    if (task.state === 'verifying') return this.reconcileVerifying(task)
    if (!SESSION_BACKED_TASK_STATES.has(task.state)) return null
    return this.reconcileSessionBacked(task)
  }

  /**
   * Work is complete and only the verdict is missing. The durable check rows
   * are the evidence; a fully-recorded attempt can be judged exactly like
   * `pluton verify`, while pending/missing/inconsistent evidence stays visible
   * in `verifying` and is never guess-completed.
   */
  private reconcileVerifying(task: TaskRecord): RecoveryDecision {
    const checks = this.store.listCurrentVerificationChecksByTaskAttempt(task.id, task.attempt)
    if (checks.length === 0) {
      this.append(
        'recovery.verification_missing',
        { taskId: task.id, priorState: 'verifying', attempt: task.attempt },
        task.id,
      )
      return {
        taskId: task.id,
        priorState: task.state,
        action: 'verification_missing',
        attempt: task.attempt,
        reason: 'task is verifying but no current-attempt verification evidence exists; operator must re-run verification',
      }
    }

    const pending = checks.filter((c) => c.status === 'pending')
    if (pending.length > 0) {
      this.append(
        'recovery.verification_interrupted',
        {
          taskId: task.id,
          priorState: 'verifying',
          attempt: task.attempt,
          pendingCount: pending.length,
          pendingChecks: pending.slice(0, 20).map((c) => c.name),
        },
        task.id,
      )
      return {
        taskId: task.id,
        priorState: task.state,
        action: 'verification_interrupted',
        attempt: task.attempt,
        reason: `${String(pending.length)} verification check(s) never finished; evidence is incomplete`,
      }
    }

    try {
      const verdict = applyTaskVerificationVerdict(this.store, task.id)
      this.append(
        'recovery.verification_resumed',
        {
          taskId: task.id,
          priorState: 'verifying',
          attempt: task.attempt,
          verdict: verdict.state,
          passed: verdict.passed,
        },
        task.id,
      )
      return {
        taskId: task.id,
        priorState: task.state,
        action: 'verification_resumed',
        attempt: task.attempt,
        reason: verdict.summary,
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.diagnostic(`recovery: task ${task.id} verification evidence cannot authorize a verdict: ${message}`)
      this.append(
        'recovery.verification_blocked',
        { taskId: task.id, priorState: 'verifying', attempt: task.attempt, message: message.slice(0, 1_000) },
        task.id,
      )
      return {
        taskId: task.id,
        priorState: task.state,
        action: 'verification_blocked',
        attempt: task.attempt,
        reason: message,
      }
    }
  }

  private reconcileSessionBacked(task: TaskRecord): RecoveryDecision {
    const approvals = this.store.listApprovals(this.runId).filter((a) => a.taskId === task.id)
    let approvalWasGranted = approvals.some((a) => a.status === 'approved')

    if (task.state === 'needs_approval') {
      // A pending request belongs to a dead session. The engine was blocked
      // before executing the tool, so expiring it loses no side effect. A
      // granted request is different: the tool may already have run.
      for (const approval of approvals) {
        if (approval.status !== 'pending') continue
        this.store.setApprovalStatus(approval.id, 'expired', { decidedBy: 'pluton:recovery' })
        this.store.appendEvent(
          {
            projectId: this.projectId,
            runId: this.runId,
            taskId: task.id,
            ...(approval.requestedByShipId !== null ? { shipId: approval.requestedByShipId } : {}),
            type: 'approval.expired',
            payload: { approvalId: approval.id, action: approval.action, reason: 'supervisor_restart' },
          },
          this.fence,
        )
        this.append(
          'recovery.approval_expired',
          { approvalId: approval.id, action: approval.action, taskId: task.id },
          task.id,
        )
      }
    }

    if (approvalWasGranted) {
      return this.unknownOutcome(
        task,
        'recovery_approval_unconfirmed',
        'an approval was granted before the process died, but the tool result was never persisted; the external side effect is unknown',
      )
    }

    const checkpoints = this.store.listTaskEvents(task.id, {
      types: TOOL_CHECKPOINT_TYPES,
      limit: MAX_CHECKPOINT_EVENTS,
    })
    const trace = analyzeToolCheckpoints(checkpoints, task.attempt)
    if (trace.unknownReason !== null) {
      return this.unknownOutcome(task, 'recovery_unknown_tool_outcome', trace.unknownReason)
    }

    if (task.attempt >= this.maxRetriesPerTask) {
      const terminal = this.store.setTaskStateIf(
        task.id,
        task.state,
        'unknown_outcome',
        {
          failure: {
            code: 'recovery_exhausted',
            message:
              `no recovery budget left: task was left in state '${task.state}' by a process that died ` +
              `(attempt ${String(task.attempt)} of ${String(this.maxRetriesPerTask)}); the engine session cannot be resumed`,
          },
        },
        this.fence,
      )
      if (terminal === null) {
        return {
          taskId: task.id,
          priorState: task.state,
          action: 'no_action',
          attempt: task.attempt,
          reason: 'recovery budget exhausted; the durable state changed concurrently and no write was applied',
        }
      }
      this.append(
        'task.recovery_exhausted',
        { taskId: task.id, priorState: task.state, attempt: task.attempt },
        task.id,
      )
      return {
        taskId: task.id,
        priorState: task.state,
        action: 'unknown_outcome',
        attempt: task.attempt,
        reason: 'recovery budget exhausted',
      }
    }

    const abandonedSessionId = task.engineSessionId
    const requeued = this.store.setTaskStateIf(
      task.id,
      task.state,
      'queued',
      { attempt: task.attempt + 1, engineSessionId: null },
      this.fence,
    )
    if (requeued === null) {
      return {
        taskId: task.id,
        priorState: task.state,
        action: 'no_action',
        attempt: task.attempt,
        reason: 'durable state changed concurrently; no recovery write was applied',
      }
    }

    const recoveryPayload: Record<string, JsonValue> = {
      taskId: task.id,
      priorState: task.state,
      attempt: task.attempt + 1,
      ...(trace.completedTools.length > 0 ? { completedTools: trace.completedTools } : {}),
    }
    this.append('task.recovered', recoveryPayload, task.id)
    if (abandonedSessionId !== null) {
      this.append('task.session_abandoned', { sessionId: abandonedSessionId }, task.id)
    }
    return {
      taskId: task.id,
      priorState: task.state,
      action: 'requeued',
      attempt: task.attempt + 1,
      reason:
        trace.completedTools.length > 0
          ? 'requeued with durable completed-tool context; no operation was in flight'
          : 'requeued; no tool operation was in flight',
    }
  }

  private unknownOutcome(task: TaskRecord, code: string, message: string): RecoveryDecision {
    const written = this.store.setTaskStateIf(
      task.id,
      task.state,
      'unknown_outcome',
      { failure: { code, message } },
      this.fence,
    )
    if (written === null) {
      return {
        taskId: task.id,
        priorState: task.state,
        action: 'no_action',
        attempt: task.attempt,
        reason: `${message} (durable state changed concurrently; no write was applied)`,
      }
    }
    this.append(
      'task.recovery_unknown_outcome',
      { taskId: task.id, priorState: task.state, attempt: task.attempt, code },
      task.id,
    )
    return {
      taskId: task.id,
      priorState: task.state,
      action: 'unknown_outcome',
      attempt: task.attempt,
      reason: message,
    }
  }

  private append(type: string, payload: JsonValue, taskId?: string): void {
    this.store.appendEvent(
      {
        projectId: this.projectId,
        runId: this.runId,
        ...(taskId !== undefined ? { taskId } : {}),
        type,
        payload,
      },
      this.fence,
    )
  }
}
