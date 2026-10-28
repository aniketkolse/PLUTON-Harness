import type { TaskEdgeRecord, TaskRecord } from './models.ts'

/**
 * Pure task-graph checks shared by admission and import validation.
 *
 * `wouldCreateDependencyCycle` is used before inserting a `depends_on` edge;
 * `wouldCreateAncestorCycle` is used before setting a parent. Both are pure so
 * callers can validate an entire export before writing anything.
 */

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
