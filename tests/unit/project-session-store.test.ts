import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'

/**
 * Persistent project Build sessions (PLUTON 4.1 Phase 4).
 *
 * The session is the durable anchor between successive Builds: one row per
 * project, one stable workspace, a monotonic build counter, and a link from
 * each run. These tests exercise the real SQLite store and reopen the database
 * to prove the state survives a process restart.
 */

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

function makeStore(): { store: Store; db: DatabaseSync; dir: string; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-psess-'))
  tmpDirs.push(dir)
  const db = openDatabase(join(dir, 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'Session Project',
    rootPath: dir,
    configPath: join(dir, 'pluton.yaml'),
    defaultBranch: 'main',
  })
  store.syncShips(project.id, [
    {
      id: 'manager',
      slug: 'manager',
      displayName: 'Manager',
      role: 'supervisor',
      engineKind: 'mock',
      model: 'mock/test',
      instructionsFile: null,
      workspacePolicy: 'coordinator-read-only',
      permissions: [],
      approvalMode: 'manual',
      engineHome: dir,
    },
  ])
  return { store, db, dir, projectId: project.id }
}

function createRun(store: Store, projectId: string, goal: string, projectSessionId?: string): string {
  return store.createRun({
    projectId,
    goal,
    origin: 'api',
    requestedBy: 'operator:test',
    acceptanceCriteria: [],
    managerShipId: 'manager',
    budget: {
      maxConcurrentWorkers: 1,
      maxTasks: 2,
      maxDelegationDepth: 1,
      maxRunMinutes: 10,
      defaultTaskMinutes: 5,
    },
    ...(projectSessionId !== undefined ? { projectSessionId } : {}),
  }).id
}

describe('persistent project sessions', () => {
  it('creates one session per project and reuses the first workspace', () => {
    const { store, projectId, dir } = makeStore()
    const first = store.ensureProjectSession(projectId, join(dir, 'workspace-a'))
    const second = store.ensureProjectSession(projectId, join(dir, 'workspace-b'))

    expect(second.id).toBe(first.id)
    expect(second.workspaceRoot).toBe(first.workspaceRoot)
    expect(second.buildCount).toBe(0)
  })

  it('links runs and increments the build counter', () => {
    const { store, projectId, dir } = makeStore()
    const session = store.ensureProjectSession(projectId, dir)

    const runOne = createRun(store, projectId, 'First build', session.id)
    const afterFirst = store.recordProjectBuild(projectId, { runId: runOne, goal: 'First build' })
    expect(afterFirst.buildCount).toBe(1)
    expect(afterFirst.activeRunId).toBe(runOne)
    expect(afterFirst.lastGoal).toBe('First build')

    const runTwo = createRun(store, projectId, 'Second build', session.id)
    const afterSecond = store.recordProjectBuild(projectId, { runId: runTwo, goal: 'Second build' })
    expect(afterSecond.buildCount).toBe(2)
    expect(afterSecond.activeRunId).toBe(runTwo)
    expect(afterSecond.lastGoal).toBe('Second build')

    expect(store.getRun(runOne).projectSessionId).toBe(session.id)
    expect(store.getRun(runTwo).projectSessionId).toBe(session.id)
  })

  it('lists session runs newest-first and can exclude the current run', () => {
    const { store, projectId, dir } = makeStore()
    const session = store.ensureProjectSession(projectId, dir)
    const first = createRun(store, projectId, 'Older goal', session.id)
    const second = createRun(store, projectId, 'Newer goal', session.id)
    createRun(store, projectId, 'Unrelated run')

    const all = store.listProjectSessionRuns(session.id, 10)
    expect(all.map((r) => r.id)).toEqual([second, first])

    const prior = store.listProjectSessionRuns(session.id, 10, second)
    expect(prior.map((r) => r.id)).toEqual([first])
  })

  it('sets and clears the active run anchor', () => {
    const { store, projectId, dir } = makeStore()
    const session = store.ensureProjectSession(projectId, dir)
    const runId = createRun(store, projectId, 'Build', session.id)

    store.setProjectSessionActiveRun(projectId, runId)
    expect(store.getProjectSession(projectId)?.activeRunId).toBe(runId)

    store.clearProjectSessionActiveRunForRun(runId)
    expect(store.getProjectSession(projectId)?.activeRunId).toBeNull()
  })

  it('renames the project without changing its root path', () => {
    const { store, projectId, dir } = makeStore()
    const before = store.getProject(projectId)
    const after = store.renameProject(projectId, 'Renamed Project')

    expect(after.name).toBe('Renamed Project')
    expect(after.rootPath).toBe(before?.rootPath)
    expect(after.id).toBe(projectId)
  })

  it('persists the session, counter, and run link across a database reopen', () => {
    const { store, db, projectId, dir } = makeStore()
    const session = store.ensureProjectSession(projectId, join(dir, 'stable'))
    const runId = createRun(store, projectId, 'Survives restart', session.id)
    store.recordProjectBuild(projectId, { runId, goal: 'Survives restart' })
    store.renameProject(projectId, 'Persisted Name')

    // Close and reopen the same file: this is the restart boundary.
    db.close()
    openDbs.splice(openDbs.indexOf(db), 1)
    const reopened = openDatabase(join(dir, 'pluton.sqlite'))
    openDbs.push(reopened)
    migrate(reopened)
    const storeAgain = new Store(reopened)

    const restored = storeAgain.getProjectSession(projectId)
    expect(restored?.id).toBe(session.id)
    expect(restored?.workspaceRoot).toBe(session.workspaceRoot)
    expect(restored?.buildCount).toBe(1)
    expect(storeAgain.getRun(runId).projectSessionId).toBe(session.id)
    expect(storeAgain.getProject(projectId)?.name).toBe('Persisted Name')
  })
})
