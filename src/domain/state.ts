import { StateTransitionError } from './errors.ts'

/**
 * Task state machine (ADR-0006). One table, one validator. Every module that
 * changes task state goes through this module; the SQL layer does not enforce
 * transitions itself.
 */
export const TASK_STATES = [
  'created',
  'queued',
  'admitted',
  'running',
  'waiting_for_children',
  'needs_input',
  'needs_approval',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'unknown_outcome',
] as const

export type TaskState = (typeof TASK_STATES)[number]

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'unknown_outcome',
])

/**
 * Canonical session-backed task states (CS-2): a live engine session may be
 * attached to a task exactly while it is one of these five. A process that
 * dies in one of them cannot resume the task — the engine session is gone —
 * so run quiescence and window/cleanup logic must treat every member as still
 * in flight, and recovery must requeue rather than strand them. Consumers
 * derive their own supersets from this set instead of copying the list.
 */
export const SESSION_BACKED_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'admitted',
  'running',
  'waiting_for_children',
  'needs_input',
  'needs_approval',
])

/**
 * Task transitions. Recovery rationale (CS-2): a task left in a session-backed
 * state ({@link SESSION_BACKED_TASK_STATES}) by a process that has since died
 * cannot be resumed — the engine session is gone — so requeue is the only
 * non-stranding recovery, and an exhausted recovery must terminalize honestly
 * as `unknown_outcome` rather than fabricate a success. `completed` stays
 * unreachable from those states.
 */
const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  created: ['queued', 'cancelled'],
  queued: ['admitted', 'cancelled'],
  admitted: ['running', 'cancelled', 'failed', 'queued', 'unknown_outcome'],
  running: [
    'waiting_for_children',
    'needs_input',
    'needs_approval',
    'verifying',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'unknown_outcome',
    'queued',
  ],
  waiting_for_children: ['running', 'cancelled', 'interrupted', 'unknown_outcome', 'queued'],
  needs_input: ['running', 'cancelled', 'interrupted', 'failed', 'queued', 'unknown_outcome'],
  needs_approval: ['running', 'cancelled', 'failed', 'queued', 'unknown_outcome'],
  verifying: ['completed', 'failed', 'cancelled', 'interrupted', 'unknown_outcome', 'queued'],
  completed: [],
  /**
   * CS-5: the manager's bounded revision requeue (`failed → queued`) is the ONE
   * deliberate reverse edge out of a terminal state: a failed task may be sent
   * back for one more attempt (capped by `runtime.max_revisions_per_task`) with
   * sanitized feedback recorded on the task. Every other terminal state stays
   * frozen, and `TERMINAL_TASK_STATES` is unchanged — the revision tool, not
   * settle/notify/recovery, is the only caller that may take this edge.
   */
  failed: ['queued'],
  cancelled: [],
  interrupted: [],
  unknown_outcome: [],
}

export function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as readonly string[]).includes(value)
}

export function allowedTransitions(from: TaskState): readonly TaskState[] {
  return TASK_TRANSITIONS[from]
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to)
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new StateTransitionError(from, to, 'task')
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state)
}

/**
 * Run state is a separate axis (ADR-0006): a run's state is derived by the
 * verdict engine from its tasks and verification results, never compressed
 * with task or process state.
 */
export const RUN_STATES = [
  'created',
  'active',
  'awaiting_approval',
  'awaiting_input',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'uncertain',
] as const

export type RunState = (typeof RUN_STATES)[number]

const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  created: ['active', 'cancelled', 'failed'],
  active: ['awaiting_approval', 'awaiting_input', 'verifying', 'completed', 'failed', 'cancelled', 'uncertain'],
  awaiting_approval: ['active', 'cancelled', 'failed'],
  awaiting_input: ['active', 'cancelled', 'failed'],
  verifying: ['completed', 'failed', 'cancelled', 'uncertain', 'active'],
  completed: [],
  failed: [],
  cancelled: [],
  uncertain: [],
}

export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value)
}

export function isTerminalRunState(state: RunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'uncertain'
}

export function canRunTransition(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canRunTransition(from, to)) throw new StateTransitionError(from, to, 'run')
}

/**
 * Engine *process* state is deliberately not modelled here: Pluton delegates
 * the engine process lifecycle to the adapter/session and persists no process
 * state of its own. A declared vocabulary with no producer or consumer is the
 * exact "vestigial states" failure R3 forbids, so there is no such table. The
 * state-coverage test pins this decision.
 */

/** Sandbox lifecycle state — distinct from task state. */
export const SANDBOX_STATES = ['absent', 'creating', 'running', 'stopped', 'error'] as const
export type SandboxState = (typeof SANDBOX_STATES)[number]
