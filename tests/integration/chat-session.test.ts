import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { ScriptedIo } from '../helpers/scripted-io.ts'
import { ChatSession } from '../../src/chat/session.ts'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import type { MuseRecord } from '../../src/domain/models.ts'

describe('ChatSession interactive loop', () => {
  let tmpDir: string
  let db: DatabaseSync
  let store: Store
  let projectId: string
  let rootDir: string
  let muse: MuseRecord
  let io: ScriptedIo

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pluton-chat-session-'))
    db = openDatabase(join(tmpDir, 'pluton.sqlite'))
    migrate(db)
    store = new Store(db)
    rootDir = join(tmpDir, 'proj')
    const proj = store.ensureProject({
      name: 'chat-test-proj',
      rootPath: rootDir,
      configPath: join(rootDir, 'pluton.yaml'),
      defaultBranch: 'main',
    })
    projectId = proj.id

    store.syncMuses(projectId, [
      {
        id: 'operator-muse',
        slug: 'operator',
        displayName: 'Operator',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/model-1',
        instructionsFile: null,
        workspacePolicy: 'shared-project-root',
        permissions: [...PERMISSIONS],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/operator',
      },
    ])
    muse = store.getMuse('operator-muse')!
    io = new ScriptedIo()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs a full turn: commits header, user block, streams text, commits assistant block and persists messages', async () => {
    const chatSessionRow = store.createChatSession({ projectId, museId: muse.id })
    const adapter = new MockEngineAdapter({
      script: [
        {
          events: [
            { kind: 'text', text: 'Hello ' },
            { kind: 'text', text: 'operator!' },
          ],
          outcome: 'success',
        },
      ],
    })

    const session = new ChatSession({
      store,
      projectId,
      rootDir,
      muse,
      adapter,
      io,
      session: chatSessionRow,
      mcpServers: [],
    })

    await session.start()
    expect(io.commits.length).toBeGreaterThan(0) // Header committed
    expect(io.commits[0]).toContain('Pluton Chat')

    const runPromise = session.run()

    // Send user message
    io.send('Hello muse')

    // Allow async turn to process
    await new Promise((r) => setTimeout(r, 20))

    // Check commits: header, user input (> Hello muse), assistant response (Hello operator!)
    expect(io.commits.some((c) => c.includes('> Hello muse'))).toBe(true)
    expect(io.commits.some((c) => c.includes('Hello operator!'))).toBe(true)

    // Check persisted messages
    const msgs = store.listChatMessages(chatSessionRow.id)
    expect(msgs.length).toBe(2)
    expect(msgs[0]?.role).toBe('user')
    expect(msgs[0]?.text).toBe('Hello muse')
    expect(msgs[1]?.role).toBe('assistant')
    expect(msgs[1]?.text).toBe('Hello operator!')
    expect(msgs[1]?.meta).toMatchObject({ outcome: 'success', interrupted: false })

    // Exit
    io.press('d', { ctrl: true })
    const exitCode = await runPromise
    expect(exitCode).toBe(0)
  })

  it('handles busy queue: queues second prompt entered while streaming and sends it after first finishes', async () => {
    const chatSessionRow = store.createChatSession({ projectId, museId: muse.id })
    const adapter = new MockEngineAdapter({
      script: [
        {
          delayMs: 50,
          text: 'First response',
          outcome: 'success',
        },
        {
          text: 'Second response',
          outcome: 'success',
        },
      ],
    })

    const session = new ChatSession({
      store,
      projectId,
      rootDir,
      muse,
      adapter,
      io,
      session: chatSessionRow,
      mcpServers: [],
    })

    await session.start()
    const runPromise = session.run()

    // Send first prompt
    io.send('prompt 1')

    // While busy (during delayMs: 50), send second prompt
    io.send('prompt 2')

    // Wait for both to finish
    await new Promise((r) => setTimeout(r, 120))

    const msgs = store.listChatMessages(chatSessionRow.id)
    expect(msgs.length).toBe(4)
    expect(msgs[0]?.text).toBe('prompt 1')
    expect(msgs[1]?.text).toBe('First response')
    expect(msgs[2]?.text).toBe('prompt 2')
    expect(msgs[3]?.text).toBe('Second response')

    io.press('d', { ctrl: true })
    await runPromise
  })

  it('interrupts turn with Escape: marks block interrupted and records in meta', async () => {
    const chatSessionRow = store.createChatSession({ projectId, museId: muse.id })
    const adapter = new MockEngineAdapter({
      script: [
        {
          delayMs: 200,
          events: [{ kind: 'text', text: 'Starting to work...' }],
        },
      ],
    })

    const session = new ChatSession({
      store,
      projectId,
      rootDir,
      muse,
      adapter,
      io,
      session: chatSessionRow,
      mcpServers: [],
    })

    await session.start()
    const runPromise = session.run()

    io.send('long calculation')
    // Wait a brief tick for stream to yield partial text
    await new Promise((r) => setTimeout(r, 30))

    // Interrupt with Escape
    io.press('escape')

    await new Promise((r) => setTimeout(r, 50))

    const msgs = store.listChatMessages(chatSessionRow.id)
    expect(msgs.length).toBe(2)
    expect(msgs[0]?.text).toBe('long calculation')
    expect(msgs[1]?.role).toBe('assistant')
    expect(msgs[1]?.meta).toMatchObject({ interrupted: true })

    io.press('d', { ctrl: true })
    await runPromise
  })

  it('resumes previous session: passes resumeToken to adapter and commits stored transcript', async () => {
    const chatSessionRow = store.createChatSession({ projectId, museId: muse.id })
    store.updateChatSession(chatSessionRow.id, {
      resumeToken: 'token_saved_previously',
    })
    store.appendChatMessage({ sessionId: chatSessionRow.id, role: 'user', text: 'prior question' })
    store.appendChatMessage({ sessionId: chatSessionRow.id, role: 'assistant', text: 'prior answer' })

    let capturedResumeToken: string | undefined
    const adapter = new MockEngineAdapter({
      onStartSession: (req) => {
        capturedResumeToken = req.resumeToken
      },
    })

    const session = new ChatSession({
      store,
      projectId,
      rootDir,
      muse,
      adapter,
      io,
      session: chatSessionRow,
      resumeToken: 'token_saved_previously',
      mcpServers: [],
    })

    await session.start()
    expect(capturedResumeToken).toBe('token_saved_previously')

    // Stored transcript should be re-rendered in commits
    expect(io.commits.some((c) => c.includes('prior question'))).toBe(true)
    expect(io.commits.some((c) => c.includes('prior answer'))).toBe(true)
  })

  it('runs poll tick: commits notice lines and updates status view', async () => {
    const chatSessionRow = store.createChatSession({ projectId, museId: muse.id })
    const adapter = new MockEngineAdapter()

    let pollCount = 0
    const poll = async () => {
      pollCount++
      return {
        events: [{ seq: 1, type: 'task.settled', line: 'Task 1 settled' }],
        run: { id: 'run_active', state: 'active' },
        approvalsPending: 1,
        notices: ['Notice from poll'],
      }
    }

    const session = new ChatSession({
      store,
      projectId,
      rootDir,
      muse,
      adapter,
      io,
      session: chatSessionRow,
      mcpServers: [],
      poll,
      pollIntervalMs: 50,
    })

    await session.start()
    const runPromise = session.run()

    await new Promise((r) => setTimeout(r, 120))
    expect(pollCount).toBeGreaterThan(0)
    expect(io.commits.some((c) => c.includes('Notice from poll'))).toBe(true)
    expect(io.commits.some((c) => c.includes('Task 1 settled'))).toBe(true)

    io.press('d', { ctrl: true })
    await runPromise
  })
})
