import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InternalError, NotFoundError } from '../domain/errors.ts'
import type { JsonValue, MuseRecord, TaskRecord } from '../domain/models.ts'
import { engineAdapterForMuse } from '../engines/approval.ts'
import type {
  EngineAdapter,
  EngineEvent,
  EngineSession,
  McpServerSpec,
  PromptRequest,
} from '../engines/contract/types.ts'
import { TERMINAL_TASK_STATES, type RunState } from '../domain/state.ts'
import type { Store } from '../store/store.ts'
import type { GitWorkspaceManager } from '../workspace/manager.ts'
import { KeyedMutex } from './mutex.ts'
import { notifyTaskSettled, taskAncestorIds, WakeupRegistry, wakeupChannelFor } from './wakeups.ts'
import { PlutonToolBridge, type ToolBridgeLimits } from '../tools/bridge.ts'

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
  adapterFor?: (muse: MuseRecord) => EngineAdapter
  workspaceManager?: GitWorkspaceManager
  /** Extra environment variables per Muse (allowlisted by the caller; never secrets here). */
  engineEnv?: (muse: MuseRecord) => Record<string, string>
  /** MCP server spec handed to engine sessions; null = engines get no tools (dev/mock). */
  mcpServerFor?: (muse: MuseRecord, taskId: string | null) => McpServerSpec | null
  wakeups?: WakeupRegistry
  now?: () => number
  diagnostic?: (line: string) => void
}

export interface RunOutcome {
  runId: string
  state: RunState
  outcome: 'success' | 'failure' | 'cancelled' | 'unknown' | 'timeout' | 'pending_verification'
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

interface PromptOutcome {
  outcome: 'success' | 'failure' | 'cancelled' | 'unknown'
  summary: string | null
  errorCode: string | null
  textChars: number
}

const ACTIVELY_RUNNING = new Set(['admitted', 'running', 'waiting_for_children', 'needs_input', 'needs_approval'])
const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(['completed', 'failed', 'cancelled', 'uncertain'])
const DEFAULT_LOOP_POLL_MS = 200

function boundedSummary(text: string | undefined, max = 2_000): string | null {
  if (text === undefined) return null
  return text.length > max ? `${text.slice(0, max)}…` : text
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
  /**
   * The per-Muse engine factory actually used: the injected seam, or the
   * approval-aware default ({@link engineAdapterForMuse}). Public so the
   * default path itself is testable without spawning engines.
   */
  readonly adapterFor: (muse: MuseRecord) => EngineAdapter
  private readonly workspaceManager: GitWorkspaceManager | null
  private readonly engineEnv: (muse: MuseRecord) => Record<string, string>
  private readonly mcpServerFor: (muse: MuseRecord, taskId: string | null) => McpServerSpec | null
  private readonly wakeups: WakeupRegistry
  private readonly now: () => number
  private readonly diagnostic: (line: string) => void
  private readonly mutex = new KeyedMutex()
  private bridgeInstance: PlutonToolBridge | null = null
  private timedOut = false
  private readonly inFlight = new Map<string, Promise<void>>()

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
    this.adapterFor = opts.adapterFor ?? ((muse) => engineAdapterForMuse(muse))
    this.workspaceManager = opts.workspaceManager ?? null
    this.engineEnv = opts.engineEnv ?? (() => ({}))
    this.mcpServerFor = opts.mcpServerFor ?? (() => null)
    this.wakeups = opts.wakeups ?? new WakeupRegistry()
    this.now = opts.now ?? Date.now
    this.diagnostic = opts.diagnostic ?? (() => {})
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
        wakeups: this.wakeups,
        now: this.now,
      })
    }
    return this.bridgeInstance
  }

  private managerChannel(): string {
    return wakeupChannelFor(null, this.runId)
  }

  private appendEvent(type: string, payload: JsonValue, taskId?: string, museId?: string): void {
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
    context?: { taskId?: string; museId?: string },
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
            // leaving a "successful" no-op task). Description is bounded like
            // every other model-controlled string before it reaches the store.
            this.appendEvent(
              'approval.engine_decision',
              { requestId: a.requestId, description: a.description.slice(0, 1_000) },
              context?.taskId,
              context?.museId,
            )
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
    },
  ): void {
    switch (ev.kind) {
      case 'text':
        hooks.onText(ev.text.length)
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
      default:
        break // status/tool/usage events: not needed for run decisions yet
    }
  }

  /** Record `failed` on a task through only legal transitions; never fabricate. */
  private failTask(taskId: string, failure: JsonValue, eventType = 'task.failed'): void {
    const task = this.store.getTask(taskId)
    if (TERMINAL_TASK_STATES.has(task.state)) return
    let current = task
    if (current.state === 'created') current = this.store.setTaskState(taskId, 'queued')
    if (current.state === 'queued') current = this.store.setTaskState(taskId, 'admitted')
    if (current.state === 'waiting_for_children') current = this.store.setTaskState(taskId, 'running')
    if (current.state === 'needs_approval' || current.state === 'needs_input') {
      current = this.store.setTaskState(taskId, 'failed', { failure })
    } else if (current.state === 'admitted' || current.state === 'running' || current.state === 'verifying') {
      current = this.store.setTaskState(taskId, 'failed', { failure })
    } else {
      this.diagnostic(`task ${taskId}: cannot record failure from state '${current.state}'`)
    }
    if (current.state === 'failed') {
      this.appendEvent(eventType, { failure }, taskId)
      this.notifySettled(current)
    }
  }

  private async executeTask(task: TaskRecord): Promise<void> {
    const store = this.store
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
      store.setTaskState(task.id, 'admitted')

      let workspaceId: string | null = null
      let workdir = this.rootDir
      if (muse.workspacePolicy === 'isolated-task-checkout') {
        if (!this.workspaceManager) {
          throw new InternalError('isolated-task-checkout requires a workspace manager')
        }
        const info = await this.workspaceManager.createCheckout({
          repoPath: this.rootDir,
          kind: 'task-checkout',
          runId: this.runId,
          slug: task.title,
          destName: task.id,
        })
        const ws = store.createWorkspace({
          projectId: this.projectId,
          runId: this.runId,
          taskId: task.id,
          museId: muse.id,
          kind: 'task-checkout',
          path: info.path,
          branch: info.branch,
          baseCommit: info.baseCommit,
        })
        workspaceId = ws.id
        workdir = info.path
      }

      const adapter = this.adapterFor(muse)
      const mcpSpec = this.mcpServerFor(muse, task.id)
      const instructions = this.instructionsFor(muse)
      const session = await adapter.startSession({
        muse: { id: muse.id, slug: muse.slug, role: muse.role, model: muse.model },
        workdir,
        env: this.engineEnv(muse),
        configDir: muse.engineHome,
        ...(instructions !== undefined ? { instructions } : {}),
        ...(mcpSpec !== null ? { mcpServers: [mcpSpec] } : {}),
      })
      store.setTaskState(task.id, 'running', {
        workspaceId,
        engineSessionId: session.info.nativeSessionId ?? session.info.id,
      })
      this.appendEvent('task.started', { museId: muse.id, engine: adapter.kind, workspaceId }, task.id)

      const promptText = buildTaskPrompt(task, muse, this.limits.maxBriefChars)
      let out: PromptOutcome
      try {
        out = await this.runPrompt(
          session,
          { text: promptText, timeoutMs: this.defaultTaskTimeoutMs },
          { taskId: task.id, museId: muse.id },
        )
      } finally {
        // Close on EVERY exit path: a throwing prompt previously skipped the
        // close and leaked a live engine process in the container
        // (container-mode smoke finding, 2026-10-17).
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
      if (out.outcome === 'success') {
        const verifying = store.setTaskState(task.id, 'verifying', { result: resultPayload })
        if (this.verificationConfigured) {
          // Work is done; only the operator's verification gate can close the
          // task. Waiters are woken NOW so they never deadlock on `completed`
          // (host-mode smoke finding: the manager waited out the whole run).
          this.appendEvent('task.awaiting_verification', { outcome: out.outcome }, task.id)
          this.notifySettled(verifying)
          return // Phase-7 gate completes it; the dispatch loop leaves it here honestly
        }
        const done = store.setTaskState(task.id, 'completed')
        this.appendEvent('task.completed', { outcome: out.outcome, summary: out.summary }, task.id)
        this.notifySettled(done)
        return
      }
      if (out.outcome === 'failure') {
        this.failTask(task.id, resultPayload)
        return
      }
      if (out.outcome === 'cancelled') {
        const cancelled = store.setTaskState(task.id, 'cancelled', { failure: resultPayload })
        this.appendEvent('task.cancelled', { outcome: 'cancelled', summary: out.summary }, task.id)
        this.notifySettled(cancelled)
        return
      }
      // unknown — never replay automatically; a human/manager decides what next.
      const unknown = store.setTaskState(task.id, 'unknown_outcome', { failure: resultPayload })
      this.appendEvent('task.unknown_outcome', { outcome: 'unknown', summary: out.summary }, task.id)
      this.notifySettled(unknown)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.diagnostic(`task ${task.id} failed: ${message}`)
      this.failTask(task.id, { code: 'task_setup_failed', message: message.slice(0, 2_000) })
    }
  }

  private dispatchReadyTasks(): void {
    for (const task of this.store.listReadyTasks(this.runId)) {
      if (this.inFlight.size >= this.maxConcurrentWorkers) return
      const key = task.assigneeMuseId ?? `unassigned:${task.id}`
      const promise = this.mutex.withLock(key, () => this.executeTask(task))
      this.inFlight.set(task.id, promise)
      promise.then(
        () => this.inFlight.delete(task.id),
        () => this.inFlight.delete(task.id),
      )
    }
  }

  private allQuiescent(managerSettled: boolean): boolean {
    if (!managerSettled) return false
    if (this.inFlight.size > 0) return false
    if (this.store.listReadyTasks(this.runId).length > 0) return false
    return !this.store.listTasks(this.runId).some((t) => ACTIVELY_RUNNING.has(t.state))
  }

  private async runManagerSession(): Promise<PromptOutcome> {
    const run = this.store.getRun(this.runId)
    const muse = this.store.getMuse(run.managerMuseId)
    if (!muse || !muse.enabled) {
      throw new NotFoundError('manager muse', run.managerMuseId)
    }
    const adapter = this.adapterFor(muse)
    const mcpSpec = this.mcpServerFor(muse, null)
    const instructions = this.instructionsFor(muse)
    const session = await adapter.startSession({
      muse: { id: muse.id, slug: muse.slug, role: muse.role, model: muse.model },
      workdir: this.rootDir, // coordinator-read-only: read the tree, never write
      env: this.engineEnv(muse),
      configDir: muse.engineHome,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(mcpSpec !== null ? { mcpServers: [mcpSpec] } : {}),
    })
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
   * Drive the run: manager session concurrently with task dispatch, until the
   * manager has settled and nothing can make progress — then finalize the run
   * from durable records only.
   */
  async runToCompletion(): Promise<RunOutcome> {
    const started = this.now()
    const deadline = started + this.runDeadlineMs
    const run = this.store.getRun(this.runId)
    if (run.state === 'created') {
      this.store.setRunState(this.runId, 'active', { supervisorPid: process.pid })
      this.appendEvent('run.started', { goal: run.goal, managerMuseId: run.managerMuseId })
    }

    let managerOutcome: PromptOutcome | null = null
    let managerError: string | null = null
    const managerCompletion = this.runManagerSession().then(
      (o) => {
        managerOutcome = o
      },
      (e: unknown) => {
        managerError = (e instanceof Error ? e.message : String(e)).slice(0, 2_000)
      },
    )

    for (;;) {
      const current = this.store.getRun(this.runId)
      if (TERMINAL_RUN_STATES.has(current.state)) break // operator stopped/finished it; respect the record
      this.dispatchReadyTasks()
      const managerSettled = managerOutcome !== null || managerError !== null
      if (this.allQuiescent(managerSettled)) break
      const remaining = deadline - this.now()
      if (remaining <= 0) {
        this.timedOut = true
        break
      }
      await this.wakeups.waitFor(this.managerChannel(), Math.min(this.loopPollMs, Math.max(remaining, 1)))
    }
    await managerCompletion // bounded by the manager prompt's own timeout
    this.managerOutcomeCache = managerOutcome
    this.managerErrorCache = managerError
    return this.finalize(started)
  }

  private finalize(startedMs: number): RunOutcome {
    const tasks = this.store.listTasks(this.runId)
    const taskCounts: Record<string, number> = {}
    for (const t of tasks) taskCounts[t.state] = (taskCounts[t.state] ?? 0) + 1
    const unfinished = tasks.filter((t) => !TERMINAL_TASK_STATES.has(t.state)).map((t) => t.id)
    // Dependents are only admissible once their dependency is `completed`, so
    // tasks stuck behind unverified dependencies are not awaiting verification
    // themselves — name them separately or the record overstates the gate.
    const blocked = tasks
      .filter((t) => !TERMINAL_TASK_STATES.has(t.state) && t.state !== 'verifying')
      .map((t) => t.id)
    const anyBad = tasks.some((t) => t.state === 'failed' || t.state === 'unknown_outcome')
    const anyVerifying = tasks.some((t) => t.state === 'verifying')

    const managerOutcome = this.managerOutcomeCache
    const managerError = this.managerErrorCache
    const managerSummary = boundedSummary(managerOutcome?.summary ?? undefined)

    let outcome: RunOutcome['outcome']
    let runState: RunState
    if (this.timedOut) {
      outcome = 'timeout'
      runState = 'uncertain'
    } else if (managerError !== null) {
      outcome = 'failure'
      runState = 'failed'
    } else if (managerOutcome?.outcome === 'success') {
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

    const eventPayload: JsonValue = {
      outcome,
      state: runState,
      taskCounts,
      ...(blocked.length > 0 ? { blockedTasks: blocked } : {}),
      ...(managerSummary !== null ? { managerSummary } : {}),
      ...(managerError !== null ? { managerError } : {}),
      durationMs: this.now() - startedMs,
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
      this.store.setRunState(this.runId, runState, { finalSummary: managerSummary ?? undefined })
    }
    const actualState = this.store.getRun(this.runId).state
    this.appendEvent(actualState === 'uncertain' ? 'run.uncertain' : 'run.finished', {
      ...eventPayload,
      state: actualState,
    })
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
