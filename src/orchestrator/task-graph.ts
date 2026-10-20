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
  id?: string
  runId: string
  parentTaskId: string | null
  title: string
  brief: string
  acceptanceCriteria: string[]
  assigneeMuseId: string | null
  writeScope?: string[]
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
      id: req.id,
      runId: req.runId,
      parentTaskId: req.parentTaskId,
      title: req.title,
      brief: req.brief,
      acceptanceCriteria: req.acceptanceCriteria,
      assigneeMuseId: req.assigneeMuseId,
      writeScope: req.writeScope,
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

export interface TaskGraphNodeOptions {
  role?: string
  state?: string
  assigneeMuseId?: string | null
  [key: string]: unknown
}

export interface TaskGraphNode {
  id: string
  role?: string
  state: string
  metadata: Record<string, unknown>
}

function isWaitingState(state: string): boolean {
  return (
    state === 'waiting' ||
    state === 'needs_input' ||
    state === 'needs_approval' ||
    state === 'waiting_for_children' ||
    state === 'awaiting_input' ||
    state === 'awaiting_approval' ||
    state.includes('wait') ||
    state.startsWith('needs_')
  )
}

/**
 * Pure evaluation helper: checks if a task is blocked because any of its direct or
 * transitive dependencies in `tasks` is in a waiting state (e.g. 'waiting', 'needs_approval', 'needs_input').
 *
 * In Pluton's canonical domain model, `fromTaskId` is the dependent task and `toTaskId` is the dependency
 * (edge semantics: `from` depends on `to`). If edges are supplied in inverted order (`to` depends on `from`),
 * this helper adapts accordingly.
 */
export function isTaskBlockedOnWaiting(
  taskId: string,
  tasks: Map<string, TaskRecord>,
  edges: TaskEdgeRecord[],
): boolean {
  const hasCanonical = edges.some((e) => e.fromTaskId === taskId)
  const hasInverted = !hasCanonical && edges.some((e) => e.toTaskId === taskId)

  const getPrerequisites = (currentId: string): string[] => {
    if (hasInverted) {
      return edges.filter((e) => e.toTaskId === currentId).map((e) => e.fromTaskId)
    }
    return edges.filter((e) => e.fromTaskId === currentId).map((e) => e.toTaskId)
  }

  const seen = new Set<string>()
  const queue = [...getPrerequisites(taskId)]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)

    const task = tasks.get(current)
    if (task && isWaitingState(task.state)) {
      return true
    }

    for (const prereq of getPrerequisites(current)) {
      if (!seen.has(prereq)) {
        queue.push(prereq)
      }
    }
  }

  return false
}

/**
 * In-memory Task Graph representation for DAG dependency evaluation, selective pausing,
 * and dispatch readiness calculation.
 */
export class TaskGraph {
  private nodes = new Map<string, TaskGraphNode>()
  private dependencies = new Map<string, Set<string>>() // dependent -> upstream dependencies
  private dependents = new Map<string, Set<string>>() // upstream dependency -> downstream dependents

  addTask(id: string, options: TaskGraphNodeOptions = {}): void {
    const { role, state = 'pending', ...rest } = options
    const existing = this.nodes.get(id)
    if (existing) {
      if (role !== undefined) existing.role = role
      if (state !== undefined) existing.state = String(state)
      existing.metadata = { ...existing.metadata, ...rest }
    } else {
      this.nodes.set(id, {
        id,
        role,
        state: String(state),
        metadata: rest,
      })
    }
    if (!this.dependencies.has(id)) {
      this.dependencies.set(id, new Set())
    }
    if (!this.dependents.has(id)) {
      this.dependents.set(id, new Set())
    }
  }

  getTask(id: string): TaskGraphNode | undefined {
    return this.nodes.get(id)
  }

  hasTask(id: string): boolean {
    return this.nodes.has(id)
  }

  setTaskState(id: string, state: string): void {
    const node = this.nodes.get(id)
    if (node) {
      node.state = state
    }
  }

  /**
   * Adds an edge from upstream (dependency / prerequisite) to downstream (dependent).
   * e.g. addEdge('task-qa', 'task-coder') indicates task-coder depends on task-qa.
   */
  addEdge(fromTaskId: string, toTaskId: string): void {
    if (!this.nodes.has(fromTaskId)) {
      this.addTask(fromTaskId)
    }
    if (!this.nodes.has(toTaskId)) {
      this.addTask(toTaskId)
    }

    if (!this.dependents.has(fromTaskId)) {
      this.dependents.set(fromTaskId, new Set())
    }
    this.dependents.get(fromTaskId)!.add(toTaskId)

    if (!this.dependencies.has(toTaskId)) {
      this.dependencies.set(toTaskId, new Set())
    }
    this.dependencies.get(toTaskId)!.add(fromTaskId)
  }

  getDependencies(taskId: string): string[] {
    return Array.from(this.dependencies.get(taskId) ?? [])
  }

  getDependents(taskId: string): string[] {
    return Array.from(this.dependents.get(taskId) ?? [])
  }

  /**
   * Returns all tasks that transitively depend on the given taskId (downstream tasks).
   */
  getTransitiveDependents(taskId: string): string[] {
    const result: string[] = []
    const seen = new Set<string>()
    const queue = Array.from(this.dependents.get(taskId) ?? [])

    while (queue.length > 0) {
      const nextId = queue.shift()!
      if (seen.has(nextId)) continue
      seen.add(nextId)
      result.push(nextId)
      for (const child of this.dependents.get(nextId) ?? []) {
        if (!seen.has(child)) {
          queue.push(child)
        }
      }
    }

    return result
  }

  /**
   * Returns all tasks that taskId directly or transitively depends on (upstream tasks).
   */
  getTransitiveDependencies(taskId: string): string[] {
    const result: string[] = []
    const seen = new Set<string>()
    const queue = Array.from(this.dependencies.get(taskId) ?? [])

    while (queue.length > 0) {
      const nextId = queue.shift()!
      if (seen.has(nextId)) continue
      seen.add(nextId)
      result.push(nextId)
      for (const parent of this.dependencies.get(nextId) ?? []) {
        if (!seen.has(parent)) {
          queue.push(parent)
        }
      }
    }

    return result
  }

  /**
   * Returns tasks that are eligible to be dispatched.
   * A task is ready if:
   * 1. Its state is 'pending' or 'queued'.
   * 2. All of its direct dependencies have state 'completed'.
   */
  getReadyTasks(): string[] {
    const ready: string[] = []
    for (const [id, node] of this.nodes) {
      if (node.state !== 'pending' && node.state !== 'queued') {
        continue
      }
      const deps = this.dependencies.get(id)
      let allDepsCompleted = true
      if (deps && deps.size > 0) {
        for (const depId of deps) {
          const dep = this.nodes.get(depId)
          if (!dep || dep.state !== 'completed') {
            allDepsCompleted = false
            break
          }
        }
      }
      if (allDepsCompleted) {
        ready.push(id)
      }
    }
    return ready
  }

  /**
   * Returns true if taskId depends directly or transitively on any task in a waiting state.
   */
  isTaskBlockedOnWaiting(taskId: string): boolean {
    const seen = new Set<string>()
    const queue = Array.from(this.dependencies.get(taskId) ?? [])

    while (queue.length > 0) {
      const current = queue.shift()!
      if (seen.has(current)) continue
      seen.add(current)

      const dep = this.nodes.get(current)
      if (dep && isWaitingState(dep.state)) {
        return true
      }

      for (const parent of this.dependencies.get(current) ?? []) {
        if (!seen.has(parent)) {
          queue.push(parent)
        }
      }
    }

    return false
  }
}
