import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { TaskGraph, isTaskBlockedOnWaiting } from '../../src/orchestrator/task-graph.ts'
import type { TaskEdgeRecord, TaskRecord } from '../../src/domain/models.ts'

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
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeStore(): { store: Store; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-sel-pause-'))
  tmpDirs.push(dir)
  const db = openDatabase(join(dir, 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'selective-pause-test',
    rootPath: dir,
    configPath: join(dir, 'pluton.yaml'),
    defaultBranch: 'main',
  })
  store.syncMuses(project.id, [
    {
      id: 'manager-muse',
      slug: 'manager',
      displayName: 'Manager',
      role: 'manager',
      engineKind: 'mock',
      model: 'mock/model',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: [],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/manager',
    },
  ])
  return { store, projectId: project.id }
}

describe('Selective DAG Dependency Pausing', () => {
  it('allows independent tasks to run while dependent tasks pause on QA question', () => {
    const graph = new TaskGraph()
    graph.addTask('task-qa', { role: 'qa', state: 'waiting' })
    graph.addTask('task-researcher', { role: 'researcher', state: 'pending' })
    graph.addTask('task-coder', { role: 'coder', state: 'pending' })

    // Coder depends on QA, Researcher is independent
    graph.addEdge('task-qa', 'task-coder')

    const ready = graph.getReadyTasks()
    expect(ready).toContain('task-researcher')
    expect(ready).not.toContain('task-coder')
  })

  it('correctly tracks transitive dependents and pauses entire downstream branch', () => {
    const graph = new TaskGraph()
    graph.addTask('task-qa', { role: 'qa', state: 'waiting' })
    graph.addTask('task-coder', { role: 'coder', state: 'pending' })
    graph.addTask('task-reviewer', { role: 'reviewer', state: 'pending' })
    graph.addTask('task-researcher', { role: 'researcher', state: 'pending' })

    // QA -> Coder -> Reviewer
    graph.addEdge('task-qa', 'task-coder')
    graph.addEdge('task-coder', 'task-reviewer')

    // Transitive dependents of QA
    const dependents = graph.getTransitiveDependents('task-qa')
    expect(dependents).toEqual(['task-coder', 'task-reviewer'])
    expect(graph.getTransitiveDependents('task-coder')).toEqual(['task-reviewer'])
    expect(graph.getTransitiveDependents('task-reviewer')).toEqual([])

    // Pausing checks
    expect(graph.isTaskBlockedOnWaiting('task-coder')).toBe(true)
    expect(graph.isTaskBlockedOnWaiting('task-reviewer')).toBe(true)
    expect(graph.isTaskBlockedOnWaiting('task-researcher')).toBe(false)

    // Ready tasks: only independent researcher
    expect(graph.getReadyTasks()).toEqual(['task-researcher'])

    // When QA completes, Coder becomes ready but Reviewer still paused on Coder
    graph.setTaskState('task-qa', 'completed')
    expect(graph.isTaskBlockedOnWaiting('task-coder')).toBe(false)
    expect(graph.isTaskBlockedOnWaiting('task-reviewer')).toBe(false)

    const readyAfterQA = graph.getReadyTasks()
    expect(readyAfterQA).toContain('task-coder')
    expect(readyAfterQA).toContain('task-researcher')
    expect(readyAfterQA).not.toContain('task-reviewer')

    // When Coder completes, Reviewer becomes ready
    graph.setTaskState('task-coder', 'completed')
    const readyAfterCoder = graph.getReadyTasks()
    expect(readyAfterCoder).toContain('task-reviewer')
  })

  describe('isTaskBlockedOnWaiting evaluation helper', () => {
    it('evaluates blocked status on canonical Pluton task edges (fromTaskId depends on toTaskId)', () => {
      const mockTask = (id: string, state: TaskRecord['state']): TaskRecord => ({
        id,
        runId: 'run-1',
        parentTaskId: null,
        rootTaskId: id,
        depth: 0,
        title: id,
        brief: id,
        acceptanceCriteria: [],
        writeScope: [],
        assigneeMuseId: null,
        state,
        attempt: 0,
        workspaceId: null,
        engineSessionId: null,
        result: null,
        failure: null,
        assignment: null,
        createdAt: '2026-10-20T10:00:00Z',
        startedAt: null,
        completedAt: null,
      })

      const tasks = new Map<string, TaskRecord>([
        ['task-qa', mockTask('task-qa', 'needs_approval')],
        ['task-coder', mockTask('task-coder', 'queued')],
        ['task-reviewer', mockTask('task-reviewer', 'queued')],
        ['task-researcher', mockTask('task-researcher', 'queued')],
      ])

      // In Pluton canonical edge semantics: fromTaskId depends on toTaskId
      const edges: TaskEdgeRecord[] = [
        { runId: 'run-1', fromTaskId: 'task-coder', toTaskId: 'task-qa', kind: 'depends_on' },
        { runId: 'run-1', fromTaskId: 'task-reviewer', toTaskId: 'task-coder', kind: 'depends_on' },
      ]

      expect(isTaskBlockedOnWaiting('task-coder', tasks, edges)).toBe(true)
      expect(isTaskBlockedOnWaiting('task-reviewer', tasks, edges)).toBe(true)
      expect(isTaskBlockedOnWaiting('task-researcher', tasks, edges)).toBe(false)

      // When QA transitions to completed
      tasks.set('task-qa', mockTask('task-qa', 'completed'))
      expect(isTaskBlockedOnWaiting('task-coder', tasks, edges)).toBe(false)
      expect(isTaskBlockedOnWaiting('task-reviewer', tasks, edges)).toBe(false)
    })

    it('evaluates inverted edges where fromTaskId is dependency and toTaskId is dependent', () => {
      const mockTask = (id: string, state: TaskRecord['state']): TaskRecord => ({
        id,
        runId: 'run-1',
        parentTaskId: null,
        rootTaskId: id,
        depth: 0,
        title: id,
        brief: id,
        acceptanceCriteria: [],
        writeScope: [],
        assigneeMuseId: null,
        state,
        attempt: 0,
        workspaceId: null,
        engineSessionId: null,
        result: null,
        failure: null,
        assignment: null,
        createdAt: '2026-10-20T10:00:00Z',
        startedAt: null,
        completedAt: null,
      })

      const tasks = new Map<string, TaskRecord>([
        ['task-qa', mockTask('task-qa', 'needs_input')],
        ['task-coder', mockTask('task-coder', 'queued')],
        ['task-researcher', mockTask('task-researcher', 'queued')],
      ])

      // Inverted: QA -> Coder
      const edges: TaskEdgeRecord[] = [
        { runId: 'run-1', fromTaskId: 'task-qa', toTaskId: 'task-coder', kind: 'depends_on' },
      ]

      expect(isTaskBlockedOnWaiting('task-coder', tasks, edges)).toBe(true)
      expect(isTaskBlockedOnWaiting('task-researcher', tasks, edges)).toBe(false)
    })
  })

  describe('Durable Store selective pausing verification', () => {
    it('listReadyTasks cleanly blocks queued tasks whose dependencies are waiting/needs_approval while unblocking independent tasks', () => {
      const { store, projectId } = makeStore()
      const run = store.createRun({
        projectId,
        goal: 'test selective pausing',
        origin: 'cli',
        requestedBy: 'tester',
        acceptanceCriteria: [],
        managerMuseId: 'manager-muse',
        budget: {
          maxConcurrentWorkers: 3,
          maxTasks: 10,
          maxDelegationDepth: 2,
          maxRunMinutes: 60,
          defaultTaskMinutes: 10,
        },
      })

      const taskQa = store.createTask({
        runId: run.id,
        title: 'QA review',
        brief: 'Run tests and verify',
        acceptanceCriteria: ['pass'],
      })
      const taskResearcher = store.createTask({
        runId: run.id,
        title: 'Research API',
        brief: 'Investigate API specs',
        acceptanceCriteria: ['documented'],
      })
      const taskCoder = store.createTask({
        runId: run.id,
        title: 'Implement fixes',
        brief: 'Fix bugs found by QA',
        acceptanceCriteria: ['tests pass'],
      })

      // In store, taskCoder depends on taskQa
      store.addEdge(run.id, taskCoder.id, taskQa.id, 'depends_on')

      // Set initial states:
      // QA enters needs_approval (waiting on user answer)
      store.setTaskState(taskQa.id, 'queued')
      store.setTaskState(taskQa.id, 'admitted')
      store.setTaskState(taskQa.id, 'running')
      store.setTaskState(taskQa.id, 'needs_approval')

      // Researcher and Coder are queued
      store.setTaskState(taskResearcher.id, 'queued')
      store.setTaskState(taskCoder.id, 'queued')

      // listReadyTasks should return ONLY taskResearcher, NOT taskCoder
      const readyTasks = store.listReadyTasks(run.id)
      const readyIds = readyTasks.map((t) => t.id)
      expect(readyIds).toContain(taskResearcher.id)
      expect(readyIds).not.toContain(taskCoder.id)

      // Once QA is resolved and completes:
      store.setTaskState(taskQa.id, 'running')
      store.setTaskState(taskQa.id, 'completed')

      // Now taskCoder becomes ready as well
      const readyTasksAfterResolution = store.listReadyTasks(run.id)
      const readyIdsAfter = readyTasksAfterResolution.map((t) => t.id)
      expect(readyIdsAfter).toContain(taskResearcher.id)
      expect(readyIdsAfter).toContain(taskCoder.id)
    })
  })
})
