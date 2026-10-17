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

const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  created: ['queued', 'cancelled'],
  queued: ['admitted', 'cancelled'],
  admitted: ['running', 'cancelled', 'failed'],
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
  waiting_for_children: ['running', 'cancelled', 'interrupted', 'unknown_outcome'],
  needs_input: ['running', 'cancelled', 'interrupted', 'failed'],
  needs_approval: ['running', 'cancelled', 'failed'],
  verifying: ['completed', 'failed', 'cancelled', 'interrupted', 'unknown_outcome', 'queued'],
  completed: [],
  failed: [],
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
 * Engine *process* state — distinct from task state and run state.
 */
export const ENGINE_PROCESS_STATES = [
  'not_started',
  'starting',
  'ready',
  'busy',
  'interrupted',
  'stopped',
  'crashed',
] as const

export type EngineProcessState = (typeof ENGINE_PROCESS_STATES)[number]

/** Sandbox lifecycle state — distinct from task state. */
export const SANDBOX_STATES = ['absent', 'creating', 'running', 'stopped', 'error'] as const
export type SandboxState = (typeof SANDBOX_STATES)[number]
