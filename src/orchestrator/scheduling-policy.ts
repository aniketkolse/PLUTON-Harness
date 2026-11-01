import type { TaskEdgeRecord, TaskRecord } from '../domain/models.ts'
import { TERMINAL_TASK_STATES, type TaskState } from '../domain/state.ts'
import type { Store } from '../store/store.ts'
import type { TaskAssessment, WorkerAllocation } from './task-assessment.ts'

/**
 * Deterministic scheduling policy (Phase 4, Batch 3).
 *
 * Layers adaptive priority, allocation, and duplicate-work prevention on top of
 * the existing scheduler (`listReadyTasks`, `dispatchReadyTasks`, `executeTask`)
 * without replacing it. All functions are pure over store rows: they recommend,
 * never mutate, and never exceed the caller's hard limits.
 *
 * Policy rules:
 * 1. Readiness: a task is ready only when every dependency is `completed`
 *    (unchanged from `listReadyTasks`).
 * 2. Priority: among ready tasks, tasks blocking the most unblocked dependents
 *    are dispatched first; ties broken by `created_at` (FIFO baseline preserved).
 * 3. Allocation: the Batch 1 `TaskAssessment` strategy caps how many tasks of
 *    the run may be in flight at once, never above `maxConcurrentWorkers`.
 * 4. Duplicate intent: tasks with overlapping write scope and near-duplicate
 *   title/brief are flagged but left `queued` (never discarded).
 * 5. Unknown signals → conservative: FIFO, single-worker-per-Ship via KeyedMutex,
 *    no parallelism boost.
 */

export type SchedulingAction = 'scheduled' | 'deferred' | 'duplicate_suppressed'

export interface SchedulingDecision {
  taskId: string
  action: SchedulingAction
  reason: string
  /** Assessment-informed cap that influenced this decision, when known. */
  workerCap: number
  at: string
}

export interface ScheduleAllocation {
  /** Max tasks of this run that may be in flight at once (>= 1). */
  workerCap: number
  strategy: WorkerAllocation['strategy']
  reason: string
  /** True when the cap came from the assessment rather than the hard limit. */
  assessmentDriven: boolean
}

export interface SchedulePlan {
  /** Tasks recommended for immediate dispatch (in priority order). */
  dispatchOrder: string[]
  /** Tasks deferred this tick with reasons. */
  deferred: SchedulingDecision[]
  /** Tasks flagged as duplicate intent and left queued. */
  duplicateSuppressed: SchedulingDecision[]
  allocation: ScheduleAllocation
}

function nowIso(): string {
  return new Date().toISOString()
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Read the latest `run.assessed` event for a run, if any. Returns null when no
 * assessment has been recorded (pre-Batch-1 runs) — callers fall back to
 * conservative scheduling.
 */
export function readRunAssessment(store: Store, runId: string): TaskAssessment | null {
  const events = store.listEvents(runId, { type: 'run.assessed', limit: 5 })
  if (events.length === 0) return null
  // `listEvents` returns newest-first, so index 0 is the latest assessment.
  const latest = events[0]! // listEvents is newest-first
  const payload = objectOf(latest.payload)
  const assessment = payload !== null ? payload['assessment'] : null
  if (assessment === null || typeof assessment !== 'object' || Array.isArray(assessment)) return null
  return assessment as TaskAssessment
}

/** Count unblocked (non-terminal) direct dependents of a task within the run. */
function unblockedDependentCount(
  taskId: string,
  edges: TaskEdgeRecord[],
  statesById: Map<string, TaskState>,
): number {
  let count = 0
  for (const e of edges) {
    if (e.toTaskId !== taskId) continue // e.fromTaskId depends on e.toTaskId (= taskId)
    const depState = statesById.get(e.fromTaskId)
    if (depState !== undefined && !TERMINAL_TASK_STATES.has(depState)) count += 1
  }
  return count
}

/**
 * Sort ready tasks by scheduling priority.
 *
 * Primary: unblocked dependent count descending (tasks that unblock the most
 * work go first — dependency criticality).
 * Secondary: created_at ascending (FIFO baseline preserved for ties).
 *
 * This is a tie-break on FIFO, not preemption: an in-flight low-priority task
 * keeps its slot until it settles.
 */
export function prioritizeReadyTasks(
  readyTasks: TaskRecord[],
  edges: TaskEdgeRecord[],
  statesById: Map<string, TaskState>,
): TaskRecord[] {
  return [...readyTasks].sort((a, b) => {
    const aDeps = unblockedDependentCount(a.id, edges, statesById)
    const bDeps = unblockedDependentCount(b.id, edges, statesById)
    if (bDeps !== aDeps) return bDeps - aDeps
    const aCreated = str(a.createdAt) ?? ''
    const bCreated = str(b.createdAt) ?? ''
    if (aCreated < bCreated) return -1
    if (aCreated > bCreated) return 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Compute the adaptive worker cap for a run from its TaskAssessment.
 *
 * The assessment is advisory: it caps in-flight work for this run but never
 * exceeds `maxConcurrentWorkers` or drops below 1. When no assessment exists,
 * the cap equals `maxConcurrentWorkers` (conservative existing behavior).
 */
export function computeAllocation(
  assessment: TaskAssessment | null,
  maxConcurrentWorkers: number,
  inFlightCount: number,
): ScheduleAllocation {
  const hardCap = Math.max(1, maxConcurrentWorkers)
  const remaining = Math.max(0, hardCap - inFlightCount)

  if (assessment === null) {
    return {
      workerCap: hardCap,
      strategy: 'single',
      reason: 'no assessment recorded; hard concurrency cap applies',
      assessmentDriven: false,
    }
  }

  const base = allocateWorkersFromAssessment(assessment, hardCap)
  // Never dispatch more than the run's remaining concurrency headroom.
  const workerCap = Math.min(base.workerCount, hardCap, Math.max(1, remaining))
  const strategy = workerCap <= 1 ? 'single' : base.strategy
  const reason =
    base.workerCount >= hardCap
      ? `assessment recommends ${String(base.workerCount)} workers; hard cap ${String(hardCap)} applies`
      : `assessment ${assessment.complexity}: ${base.reason}`
  return {
    workerCap,
    strategy,
    reason,
    assessmentDriven: true,
  }
}

function allocateWorkersFromAssessment(assessment: TaskAssessment, maxWorkers: number): WorkerAllocation {
  const { complexity, parallelizableUnits, dependencyDepth } = assessment
  if (complexity === 'simple') {
    return { workerCount: 1, strategy: 'single', reason: 'simple request: single worker' }
  }
  if (parallelizableUnits <= 1) {
    return { workerCount: 1, strategy: 'single', reason: 'no independent units detected' }
  }
  if (complexity === 'moderate') {
    const count = Math.min(maxWorkers, Math.max(1, parallelizableUnits))
    return { workerCount: count, strategy: 'small_parallel', reason: `moderate request: ${String(parallelizableUnits)} independent units` }
  }
  // complex
  if (dependencyDepth > 2) {
    const count = Math.min(maxWorkers, Math.max(1, Math.min(2, parallelizableUnits)))
    return { workerCount: count, strategy: 'sequential_fallback', reason: 'complex but dependency-heavy: sequential fallback' }
  }
  const count = Math.min(maxWorkers, Math.max(1, parallelizableUnits))
  return { workerCount: count, strategy: 'bounded_parallel', reason: `complex request: ${String(parallelizableUnits)} independent units` }
}

/**
 * Token-overlap duplicate-intent detection. Deterministic, no model calls, no
 * semantic embedding. A candidate is a secondary duplicate when it shares a
 * write scope AND has sufficiently similar title/brief tokens with a task that
 * has already been selected for dispatch in this plan.
 *
 * The first (highest-priority) task in a duplicate group is dispatched; later
 * ones are flagged but left `queued` — never auto-deleted or auto-rejected. The
 * manager/operator may re-inspect.
 */
export function detectDuplicateIntent(
  candidate: TaskRecord,
  priorDispatches: TaskRecord[],
): { isDuplicate: boolean; reason: string } {
  const candidateTokens = normalizeTokens(`${candidate.title} ${candidate.brief}`)
  const candidateScope = new Set(candidate.writeScope ?? [])

  let bestSimilarity = 0
  let bestMatch = ''

  for (const existing of priorDispatches) {
    if (existing.id === candidate.id) continue
    if (existing.state === 'cancelled' || existing.state === 'unknown_outcome') continue
    const existingTokens = normalizeTokens(`${existing.title} ${existing.brief}`)
    const overlap = intersectCount(candidateTokens, existingTokens)
    const union = new Set([...candidateTokens, ...existingTokens]).size
    const similarity = union === 0 ? 0 : overlap / union
    const existingScope = new Set(existing.writeScope ?? [])
    const sharesScope = [...candidateScope].some((p) => existingScope.has(p))

    if (sharesScope && similarity > bestSimilarity) {
      bestSimilarity = similarity
      bestMatch = existing.id
    }
  }

  const threshold = 0.5
  if (bestSimilarity >= threshold) {
    return {
      isDuplicate: true,
      reason: `overlapping write scope and ${String(Math.round(bestSimilarity * 100))}% title/brief similarity with already-dispatched task ${bestMatch}`,
    }
  }
  return { isDuplicate: false, reason: 'no duplicate intent detected' }
}

function normalizeTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const token = raw.trim()
    if (token.length >= 3) tokens.add(token)
  }
  return tokens
}

function intersectCount(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const t of a) if (b.has(t)) n += 1
  return n
}

/**
 * Build a scheduling plan for one dispatch tick.
 *
 * @param readyTasks tasks returned by `listReadyTasks()` (already readiness-validated).
 * @param edges all task edges for the run (for dependency-criticality priority).
 * @param statesById current durable state of every task in the run.
 * @param existingTasks all tasks in the run (for duplicate detection).
 * @param assessment optional `run.assessed` assessment.
 * @param maxConcurrentWorkers hard concurrency cap.
 * @param inFlightCount current number of in-flight tasks.
 * @param now injectable clock.
 */
export function buildSchedulePlan(
  readyTasks: TaskRecord[],
  edges: TaskEdgeRecord[],
  statesById: Map<string, TaskState>,
  /** Tasks already dispatched this run (persistent across ticks), used to detect duplicate intent across ticks. */
  priorDispatches: TaskRecord[],
  assessment: TaskAssessment | null,
  maxConcurrentWorkers: number,
  inFlightCount: number,
  now?: () => number,
): SchedulePlan {
  const t = now ?? (() => Date.now())
  const at = new Date(t()).toISOString()

  const prioritized = prioritizeReadyTasks(readyTasks, edges, statesById)
  const allocation = computeAllocation(assessment, maxConcurrentWorkers, inFlightCount)
  const workerCap = allocation.workerCap

  const dispatchOrder: string[] = []
  const deferred: SchedulingDecision[] = []
  const duplicateSuppressed: SchedulingDecision[] = []

  let dispatched = 0
  for (const task of prioritized) {
    if (dispatched >= workerCap) {
      deferred.push({
        taskId: task.id,
        action: 'deferred',
        reason: `concurrency cap reached (${String(workerCap)} in flight)`,
        workerCap,
        at,
      })
      continue
    }

    const dup = detectDuplicateIntent(task, priorDispatches)
    if (dup.isDuplicate) {
      duplicateSuppressed.push({
        taskId: task.id,
        action: 'duplicate_suppressed',
        reason: dup.reason,
        workerCap,
        at,
      })
      continue
    }

    dispatchOrder.push(task.id)
    priorDispatches.push(task)
    deferred.push({
      taskId: task.id,
      action: 'scheduled',
      reason: `priority ${String(dispatched + 1)} of ${String(workerCap)}; ${allocation.reason}`,
      workerCap,
      at,
    })
    dispatched += 1
  }

  return { dispatchOrder, deferred, duplicateSuppressed, allocation }
}

/**
 * Build a single scheduling decision for a dispatched task.
 */
export function scheduledDecision(taskId: string, workerCap: number, reason: string, now?: () => number): SchedulingDecision {
  return {
    taskId,
    action: 'scheduled',
    reason,
    workerCap,
    at: new Date((now ?? (() => Date.now()))()).toISOString(),
  }
}
