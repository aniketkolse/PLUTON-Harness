import { PolicyDeniedError, ValidationError } from '../domain/errors.ts'
import type { TaskEdgeRecord, TaskRecord } from '../domain/models.ts'
import { withTx } from '../store/db.ts'
import type { NewTaskSpec, Store } from '../store/store.ts'

/**
 * Task-graph admission (prompt §6): every new task is validated against the
 * run budget and the existing graph BEFORE it is written, inside the same
 * transaction as the task row, its dependency edges and its event.
 *
 * Rejected here: depth overflow, fan-out overflow, run size overflow, deps on
 * tasks from another run, duplicates, self-deps, and dependency cycles.
 */
export interface AdmitTaskRequest {
  runId: string
  parentTaskId: string | null
  title: string
  brief: string
  acceptanceCriteria: string[]
  assigneeMuseId: string | null
  /** Tasks that must reach `completed` before this task becomes ready. */
  dependsOn?: string[]
}

export interface AdmitTaskLimits {
  /** runtime.max_child_tasks_per_task */
  maxChildrenPerTask: number
  /** runtime.max_prompt_chars or similar bound for the brief; caller may skip. */
  maxBriefChars?: number
}

export function admitTask(store: Store, req: AdmitTaskRequest, limits: AdmitTaskLimits): TaskRecord {
  return withTx(store.db, () => {
    const run = store.getRun(req.runId)
    if (run.state !== 'created' && run.state !== 'active' && run.state !== 'awaiting_approval' && run.state !== 'awaiting_input') {
      throw new PolicyDeniedError(`run ${run.id} is ${run.state}; new tasks cannot be admitted`)
    }
    if (limits.maxBriefChars !== undefined && req.brief.length > limits.maxBriefChars) {
      throw new ValidationError(
        `task brief is ${req.brief.length} chars, above the limit of ${limits.maxBriefChars}`,
      )
    }

    const parent = req.parentTaskId ? store.getTask(req.parentTaskId) : null
    if (req.parentTaskId && !parent) throw new ValidationError(`parent task ${req.parentTaskId} does not exist`)
    if (parent && parent.runId !== req.runId) {
      throw new ValidationError(`parent task ${parent.id} belongs to run ${parent.runId}, not ${req.runId}`)
    }

    const depth = parent ? parent.depth + 1 : 0
    if (depth > run.budget.maxDelegationDepth) {
      throw new PolicyDeniedError(
        `delegation depth ${depth} exceeds max_delegation_depth ${run.budget.maxDelegationDepth} for run ${run.id}`,
      )
    }
    if (parent && store.childCount(parent.id) >= limits.maxChildrenPerTask) {
      throw new PolicyDeniedError(
        `task ${parent.id} already has ${limits.maxChildrenPerTask} children (max_child_tasks_per_task)`,
      )
    }
    const existing = store.listTasks(req.runId)
    if (existing.length >= run.budget.maxTasks) {
      throw new PolicyDeniedError(`run ${run.id} reached max_tasks (${run.budget.maxTasks})`)
    }

    const deps = req.dependsOn ?? []
    const uniqueDeps = new Set(deps)
    if (uniqueDeps.size !== deps.length) throw new ValidationError('dependsOn contains duplicate task ids')
    for (const depId of deps) {
      const dep = store.getTask(depId)
      if (dep.runId !== req.runId) {
        throw new ValidationError(`dependency ${depId} belongs to run ${dep.runId}, not ${req.runId}`)
      }
    }

    const edges = store.listEdges(req.runId)

    // Create first (a fresh id can't close a cycle), then verify each edge would
    // not introduce one before inserting it — belt and braces for future
    // edge-adding APIs that reuse this validator.
    const task = store.createTask({
      runId: req.runId,
      parentTaskId: req.parentTaskId,
      title: req.title,
      brief: req.brief,
      acceptanceCriteria: req.acceptanceCriteria,
      assigneeMuseId: req.assigneeMuseId,
    } satisfies NewTaskSpec)

    for (const depId of deps) {
      if (depId === task.id) throw new ValidationError('task cannot depend on itself')
      if (wouldCreateDependencyCycle(edges, task.id, depId)) {
        throw new PolicyDeniedError(`dependency ${task.id} -> ${depId} would create a cycle`)
      }
      store.addEdge(req.runId, task.id, depId, 'depends_on')
    }

    store.appendEvent({
      projectId: run.projectId,
      runId: req.runId,
      taskId: task.id,
      museId: req.assigneeMuseId,
      type: 'task.admitted',
      payload: {
        title: req.title,
        parentTaskId: req.parentTaskId,
        depth,
        dependsOn: deps,
        assigneeMuseId: req.assigneeMuseId,
      },
    })

    store.setTaskState(task.id, 'queued')
    return store.getTask(task.id)
  })
}

/**
 * Pure cycle check for `depends_on` edges. Edge semantics: `from` depends on
 * `to`. Adding from→to is safe unless `to` already (transitively) depends on
 * `from`, or from === to.
 */
export function wouldCreateDependencyCycle(
  edges: TaskEdgeRecord[],
  fromTaskId: string,
  toTaskId: string,
): boolean {
  if (fromTaskId === toTaskId) return true
  const next = new Map<string, string[]>()
  for (const e of edges) {
    const list = next.get(e.fromTaskId) ?? []
    list.push(e.toTaskId)
    next.set(e.fromTaskId, list)
  }
  const seen = new Set<string>()
  const stack = [toTaskId]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (current === fromTaskId) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const n of next.get(current) ?? []) stack.push(n)
  }
  return false
}

/**
 * Pure ancestor check: reparenting `taskId` under `newParentId` is a cycle when
 * `taskId` is found walking up from `newParentId`. Used to reject
 * ancestor-delegation attempts (a task may never become its own descendant).
 */
export function wouldCreateAncestorCycle(
  tasks: Pick<TaskRecord, 'id' | 'parentTaskId'>[],
  taskId: string,
  newParentId: string,
): boolean {
  if (taskId === newParentId) return true
  const byId = new Map(tasks.map((t) => [t.id, t]))
  let current: string | null = newParentId
  const seen = new Set<string>()
  while (current) {
    if (current === taskId) return true
    if (seen.has(current)) return true // pre-existing corruption: treat as cycle
    seen.add(current)
    current = byId.get(current)?.parentTaskId ?? null
  }
  return false
}
