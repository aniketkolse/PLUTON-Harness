import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { admitTask, wouldCreateAncestorCycle, wouldCreateDependencyCycle } from '../../src/orchestrator/task-graph.ts'
import { PolicyDeniedError, ValidationError } from '../../src/domain/errors.ts'
import type { RunBudget, RunRecord, TaskEdgeRecord, TaskRecord } from '../../src/domain/models.ts'

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStore(): { store: Store; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-graph-'))
  tmpDirs.push(dir)
  const db = openDatabase(join(dir, 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'graph-test',
    rootPath: dir,
    configPath: join(dir, 'pluton.yaml'),
    defaultBranch: 'main',
  })
  const projectId = project.id
  store.syncMuses(projectId, [
    {
      id: 'worker-a',
      slug: 'worker-a',
      displayName: 'Worker A',
      role: 'coder',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: [],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/worker-a',
    },
    {
      id: 'worker-b',
      slug: 'worker-b',
      displayName: 'Worker B',
      role: 'coder',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: [],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/worker-b',
    },
  ])
  return { store, projectId }
}

const LIMITS = { maxChildrenPerTask: 2 }

function makeRun(store: Store, projectId: string, budgetOverrides: Partial<RunBudget> = {}): RunRecord {
  return store.createRun({
    projectId,
    goal: 'graph goal',
    origin: 'cli',
    requestedBy: 'tester',
    acceptanceCriteria: [],
    managerMuseId: 'worker-a',
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 5,
      maxDelegationDepth: 2,
      maxRunMinutes: 60,
      defaultTaskMinutes: 10,
      ...budgetOverrides,
    },
  })
}

function admit(store: Store, runId: string, over: Partial<Parameters<typeof admitTask>[1]> = {}): TaskRecord {
  return admitTask(
    store,
    {
      runId,
      parentTaskId: null,
      title: 'task',
      brief: 'do something',
      acceptanceCriteria: ['done'],
      assigneeMuseId: 'worker-a',
      ...over,
    },
    LIMITS,
  )
}

describe('admitTask', () => {
  it('admits a root task as queued with an audit event', () => {
    const { store, projectId } = makeStore()
    const run = makeRun(store, projectId)
    const task = admit(store, run.id)
    expect(task.state).toBe('queued')
    expect(task.depth).toBe(0)
    expect(task.rootTaskId).toBe(task.id)
    const events = store.eventsSince(projectId, 0).filter((e) => e.type === 'task.admitted')
    expect(events.length).toBe(1)
    expect(events[0]?.taskId).toBe(task.id)
  })

  it('rejects depth beyond max_delegation_depth', () => {
    const { store, projectId } = makeStore()
    const run = makeRun(store, projectId, { maxDelegationDepth: 1 })
    const root = admit(store, run.id)
    const child = admit(store, run.id, { parentTaskId: root.id })
    expect(child.depth).toBe(1)
    expect(() => admit(store, run.id, { parentTaskId: child.id })).toThrow(PolicyDeniedError)
  })

  it('rejects fan-out beyond max_child_tasks_per_task', () => {
    const { store, projectId } = makeStore()
    const run = makeRun(store, projectId)
    const root = admit(store, run.id)
    admit(store, run.id, { parentTaskId: root.id, title: 'c1' })
    admit(store, run.id, { parentTaskId: root.id, title: 'c2' })
    expect(() => admit(store, run.id, { parentTaskId: root.id, title: 'c3' })).toThrow(PolicyDeniedError)
  })

  it('rejects admission beyond max_tasks for the run', () => {
    const { store, projectId } = makeStore()
    const run = makeRun(store, projectId, { maxTasks: 2 })
    admit(store, run.id, { title: 'a' })
    admit(store, run.id, { title: 'b' })
    expect(() => admit(store, run.id, { title: 'c' })).toThrow(PolicyDeniedError)
  })

  it('rejects duplicate deps, unknown deps and cross-run deps', () => {
    const { store, projectId } = makeStore()
    const runA = makeRun(store, projectId)
    const runB = makeRun(store, projectId)
    const inB = admit(store, runB.id)
    const t1 = admit(store, runA.id, { title: 'one' })
    expect(() => admit(store, runA.id, { title: 'dup', dependsOn: [t1.id, t1.id] })).toThrow(ValidationError)
    expect(() => admit(store, runA.id, { title: 'ghost', dependsOn: ['task_missing'] })).toThrow()
    expect(() => admit(store, runA.id, { title: 'cross', dependsOn: [inB.id] })).toThrow(ValidationError)
  })

  it('gates readiness on dependency completion', () => {
    const { store, projectId } = makeStore()
    const run = makeRun(store, projectId)
    const dep = admit(store, run.id, { title: 'dep' })
    const blocked = admit(store, run.id, { title: 'blocked', dependsOn: [dep.id] })
    let ready = store.listReadyTasks(run.id)
    expect(ready.map((t) => t.id)).toEqual([dep.id])

    store.setTaskState(dep.id, 'admitted')
    store.setTaskState(dep.id, 'running')
    store.setTaskState(dep.id, 'completed', { result: { ok: true } })
    // `dep` is completed (so not 'queued' anymore); `blocked` becomes ready.
    ready = store.listReadyTasks(run.id)
    expect(ready.map((t) => t.id)).toEqual([blocked.id])
  })

  it('refuses to admit tasks into a completed run', () => {
    const { store, projectId } = makeStore()
    const run = makeRun(store, projectId)
    store.setRunState(run.id, 'active')
    store.setRunState(run.id, 'completed')
    expect(() => admit(store, run.id)).toThrow(PolicyDeniedError)
  })
})

describe('graph validators (pure)', () => {
  it('detects dependency cycles in both directions', () => {
    const edges: TaskEdgeRecord[] = [
      { runId: 'r', fromTaskId: 'A', toTaskId: 'B', kind: 'depends_on' },
      { runId: 'r', fromTaskId: 'B', toTaskId: 'C', kind: 'depends_on' },
    ]
    expect(wouldCreateDependencyCycle(edges, 'C', 'A')).toBe(true)
    expect(wouldCreateDependencyCycle(edges, 'A', 'C')).toBe(false)
    expect(wouldCreateDependencyCycle(edges, 'A', 'A')).toBe(true)
    expect(wouldCreateDependencyCycle([], 'A', 'B')).toBe(false)
  })

  it('detects ancestor cycles for reparenting attempts', () => {
    const tasks: Pick<TaskRecord, 'id' | 'parentTaskId'>[] = [
      { id: 'A', parentTaskId: null },
      { id: 'B', parentTaskId: 'A' },
      { id: 'C', parentTaskId: 'B' },
      { id: 'D', parentTaskId: null },
    ]
    expect(wouldCreateAncestorCycle(tasks, 'A', 'C')).toBe(true) // A under its own descendant
    expect(wouldCreateAncestorCycle(tasks, 'C', 'D')).toBe(false)
    expect(wouldCreateAncestorCycle(tasks, 'A', 'A')).toBe(true)
  })
})
