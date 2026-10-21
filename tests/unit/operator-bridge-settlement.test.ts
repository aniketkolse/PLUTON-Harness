import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import type { LoadedConfig } from '../../src/config/load.ts'
import { ApiRouter } from '../../src/server/routes.ts'
import { ServerEventBroadcaster } from '../../src/server/events.ts'
import type { ServerSSEEvent } from '../../src/server/types.ts'
import { REDACTED } from '../../src/util/redact.ts'

/**
 * Operator-bridge crash settlement (defect 2026-10-21, verification gap #1).
 *
 * When the manager Muse starts a run through the shared operator bridge, the
 * route hands `startRunInBackground`'s promise to `ApiRouter.watchBackgroundRun`.
 * A REJECTION of that promise is durable evidence the run has no live driver,
 * and it used to be swallowed — the row stranded forever. These tests drive the
 * REAL seam (the same private method the bridge callback invokes) against a
 * real store: no engines, no MCP transport, no timing or PID dependence.
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

interface Fixture {
  store: Store
  projectId: string
  router: ApiRouter
  /** Sink for every SSE event the router broadcasts. */
  frames: ServerSSEEvent[]
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-bridge-settle-'))
  tmpDirs.push(dir)
  const db = openDatabase(join(dir, 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'bridge-settle-test',
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
  const broadcaster = new ServerEventBroadcaster()
  const frames: ServerSSEEvent[] = []
  broadcaster.on('event', (event: ServerSSEEvent) => frames.push(event))
  const router = new ApiRouter({
    store,
    projectId: project.id,
    // The crash-settlement path touches only store/projectId/broadcaster;
    // no request handling happens in these tests.
    loaded: {} as LoadedConfig,
    broadcaster,
  })
  return { store, projectId: project.id, router, frames }
}

/** The exact private seam the operator-bridge `startRun` callback invokes. */
function watch(
  router: ApiRouter,
  started: { runId: string; done: Promise<unknown> },
): void {
  ;(router as unknown as { watchBackgroundRun: (s: { runId: string; done: Promise<unknown> }) => void })
    .watchBackgroundRun(started)
}

function activeRuns(router: ApiRouter): Map<string, string> {
  return (router as unknown as { activeRunTasks: Map<string, string> }).activeRunTasks
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function createRun(store: Store, projectId: string): string {
  return store.createRun({
    projectId,
    goal: 'operator bridge crash settlement test',
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

function finishedEvents(store: Store, projectId: string, runId: string): { via?: unknown; error?: unknown }[] {
  return store
    .eventsSince(projectId, 0, 100)
    .filter((e) => e.type === 'run.finished' && e.runId === runId)
    .map((e) => (e.payload ?? {}) as { via?: unknown; error?: unknown })
}

describe('operator-bridge crash settlement (watchBackgroundRun seam)', () => {
  it('settles a bridge-started run when the background driver rejects', async () => {
    const { store, projectId, router, frames } = makeFixture()
    const runId = createRun(store, projectId)

    watch(router, { runId, done: Promise.reject(new Error('transport exploded')) })
    expect(activeRuns(router).get(runId)).toBe(runId) // tracked while un-settled
    await flushMicrotasks()

    const row = store.getRun(runId)
    expect(row.state).toBe('failed')
    expect(row.completedAt).not.toBeNull()
    expect(row.finalSummary).toBe('run crashed before completion: transport exploded')

    // Exactly one lifecycle event, labelled background_crash.
    const finished = finishedEvents(store, projectId, runId)
    expect(finished.length).toBe(1)
    expect(finished[0]?.via).toBe('background_crash')
    expect(finished[0]?.error).toBe('transport exploded')

    // The immediate broadcast frame (not only the poller-derived one).
    const frame = frames.find(
      (f): f is Extract<ServerSSEEvent, { type: 'run_state' }> => f.type === 'run_state' && f.runId === runId,
    )
    expect(frame).toBeDefined()
    expect(frame?.state).toBe('failed')

    // The active-run map no longer claims the crashed run.
    expect(activeRuns(router).has(runId)).toBe(false)
  })

  it('preserves an already-terminal outcome and emits nothing extra', async () => {
    const { store, projectId, router } = makeFixture()
    const runId = createRun(store, projectId)
    store.setRunState(runId, 'active')
    store.setRunState(runId, 'completed', { finalSummary: 'the real answer' })

    watch(router, { runId, done: Promise.reject(new Error('late background noise')) })
    await flushMicrotasks()

    const row = store.getRun(runId)
    expect(row.state).toBe('completed')
    expect(row.completedAt).not.toBeNull()
    expect(row.finalSummary).toBe('the real answer')
    expect(finishedEvents(store, projectId, runId)).toHaveLength(0)
    expect(activeRuns(router).has(runId)).toBe(false)
  })

  it('settles once under duplicate watcher entries (two rejections, one record)', async () => {
    const { store, projectId, router } = makeFixture()
    const runId = createRun(store, projectId)

    watch(router, { runId, done: Promise.reject(new Error('first crash')) })
    watch(router, { runId, done: Promise.reject(new Error('second crash')) })
    await flushMicrotasks()

    const row = store.getRun(runId)
    expect(row.state).toBe('failed')
    // The first settlement wins; the duplicate is a no-op on the terminal row.
    expect(row.finalSummary).toBe('run crashed before completion: first crash')
    expect(finishedEvents(store, projectId, runId)).toHaveLength(1)
  })

  it('still settles a run whose promise rejected before the watcher was attached', async () => {
    // startRunInBackground can reject synchronously after row creation (e.g.
    // sandbox preparation throws before any await): the callback attaches the
    // watcher right after `started` is built, so the rejection may already be
    // settled. `.then` on a rejected promise still fires the handler.
    const { store, projectId, router } = makeFixture()
    const runId = createRun(store, projectId)
    const done = Promise.reject(new Error('pre-attach crash'))

    watch(router, { runId, done })
    await flushMicrotasks()

    const row = store.getRun(runId)
    expect(row.state).toBe('failed')
    expect(row.finalSummary).toBe('run crashed before completion: pre-attach crash')
    expect(finishedEvents(store, projectId, runId)).toHaveLength(1)
  })

  it('redacts credential-looking prose out of the crash settlement summary and event error', async () => {
    const { store, projectId, router } = makeFixture()
    const runId = createRun(store, projectId)

    watch(router, {
      runId,
      done: Promise.reject(new Error('sandbox boot echoed password=hunter2 in its env dump')),
    })
    await flushMicrotasks()

    const row = store.getRun(runId)
    expect(row.state).toBe('failed')
    expect(row.finalSummary).toContain(`password=${REDACTED}`)
    expect(row.finalSummary).not.toContain('hunter2')
    const finished = finishedEvents(store, projectId, runId)
    expect(finished).toHaveLength(1)
    const error = String(finished[0]?.error ?? '')
    expect(error).toContain(REDACTED)
    expect(error).not.toContain('hunter2')
  })
})
