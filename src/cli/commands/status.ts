import { existsSync } from 'node:fs'
import type { EventRecord, RunRecord, TaskEdgeRecord, TaskRecord } from '../../domain/models.ts'
import { NotFoundError, ValidationError } from '../../domain/errors.ts'
import { recentEvents } from '../../store/query.ts'
import type { Store } from '../../store/store.ts'
import { getProjectRegistry } from '../../projects/registry.ts'
import { loadConfig } from '../../config/load.ts'
import { bootstrapStore } from '../../bootstrap.ts'

export interface RunSummary {
  run: RunRecord
  taskCounts: Record<string, number>
  totalTasks: number
}

export interface ProjectRunSummary extends RunSummary {
  projectName: string
  projectId: string
}

export function statusAllProjects(customHome?: string, limitPerProject = 10): ProjectRunSummary[] {
  const reg = getProjectRegistry(customHome)
  const summaries: ProjectRunSummary[] = []
  for (const entry of Object.values(reg.projects)) {
    if (!existsSync(entry.rootDir)) continue
    try {
      const loaded = loadConfig(entry.rootDir)
      const { store } = bootstrapStore(loaded)
      try {
        const runs = store.listRuns(limitPerProject).map((run) => ({
          ...summarizeRun(store, run),
          projectName: entry.name,
          projectId: entry.id,
        }))
        summaries.push(...runs)
      } finally {
        store.close()
      }
    } catch {
      // Ignore config/load errors on individual projects
    }
  }
  summaries.sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))
  return summaries
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
  const events = recentEvents(store, { projectId: run.projectId, runId, limit: eventLimit })
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
      t.assigneeShipId ?? t.assigneeMuseId ?? '-',
      t.title.length > 60 ? `${t.title.slice(0, 57)}...` : t.title,
    ])
  }
  return rows.map((r) => r.join('  ')).join('\n')
}

export { runByRef, taskById } from '../../orchestrator/service.ts'

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
      lines.push(`${'  '.repeat(indent)}- [${t.state}] ${t.id.slice(-8)} ${t.title} (${t.assigneeShipId ?? t.assigneeMuseId ?? 'unassigned'})`)
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
