import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors.ts'
import type { EventRecord, RunBudget } from '../../src/domain/models.ts'
import { runDetail } from '../../src/cli/commands/status.ts'
import { collectLogType, formatLogsHuman, logsView, normalizeLogsArgs } from '../../src/cli/commands/logs.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import {
  MAX_EVENT_QUERY_LIMIT,
  pendingApprovalsForRun,
  queryEvents,
  recentEvents,
  runProjection,
  taskStateCounts,
  usageForRun,
} from '../../src/store/query.ts'
import { Store } from '../../src/store/store.ts'

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

const BUDGET: RunBudget = {
  maxConcurrentWorkers: 2,
  maxTasks: 100,
  maxDelegationDepth: 3,
  maxRunMinutes: 60,
  defaultTaskMinutes: 10,
}

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-log-query-'))
  tmpDirs.push(dir)
  const db = openDatabase(join(dir, 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  return new Store(db)
}

function seedProject(store: Store, name = 'log-query'): string {
  const project = store.ensureProject({
    name,
    rootPath: join(tmpdir(), `pluton-log-query-${name}`),
    configPath: join(tmpdir(), `pluton-log-query-${name}`, 'pluton.yaml'),
    defaultBranch: 'main',
  })
  store.syncShips(project.id, [
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
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/manager',
    },
    {
      id: 'worker-a',
      slug: 'worker-a',
      displayName: 'Worker A',
      role: 'coder',
      engineKind: 'mock',
      model: 'mock/model',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: [],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/worker-a',
    },
  ])
  return project.id
}

function seedRun(store: Store, projectId: string, goal: string): string {
  return store.createRun({
    projectId,
    goal,
    origin: 'cli',
    requestedBy: 'test',
    acceptanceCriteria: [],
    managerShipId: 'manager',
    budget: BUDGET,
  }).id
}

function append(
  store: Store,
  projectId: string,
  type: string,
  fields: { runId?: string; taskId?: string; shipId?: string; payload?: EventRecord['payload'] } = {},
): EventRecord {
  return store.appendEvent({
    projectId,
    type,
    ...(fields.runId !== undefined ? { runId: fields.runId } : {}),
    ...(fields.taskId !== undefined ? { taskId: fields.taskId } : {}),
    ...(fields.shipId !== undefined ? { shipId: fields.shipId } : {}),
    ...(fields.payload !== undefined ? { payload: fields.payload } : {}),
  })
}

function setCreatedAt(store: Store, seq: number, iso: string): void {
  store.db.prepare('UPDATE events SET created_at = ? WHERE seq = ?').run(iso, seq)
}

function collectAllPages(
  store: Store,
  query: Parameters<typeof queryEvents>[1],
): { events: EventRecord[]; pages: number } {
  const events: EventRecord[] = []
  let afterSeq = query.afterSeq ?? 0
  let pages = 0
  for (;;) {
    const page = queryEvents(store, { ...query, afterSeq, limit: query.limit ?? 2 })
    pages += 1
    events.push(...page.events)
    afterSeq = page.nextAfter
    if (!page.hasMore) return { events, pages }
    if (pages > 100) throw new Error('cursor did not converge')
  }
}

describe('event cursor query', () => {
  it('pages ascending with a keyset cursor: no gaps, no duplicates, monotonic seqs', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const runId = seedRun(store, projectId, 'page me')
    const appended = Array.from({ length: 5 }, (_, i) =>
      append(store, projectId, `e.${i}`, { runId, payload: { i } }),
    )

    const { events, pages } = collectAllPages(store, { projectId, runId, limit: 2 })
    expect(pages).toBe(3)
    expect(events.map((e) => e.seq)).toEqual(appended.map((e) => e.seq))
    expect(new Set(events.map((e) => e.id)).size).toBe(5)
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq)
    }
  })

  it('continues from the cursor when rows are appended between pages (tail follows)', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const runId = seedRun(store, projectId, 'live tail')
    const first = append(store, projectId, 'a', { runId })
    append(store, projectId, 'b', { runId })

    const page1 = queryEvents(store, { projectId, runId, limit: 2 })
    expect(page1.events.map((e) => e.id)).toEqual([first.id, expect.any(String)])
    expect(page1.hasMore).toBe(false)
    expect(page1.headSeq).toBe(page1.nextAfter)

    // A client that reconnects with the last seen seq must see the new rows
    // and none of the old ones.
    const late1 = append(store, projectId, 'c', { runId })
    const late2 = append(store, projectId, 'd', { runId })
    const page2 = queryEvents(store, { projectId, runId, afterSeq: page1.nextAfter, limit: 2 })
    expect(page2.events.map((e) => e.id)).toEqual([late1.id, late2.id])
    expect(page2.hasMore).toBe(false)
    expect(page2.headSeq).toBe(late2.seq)
  })

  it('does not let another run crowd matching rows out of the window', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const runA = seedRun(store, projectId, 'run A')
    const runB = seedRun(store, projectId, 'run B')
    const mine = [append(store, projectId, 'a.1', { runId: runA }), append(store, projectId, 'a.2', { runId: runA })]
    for (let i = 0; i < 20; i++) append(store, projectId, 'b', { runId: runB })

    const page = queryEvents(store, { projectId, runId: runA, limit: 10 })
    expect(page.events.map((e) => e.id)).toEqual(mine.map((e) => e.id))
    expect(page.headSeq).toBe(mine[1]!.seq)
  })

  it('filters by task, ship, type list, and inclusive time bounds', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const runId = seedRun(store, projectId, 'filters')
    const e1 = append(store, projectId, 'task.admitted', { runId, taskId: 'task_a', shipId: 'worker-a' })
    const e2 = append(store, projectId, 'task.completed', { runId, taskId: 'task_a', shipId: 'worker-a' })
    const e3 = append(store, projectId, 'approval.requested', { runId, taskId: 'task_b', shipId: 'manager' })
    setCreatedAt(store, e1.seq, '2026-01-01T00:00:00.000Z')
    setCreatedAt(store, e2.seq, '2026-01-02T00:00:00.000Z')
    setCreatedAt(store, e3.seq, '2026-01-03T00:00:00.000Z')

    expect(queryEvents(store, { projectId, taskId: 'task_a' }).events.map((e) => e.id)).toEqual([e1.id, e2.id])
    expect(queryEvents(store, { projectId, shipId: 'manager' }).events.map((e) => e.id)).toEqual([e3.id])
    expect(
      queryEvents(store, { projectId, types: ['task.completed', 'approval.requested'] }).events.map((e) => e.id),
    ).toEqual([e2.id, e3.id])
    expect(queryEvents(store, { projectId, since: '2026-01-02T00:00:00.000Z' }).events.map((e) => e.id)).toEqual([
      e2.id,
      e3.id,
    ])
    expect(queryEvents(store, { projectId, until: '2026-01-02T00:00:00.000Z' }).events.map((e) => e.id)).toEqual([
      e1.id,
      e2.id,
    ])
    expect(
      queryEvents(store, {
        projectId,
        since: '2026-01-02T00:00:00.000Z',
        until: '2026-01-02T23:59:59.999Z',
      }).events.map((e) => e.id),
    ).toEqual([e2.id])
  })

  it('reports hasMore and headSeq without counting a page twice', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    for (let i = 0; i < 4; i++) append(store, projectId, 'x')
    const page = queryEvents(store, { projectId, limit: 3 })
    expect(page.events).toHaveLength(3)
    expect(page.hasMore).toBe(true)
    expect(page.headSeq).toBe(4)
    const last = queryEvents(store, { projectId, afterSeq: page.nextAfter, limit: 3 })
    expect(last.events).toHaveLength(1)
    expect(last.hasMore).toBe(false)
    expect(last.nextAfter).toBe(4)
  })

  it('returns an empty page with the given cursor when nothing matches', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const page = queryEvents(store, { projectId, afterSeq: 0, types: ['missing'] })
    expect(page).toMatchObject({ events: [], nextAfter: 0, hasMore: false, headSeq: 0 })
  })

  it('rejects invalid cursors, limits, types and time windows', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    expect(() => queryEvents(store, { projectId, afterSeq: -1 })).toThrow(ValidationError)
    expect(() => queryEvents(store, { projectId, afterSeq: 1.5 })).toThrow(ValidationError)
    expect(() => queryEvents(store, { projectId, limit: 0 })).toThrow(ValidationError)
    expect(() => queryEvents(store, { projectId, limit: MAX_EVENT_QUERY_LIMIT + 1 })).toThrow(ValidationError)
    expect(() => queryEvents(store, { projectId, types: [''] })).toThrow(ValidationError)
    expect(() => queryEvents(store, { projectId, since: 'yesterday' })).toThrow(ValidationError)
    expect(() =>
      queryEvents(store, { projectId, since: '2026-02-01T00:00:00.000Z', until: '2026-01-01T00:00:00.000Z' }),
    ).toThrow(ValidationError)
    expect(() => queryEvents(store, { projectId: '' })).toThrow(ValidationError)
  })

  it('maps every event field exactly like the store reader (no mapper drift)', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const runId = seedRun(store, projectId, 'parity')
    append(store, projectId, 'with.context', {
      runId,
      taskId: 'task_x',
      shipId: 'worker-a',
      payload: { nested: { ok: true }, list: [1, 'two'] },
    })
    append(store, projectId, 'without.context')
    expect(queryEvents(store, { projectId }).events).toEqual(store.eventsSince(projectId, 0, 1000))
  })
})

describe('recent events and the status run tail', () => {
  it('returns the newest N oldest-first and ignores later traffic from other runs', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const runA = seedRun(store, projectId, 'A')
    const runB = seedRun(store, projectId, 'B')
    const mine = Array.from({ length: 5 }, (_, i) => append(store, projectId, `a.${i}`, { runId: runA }))
    for (let i = 0; i < 1005; i++) append(store, projectId, 'b', { runId: runB })

    const recent = recentEvents(store, { projectId, runId: runA, limit: 10 })
    expect(recent.map((e) => e.id)).toEqual(mine.map((e) => e.id))
    expect(recent.length).toBeLessThanOrEqual(10)
    expect(recentEvents(store, { projectId, runId: runA, limit: 2 }).map((e) => e.id)).toEqual([
      mine[3]!.id,
      mine[4]!.id,
    ])
  })

  it('fixes status --run: the run tail is not crowded out by 1000 later project events', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const runA = seedRun(store, projectId, 'A')
    const runB = seedRun(store, projectId, 'B')
    const mine = [append(store, projectId, 'a.1', { runId: runA }), append(store, projectId, 'a.2', { runId: runA })]
    // The old implementation read the first 1000 project events and then
    // filtered by run; these 1005 rows pushed run A out of that window.
    for (let i = 0; i < 1005; i++) append(store, projectId, 'b', { runId: runB })

    const detail = runDetail(store, runA, 10)
    expect(detail.recentEvents.map((e) => e.id)).toEqual(mine.map((e) => e.id))
  })

  it('validates the recent-event limit', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    expect(() => recentEvents(store, { projectId, limit: 0 })).toThrow(ValidationError)
  })
})

describe('run projections', () => {
  it('counts tasks by state, pending approvals and per-Ship usage', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const runId = seedRun(store, projectId, 'projection')
    const created = store.createTask({
      runId,
      title: 'created task',
      brief: 'b',
      acceptanceCriteria: [],
      assigneeShipId: 'worker-a',
    })
    store.createTask({
      runId,
      title: 'queued task',
      brief: 'b',
      acceptanceCriteria: [],
      assigneeShipId: 'worker-a',
    })
    const queued = store.listTasks(runId)[1]!
    store.setTaskState(queued.id, 'queued')

    const pending = store.createApproval({
      projectId,
      runId,
      taskId: created.id,
      requestedByShipId: 'worker-a',
      action: 'shell.exec',
      reason: 'run tests',
      scope: {},
    })
    const decided = store.createApproval({
      projectId,
      runId,
      taskId: created.id,
      requestedByShipId: 'worker-a',
      action: 'shell.exec',
      reason: 'run build',
      scope: {},
    })
    store.setApprovalStatus(decided.id, 'denied', { decidedBy: 'operator' })

    store.recordUsage({ runId, shipId: 'worker-a', inputTokens: 10, outputTokens: 5, cachedTokens: 2, costUsd: 0.25 })
    store.recordUsage({ runId, shipId: 'manager', inputTokens: 20, outputTokens: 7, costUsd: 0.5 })
    append(store, projectId, 'run.started', { runId })

    expect(taskStateCounts(store, runId)).toEqual({ taskCounts: { created: 1, queued: 1 }, totalTasks: 2 })
    expect(pendingApprovalsForRun(store, runId).map((a) => a.id)).toEqual([pending.id])
    expect(usageForRun(store, runId)).toMatchObject({
      totalInputTokens: 30,
      totalOutputTokens: 12,
      totalCachedTokens: 2,
      totalCostUsd: 0.75,
      perShip: {
        'worker-a': { inputTokens: 10, outputTokens: 5, cachedTokens: 2, costUsd: 0.25 },
        manager: { inputTokens: 20, outputTokens: 7, cachedTokens: 0, costUsd: 0.5 },
      },
    })

    const projection = runProjection(store, projectId, runId)
    expect(projection).toMatchObject({
      runId,
      taskCounts: { created: 1, queued: 1 },
      totalTasks: 2,
      pendingApprovals: 1,
      headSeq: store.latestEventSeq(projectId),
    })
  })

  it('rejects unknown runs and runs from another project', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const otherProject = seedProject(store, 'other')
    const otherRun = seedRun(store, otherProject, 'elsewhere')
    expect(() => runProjection(store, projectId, otherRun)).toThrow(ValidationError)
    expect(() => runProjection(store, projectId, 'run_missing')).toThrow()
  })
})

describe('pluton logs argument handling and rendering', () => {
  it('parses cursors, limits and repeatable types', () => {
    expect(collectLogType('a', [])).toEqual(['a'])
    expect(collectLogType('b', ['a'])).toEqual(['a', 'b'])
    expect(normalizeLogsArgs({ after: '12', limit: '5', type: ['a', 'a', 'b'] })).toMatchObject({
      runRef: null,
      afterSeq: 12,
      limit: 5,
      types: ['a', 'b'],
    })
    expect(normalizeLogsArgs({ run: 'run_1' }).runRef).toBe('run_1')
    expect(normalizeLogsArgs({ runOption: 'run_2' }).runRef).toBe('run_2')
    expect(normalizeLogsArgs({ run: 'run_3', runOption: 'run_3' }).runRef).toBe('run_3')
  })

  it('rejects conflicting or malformed options', () => {
    expect(() => normalizeLogsArgs({ run: 'a', runOption: 'b' })).toThrow(ValidationError)
    expect(() => normalizeLogsArgs({ after: '-1' })).toThrow(ValidationError)
    expect(() => normalizeLogsArgs({ after: '12x' })).toThrow(ValidationError)
    expect(() => normalizeLogsArgs({ limit: '0' })).toThrow(ValidationError)
    expect(() => normalizeLogsArgs({ limit: String(MAX_EVENT_QUERY_LIMIT + 1) })).toThrow(ValidationError)
    expect(() => normalizeLogsArgs({ type: [''] })).toThrow(ValidationError)
  })

  it('resolves a run suffix and returns a scoped page', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const runA = seedRun(store, projectId, 'A')
    const runB = seedRun(store, projectId, 'B')
    append(store, projectId, 'a', { runId: runA })
    append(store, projectId, 'b', { runId: runB })

    const view = logsView(store, projectId, { run: runA.slice(-8), limit: '10' })
    expect(view.runId).toBe(runA)
    expect(view.events.map((e) => e.type)).toEqual(['a'])
  })

  it('renders a padded seq, refs, a single-line payload preview and the cursor footer', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const runId = seedRun(store, projectId, 'render')
    const event = append(store, projectId, 'task.admitted', {
      runId,
      taskId: 'task_abcdefgh',
      shipId: 'worker-a',
      payload: { text: 'line one\nline two', esc: '\u001b[31mred\u001b[0m' },
    })
    const human = formatLogsHuman(logsView(store, projectId, { run: runId }))
    expect(human).toContain(`#${String(event.seq).padStart(6)}`)
    expect(human).toContain('task.admitted')
    expect(human).toContain(`run=${runId.slice(-8)}`)
    expect(human).toContain('task=abcdefgh')
    expect(human).toContain('ship=worker-a')
    expect(human).not.toContain('\nline two')
    expect(human).not.toContain('\u001b')
    expect(human).toContain(`cursor #${event.seq}`)
    expect(human).toContain(`head #${event.seq}`)

    // Event type and Ship id are persisted strings; a hostile writer must not
    // be able to drive the operator's terminal through the human renderer.
    const hostile = append(store, projectId, 'bad\u001b[2Jtype', {
      runId,
      shipId: 'ship\u001b]0;pwned\u0007',
    })
    const huge = append(store, projectId, 'huge.payload', { runId, payload: 'x'.repeat(500) })
    const hostileHuman = formatLogsHuman(logsView(store, projectId, { run: runId }))
    expect(hostileHuman).not.toContain('\u001b')
    expect(hostileHuman).not.toContain('\u0007')
    expect(hostileHuman).toContain(`#${String(hostile.seq).padStart(6)}`)
    expect(hostileHuman).toContain(`#${String(huge.seq).padStart(6)}`)
    for (const line of hostileHuman.split('\n')) expect(line.length).toBeLessThan(300)
  })

  it('says so when no event matches and still prints the cursor', () => {
    const store = freshStore()
    const projectId = seedProject(store)
    const human = formatLogsHuman(logsView(store, projectId, { after: '42' }))
    expect(human).toContain('no events matched')
    expect(human).toContain('cursor #42')
    expect(human).toContain('head #0')
  })
})
