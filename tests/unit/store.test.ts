import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, setUserVersion, type DatabaseSync } from '../../src/store/db.ts'
import { MIGRATIONS, migrate, SCHEMA_VERSION } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { ConflictError, InternalError, NotFoundError, StateTransitionError, ValidationError } from '../../src/domain/errors.ts'
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
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows lock cleanup best effort
    }
  }
})

describe('migrations', () => {
  it('applies version 1 and is idempotent on reopen', () => {
    const path = tmpDbPath('mig')
    const db = openDatabase(path)
    const first = migrate(db)
    expect(first.from).toBe(0)
    expect(first.to).toBe(SCHEMA_VERSION)
    expect(first.applied).toEqual([
      'v1:initial-schema',
      'v2:unique-sandbox-and-terminal-per-muse',
      'v3:chat-sessions',
      'v4:plans',
      'v5:multi-agent-reliability',
    ])
    const second = migrate(db)
    expect(second.applied).toEqual([])
    db.close()

    const db2 = openDatabase(path)
    expect(migrate(db2).from).toBe(SCHEMA_VERSION)
    db2.close()
  })

  it('v2 dedupes pre-existing duplicates, keeping the newest row per (project, muse)', () => {
    const path = tmpDbPath('mig-dedupe')
    const db = openDatabase(path)
    openDbs.push(db)
    // Build a legacy v1 database, where duplicate rows per (project, muse) were possible.
    for (const sql of MIGRATIONS[0]!.statements) db.exec(sql)
    setUserVersion(db, 1)
    db.prepare(
      `INSERT INTO projects (id, name, root_path, config_path, default_branch, created_at, updated_at)
       VALUES ('project_legacy', 'legacy', '/legacy', '/legacy/pluton.yaml', 'main', ?, ?)`,
    ).run('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
    const insertSandbox = db.prepare(
      `INSERT INTO sandboxes (id, project_id, muse_id, kind, container_name, container_id, image, state,
                              created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'docker', NULL, NULL, NULL, 'running', 'legacy', ?, ?)`,
    )
    insertSandbox.run('sb_old', 'project_legacy', 'worker-a', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
    insertSandbox.run('sb_new', 'project_legacy', 'worker-a', '2024-02-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z')
    insertSandbox.run('sb_null_old', 'project_legacy', null, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
    insertSandbox.run('sb_null_new', 'project_legacy', null, '2024-02-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z')
    const insertTerminal = db.prepare(
      `INSERT INTO terminals (id, project_id, muse_id, sandbox_id, tmux_session_name, state, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'sess', 'absent', ?, ?)`,
    )
    insertTerminal.run('tm_old', 'project_legacy', 'worker-a', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
    insertTerminal.run('tm_new', 'project_legacy', 'worker-a', '2024-02-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z')

    const result = migrate(db)
    expect(result.from).toBe(1)
    expect(result.to).toBe(SCHEMA_VERSION)
    expect(result.applied).toEqual([
      'v2:unique-sandbox-and-terminal-per-muse',
      'v3:chat-sessions',
      'v4:plans',
      'v5:multi-agent-reliability',
    ])
    const sandboxIds = db.prepare('SELECT id FROM sandboxes ORDER BY id').all().map((r) => r['id'])
    expect(sandboxIds).toEqual(['sb_new', 'sb_null_new'])
    const terminalIds = db.prepare('SELECT id FROM terminals ORDER BY id').all().map((r) => r['id'])
    expect(terminalIds).toEqual(['tm_new'])
    // The index now rejects a duplicate that the v1 schema would have accepted.
    expect(() =>
      insertSandbox.run('sb_dup', 'project_legacy', null, '2024-03-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'),
    ).toThrow(/UNIQUE constraint failed/)
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

  it('updateMuseModel updates the model of an existing muse', () => {
    const { store } = freshStore('muses-update')
    seedProject(store)
    expect(store.getMuse('worker-a')?.model).toBe('mock/model-a')
    store.updateMuseModel('worker-a', 'claude-3-5-sonnet')
    expect(store.getMuse('worker-a')?.model).toBe('claude-3-5-sonnet')
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

  it('listEvents reads one run newest-first, filters by type, and caps the result', () => {
    const { store } = freshStore('list-events')
    const projectId = seedProject(store)
    store.appendEvent({ projectId, runId: 'run_other', type: 'task.admitted' })
    const first = store.appendEvent({ projectId, runId: 'run_listed', type: 'task.admitted' })
    const second = store.appendEvent({ projectId, runId: 'run_listed', type: 'task.completed' })
    const third = store.appendEvent({ projectId, runId: 'run_listed', type: 'task.completed' })

    expect(store.listEvents('run_listed').map((e) => e.id)).toEqual([third.id, second.id, first.id])
    expect(store.listEvents('run_listed', { type: 'task.completed' }).map((e) => e.id)).toEqual([third.id, second.id])
    expect(store.listEvents('run_listed', { type: 'task.admitted' }).map((e) => e.id)).toEqual([first.id])
    expect(store.listEvents('run_listed', { limit: 1 }).map((e) => e.id)).toEqual([third.id])
    expect(store.listEvents('run_listed', { type: 'nope' })).toEqual([])
    expect(store.listEvents('run_missing')).toEqual([])

    // Default cap is 50, newest first.
    for (let i = 0; i < 51; i++) store.appendEvent({ projectId, runId: 'run_listed', type: 'bulk', payload: { i } })
    const bulk = store.listEvents('run_listed')
    expect(bulk).toHaveLength(50)
    expect(bulk[0]?.payload).toEqual({ i: 50 })
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

describe('workspace / sandbox / terminal registry (Phase 5)', () => {
  function seedRunAndTask(store: Store, projectId: string): { runId: string; taskId: string } {
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
    return { runId: run.id, taskId: task.id }
  }

  it('creates, resolves, updates, and filters workspace records', () => {
    const { store } = freshStore('workspaces')
    const projectId = seedProject(store)
    const { runId, taskId } = seedRunAndTask(store, projectId)
    const ws = store.createWorkspace({
      projectId,
      runId,
      taskId,
      museId: 'worker-a',
      kind: 'task-checkout',
      path: join(tmpdir(), 'pluton-ws', taskId),
      branch: `pluton/${runId}/${taskId}`,
      baseCommit: 'a'.repeat(40),
    })
    expect(ws.state).toBe('active')
    expect(ws.headCommit).toBeNull()
    expect(ws.baseCommit).toBe('a'.repeat(40))
    expect(store.getWorkspaceOrNull(ws.id)?.id).toBe(ws.id)
    expect(store.getWorkspaceByTask(taskId)?.id).toBe(ws.id)

    const advanced = store.updateWorkspace(ws.id, { headCommit: 'b'.repeat(40) })
    expect(advanced.headCommit).toBe('b'.repeat(40))
    expect(advanced.state).toBe('active')

    const archived = store.updateWorkspace(ws.id, { state: 'archived' })
    expect(archived.state).toBe('archived')
    // The per-task lookup only ever returns the active checkout.
    expect(store.getWorkspaceByTask(taskId)).toBeNull()
    expect(store.listWorkspaces(projectId).map((w) => w.id)).toEqual([ws.id])
    expect(store.listWorkspaces(projectId, 'active')).toEqual([])
    expect(store.listWorkspaces(projectId, 'archived').map((w) => w.id)).toEqual([ws.id])
  })

  it('stores a project-level workspace (integration checkout) with no task or muse', () => {
    const { store } = freshStore('workspaces2')
    const projectId = seedProject(store)
    const ws = store.createWorkspace({
      projectId,
      runId: null,
      taskId: null,
      museId: null,
      kind: 'integration-checkout',
      path: join(tmpdir(), 'pluton-ws', 'integration'),
      branch: 'pluton/integration/run-1',
      baseCommit: 'c'.repeat(40),
    })
    expect(ws.taskId).toBeNull()
    expect(ws.runId).toBeNull()
    expect(ws.museId).toBeNull()
    expect(ws.kind).toBe('integration-checkout')
  })

  it('upserts one sandbox row per (project, muse) and keeps the record id stable', () => {
    const { store } = freshStore('sandboxes')
    const projectId = seedProject(store)
    const first = store.upsertSandbox({
      projectId,
      museId: 'worker-a',
      kind: 'docker',
      containerName: 'pluton-test-worker-a',
      containerId: 'cid_1',
      image: 'pluton-worker:dev',
      state: 'creating',
      createdBy: 'tester',
    })
    expect(store.getSandboxForMuse(projectId, 'worker-a')?.id).toBe(first.id)

    const second = store.upsertSandbox({
      projectId,
      museId: 'worker-a',
      kind: 'docker',
      containerName: 'pluton-test-worker-a',
      containerId: 'cid_2',
      image: 'pluton-worker:dev',
      state: 'running',
      createdBy: 'tester',
    })
    expect(second.id).toBe(first.id)
    expect(second.state).toBe('running')
    expect(second.containerId).toBe('cid_2')
    expect(store.listSandboxes(projectId).length).toBe(1)
  })

  it('addresses a project-level sandbox (muse_id NULL) without colliding with muse rows', () => {
    const { store } = freshStore('sandboxes2')
    const projectId = seedProject(store)
    const projectLevel = store.upsertSandbox({
      projectId,
      museId: null,
      kind: 'local-process',
      containerName: null,
      containerId: null,
      image: null,
      state: 'running',
      createdBy: 'tester',
    })
    expect(store.getSandboxForMuse(projectId, null)?.id).toBe(projectLevel.id)
    expect(store.getSandboxForMuse(projectId, 'worker-a')).toBeNull()
    store.upsertSandbox({
      projectId,
      museId: 'worker-a',
      kind: 'docker',
      containerName: 'pluton-test-worker-a',
      containerId: 'cid_1',
      image: 'pluton-worker:dev',
      state: 'running',
      createdBy: 'tester',
    })
    expect(store.listSandboxes(projectId).length).toBe(2)
  })

  it('updates sandbox state with field patches, and unknown ids throw not_found', () => {
    const { store } = freshStore('sandboxes3')
    const projectId = seedProject(store)
    const sb = store.upsertSandbox({
      projectId,
      museId: 'worker-a',
      kind: 'docker',
      containerName: 'pluton-test-worker-a',
      containerId: 'cid_1',
      image: 'pluton-worker:dev',
      state: 'creating',
      createdBy: 'tester',
    })
    const stopped = store.setSandboxState(sb.id, 'stopped', { containerId: null })
    expect(stopped.state).toBe('stopped')
    expect(stopped.containerId).toBeNull()
    expect(stopped.containerName).toBe('pluton-test-worker-a')
    expect(() => store.setSandboxState('sandbox_nope', 'running')).toThrow(NotFoundError)
  })

  it('upserts one terminal row per (project, muse) and records state changes', () => {
    const { store } = freshStore('terminals')
    const projectId = seedProject(store)
    const sb = store.upsertSandbox({
      projectId,
      museId: 'worker-a',
      kind: 'docker',
      containerName: 'pluton-test-worker-a',
      containerId: 'cid_1',
      image: 'pluton-worker:dev',
      state: 'running',
      createdBy: 'tester',
    })
    const first = store.upsertTerminal({
      projectId,
      museId: 'worker-a',
      sandboxId: sb.id,
      tmuxSessionName: 'pluton_test_4f2a19',
      state: 'absent',
    })
    expect(first.state).toBe('absent')

    const second = store.upsertTerminal({
      projectId,
      museId: 'worker-a',
      sandboxId: sb.id,
      tmuxSessionName: 'pluton_test_4f2a19',
      state: 'recreated',
    })
    expect(second.id).toBe(first.id)
    expect(second.state).toBe('recreated')
    expect(store.getTerminalForMuse(projectId, 'worker-a')?.id).toBe(first.id)

    const listed = store.listTerminals(projectId)
    expect(listed.length).toBe(1)
    const absent = store.setTerminalState(first.id, 'absent')
    expect(absent.state).toBe('absent')
    expect(() => store.getTerminal('terminal_nope')).toThrow(NotFoundError)
  })

  it('re-upserting a project-level sandbox (muse_id NULL) keeps the same id and exactly one row', () => {
    const { store } = freshStore('sandboxes4')
    const projectId = seedProject(store)
    const spec = {
      projectId,
      museId: null,
      kind: 'local-process' as const,
      containerName: null,
      containerId: null,
      image: null,
      state: 'creating' as const,
      createdBy: 'tester',
    }
    const first = store.upsertSandbox(spec)
    const second = store.upsertSandbox({ ...spec, state: 'running', createdBy: 'someone-else' })
    expect(second.id).toBe(first.id)
    expect(second.state).toBe('running')
    // created_by/created_at belong to the original row; only mutable columns move.
    expect(second.createdBy).toBe('tester')
    expect(second.createdAt).toBe(first.createdAt)
    const count = store.db
      .prepare('SELECT COUNT(*) AS n FROM sandboxes WHERE project_id = ? AND muse_id IS NULL')
      .get(projectId)
    expect(count?.['n']).toBe(1)
  })

  it('re-upserting a terminal for the same (project, muse) keeps the same id and exactly one row', () => {
    const { store } = freshStore('terminals2')
    const projectId = seedProject(store)
    // terminals.muse_id is NOT NULL (v1 schema), so only the sandbox case can have muse_id NULL.
    const first = store.upsertTerminal({
      projectId,
      museId: 'worker-a',
      sandboxId: null,
      tmuxSessionName: 'pluton_test_dup',
      state: 'absent',
    })
    const second = store.upsertTerminal({
      projectId,
      museId: 'worker-a',
      sandboxId: null,
      tmuxSessionName: 'pluton_test_dup',
      state: 'present',
    })
    expect(second.id).toBe(first.id)
    expect(second.state).toBe('present')
    expect(second.createdAt).toBe(first.createdAt)
    const count = store.db
      .prepare('SELECT COUNT(*) AS n FROM terminals WHERE project_id = ? AND muse_id = ?')
      .get(projectId, 'worker-a')
    expect(count?.['n']).toBe(1)
  })

  it('the NULL-safe unique indexes reject raw duplicate rows at the database level', () => {
    const { store } = freshStore('sandbox-index')
    const projectId = seedProject(store)
    const createdAt = '2024-01-01T00:00:00.000Z'
    const rawSandbox = (id: string, museId: string | null): void => {
      store.db
        .prepare(
          `INSERT INTO sandboxes (id, project_id, muse_id, kind, container_name, container_id, image, state,
                                  created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'docker', NULL, NULL, NULL, 'running', 'raw', ?, ?)`,
        )
        .run(id, projectId, museId, createdAt, createdAt)
    }
    store.upsertSandbox({
      projectId,
      museId: 'worker-a',
      kind: 'docker',
      containerName: 'c',
      containerId: 'cid',
      image: 'img',
      state: 'running',
      createdBy: 'tester',
    })
    store.upsertSandbox({
      projectId,
      museId: null,
      kind: 'local-process',
      containerName: null,
      containerId: null,
      image: null,
      state: 'running',
      createdBy: 'tester',
    })
    expect(() => rawSandbox('sandbox_dup', 'worker-a')).toThrow(/UNIQUE constraint failed/)
    // A plain UNIQUE(project_id, muse_id) index lets NULLs duplicate; ours must not.
    expect(() => rawSandbox('sandbox_dup_null', null)).toThrow(/UNIQUE constraint failed/)

    store.upsertTerminal({
      projectId,
      museId: 'worker-a',
      sandboxId: null,
      tmuxSessionName: 'pluton_test_raw',
      state: 'absent',
    })
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO terminals (id, project_id, muse_id, sandbox_id, tmux_session_name, state, created_at, updated_at)
           VALUES ('terminal_dup', ?, 'worker-a', NULL, 'pluton_test_raw', 'absent', ?, ?)`,
        )
        .run(projectId, createdAt, createdAt),
    ).toThrow(/UNIQUE constraint failed/)
  })
})

describe('approvals', () => {
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

  it('create -> get round-trips every field, including the JSON scope', () => {
    const { store } = freshStore('approvals1')
    const projectId = seedProject(store)
    const run = makeRun(store, projectId, 'g')
    const task = store.createTask({
      runId: run.id,
      parentTaskId: null,
      title: 't',
      brief: 'b',
      acceptanceCriteria: [],
      assigneeMuseId: 'worker-a',
    })
    const scope = { branch: 'pluton/run/task', force: false, remotes: ['origin', 'upstream'] }
    const created = store.createApproval({
      projectId,
      runId: run.id,
      taskId: task.id,
      requestedByMuseId: 'worker-a',
      action: 'git.push',
      reason: 'publish the branch',
      scope,
    })
    expect(created.id.startsWith('approval_')).toBe(true)
    expect(created.status).toBe('pending')
    expect(created.decidedBy).toBeNull()
    expect(created.decidedAt).toBeNull()
    expect(created.expiresAt).toBeNull()
    expect(created.createdAt).not.toBe('')
    const got = store.getApproval(created.id)
    expect(got).toEqual(created)
    expect(got.scope).toEqual(scope)
  })

  it('missing ids throw NotFoundError and getApprovalOrNull returns null', () => {
    const { store } = freshStore('approvals2')
    expect(() => store.getApproval('approval_nope')).toThrow(NotFoundError)
    expect(store.getApprovalOrNull('approval_nope')).toBeNull()
    expect(() => store.setApprovalStatus('approval_nope', 'approved')).toThrow(NotFoundError)
  })

  it('listApprovals isolates runs and returns the newest first', () => {
    const { store } = freshStore('approvals3')
    const projectId = seedProject(store)
    const runA = makeRun(store, projectId, 'a')
    const runB = makeRun(store, projectId, 'b')
    const base = {
      projectId,
      taskId: null,
      requestedByMuseId: null,
      reason: 'r',
      scope: { kind: 'test' },
    }
    const older = store.createApproval({ ...base, runId: runA.id, action: 'x' })
    const newer = store.createApproval({ ...base, runId: runA.id, action: 'y' })
    store.createApproval({ ...base, runId: runB.id, action: 'z' })
    // created_at has millisecond resolution; pin the older row so ordering is deterministic.
    store.db
      .prepare('UPDATE approvals SET created_at = ? WHERE id = ?')
      .run('2024-01-01T00:00:00.000Z', older.id)
    expect(store.listApprovals(runA.id).map((a) => a.id)).toEqual([newer.id, older.id])
    expect(store.listApprovals(runB.id).map((a) => a.action)).toEqual(['z'])
    expect(store.listApprovals('run_nope')).toEqual([])
  })

  it('pending -> approved stamps decided_by and decided_at', () => {
    const { store } = freshStore('approvals4')
    const projectId = seedProject(store)
    const run = makeRun(store, projectId, 'g')
    const approval = store.createApproval({
      projectId,
      runId: run.id,
      taskId: null,
      requestedByMuseId: null,
      action: 'git.push',
      reason: 'r',
      scope: {},
    })
    const approved = store.setApprovalStatus(approval.id, 'approved', { decidedBy: 'operator' })
    expect(approved.status).toBe('approved')
    expect(approved.decidedBy).toBe('operator')
    expect(approved.decidedAt).not.toBeNull()
    expect(store.getApproval(approval.id)).toEqual(approved)
  })

  it('setting the same status again is an idempotent no-op returning the record unchanged', () => {
    const { store } = freshStore('approvals5')
    const projectId = seedProject(store)
    const run = makeRun(store, projectId, 'g')
    const approval = store.createApproval({
      projectId,
      runId: run.id,
      taskId: null,
      requestedByMuseId: null,
      action: 'git.push',
      reason: 'r',
      scope: {},
    })
    // Pending no-op ignores the patch and does not decide anything.
    expect(store.setApprovalStatus(approval.id, 'pending', { decidedBy: 'sneaky' })).toEqual(approval)
    const approved = store.setApprovalStatus(approval.id, 'approved', { decidedBy: 'operator' })
    // A decided approval re-set to the same status is returned without touching the decision.
    expect(store.setApprovalStatus(approval.id, 'approved', { decidedBy: 'someone-else' })).toEqual(approved)
    expect(store.getApproval(approval.id).decidedBy).toBe('operator')
  })

  it('rejects a transition out of a decided state', () => {
    const { store } = freshStore('approvals6')
    const projectId = seedProject(store)
    const run = makeRun(store, projectId, 'g')
    const approval = store.createApproval({
      projectId,
      runId: run.id,
      taskId: null,
      requestedByMuseId: null,
      action: 'git.push',
      reason: 'r',
      scope: {},
    })
    store.setApprovalStatus(approval.id, 'denied', { decidedBy: 'operator' })
    expect(() => store.setApprovalStatus(approval.id, 'approved')).toThrow(ValidationError)
    expect(() => store.setApprovalStatus(approval.id, 'expired')).toThrow(/denied -> expired/)
    expect(store.getApproval(approval.id).status).toBe('denied')
  })

  it('an unknown status written directly to the database is an InternalError, never coerced', () => {
    const { store } = freshStore('approvals7')
    const projectId = seedProject(store)
    const run = makeRun(store, projectId, 'g')
    const approval = store.createApproval({
      projectId,
      runId: run.id,
      taskId: null,
      requestedByMuseId: null,
      action: 'git.push',
      reason: 'r',
      scope: {},
    })
    store.db.prepare("UPDATE approvals SET status = 'maybe' WHERE id = ?").run(approval.id)
    expect(() => store.getApproval(approval.id)).toThrow(InternalError)
    expect(() => store.getApproval(approval.id)).toThrow(/invalid approval status 'maybe'/)
  })

  it('createApproval stores the given expiresAt and defaults it to null', () => {
    const { store } = freshStore('approvals-expiry-write')
    const projectId = seedProject(store)
    const run = makeRun(store, projectId, 'g')
    const base = {
      projectId,
      runId: run.id,
      taskId: null,
      requestedByMuseId: null,
      action: 'git.push',
      reason: 'r',
      scope: {},
    }
    const withTtl = store.createApproval({ ...base, expiresAt: '2026-10-17T12:00:00.000Z' })
    expect(withTtl.expiresAt).toBe('2026-10-17T12:00:00.000Z')
    expect(store.getApproval(withTtl.id).expiresAt).toBe('2026-10-17T12:00:00.000Z')
    expect(store.createApproval(base).expiresAt).toBeNull()
  })

  it('listApprovalsByProject scopes to the project, filters by status, and applies the limit', () => {
    const { store } = freshStore('approvals-by-project')
    const projectId = seedProject(store)
    const otherProject = store.ensureProject({
      name: 'other',
      rootPath: join(tmpdir(), 'pluton-store-other-root'),
      configPath: join(tmpdir(), 'pluton-store-other-root', 'pluton.yaml'),
      defaultBranch: 'main',
    })
    const run = makeRun(store, projectId, 'g')
    const base = {
      projectId,
      runId: run.id,
      taskId: null,
      requestedByMuseId: null,
      action: 'x',
      reason: 'r',
      scope: {},
    }
    const first = store.createApproval({ ...base, action: 'first' })
    const second = store.createApproval({ ...base, action: 'second' })
    const third = store.createApproval({ ...base, action: 'third' })
    store.createApproval({ ...base, projectId: otherProject.id, action: 'elsewhere' })
    store.setApprovalStatus(second.id, 'denied', { decidedBy: 'operator' })
    // created_at has millisecond resolution; pin every row so ordering is deterministic.
    const pin = store.db.prepare('UPDATE approvals SET created_at = ? WHERE id = ?')
    pin.run('2024-01-01T00:00:00.000Z', first.id)
    pin.run('2024-01-02T00:00:00.000Z', second.id)
    pin.run('2024-01-03T00:00:00.000Z', third.id)

    expect(store.listApprovalsByProject(projectId).map((a) => a.id)).toEqual([third.id, second.id, first.id])
    expect(store.listApprovalsByProject(projectId, { status: 'pending' }).map((a) => a.id)).toEqual([
      third.id,
      first.id,
    ])
    expect(store.listApprovalsByProject(projectId, { status: 'denied' }).map((a) => a.id)).toEqual([second.id])
    expect(store.listApprovalsByProject(projectId, { limit: 2 }).map((a) => a.id)).toEqual([third.id, second.id])
    expect(store.listApprovalsByProject('project_nope')).toEqual([])
  })

  it('expirePendingApprovals flips only overdue pendings, scopes by project and is idempotent', () => {
    const { store } = freshStore('approvals-expire')
    const projectId = seedProject(store)
    const otherProject = store.ensureProject({
      name: 'other',
      rootPath: join(tmpdir(), 'pluton-store-other-root'),
      configPath: join(tmpdir(), 'pluton-store-other-root', 'pluton.yaml'),
      defaultBranch: 'main',
    })
    const now = '2026-10-17T12:00:00.000Z'
    const base = {
      projectId,
      runId: null,
      taskId: null,
      requestedByMuseId: null,
      action: 'git.push',
      reason: 'r',
      scope: {},
    }
    const overdue = store.createApproval({ ...base, expiresAt: '2026-10-17T11:59:59.000Z' })
    const exactlyNow = store.createApproval({ ...base, expiresAt: now })
    const future = store.createApproval({ ...base, expiresAt: '2026-10-17T12:00:01.000Z' })
    const never = store.createApproval(base)
    const decided = store.createApproval({ ...base, expiresAt: '2026-10-17T11:00:00.000Z' })
    store.setApprovalStatus(decided.id, 'denied', { decidedBy: 'operator' })
    const otherOverdue = store.createApproval({
      ...base,
      projectId: otherProject.id,
      expiresAt: '2026-10-17T11:00:00.000Z',
    })

    const swept = store.expirePendingApprovals(now, projectId)
    expect(swept.map((a) => a.id).sort()).toEqual([overdue.id, exactlyNow.id].sort())
    for (const row of swept) {
      expect(row.status).toBe('expired')
      expect(row.decidedBy).toBe('pluton:timeout')
      expect(row.decidedAt).toBe(now)
    }
    expect(store.getApproval(future.id).status).toBe('pending')
    expect(store.getApproval(never.id).status).toBe('pending')
    expect(store.getApproval(decided.id).status).toBe('denied')
    expect(store.getApproval(otherOverdue.id).status).toBe('pending') // project-scoped sweep
    expect(store.getApproval(overdue.id)).toEqual(swept.find((a) => a.id === overdue.id))

    // Idempotent: nothing is left overdue in this project, and an unscoped sweep reaches the other project.
    expect(store.expirePendingApprovals(now, projectId)).toEqual([])
    expect(store.expirePendingApprovals(now).map((a) => a.id)).toEqual([otherOverdue.id])
    expect(store.getApproval(otherOverdue.id).decidedBy).toBe('pluton:timeout')
  })
})
