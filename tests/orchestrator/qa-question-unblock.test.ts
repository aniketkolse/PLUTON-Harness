import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiRouter, handleQuestionDecision } from '../../src/server/routes.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { TaskGraph } from '../../src/orchestrator/task-graph.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'pluton-qa-unblock-'))
  tmpDirs.push(dir)
  const db = openDatabase(join(dir, 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'qa-unblock-test',
    rootPath: dir,
    configPath: join(dir, 'pluton.yaml'),
    defaultBranch: 'main',
  })
  store.syncMuses(project.id, [
    {
      id: 'manager',
      slug: 'manager',
      displayName: 'Manager',
      role: 'supervisor',
      engineKind: 'mock',
      model: 'mock/model',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: [],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/manager',
    },
    {
      id: 'qa',
      slug: 'qa',
      displayName: 'QA',
      role: 'tester',
      engineKind: 'mock',
      model: 'mock/model',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: [],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/qa',
    },
    {
      id: 'coder',
      slug: 'coder',
      displayName: 'Coder',
      role: 'coder',
      engineKind: 'mock',
      model: 'mock/model',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: [],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/coder',
    },
  ])
  return { store, projectId: project.id }
}

describe('QA Question Decision & Unblocking', () => {
  it('resolves approval and transitions dependent task to ready', async () => {
    const result = await handleQuestionDecision({
      approvalId: 'app-q1',
      decision: 'approved',
      selectedOption: 'Option A',
    })
    expect(result.status).toBe('resolved')
    expect(result.unblockedTasks).toContain('task-coder')
  })

  it('supports idempotency without error when already decided', async () => {
    const first = await handleQuestionDecision({
      approvalId: 'app-q-idem',
      decision: 'approved',
      selectedOption: 'Choice 1',
    })
    expect(first.status).toBe('resolved')

    const second = await handleQuestionDecision({
      approvalId: 'app-q-idem',
      decision: 'approved',
      selectedOption: 'Choice 1',
    })
    expect(second.status).toBe('already_decided')
    expect(second.approval.status).toBe('approved')
  })

  it('unblocks downstream tasks in durable store upon QA question approval', async () => {
    const { store, projectId } = makeStore()
    const run = store.createRun({
      projectId,
      goal: 'Implement feature with QA approval',
      origin: 'api',
      requestedBy: 'operator',
      acceptanceCriteria: ['Feature complete'],
      managerMuseId: 'manager',
      budget: {
        maxConcurrentWorkers: 2,
        maxTasks: 10,
        maxDelegationDepth: 3,
        maxRunMinutes: 30,
        defaultTaskMinutes: 10,
      },
    })

    const taskQa = store.createTask({
      runId: run.id,
      parentTaskId: null,
      title: 'QA Architecture Question',
      brief: 'Determine data storage layer',
      acceptanceCriteria: ['Answer received'],
      assigneeMuseId: 'qa',
    })
    store.setTaskState(taskQa.id, 'queued')
    store.setTaskState(taskQa.id, 'admitted')
    store.setTaskState(taskQa.id, 'running')
    store.setTaskState(taskQa.id, 'needs_approval')

    const taskCoder = store.createTask({
      runId: run.id,
      parentTaskId: null,
      title: 'Coder Task',
      brief: 'Implement storage logic',
      acceptanceCriteria: ['Storage working'],
      assigneeMuseId: 'coder',
    })
    store.setTaskState(taskCoder.id, 'queued')

    // taskCoder depends on taskQa
    store.addEdge(run.id, taskCoder.id, taskQa.id, 'depends_on')

    // taskCoder is NOT ready because taskQa is in needs_approval
    expect(store.listReadyTasks(run.id).map((t) => t.id)).not.toContain(taskCoder.id)

    // Create question approval
    const approval = store.createApproval({
      projectId,
      runId: run.id,
      taskId: taskQa.id,
      requestedByMuseId: 'qa',
      action: 'qa.question',
      reason: 'Select database engine',
      scope: {
        question: 'Which database engine should we use?',
        options: ['PostgreSQL', 'SQLite'],
      },
    })

    // Resolve question decision
    const result = await handleQuestionDecision({
      approvalId: approval.id,
      decision: 'approved',
      selectedOption: 'PostgreSQL',
      answer: 'We chose PostgreSQL for distributed deployment',
      store,
      projectId,
    })

    expect(result.status).toBe('resolved')
    expect(result.approval.status).toBe('approved')
    expect(result.unblockedTasks).toContain(taskCoder.id)

    // Verify taskQa completed
    const updatedQa = store.getTask(taskQa.id)
    expect(updatedQa.state).toBe('completed')

    // Verify taskCoder is now in ready tasks
    const readyTasks = store.listReadyTasks(run.id).map((t) => t.id)
    expect(readyTasks).toContain(taskCoder.id)

    // Verify resolution event appended
    const events = store.listEvents(run.id)
    const resolveEvent = events.find((e) => e.type === 'question.resolved')
    expect(resolveEvent).toBeDefined()
    expect((resolveEvent?.payload as any)?.selectedOption).toBe('PostgreSQL')
  })

  it('handles denied QA question decision without unblocking downstream tasks', async () => {
    const { store, projectId } = makeStore()
    const run = store.createRun({
      projectId,
      goal: 'Denied question test',
      origin: 'api',
      requestedBy: 'operator',
      acceptanceCriteria: ['Feature complete'],
      managerMuseId: 'manager',
      budget: {
        maxConcurrentWorkers: 2,
        maxTasks: 10,
        maxDelegationDepth: 3,
        maxRunMinutes: 30,
        defaultTaskMinutes: 10,
      },
    })

    const taskQa = store.createTask({
      runId: run.id,
      parentTaskId: null,
      title: 'QA Question Task',
      brief: 'Question',
      acceptanceCriteria: [],
      assigneeMuseId: 'qa',
    })
    store.setTaskState(taskQa.id, 'queued')
    store.setTaskState(taskQa.id, 'admitted')
    store.setTaskState(taskQa.id, 'running')
    store.setTaskState(taskQa.id, 'needs_approval')

    const taskCoder = store.createTask({
      runId: run.id,
      parentTaskId: null,
      title: 'Coder Task',
      brief: 'Work',
      acceptanceCriteria: [],
      assigneeMuseId: 'coder',
    })
    store.setTaskState(taskCoder.id, 'queued')
    store.addEdge(run.id, taskCoder.id, taskQa.id, 'depends_on')

    const approval = store.createApproval({
      projectId,
      runId: run.id,
      taskId: taskQa.id,
      requestedByMuseId: 'qa',
      action: 'qa.question',
      reason: 'Should we add cache layer?',
      scope: { question: 'Add redis?' },
    })

    const result = await handleQuestionDecision({
      approvalId: approval.id,
      decision: 'denied',
      answer: 'No caching needed',
      store,
      projectId,
    })

    expect(result.status).toBe('resolved')
    expect(result.approval.status).toBe('denied')
    expect(result.unblockedTasks).not.toContain(taskCoder.id)

    // taskCoder must remain blocked (not ready)
    const readyTasks = store.listReadyTasks(run.id).map((t) => t.id)
    expect(readyTasks).not.toContain(taskCoder.id)
  })

  it('unblocks in-memory TaskGraph when graph is provided', async () => {
    const graph = new TaskGraph()
    graph.addTask('task-qa', { role: 'qa', state: 'waiting' })
    graph.addTask('task-coder', { role: 'coder', state: 'pending' })
    graph.addEdge('task-qa', 'task-coder')

    const result = await handleQuestionDecision({
      approvalId: 'app-graph-1',
      decision: 'approved',
      selectedOption: 'Option A',
      taskGraph: graph,
    })

    expect(result.status).toBe('resolved')
    expect(result.unblockedTasks).toContain('task-coder')
    expect(graph.getTask('task-qa')?.state).toBe('completed')
    expect(graph.getReadyTasks()).toContain('task-coder')
  })

  it('POST /api/approvals/:id/decide accepts question options and unblocks tasks', async () => {
    const { store, projectId } = makeStore()
    const run = store.createRun({
      projectId,
      goal: 'HTTP QA Decision Test',
      origin: 'api',
      requestedBy: 'operator',
      acceptanceCriteria: ['Done'],
      managerMuseId: 'manager',
      budget: {
        maxConcurrentWorkers: 2,
        maxTasks: 10,
        maxDelegationDepth: 3,
        maxRunMinutes: 30,
        defaultTaskMinutes: 10,
      },
    })

    const taskQa = store.createTask({
      runId: run.id,
      parentTaskId: null,
      title: 'QA Decision Task',
      brief: 'Choose option',
      acceptanceCriteria: [],
      assigneeMuseId: 'qa',
    })
    store.setTaskState(taskQa.id, 'queued')
    store.setTaskState(taskQa.id, 'admitted')
    store.setTaskState(taskQa.id, 'running')
    store.setTaskState(taskQa.id, 'needs_approval')

    const taskCoder = store.createTask({
      runId: run.id,
      parentTaskId: null,
      title: 'Coder Downstream',
      brief: 'Build it',
      acceptanceCriteria: [],
      assigneeMuseId: 'coder',
    })
    store.setTaskState(taskCoder.id, 'queued')
    store.addEdge(run.id, taskCoder.id, taskQa.id, 'depends_on')

    const approval = store.createApproval({
      projectId,
      runId: run.id,
      taskId: taskQa.id,
      requestedByMuseId: 'qa',
      action: 'qa.question',
      reason: 'Architecture question',
      scope: { question: 'Pick A or B' },
    })

    const router = new ApiRouter({
      store,
      projectId,
      loaded: {
        rootDir: tmpDirs[0]!,
        configPath: join(tmpDirs[0]!, 'pluton.yaml'),
        config: {
          project: { name: 'qa-test', default_branch: 'main', verification: [] },
          muses: {},
          runtime: {
            approval_timeout_minutes: 60,
            task_timeout_minutes: 10,
            max_concurrent_workers: 2,
            max_tasks_per_run: 10,
            max_delegation_depth: 3,
            max_revisions_per_task: 2,
            max_child_tasks_per_task: 5,
          },
        } as any,
      },
      broadcaster: { broadcast: () => {} } as any,
    })

    function makeMockHttp(body: unknown) {
      let responseBody = ''
      let statusCode = 200
      const bodyStr = JSON.stringify(body)

      const req = new EventEmitter() as any
      req.url = `/api/approvals/${approval.id}/decide`
      req.method = 'POST'
      req.headers = { 'content-type': 'application/json' }

      const res = {
        setHeader: () => {},
        writeHead: (code: number) => {
          statusCode = code
        },
        end: (data?: string) => {
          if (data) responseBody = data
        },
        get statusCode() {
          return statusCode
        },
      } as unknown as ServerResponse

      process.nextTick(() => {
        req.emit('data', bodyStr)
        req.emit('end')
      })

      return {
        req,
        res,
        getBody: () => (responseBody ? JSON.parse(responseBody) : null),
        getStatus: () => statusCode,
      }
    }

    // 1. Initial decision
    const firstCall = makeMockHttp({
      decision: 'approved',
      selectedOption: 'Option A',
      answer: 'Approved Option A',
    })
    const handled = await router.handle(firstCall.req, firstCall.res)
    expect(handled).toBe(true)
    expect(firstCall.getStatus()).toBe(200)
    const firstJson = firstCall.getBody()
    expect(firstJson.ok).toBe(true)
    expect(firstJson.status).toBe('resolved')
    expect(firstJson.unblockedTasks).toContain(taskCoder.id)

    // 2. Idempotent repeat decision via HTTP
    const secondCall = makeMockHttp({
      decision: 'approved',
      selectedOption: 'Option A',
    })
    const secondHandled = await router.handle(secondCall.req, secondCall.res)
    expect(secondHandled).toBe(true)
    expect(secondCall.getStatus()).toBe(200)
    const secondJson = secondCall.getBody()
    expect(secondJson.ok).toBe(true)
    expect(secondJson.status).toBe('already_decided')
  })
})
