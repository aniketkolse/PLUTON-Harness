import { StateTransitionError, ValidationError } from '../domain/errors.ts'
import {
  type PlanRecord,
  type PlanState,
  type PlanTask,
  transitionPlanState,
  validatePlanTasks,
} from '../domain/plan.ts'
import type { Store } from '../store/store.ts'

export class PlanManager {
  private readonly store: Store
  private readonly projectId: string
  private readonly sessionId: string

  constructor(
    store: Store,
    projectId: string,
    sessionId: string,
  ) {
    this.store = store
    this.projectId = projectId
    this.sessionId = sessionId
  }

  getCurrentPlan(): PlanRecord | null {
    return this.store.getLatestPlanForSession(this.sessionId)
  }

  getPlan(planId: string): PlanRecord {
    return this.store.getPlan(planId)
  }

  createPlanDraft(goal: string, options?: { tasks?: PlanTask[] }): PlanRecord {
    const tasks = options?.tasks ?? []
    if (tasks.length > 0) {
      const validation = validatePlanTasks(tasks)
      if (!validation.valid) {
        throw new ValidationError(`invalid plan tasks: ${validation.errors.join('; ')}`)
      }
    }
    return this.store.createPlan({
      projectId: this.projectId,
      sessionId: this.sessionId,
      goal,
      tasks,
      state: 'DRAFT',
    })
  }

  setGoal(planId: string, goal: string): PlanRecord {
    const trimmed = goal.trim()
    if (!trimmed) throw new ValidationError('goal cannot be empty')
    return this.store.updatePlan(planId, { goal: trimmed })
  }

  addTask(planId: string, task: PlanTask): PlanRecord {
    const current = this.getPlan(planId)
    const newTasks = [...current.tasks, task]
    const validation = validatePlanTasks(newTasks)
    if (!validation.valid) {
      throw new ValidationError(`cannot add task: ${validation.errors.join('; ')}`)
    }
    return this.store.updatePlan(planId, { tasks: newTasks })
  }

  removeTask(planId: string, taskId: string): PlanRecord {
    const current = this.getPlan(planId)
    const existing = current.tasks.find((t) => t.id === taskId)
    if (!existing) {
      throw new ValidationError(`task '${taskId}' not found in plan`)
    }

    const dependents = current.tasks.filter((t) => t.dependsOn.includes(taskId))
    if (dependents.length > 0) {
      const depIds = dependents.map((d) => d.id).join(', ')
      throw new ValidationError(
        `cannot remove task '${taskId}': tasks [${depIds}] depend on it. Remove or edit them first.`,
      )
    }

    const newTasks = current.tasks.filter((t) => t.id !== taskId)
    return this.store.updatePlan(planId, { tasks: newTasks })
  }

  editTask(planId: string, taskId: string, patch: Partial<PlanTask>): PlanRecord {
    const current = this.getPlan(planId)
    const index = current.tasks.findIndex((t) => t.id === taskId)
    if (index === -1) {
      throw new ValidationError(`task '${taskId}' not found in plan`)
    }

    const updatedTask: PlanTask = {
      ...current.tasks[index]!,
      ...patch,
      id: taskId, // ID cannot be mutated via patch
    }

    const newTasks = [...current.tasks]
    newTasks[index] = updatedTask

    const validation = validatePlanTasks(newTasks)
    if (!validation.valid) {
      throw new ValidationError(`cannot update task: ${validation.errors.join('; ')}`)
    }

    return this.store.updatePlan(planId, { tasks: newTasks })
  }

  reorderTasks(planId: string, taskIds: string[]): PlanRecord {
    const current = this.getPlan(planId)
    if (taskIds.length !== current.tasks.length) {
      throw new ValidationError('reordered task list must contain all existing tasks')
    }
    const taskMap = new Map(current.tasks.map((t) => [t.id, t]))
    const newTasks: PlanTask[] = []
    for (const id of taskIds) {
      const t = taskMap.get(id)
      if (!t) throw new ValidationError(`unknown task id in reorder list: ${id}`)
      newTasks.push(t)
    }
    const validation = validatePlanTasks(newTasks)
    if (!validation.valid) {
      throw new ValidationError(`invalid reordering: ${validation.errors.join('; ')}`)
    }
    return this.store.updatePlan(planId, { tasks: newTasks })
  }

  reviewPlan(planId: string): PlanRecord {
    const current = this.getPlan(planId)
    if (current.tasks.length === 0) {
      throw new ValidationError('cannot review an empty plan with no tasks')
    }
    const validation = validatePlanTasks(current.tasks)
    if (!validation.valid) {
      throw new ValidationError(`cannot review invalid plan: ${validation.errors.join('; ')}`)
    }
    return this.store.updatePlan(planId, { state: 'REVIEW' })
  }

  approvePlan(planId: string): PlanRecord {
    const current = this.getPlan(planId)
    if (current.state !== 'REVIEW') {
      throw new StateTransitionError(current.state, 'APPROVED', 'plan')
    }
    const validation = validatePlanTasks(current.tasks)
    if (!validation.valid) {
      throw new ValidationError(`cannot approve invalid plan: ${validation.errors.join('; ')}`)
    }
    return this.store.updatePlan(planId, { state: 'APPROVED' })
  }

  cancelPlan(planId: string): PlanRecord {
    return this.store.updatePlan(planId, { state: 'CANCELLED' })
  }

  async executePlan(
    planId: string,
    executeFn: (plan: PlanRecord) => Promise<string>,
  ): Promise<PlanRecord> {
    const current = this.getPlan(planId)
    if (current.state !== 'APPROVED') {
      throw new StateTransitionError(current.state, 'RUNNING', 'plan')
    }
    const validation = validatePlanTasks(current.tasks)
    if (!validation.valid) {
      throw new ValidationError(`cannot execute invalid plan: ${validation.errors.join('; ')}`)
    }

    const runId = await executeFn(current)
    return this.store.updatePlan(planId, {
      state: 'RUNNING',
      runId,
    })
  }
}
