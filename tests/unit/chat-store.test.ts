import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, setUserVersion, type DatabaseSync } from '../../src/store/db.ts'
import { migrate, SCHEMA_VERSION } from '../../src/store/migrations.ts'
import { MAX_CHAT_MESSAGE_CHARS, Store } from '../../src/store/store.ts'
import { InternalError, NotFoundError } from '../../src/domain/errors.ts'

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

function tmpDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pluton-chat-store-${name}-`))
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

/** Project + one supervisor Muse — the operator chat's default target. */
function seed(name: string): { store: Store; projectId: string } {
  const { store } = freshStore(name)
  const root = join(tmpdir(), `pluton-chat-root-${name}`)
  const project = store.ensureProject({
    name: 'test',
    rootPath: root,
    configPath: join(root, 'pluton.yaml'),
    defaultBranch: 'main',
  })
  store.syncMuses(project.id, [
    {
      id: 'operator',
      slug: 'operator',
      displayName: 'Operator',
      role: 'supervisor',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'shared-project-root',
      permissions: ['project.status'],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/operator',
    },
  ])
  return { store, projectId: project.id }
}

afterEach(() => {
  vi.useRealTimers()
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

describe('chat migrations', () => {
  it('migrates a fresh database to v3 and creates the chat tables', () => {
    const path = tmpDbPath('mig')
    const db = openDatabase(path)
    openDbs.push(db)
    const result = migrate(db)
    expect(SCHEMA_VERSION).toBe(10)
    expect(result.to).toBe(10)
    expect(result.applied).toEqual([
      'v1:initial-schema',
      'v2:unique-sandbox-and-terminal-per-muse',
      'v3:chat-sessions',
      'v4:plans',
      'v5:multi-agent-reliability',
      'v6:task-assignment-snapshot',
      'v7:run-supervisor-ownership',
      'v8:muse-to-ship-terminology',
      'v9:session-workspaces',
      'v10:native-execution-sessions',
    ])
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chat_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(tables).toEqual(['chat_messages', 'chat_sessions'])
  })

  it('refuses a database whose schema version is newer than this build (a v3 DB on an older build)', () => {
    const path = tmpDbPath('newer')
    const db = openDatabase(path)
    openDbs.push(db)
    setUserVersion(db, SCHEMA_VERSION + 1)
    expect(() => migrate(db)).toThrow(InternalError)
    expect(() => migrate(db)).toThrow(/newer than this build/)
  })
})

describe('chat sessions', () => {
  it('create/get round-trips every field', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { store, projectId } = seed('session-roundtrip')
    const created = store.createChatSession({ projectId, museId: 'operator', title: 'first chat' })
    expect(created.id).toMatch(/^chat_/)
    expect(created).toEqual({
      id: created.id,
      projectId,
      shipId: 'operator',
      museId: 'operator',
      title: 'first chat',
      state: 'active',
      nativeSessionId: null,
      resumeToken: null,
      engineSessionId: null,
      workspaceRoot: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(store.getChatSession(created.id)).toEqual(created)
    expect(store.getChatSessionOrNull(created.id)).toEqual(created)
  })

  it('update patches only the named fields (undefined leaves, null clears) and bumps updatedAt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { store, projectId } = seed('session-update')
    const created = store.createChatSession({ projectId, museId: 'operator', title: 'first' })

    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'))
    const updated = store.updateChatSession(created.id, {
      title: null,
      state: 'closed',
      nativeSessionId: 'nat-1',
      resumeToken: 'tok-1',
      engineSessionId: 'eng-1',
    })
    expect(updated).toEqual({
      ...created,
      title: null,
      state: 'closed',
      nativeSessionId: 'nat-1',
      resumeToken: 'tok-1',
      engineSessionId: 'eng-1',
      updatedAt: '2026-01-01T00:05:00.000Z',
    })

    vi.setSystemTime(new Date('2026-01-01T00:06:00.000Z'))
    const partial = store.updateChatSession(created.id, { title: 'renamed' })
    expect(partial.title).toBe('renamed')
    expect(partial.state).toBe('closed')
    expect(partial.nativeSessionId).toBe('nat-1')
    expect(partial.resumeToken).toBe('tok-1')
    expect(partial.engineSessionId).toBe('eng-1')
    expect(partial.updatedAt).toBe('2026-01-01T00:06:00.000Z')
  })

  it('missing ids throw NotFoundError (get and update); OrNull returns null', () => {
    const { store } = seed('session-missing')
    expect(store.getChatSessionOrNull('chat_missing00000000')).toBeNull()
    expect(() => store.getChatSession('chat_missing00000000')).toThrow(NotFoundError)
    expect(() => store.updateChatSession('chat_missing00000000', { title: 'x' })).toThrow(NotFoundError)
  })

  it('getLatestChatSession returns the most recently updated session for (project, muse)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { store, projectId } = seed('session-latest')
    const a = store.createChatSession({ projectId, museId: 'operator', title: 'a' })
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'))
    const b = store.createChatSession({ projectId, museId: 'operator', title: 'b' })
    expect(store.getLatestChatSession(projectId, 'operator')!.id).toBe(b.id)

    // Updating the older session makes it the latest again.
    vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'))
    store.updateChatSession(a.id, { title: 'a2' })
    expect(store.getLatestChatSession(projectId, 'operator')!.id).toBe(a.id)

    // Another muse has no sessions.
    expect(store.getLatestChatSession(projectId, 'worker-a')).toBeNull()
  })

  it('getLatestChatSession breaks updated_at ties by id DESC', () => {
    const { store, projectId } = seed('session-tie')
    const a = store.createChatSession({ projectId, museId: 'operator', title: 'a' })
    const b = store.createChatSession({ projectId, museId: 'operator', title: 'b' })
    store.db
      .prepare('UPDATE chat_sessions SET updated_at = ? WHERE id IN (?, ?)')
      .run('2026-01-01T00:00:00.000Z', a.id, b.id)
    const expected = a.id > b.id ? a.id : b.id
    expect(store.getLatestChatSession(projectId, 'operator')!.id).toBe(expected)
  })
})

describe('chat messages', () => {
  it('appendChatMessage assigns monotonic per-session seqs, even within one timestamp tick', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z')) // frozen: all appends share one timestamp
    const { store, projectId } = seed('messages-seq')
    const session = store.createChatSession({ projectId, museId: 'operator' })
    const m1 = store.appendChatMessage({ sessionId: session.id, role: 'user', text: 'one' })
    const m2 = store.appendChatMessage({ sessionId: session.id, role: 'assistant', text: 'two' })
    const m3 = store.appendChatMessage({ sessionId: session.id, role: 'tool', text: 'three', meta: { tool: 'project.status' } })
    expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 2, 3])
    expect(m1.id).toMatch(/^msg_/)
    expect(m1).toMatchObject({ sessionId: session.id, role: 'user', text: 'one', meta: {} })
    expect(m3.meta).toEqual({ tool: 'project.status' })
    expect(m1.createdAt).toBe('2026-01-01T00:00:00.000Z')

    // Seqs are per-session: a second session starts again at 1.
    const other = store.createChatSession({ projectId, museId: 'operator' })
    expect(store.appendChatMessage({ sessionId: other.id, role: 'user', text: 'x' }).seq).toBe(1)
  })

  it('listChatMessages returns messages in seq order and keeps the newest limit as a tail', () => {
    const { store, projectId } = seed('messages-list')
    const session = store.createChatSession({ projectId, museId: 'operator' })
    for (let i = 1; i <= 5; i++) {
      store.appendChatMessage({ sessionId: session.id, role: 'user', text: `m${i}` })
    }
    expect(store.listChatMessages(session.id).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
    expect(store.listChatMessages(session.id, { limit: 3 }).map((m) => m.seq)).toEqual([3, 4, 5])
    expect(store.listChatMessages(session.id).map((m) => m.text)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
  })

  it('appending a message bumps the session updatedAt (so --continue picks the active session)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { store, projectId } = seed('messages-bump')
    const session = store.createChatSession({ projectId, museId: 'operator' })
    vi.setSystemTime(new Date('2026-01-01T00:03:00.000Z'))
    store.appendChatMessage({ sessionId: session.id, role: 'user', text: 'hi' })
    expect(store.getChatSession(session.id).updatedAt).toBe('2026-01-01T00:03:00.000Z')
  })

  it('appendChatMessage refuses an unknown session with NotFoundError', () => {
    const { store } = seed('messages-missing')
    expect(() => store.appendChatMessage({ sessionId: 'chat_missing00000000', role: 'user', text: 'x' })).toThrow(
      NotFoundError,
    )
  })

  it('truncates text over the cap with a marker and records truncatedChars in meta', () => {
    const { store, projectId } = seed('messages-truncate')
    const session = store.createChatSession({ projectId, museId: 'operator' })
    const over = MAX_CHAT_MESSAGE_CHARS + 25
    const m = store.appendChatMessage({ sessionId: session.id, role: 'assistant', text: 'x'.repeat(over) })
    expect(m.text.startsWith('x'.repeat(MAX_CHAT_MESSAGE_CHARS))).toBe(true)
    expect(m.text.endsWith('\n… [truncated 25 chars]')).toBe(true)
    expect(m.meta).toEqual({ truncatedChars: 25 })

    // Existing meta keys survive next to the marker.
    const withMeta = store.appendChatMessage({
      sessionId: session.id,
      role: 'tool',
      text: 'y'.repeat(over),
      meta: { tool: 'run.list' },
    })
    expect(withMeta.meta).toEqual({ tool: 'run.list', truncatedChars: 25 })

    // Exactly at the cap is untouched.
    const exact = store.appendChatMessage({
      sessionId: session.id,
      role: 'assistant',
      text: 'z'.repeat(MAX_CHAT_MESSAGE_CHARS),
    })
    expect(exact.text.length).toBe(MAX_CHAT_MESSAGE_CHARS)
    expect(exact.meta).toEqual({})
  })
})
