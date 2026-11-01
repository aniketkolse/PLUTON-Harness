import type { TaskRecord } from '../domain/models.ts'
import type { Store } from '../store/store.ts'

/**
 * Task-level verification strategy (Phase 3, Batch B).
 *
 * The project-level `verification` list is the default evidence contract, but not
 * every task type needs the same gate: a research note or a review verdict is
 * not validated by the project's test suite, while an implementation or test
 * change is. The strategy keeps the gate evidence-based (no auto-completion of
 * unverified code) without forcing unrelated work through an irrelevant suite.
 */

export type TaskKind = 'implementation' | 'test' | 'research' | 'review' | 'coordination' | 'unknown'

export type VerificationStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'RUNNING'
  | 'PASSED'
  | 'FAILED'
  | 'BLOCKED'
  | 'UNKNOWN'

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function taskKind(task: TaskRecord): TaskKind {
  const assignment = objectOf(task.assignment)
  const role = typeof assignment?.['role'] === 'string' ? String(assignment['role']).toLowerCase() : ''
  switch (role) {
    case 'coder':
    case 'worker':
      return 'implementation'
    case 'tester':
      return 'test'
    case 'researcher':
      return 'research'
    case 'reviewer':
      return 'review'
    case 'supervisor':
      return 'coordination'
    default:
      return 'unknown'
  }
}

/**
 * Whether a task of this kind must pass the project verification gate before
 * completion. `projectHasChecks` is true when `project.verification` is non-empty.
 * Research, review and coordination work never requires the project suite even
 * when checks exist; implementation, test and unknown work does.
 */
export function verificationRequired(kind: TaskKind, projectHasChecks: boolean): boolean {
  if (!projectHasChecks) return false
  return kind === 'implementation' || kind === 'test' || kind === 'unknown'
}

export function verificationRequiredForTask(task: TaskRecord, projectHasChecks: boolean): boolean {
  return verificationRequired(taskKind(task), projectHasChecks)
}

/**
 * Classify a task's durable verification state into one of the reporting
 * statuses. This is a read-only classification over store rows; it never mutates.
 */
export function verificationStatus(
  store: Store,
  task: TaskRecord,
  projectHasChecks: boolean,
): VerificationStatus {
  const kind = taskKind(task)
  const required = verificationRequired(kind, projectHasChecks)

  if (task.state === 'unknown_outcome') return 'UNKNOWN'
  if (task.state === 'failed' || task.state === 'cancelled' || task.state === 'interrupted') {
    return 'FAILED'
  }
  if (!required) return 'NOT_REQUIRED'

  if (task.state !== 'verifying' && task.state !== 'completed') {
    // Work not finished yet, or blocked behind dependencies.
    return 'PENDING'
  }

  const checks = store.listCurrentVerificationChecksByTaskAttempt(task.id, task.attempt)
  if (checks.length === 0) {
    // Required verification was expected but no evidence row exists.
    return task.state === 'completed' ? 'PASSED' : 'BLOCKED'
  }
  if (checks.some((c) => c.status === 'pending')) return 'RUNNING'
  if (checks.some((c) => c.status !== 'passed')) return 'FAILED'

  const verification = store.getTaskVerification(task.id)
  if (verification === null) {
    // Evidence is green but no verdict was ever recorded (e.g. legacy row).
    return task.state === 'completed' ? 'PASSED' : 'BLOCKED'
  }
  if (verification.verdict === 'verified') return 'PASSED'
  return 'FAILED'
}
