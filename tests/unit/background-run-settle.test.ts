import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { settleRunCrashed } from '../../src/cli/commands/run.ts'

/**
 * A background driver's rejection (sandbox prep failure, supervisor crash
 * before finalize) is the only durable evidence that a run has no live owner
 * left. Defect 2026-10-21: rejections were swallowed and the run row stranded
 * `created`/`active` with no path to completion (live record
 * `run_mvgh70nha675003a`). These tests pin the settlement rule itself.
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

function makeStore(): { store: Store; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-run-settle-'))
  tmpDirs.push(dir)
  const db = openDatabase(join(dir, 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'run-settle-test',
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
      workspacePolicy: 'coordinator-read-only',
      permissions: [],
      approvalMode: 'autonomous-bounded',
      engineHome: '.pluton/engine-homes/manager',
    },
  ])
  return { store, projectId: project.id }
}

function createRun(store: Store, projectId: string): string {
  return store.createRun({
    projectId,
    goal: 'background crash settle test',
    origin: 'cli',
    requestedBy: 'cli',
    acceptanceCriteria: [],
    managerMuseId: 'manager',
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 10,
      maxDelegationDepth: 2,
      maxRunMinutes: 10,
      defaultTaskMinutes: 5,
    },
  }).id
}

describe('settleRunCrashed — background driver crash settlement', () => {
  it('fails a created run whose background driver rejected, with an honest summary and event', () => {
    const { store, projectId } = makeStore()
    const runId = createRun(store, projectId)

    settleRunCrashed(store, projectId, runId, new Error('substrate exploded'))

    const row = store.getRun(runId)
    expect(row.state).toBe('failed')
    expect(row.completedAt).not.toBeNull()
    expect(row.finalSummary).toBe('run crashed before completion: substrate exploded')

    // The event log is what the SSE log-watcher derives the terminal
    // `run_state` frame from — one finished event, failure-labelled.
    const events = store.eventsSince(projectId, 0, 100)
    const finished = events.filter((e) => e.type === 'run.finished' && e.runId === runId)
    expect(finished.length).toBe(1)
    expect(finished[0]?.payload).toMatchObject({ outcome: 'failure', via: 'background_crash' })
  })

  it('is idempotent and never rewrites an already-terminal run', () => {
    const { store, projectId } = makeStore()
    const runId = createRun(store, projectId)
    store.setRunState(runId, 'active')
    store.setRunState(runId, 'completed', { finalSummary: 'a real answer' })

    settleRunCrashed(store, projectId, runId, new Error('late background noise'))

    const row = store.getRun(runId)
    expect(row.state).toBe('completed')
    expect(row.finalSummary).toBe('a real answer')
    expect(store.eventsSince(projectId, 0, 100).filter((e) => e.type === 'run.finished').length).toBe(0)
  })

  it('preserves a competing owner: a crash racing a completed run cannot resurrect failed state', () => {
    const { store, projectId } = makeStore()
    const runId = createRun(store, projectId)
    // First crash settles failed; a second crash with a different message
    // must not rewrite the settled row or double-count events.
    settleRunCrashed(store, projectId, runId, new Error('first crash'))
    settleRunCrashed(store, projectId, runId, new Error('second crash'))

    const row = store.getRun(runId)
    expect(row.state).toBe('failed')
    expect(row.finalSummary).toBe('run crashed before completion: first crash')
    expect(store.eventsSince(projectId, 0, 100).filter((e) => e.type === 'run.finished').length).toBe(1)
  })

  it('silently ignores an unknown run id', () => {
    const { store, projectId } = makeStore()
    expect(() => settleRunCrashed(store, projectId, 'run_nope', new Error('x'))).not.toThrow()
    expect(store.eventsSince(projectId, 0, 100)).toHaveLength(0)
  })
})
