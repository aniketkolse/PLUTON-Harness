import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { ScriptedIo } from '../helpers/scripted-io.ts'
import { ChatSession } from '../../src/chat/session.ts'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import type { MuseRecord } from '../../src/domain/models.ts'
import { stripAnsi } from '../../src/tui/width.ts'

describe('ChatSession TUI 2.0 Presentation Integration', () => {
  let tmpDir: string
  let db: DatabaseSync
  let store: Store
  let projectId: string
  let rootDir: string
  let muse: MuseRecord
  let io: ScriptedIo

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pluton-ui-integration-test-'))
    db = openDatabase(join(tmpDir, 'pluton.sqlite'))
    migrate(db)
    store = new Store(db)
    rootDir = tmpDir

    const proj = store.ensureProject({
      name: 'AlphaProject',
      rootPath: rootDir,
      configPath: join(rootDir, 'pluton.yaml'),
      defaultBranch: 'main',
    })
    projectId = proj.id

    store.syncMuses(projectId, [
      {
        id: 'manager',
        slug: 'manager',
        displayName: 'Manager',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock-model',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/manager',
      },
    ])
    muse = store.getMuse('manager')!

    io = new ScriptedIo()
    io.columns = 129
    io.rows = 48
  })

  it('renders user and assistant turns with TUI 2.0 identity labels and formatting', async () => {
    const chatSessionRow = store.createChatSession({ projectId, museId: muse.id })
    const adapter = new MockEngineAdapter({
      script: [
        {
          events: [
            { kind: 'tool', phase: 'start', name: 'shell', callId: 'c1', input: { command: 'git status' } },
            { kind: 'tool', phase: 'end', name: 'shell', callId: 'c1', isError: false, output: 'clean' },
            { kind: 'usage', inputTokens: 1200, outputTokens: 300, costUsd: 0.04 },
            { kind: 'text', text: 'Everything looks clean and ready.' },
          ],
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

    io.send('Analyze code')
    await new Promise((r) => setTimeout(r, 60))

    const frame = io.frames[io.frames.length - 1]!
    const frameText = stripAnsi(frame.lines.join('\n'))

    // 1. User Message formatted with UserMessage component (👤 You or > You)
    expect(frameText).toMatch(/(?:👤|>)\s*You\s+Analyze code/)

    // 2. Assistant Message formatted with AssistantMessage component (⛵ PLUTON or [SHIP] PLUTON)
    expect(frameText).toMatch(/(?:⛵|\[SHIP\])\s*PLUTON/)
    expect(frameText).toContain('Everything looks clean and ready.')

    // 3. Docked rounded InputBox rendered with borders
    expect(frameText).toContain('╭')
    expect(frameText).toContain('╰')

    // 4. Live status bar shows only real telemetry: the cost an engine
    // actually reported, and "unknown" context (no engine reports a real
    // context window — never fabricate one; G5 / PR-2).
    expect(frameText).toContain('Context: unknown')
    expect(frameText).toContain('$0.04')
    expect(frameText).not.toContain('Context: 0%')
    expect(frameText).not.toContain('$0.00')

    // 5. Zero duplicate session header noise in transcript
    expect(frameText).not.toContain('session chat_')

    // Clean exit
    io.send('/exit')
    await runPromise
  })

  it('renders pinned actionable approval card when approval is pending', async () => {
    const chatSessionRow = store.createChatSession({ projectId, museId: muse.id })
    const adapter = new MockEngineAdapter({ script: [] })

    const session = new ChatSession({
      store,
      projectId,
      rootDir,
      muse,
      adapter,
      io,
      session: chatSessionRow,
      mcpServers: [],
      pollIntervalMs: 50,
      poll: async () => ({
        events: [],
        run: null,
        notices: [],
        approvalsPending: 1,
        approvals: [
          {
            id: 'appr-abc',
            action: 'Execute shell command',
            reason: 'Run npm test in workspace',
            target: 'workspace',
            requestedByMuse: 'manager',
          },
        ],
      }),
    })

    await session.start()
    const runPromise = session.run()

    // Trigger poll tick
    await new Promise((r) => setTimeout(r, 100))

    const frame = io.frames[io.frames.length - 1]!
    const frameText = stripAnsi(frame.lines.join('\n'))

    // Actionable approval card should be pinned above composer
    expect(frameText).toContain('APPROVAL REQUIRED')
    expect(frameText).toContain('Execute shell command')
    expect(frameText).toContain('[A] Approve once')
    expect(frameText).toContain('[D] Deny')
    expect(frameText).toContain('[V] View details')

    // Clean exit
    io.send('/exit')
    await runPromise
  })
})
