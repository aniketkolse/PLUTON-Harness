import type { EventRecord, RunRecord, TaskEdgeRecord, TaskRecord } from '../../domain/models.ts'
import { NotFoundError, ValidationError } from '../../domain/errors.ts'
import type { Store } from '../../store/store.ts'

export interface RunSummary {
  run: RunRecord
  taskCounts: Record<string, number>
  totalTasks: number
}

export function summarizeRun(store: Store, run: RunRecord): RunSummary {
  const tasks = store.listTasks(run.id)
  const taskCounts: Record<string, number> = {}
  for (const t of tasks) taskCounts[t.state] = (taskCounts[t.state] ?? 0) + 1
  return { run, taskCounts, totalTasks: tasks.length }
}

export function statusRuns(store: Store, limit: number): RunSummary[] {
  return store.listRuns(limit).map((run) => summarizeRun(store, run))
}

export function runDetail(
  store: Store,
  runId: string,
  eventLimit = 10,
): { summary: RunSummary; recentEvents: EventRecord[] } {
  const run = store.getRun(runId)
  const events = store
    .eventsSince(run.projectId, 0, 1000)
    .filter((e) => e.runId === runId)
    .slice(-eventLimit)
  return { summary: summarizeRun(store, run), recentEvents: events }
}

export function taskListHuman(tasks: TaskRecord[]): string {
  if (tasks.length === 0) return 'no tasks'
  const rows: string[][] = [['ID', 'STATE', 'DEPTH', 'PARENT', 'ASSIGNEE', 'TITLE']]
  for (const t of tasks) {
    rows.push([
      t.id.slice(-8),
      t.state,
      String(t.depth),
      t.parentTaskId ? t.parentTaskId.slice(-8) : '-',
      t.assigneeMuseId ?? '-',
      t.title.length > 60 ? `${t.title.slice(0, 57)}...` : t.title,
    ])
  }
  return rows.map((r) => r.join('  ')).join('\n')
}

export function runByRef(store: Store, runIdOrSuffix: string): RunRecord {
  const exact = store.getRunOrNull(runIdOrSuffix)
  if (exact) return exact
  const matches = store.listRuns(500).filter((r) => r.id.endsWith(runIdOrSuffix))
  if (matches.length === 1) return matches[0] as RunRecord
  if (matches.length === 0) throw new NotFoundError('run', runIdOrSuffix)
  throw new ValidationError(`ambiguous run id: ${matches.length} runs end with '${runIdOrSuffix}'; use the full id`)
}

export function taskById(store: Store, taskIdOrSuffix: string): TaskRecord {
  const exact = store.getTaskOrNull(taskIdOrSuffix)
  if (exact) return exact
  // Allow suffix lookup (short ids shown in tables), but only when unambiguous.
  const suffixMatches: TaskRecord[] = []
  for (const run of store.listRuns(500)) {
    for (const t of store.listTasks(run.id)) {
      if (t.id.endsWith(taskIdOrSuffix)) suffixMatches.push(t)
    }
  }
  if (suffixMatches.length === 1) return suffixMatches[0] as TaskRecord
  if (suffixMatches.length === 0) throw new NotFoundError('task', taskIdOrSuffix)
  throw new ValidationError(`ambiguous task id: ${suffixMatches.length} tasks end with '${taskIdOrSuffix}'; use the full id`)
}

export interface GraphView {
  tasks: TaskRecord[]
  edges: TaskEdgeRecord[]
  roots: TaskRecord[]
}

export function graphView(store: Store, runId: string): GraphView {
  const tasks = store.listTasks(runId)
  const edges = store.listEdges(runId)
  return { tasks, edges, roots: tasks.filter((t) => t.parentTaskId === null) }
}

export function graphHuman(view: GraphView): string {
  if (view.tasks.length === 0) return 'no tasks in this run'
  const byParent = new Map<string | null, TaskRecord[]>()
  for (const t of view.tasks) {
    const list = byParent.get(t.parentTaskId) ?? []
    list.push(t)
    byParent.set(t.parentTaskId, list)
  }
  const lines: string[] = []
  const walk = (parentId: string | null, indent: number): void => {
    for (const t of byParent.get(parentId) ?? []) {
      lines.push(`${'  '.repeat(indent)}- [${t.state}] ${t.id.slice(-8)} ${t.title} (${t.assigneeMuseId ?? 'unassigned'})`)
      walk(t.id, indent + 1)
    }
  }
  walk(null, 0)
  const deps = view.edges.filter((e) => e.kind === 'depends_on')
  if (deps.length > 0) {
    lines.push('')
    lines.push('depends_on:')
    for (const e of deps) {
      lines.push(`  ${e.fromTaskId.slice(-8)} -> ${e.toTaskId.slice(-8)}`)
    }
  }
  return lines.join('\n')
}

export function runLine(run: RunRecord): string {
  const when = run.createdAt.slice(0, 19).replace('T', ' ')
  const goal = run.goal.length > 70 ? `${run.goal.slice(0, 67)}...` : run.goal
  return `${run.id.slice(-8)}  ${run.state.padEnd(17)}  ${when}  ${goal}`
}
