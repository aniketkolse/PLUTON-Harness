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

/**
 * Seed a Ship on a database opened at an old migration target. `syncShips`
 * writes the current schema (including the v16 provider column), which does
 * not exist yet at v11 — so the fixture inserts only the v11 columns.
 */
function seedShipAtV11(store: Store, projectId: string): void {
  const ts = new Date().toISOString()
  store.db
    .prepare(
      `INSERT INTO ships (id, project_id, slug, display_name, role, engine_kind, model, instructions_file,
                          workspace_policy, permissions_json, approval_mode, engine_home, enabled, created_at, updated_at)
       VALUES ('supervisor', ?, 'supervisor', 'Supervisor', 'supervisor', 'mock', 'gpt-4o', NULL,
               'coordinator-read-only', '[]', 'ask-for-sensitive-actions', '/home/supervisor', 1, ?, ?)`,
    )
    .run(projectId, ts, ts)
}

/**
 * Seed a Run on a database opened at an old migration target. `createRun`
 * writes the current schema (including columns added after v11), so the
 * fixture inserts only the v11 columns.
 */
function seedRunAtV11(store: Store, projectId: string): string {
  const id = 'run_fts_pre_v12'
  const ts = new Date().toISOString()
  store.db
    .prepare(
      `INSERT INTO runs (id, project_id, goal, origin, requested_by, state, acceptance_json,
                         manager_ship_id, budget_json, created_at, workspace_root, origin_session_id)
       VALUES (?, ?, 'Investigate system performance', 'cli', 'operator', 'created', '["done"]',
               'supervisor', ?, ?, NULL, NULL)`,
    )
    .run(
      id,
      projectId,
      JSON.stringify({
        maxTasks: 5,
        maxConcurrentWorkers: 1,
        maxDelegationDepth: 0,
        maxRunMinutes: 10,
        defaultTaskMinutes: 5,
      }),
      ts,
    )
  return id
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
    seedShipAtV11(prevStore, project.id)
    const session = prevStore.createChatSession({ projectId: project.id, title: 'Chat 1', shipId: 'supervisor' })
    prevStore.appendChatMessage({
      sessionId: session.id,
      role: 'user',
      text: 'Find this historical pre-migration keyword in chat',
    })

    const runId = seedRunAtV11(prevStore, project.id)
    prevStore.appendEvent({
      projectId: project.id,
      runId,
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
    expect(eventHits[0]?.runId).toBe(runId)
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

  it('safely handles adversarial query inputs and prevents FTS5/SQL injection', () => {
    const project = store.ensureProject({ name: 'sec-test', rootPath: '/sec', configPath: '/sec/pluton.yaml', defaultBranch: 'main' })
    seedShip(store, project.id)
    const session = store.createChatSession({ projectId: project.id, title: 'Security Test', shipId: 'supervisor' })

    store.appendChatMessage({
      sessionId: session.id,
      role: 'user',
      text: 'Vulnerability assessment: injection attacks, buffer overflow, and token-leakage countermeasures.',
    })

    const maliciousQueries = [
      "'; DROP TABLE chat_messages_fts; --",
      "' OR 1=1 --",
      '"unbalanced "quotes"""',
      'AND OR NOT NEAR',
      'column:injection (unclosed [paren',
      '*** +++ --- ^^^ ~~~',
      '<<< >>> ??? &&& ||| ///',
      '🚀 🦊 💻 🛑',
      '\0null\x00byte\x1fcontrol',
      'a'.repeat(4000),
      "MATCH 'malicious'",
      'SELECT * FROM sqlite_master',
      'UNION ALL SELECT 1, 2, 3, 4',
      'k8s-pod_worker-0123',
    ]

    for (const q of maliciousQueries) {
      expect(() => store.searchChatMessages(q)).not.toThrow()
      expect(() => store.searchEvents(q)).not.toThrow()
    }

    // Verify virtual tables were NOT dropped or corrupted
    const validHits = store.searchChatMessages('vulnerability countermeasures')
    expect(validHits.length).toBe(1)
    expect(validHits[0]?.text).toContain('Vulnerability assessment')
  })

  it('supports multilingual Unicode text across scripts (CJK, Cyrillic, Arabic, Accents)', () => {
    const project = store.ensureProject({ name: 'i18n-test', rootPath: '/i18n', configPath: '/i18n/pluton.yaml', defaultBranch: 'main' })
    seedShip(store, project.id)
    const session = store.createChatSession({ projectId: project.id, title: 'i18n', shipId: 'supervisor' })

    store.appendChatMessage({
      sessionId: session.id,
      role: 'user',
      text: '多语言测试：自动化测试 验证记录。Тестирование системы прошло успешно. البحث باللغة العربية متاح.',
    })

    // Chinese token search
    const cjkHits = store.searchChatMessages('自动化测试')
    expect(cjkHits.length).toBe(1)
    expect(cjkHits[0]?.text).toContain('自动化测试')

    const cjkPrefixHits = store.searchChatMessages('多语言测试')
    expect(cjkPrefixHits.length).toBe(1)

    // Cyrillic search
    const cyrillicHits = store.searchChatMessages('Тестирование')
    expect(cyrillicHits.length).toBe(1)

    // Arabic search
    const arabicHits = store.searchChatMessages('العربية')
    expect(arabicHits.length).toBe(1)
  })

  it('enforces limit clamping bounds and BM25 relevance ordering', () => {
    const project = store.ensureProject({ name: 'limit-test', rootPath: '/limits', configPath: '/limits/pluton.yaml', defaultBranch: 'main' })
    seedShip(store, project.id)
    const session = store.createChatSession({ projectId: project.id, title: 'Limits', shipId: 'supervisor' })

    for (let i = 1; i <= 15; i++) {
      store.appendChatMessage({
        sessionId: session.id,
        role: 'user',
        text: `Cluster node report #${i}: telemetry metric status healthy and operational.`,
      })
    }

    // Negative or 0 limit clamps to 1
    expect(store.searchChatMessages('telemetry', { limit: 0 })).toHaveLength(1)
    expect(store.searchChatMessages('telemetry', { limit: -10 })).toHaveLength(1)

    // Specific bounded limit
    expect(store.searchChatMessages('telemetry', { limit: 5 })).toHaveLength(5)

    // Oversized limit clamps to 1000 without throwing
    const all = store.searchChatMessages('telemetry', { limit: 5000 })
    expect(all.length).toBe(15)

    // BM25 snippet validation
    expect(all[0]?.snippet).toContain('[telemetry]')
    expect(all[0]?.rank).toBeLessThanOrEqual(all[all.length - 1]?.rank ?? 0)
  })

  it('maintains FTS5 index consistency across direct UPDATE statements via au triggers', () => {
    const project = store.ensureProject({ name: 'update-test', rootPath: '/upd', configPath: '/upd/pluton.yaml', defaultBranch: 'main' })
    seedShip(store, project.id)
    const session = store.createChatSession({ projectId: project.id, title: 'Update', shipId: 'supervisor' })

    const msg = store.appendChatMessage({
      sessionId: session.id,
      role: 'user',
      text: 'Initial phrase before modification: alpha beta gamma.',
    })

    expect(store.searchChatMessages('alpha beta')).toHaveLength(1)
    expect(store.searchChatMessages('delta epsilon')).toHaveLength(0)

    // Directly update message in chat_messages table
    store.db.prepare('UPDATE chat_messages SET text = ? WHERE id = ?').run(
      'Updated phrase after modification: delta epsilon zeta.',
      msg.id,
    )

    // Old keywords no longer match
    expect(store.searchChatMessages('alpha beta')).toHaveLength(0)
    // New keywords match
    const updatedHits = store.searchChatMessages('delta epsilon')
    expect(updatedHits).toHaveLength(1)
    expect(updatedHits[0]?.text).toContain('delta epsilon zeta')
  })
})
