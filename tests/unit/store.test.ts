import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate, SCHEMA_VERSION } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { ConflictError, NotFoundError, StateTransitionError, ValidationError } from '../../src/domain/errors.ts'
import type { RunBudget } from '../../src/domain/models.ts'

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

function tmpDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pluton-store-${name}-`))
  tmpDirs.push(dir)
  return join(dir, 'pluton.sqlite')
}

function freshStore(name: string): { store: Store; path: string } {
  const path = tmpDbPath(name)
  const db = openDatabase(path)
  openDbs.push(db)
  migrate(db)
  return { store: new Store(db), path }
}

const BUDGET: RunBudget = {
  maxConcurrentWorkers: 2,
  maxTasks: 10,
  maxDelegationDepth: 3,
  maxRunMinutes: 60,
  defaultTaskMinutes: 10,
}

function seedProject(store: Store): string {
  const project = store.ensureProject({
    name: 'test',
    rootPath: join(tmpdir(), 'pluton-store-root'),
    configPath: join(tmpdir(), 'pluton-store-root', 'pluton.yaml'),
    defaultBranch: 'main',
  })
  store.syncMuses(project.id, [
    {
      id: 'worker-a',
      slug: 'worker-a',
      displayName: 'Worker A',
      role: 'coder',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: ['project.read'],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/worker-a',
    },
  ])
  return project.id
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed by the test
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('migrations', () => {
  it('applies version 1 and is idempotent on reopen', () => {
    const path = tmpDbPath('mig')
    const db = openDatabase(path)
    const first = migrate(db)
    expect(first.from).toBe(0)
    expect(first.to).toBe(SCHEMA_VERSION)
    expect(first.applied).toEqual(['v1:initial-schema'])
    const second = migrate(db)
    expect(second.applied).toEqual([])
    db.close()

    const db2 = openDatabase(path)
    expect(migrate(db2).from).toBe(SCHEMA_VERSION)
    db2.close()
  })
})

describe('project + muses', () => {
  it('ensureProject is idempotent for the same root path', () => {
    const { store } = freshStore('proj')
    const a = store.ensureProject({ name: 'x', rootPath: '/r', configPath: '/r/pluton.yaml', defaultBranch: 'main' })
    const b = store.ensureProject({ name: 'x', rootPath: '/r', configPath: '/r/pluton.yaml', defaultBranch: 'main' })
    expect(b.id).toBe(a.id)
  })

  it('syncMuses disables (never deletes) muses absent from config', () => {
    const { store } = freshStore('muses')
    const projectId = seedProject(store)
    expect(store.listMuses().length).toBe(1)
    expect(store.getMuse('worker-a')?.enabled).toBe(true)
    const result = store.syncMuses(projectId, [])
    expect(result.disabled).toBe(1)
    expect(store.getMuse('worker-a')?.enabled).toBe(false)
    expect(store.getMuse('worker-a')).not.toBeNull()
  })
})

describe('runs + tasks lifecycle', () => {
  it('enforces run state transitions through the domain state machine', () => {
    const { store } = freshStore('runs')
    const projectId = seedProject(store)
    const run = store.createRun({
      projectId,
      goal: 'g',
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: [],
      managerMuseId: 'worker-a',
      budget: BUDGET,
    })
    expect(run.state).toBe('created')
    const active = store.setRunState(run.id, 'active')
    expect(active.state).toBe('active')
    expect(active.startedAt).not.toBeNull()
    const done = store.setRunState(run.id, 'completed')
    expect(done.completedAt).not.toBeNull()
    expect(() => store.setRunState(run.id, 'active')).toThrow(StateTransitionError)
  })

  it('enforces task state transitions and timestamps', () => {
    const { store } = freshStore('tasklife')
    const projectId = seedProject(store)
    const run = store.createRun({
      projectId,
      goal: 'g',
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: [],
      managerMuseId: 'worker-a',
      budget: BUDGET,
    })
    const task = store.createTask({
      runId: run.id,
      parentTaskId: null,
      title: 't',
      brief: 'b',
      acceptanceCriteria: ['a'],
      assigneeMuseId: 'worker-a',
    })
    expect(task.state).toBe('created')
    expect(task.rootTaskId).toBe(task.id)
    expect(task.depth).toBe(0)
    expect(() => store.setTaskState(task.id, 'running')).toThrow(StateTransitionError)
    store.setTaskState(task.id, 'queued')
    store.setTaskState(task.id, 'admitted')
    const running = store.setTaskState(task.id, 'running')
    expect(running.startedAt).not.toBeNull()
    const done = store.setTaskState(task.id, 'completed', { result: { ok: true } })
    expect(done.completedAt).not.toBeNull()
    expect(done.result).toEqual({ ok: true })
    expect(() => store.setTaskState(task.id, 'running')).toThrow(StateTransitionError)
  })

  it('rejects tasks with an unknown assignee (FK enforced)', () => {
    const { store } = freshStore('fk')
    const projectId = seedProject(store)
    const run = store.createRun({
      projectId,
      goal: 'g',
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: [],
      managerMuseId: 'worker-a',
      budget: BUDGET,
    })
    expect(() =>
      store.createTask({
        runId: run.id,
        parentTaskId: null,
        title: 't',
        brief: 'b',
        acceptanceCriteria: [],
        assigneeMuseId: 'ghost-muse',
      }),
    ).toThrow(ValidationError)
  })

  it('derives rootTaskId and depth from the parent chain', () => {
    const { store } = freshStore('chain')
    const projectId = seedProject(store)
    const run = store.createRun({
      projectId,
      goal: 'g',
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: [],
      managerMuseId: 'worker-a',
      budget: BUDGET,
    })
    const root = store.createTask({
      runId: run.id,
      parentTaskId: null,
      title: 'root',
      brief: 'b',
      acceptanceCriteria: [],
      assigneeMuseId: 'worker-a',
    })
    const child = store.createTask({
      runId: run.id,
      parentTaskId: root.id,
      title: 'child',
      brief: 'b',
      acceptanceCriteria: [],
      assigneeMuseId: 'worker-a',
    })
    expect(child.rootTaskId).toBe(root.id)
    expect(child.depth).toBe(1)
    expect(store.childCount(root.id)).toBe(1)
  })
})

describe('events', () => {
  it('assigns increasing seq and returns stored events after a cursor', () => {
    const { store } = freshStore('events')
    const projectId = seedProject(store)
    const e1 = store.appendEvent({ projectId, type: 'a', payload: { n: 1 } })
    const e2 = store.appendEvent({ projectId, type: 'b' })
    expect(e2.seq).toBeGreaterThan(e1.seq)
    const after = store.eventsSince(projectId, e1.seq)
    expect(after.map((e) => e.id)).toEqual([e2.id])
  })

  it('redacts secret-looking keys before storing', () => {
    const { store } = freshStore('redact')
    const projectId = seedProject(store)
    const evt = store.appendEvent({
      projectId,
      type: 'x',
      payload: { token: 'super-secret', nested: { api_key: 'k', safe: 'ok' } },
    })
    expect(evt.payload).toEqual({ token: '[redacted]', nested: { api_key: '[redacted]', safe: 'ok' } })
    const reread = store.eventsSince(projectId, 0)[0]
    expect(reread?.payload).toEqual(evt.payload)
  })

  it('rejects oversized event payloads instead of truncating silently', () => {
    const { store } = freshStore('big')
    const projectId = seedProject(store)
    expect(() =>
      store.appendEvent({ projectId, type: 'x', payload: { blob: 'a'.repeat(500) }, maxChars: 100 }),
    ).toThrow(ValidationError)
  })
})

describe('receipts (idempotency)', () => {
  function makeRun(store: Store, projectId: string, goal: string) {
    return store.createRun({
      projectId,
      goal,
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: [],
      managerMuseId: 'worker-a',
      budget: BUDGET,
    })
  }

  it('same request id + same payload returns the original receipt and creates nothing', () => {
    const { store } = freshStore('receipts1')
    const projectId = seedProject(store)
    const payload = { goal: 'build x', by: 'tester' }
    const first = store.admitRequest({
      requestId: 'req_1',
      projectId,
      targetKind: 'run.create',
      payload,
      create: () => {
        const run = makeRun(store, projectId, 'build x')
        return { targetId: run.id, result: { runId: run.id } }
      },
    })
    expect(first.duplicate).toBe(false)
    expect(first.receipt.state).toBe('completed')

    const second = store.admitRequest({
      requestId: 'req_1',
      projectId,
      targetKind: 'run.create',
      payload: { by: 'tester', goal: 'build x' }, // different key order — same canonical payload
      create: () => {
        throw new Error('create must not run for a duplicate')
      },
    })
    expect(second.duplicate).toBe(true)
    expect(second.receipt.id).toBe(first.receipt.id)
    expect(second.receipt.targetId).toBe(first.receipt.targetId)
    expect(store.listRuns().length).toBe(1)
  })

  it('same request id + different payload is a conflict and mutates nothing', () => {
    const { store } = freshStore('receipts2')
    const projectId = seedProject(store)
    store.admitRequest({
      requestId: 'req_2',
      projectId,
      targetKind: 'run.create',
      payload: { goal: 'a' },
      create: () => {
        const run = makeRun(store, projectId, 'a')
        return { targetId: run.id, result: { runId: run.id } }
      },
    })
    let conflict: unknown = null
    try {
      store.admitRequest({
        requestId: 'req_2',
        projectId,
        targetKind: 'run.create',
        payload: { goal: 'b' },
        create: () => {
          throw new Error('must not run')
        },
      })
    } catch (e) {
      conflict = e
    }
    expect(conflict).toBeInstanceOf(ConflictError)
    expect(store.listRuns().length).toBe(1)
    // The attempted reuse is auditable.
    const conflicts = store.eventsSince(projectId, 0).filter((e) => e.type === 'request.conflict')
    expect(conflicts.length).toBe(1)
    const before = store.getReceipt('req_2')
    expect(before?.payloadHash).not.toBeNull()
  })

  it('a failing create() leaves no receipt behind (atomic rollback)', () => {
    const { store } = freshStore('receipts3')
    const projectId = seedProject(store)
    expect(() =>
      store.admitRequest({
        requestId: 'req_3',
        projectId,
        targetKind: 'run.create',
        payload: { goal: 'boom' },
        create: () => {
          throw new Error('engine exploded')
        },
      }),
    ).toThrow('engine exploded')
    expect(store.getReceipt('req_3')).toBeNull()
  })

  it('receipts survive a database reopen (crash reload)', () => {
    const path = tmpDbPath('receipts4')
    const db = openDatabase(path)
    migrate(db)
    const store = new Store(db)
    const projectId = seedProject(store)
    store.admitRequest({
      requestId: 'req_4',
      projectId,
      targetKind: 'run.create',
      payload: { goal: 'durable' },
      create: () => {
        const run = makeRun(store, projectId, 'durable')
        return { targetId: run.id, result: { runId: run.id } }
      },
    })
    const targetId = store.getReceipt('req_4')?.targetId
    db.close()

    const db2 = openDatabase(path)
    openDbs.push(db2)
    const store2 = new Store(db2)
    const again = store2.admitRequest({
      requestId: 'req_4',
      projectId,
      targetKind: 'run.create',
      payload: { goal: 'durable' },
      create: () => {
        throw new Error('must not re-create after restart')
      },
    })
    expect(again.duplicate).toBe(true)
    expect(again.receipt.targetId).toBe(targetId)
    expect(store2.listRuns().length).toBe(1)
    expect(store2.getTaskOrNull('task_nope')).toBeNull()
    expect(() => store2.getTask('task_nope')).toThrow(NotFoundError)
  })
})
