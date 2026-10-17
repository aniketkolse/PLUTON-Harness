import { StateTransitionError, ValidationError } from './errors.ts'

export type PlanState =
  | 'DRAFT'
  | 'REVIEW'
  | 'APPROVED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export interface PlanTask {
  id: string
  title: string
  description: string
  assigneeRole: string
  dependsOn: string[]
  acceptanceCriteria: string[]
}

export interface PlanRecord {
  id: string
  projectId: string
  sessionId: string
  goal: string
  state: PlanState
  tasks: PlanTask[]
  runId: string | null
  createdAt: string
  updatedAt: string
}

export const VALID_PLAN_TRANSITIONS: Record<PlanState, readonly PlanState[]> = {
  DRAFT: ['REVIEW', 'CANCELLED'],
  REVIEW: ['DRAFT', 'APPROVED', 'CANCELLED'],
  APPROVED: ['DRAFT', 'RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: ['DRAFT'],
}

export function canTransitionPlan(current: PlanState, next: PlanState): boolean {
  if (current === next) return true
  const allowed = VALID_PLAN_TRANSITIONS[current] ?? []
  return allowed.includes(next)
}

export function transitionPlanState(current: PlanState, next: PlanState): PlanState {
  if (!canTransitionPlan(current, next)) {
    throw new StateTransitionError(current, next, 'plan')
  }
  return next
}

export interface PlanValidationResult {
  valid: boolean
  errors: string[]
}

export function validatePlanTasks(tasks: PlanTask[]): PlanValidationResult {
  const errors: string[] = []
  const seenIds = new Set<string>()

  for (const task of tasks) {
    if (!task.id || task.id.trim() === '') {
      errors.push('task id cannot be empty')
    } else if (seenIds.has(task.id)) {
      errors.push(`duplicate task id: ${task.id}`)
    } else {
      seenIds.add(task.id)
    }

    if (!task.title || task.title.trim() === '') {
      errors.push(`task ${task.id || '<unknown>'}: title cannot be empty`)
    }

    if (!task.acceptanceCriteria || task.acceptanceCriteria.length === 0) {
      errors.push(`task ${task.id || '<unknown>'}: must have at least one acceptance criterion`)
    }
  }

  // Check dependencies exist and are not self-dependencies
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      if (depId === task.id) {
        errors.push(`task ${task.id} cannot depend on itself`)
      } else if (!seenIds.has(depId)) {
        errors.push(`task ${task.id} has unknown dependency: ${depId}`)
      }
    }
  }

  // Check for cycles using DFS cycle detection
  if (errors.length === 0) {
    const adj = new Map<string, string[]>()
    for (const task of tasks) {
      adj.set(task.id, task.dependsOn)
    }

    // 0 = unvisited, 1 = visiting (on current path), 2 = visited
    const state = new Map<string, number>()
    for (const task of tasks) {
      state.set(task.id, 0)
    }

    function hasCycle(node: string): boolean {
      state.set(node, 1)
      const deps = adj.get(node) ?? []
      for (const dep of deps) {
        const depState = state.get(dep) ?? 0
        if (depState === 1) {
          return true
        }
        if (depState === 0 && hasCycle(dep)) {
          return true
        }
      }
      state.set(node, 2)
      return false
    }

    for (const task of tasks) {
      if ((state.get(task.id) ?? 0) === 0) {
        if (hasCycle(task.id)) {
          errors.push('plan tasks contain a dependency cycle')
          break
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
