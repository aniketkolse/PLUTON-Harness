import { describe, expect, it, beforeEach } from 'vitest'
import { Store } from '../../src/store/store.ts'
import { sanitizeFtsQuery } from '../../src/store/fts.ts'

function seedShip(store: Store, projectId: string): void {
  store.syncShips(projectId, [
    {
      id: 'supervisor',
      slug: 'supervisor',
      displayName: 'Supervisor',
      role: 'supervisor',
      engineKind: 'mock',
      model: 'gpt-4o',
      instructionsFile: null,
      engineHome: '/home/supervisor',
      workspacePolicy: 'coordinator-read-only',
      approvalMode: 'ask-for-sensitive-actions',
      permissions: [],
    },
  ])
}

describe('FTS5 Full-Text Search', () => {
  let store: Store

  beforeEach(() => {
    store = Store.openMemory()
  })

  it('applies migration 12 and registers virtual tables', () => {
    expect(store.schemaVersion).toBeGreaterThanOrEqual(12)
  })

  it('sanitizes special FTS5 operators safely without throwing', () => {
    expect(sanitizeFtsQuery('')).toBe('')
    expect(sanitizeFtsQuery('   ')).toBe('')
    expect(sanitizeFtsQuery('hello world')).toBe('"hello"* "world"*')
    expect(sanitizeFtsQuery('auth:login (401) [ERROR]')).toBe('"auth"* "login"* "401"* "ERROR"*')
    expect(sanitizeFtsQuery('foo " bar """ baz')).toBe('"foo"* "bar"* "baz"*')
    expect(sanitizeFtsQuery('AND OR NOT NEAR * + ^')).toBe('"AND"* "OR"* "NOT"* "NEAR"*')
  })

  it('indexes existing chat messages and events during migration', () => {
    // Open a store at migration 11, insert rows, then migrate to 12
    const prevStore = Store.openMemory({ targetVersion: 11 })
    expect(prevStore.schemaVersion).toBe(11)

    const project = prevStore.ensureProject({ name: 'fts-test', rootPath: '/fts', configPath: '/fts/pluton.yaml', defaultBranch: 'main' })
    seedShip(prevStore, project.id)
    const session = prevStore.createChatSession({ projectId: project.id, title: 'Chat 1', shipId: 'supervisor' })
    prevStore.appendChatMessage({
      sessionId: session.id,
      role: 'user',
      text: 'Find this historical pre-migration keyword in chat',
    })

    const run = prevStore.createRun({
      projectId: project.id,
      goal: 'Investigate system performance',
      origin: 'cli',
      requestedBy: 'operator',
      managerShipId: 'supervisor',
      acceptanceCriteria: ['done'],
      budget: {
        maxTasks: 5,
        maxConcurrentWorkers: 1,
        maxDelegationDepth: 0,
        maxRunMinutes: 10,
        defaultTaskMinutes: 5,
      },
    })
    prevStore.appendEvent({
      projectId: project.id,
      runId: run.id,
      type: 'run.diagnostic',
      payload: { message: 'pre-migration diagnostic event log entry' },
    })

    // Migrate to latest (12)
    prevStore.migrate()
    expect(prevStore.schemaVersion).toBeGreaterThanOrEqual(12)

    const chatHits = prevStore.searchChatMessages('historical pre-migration')
    expect(chatHits.length).toBe(1)
    expect(chatHits[0]?.text).toContain('historical pre-migration keyword')

    const eventHits = prevStore.searchEvents('diagnostic event')
    expect(eventHits.length).toBe(1)
    expect(eventHits[0]?.runId).toBe(run.id)
    prevStore.close()
  })

  it('synchronizes chat messages via triggers on insert, update, and delete', () => {
    const project = store.ensureProject({ name: 'test', rootPath: '/test', configPath: '/test/pluton.yaml', defaultBranch: 'main' })
    seedShip(store, project.id)
    const session = store.createChatSession({ projectId: project.id, title: 'S1', shipId: 'supervisor' })

    const msg = store.appendChatMessage({
      sessionId: session.id,
      role: 'user',
      text: 'The swift orange fox discovered secret credentials in the logs',
    })

    let hits = store.searchChatMessages('orange fox credentials')
    expect(hits.length).toBe(1)
    expect(hits[0]?.messageId).toBe(msg.id)
    expect(hits[0]?.sessionId).toBe(session.id)
    expect(hits[0]?.role).toBe('user')
    expect(hits[0]?.snippet).toBeDefined()

    // Query with punctuation & special characters
    hits = store.searchChatMessages('fox:credentials (secret) [logs]')
    expect(hits.length).toBe(1)

    // Filter by session ID
    const otherSession = store.createChatSession({ projectId: project.id, title: 'S2', shipId: 'supervisor' })
    expect(store.searchChatMessages('fox', { sessionId: otherSession.id })).toEqual([])
    expect(store.searchChatMessages('fox', { sessionId: session.id }).length).toBe(1)

    // Delete message removes from FTS
    store.deleteChatMessage(msg.id)
    expect(store.searchChatMessages('orange fox')).toEqual([])
  })

  it('synchronizes events via insert trigger and supports runId filtering and snippets', () => {
    const project = store.ensureProject({ name: 'test', rootPath: '/test', configPath: '/test/pluton.yaml', defaultBranch: 'main' })
    const run1 = store.createRun({
      projectId: project.id,
      goal: 'Run 1',
      origin: 'cli',
      requestedBy: 'operator',
      managerShipId: 'supervisor',
      acceptanceCriteria: ['done'],
      budget: {
        maxTasks: 5,
        maxConcurrentWorkers: 1,
        maxDelegationDepth: 0,
        maxRunMinutes: 10,
        defaultTaskMinutes: 5,
      },
    })
    const run2 = store.createRun({
      projectId: project.id,
      goal: 'Run 2',
      origin: 'cli',
      requestedBy: 'operator',
      managerShipId: 'supervisor',
      acceptanceCriteria: ['done'],
      budget: {
        maxTasks: 5,
        maxConcurrentWorkers: 1,
        maxDelegationDepth: 0,
        maxRunMinutes: 10,
        defaultTaskMinutes: 5,
      },
    })

    store.appendEvent({
      projectId: project.id,
      runId: run1.id,
      type: 'test.failure',
      payload: { error: 'ECONNRESET connection terminated prematurely by gateway' },
    })

    store.appendEvent({
      projectId: project.id,
      runId: run2.id,
      type: 'test.success',
      payload: { message: 'all connection benchmarks completed successfully' },
    })

    // Search matches both runs
    let hits = store.searchEvents('connection')
    expect(hits.length).toBe(2)

    // Search filtered by run1
    hits = store.searchEvents('connection', { runId: run1.id })
    expect(hits.length).toBe(1)
    expect(hits[0]?.runId).toBe(run1.id)
    expect(hits[0]?.type).toBe('test.failure')
    expect(hits[0]?.snippet).toBeDefined()

    // Search filtered by run2
    hits = store.searchEvents('connection', { runId: run2.id })
    expect(hits.length).toBe(1)
    expect(hits[0]?.runId).toBe(run2.id)

    // Limit works
    expect(store.searchEvents('connection', { limit: 1 }).length).toBe(1)
  })

  it('handles empty, blank, or unmatched searches gracefully', () => {
    expect(store.searchChatMessages('')).toEqual([])
    expect(store.searchChatMessages('    ')).toEqual([])
    expect(store.searchChatMessages('nonexistenttermxyz123')).toEqual([])

    expect(store.searchEvents('')).toEqual([])
    expect(store.searchEvents('    ')).toEqual([])
    expect(store.searchEvents('nonexistenttermxyz123')).toEqual([])
  })
})
