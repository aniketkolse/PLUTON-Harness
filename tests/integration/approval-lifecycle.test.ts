import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { ScriptedIo } from '../helpers/scripted-io.ts'
import { ChatSession } from '../../src/chat/session.ts'
import { stripAnsi } from '../../src/tui/width.ts'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import type { MuseRecord, ApprovalRecord } from '../../src/domain/models.ts'
import type { SlashContext } from '../../src/chat/commands.ts'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Card title marker: box-drawing char + title (unicode or ASCII fallback). */
const CARD_TITLE = /^[┌+]/

function cardCount(frameLines: string[]): number {
  return frameLines
    .map((l) => stripAnsi(l).trimStart())
    .filter((l) => CARD_TITLE.test(l) && l.includes('APPROVAL REQUIRED')).length
}

describe('approval lifecycle in the chat transcript', () => {
  let tmpDir: string
  let db: DatabaseSync
  let store: Store
  let projectId: string
  let rootDir: string
  let muse: MuseRecord

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pluton-approval-lifecycle-'))
    db = openDatabase(join(tmpDir, 'pluton.sqlite'))
    migrate(db)
    store = new Store(db)
    rootDir = join(tmpDir, 'proj')
    const proj = store.ensureProject({
      name: 'approval-test-proj',
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
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedPendingApproval(): ApprovalRecord {
    return store.createApproval({
      projectId,
      runId: null,
      taskId: null,
      requestedByMuseId: muse.id,
      action: 'integration.apply',
      reason: 'Apply protected-path changes in the repository',
      scope: { target: 'src/auth/session.ts' },
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
  }

  /** Mirrors chat.ts defaultPoll: pending records straight from the store. */
  function makePoll() {
    return async () => {
      const pending = store.listApprovalsByProject(projectId, { status: 'pending', limit: 100 })
      return {
        events: [] as Array<{ seq: number; type: string; line: string }>,
        run: null,
        approvalsPending: pending.length,
        approvals: pending.map((a) => ({
          id: a.id,
          action: a.action,
          reason: a.reason,
          ...(a.requestedByMuseId ? { requestedByMuse: a.requestedByMuseId } : {}),
          scope: a.scope,
          status: a.status,
          runId: a.runId,
          taskId: a.taskId,
          expiresAt: a.expiresAt,
        })),
        notices: [] as string[],
      }
    }
  }

  async function startSession(
    io: ScriptedIo,
    opts: {
      adapter?: MockEngineAdapter
      slashContext: SlashContext
      pollIntervalMs?: number
    },
  ): Promise<{ session: ChatSession; runPromise: Promise<number> }> {
    const chatSessionRow = store.createChatSession({ projectId, museId: muse.id })
    const session = new ChatSession({
      store,
      projectId,
      rootDir,
      muse,
      adapter: opts.adapter ?? new MockEngineAdapter(),
      io,
      session: chatSessionRow,
      mcpServers: [],
      poll: makePoll(),
      pollIntervalMs: opts.pollIntervalMs ?? 30,
      slashContext: opts.slashContext,
    })
    await session.start()
    const runPromise = session.run()
    return { session, runPromise }
  }

  function baseSlashContext(approveImpl: (ref: string) => Promise<string>, denyImpl: (ref: string) => Promise<string>): SlashContext {
    return {
      session: { id: 'chat_placeholder' },
      muse: { id: muse.id, slug: muse.slug },
      status: async () => 'status',
      runs: async () => 'runs',
      approvalsList: async () => 'approvals',
      approve: approveImpl,
      deny: denyImpl,
      startRun: async () => 'started',
      newSession: async () => 'new session',
      help: () => 'help',
    }
  }

  it('renders one canonical card for a real pending approval and never leaks raw lifecycle text', async () => {
    seedPendingApproval()
    const io = new ScriptedIo()
    const { runPromise } = await startSession(io, {
      slashContext: baseSlashContext(async () => 'noop', async () => 'noop'),
    })

    await wait(160)

    const latest = io.frames[io.frames.length - 1]
    expect(latest, 'a frame should have been rendered').toBeDefined()
    const latestText = stripAnsi(latest!.lines.join('\n'))

    // One canonical card, with real record data.
    expect(cardCount(latest!.lines)).toBe(1)
    expect(latestText).toContain('integration.apply')
    expect(latestText).toContain('Apply protected-path changes in the repository')
    expect(latestText).toContain('src/auth/session.ts')
    expect(latestText).toContain('[A] Approve once')
    expect(latestText).toContain('[D] Deny')
    expect(latestText).toContain('[V] View details')

    // The footer flags required action.
    expect(latestText).toContain('APPROVAL REQUIRED')

    // No raw lifecycle text was ever committed to the transcript.
    const allCommits = io.commits.join('\n')
    expect(allCommits).not.toContain('approval pending:')
    expect(allCommits).not.toContain('approval.request')
    expect(allCommits).not.toContain('APPROVAL REQUIRED')

    io.press('d', { ctrl: true })
    await runPromise
  })

  it('keeps one card across duplicate poll deliveries', async () => {
    seedPendingApproval()
    const io = new ScriptedIo()
    const { runPromise } = await startSession(io, {
      slashContext: baseSlashContext(async () => 'noop', async () => 'noop'),
    })

    await wait(200) // several poll ticks with the same pending record

    const latest = io.frames[io.frames.length - 1]
    expect(latest).toBeDefined()
    expect(cardCount(latest!.lines)).toBe(1)

    io.press('d', { ctrl: true })
    await runPromise
  })

  it('approve invokes the backend op and the card stays until the record is confirmed decided', async () => {
    const approval = seedPendingApproval()
    const io = new ScriptedIo()
    const approveCalls: string[] = []
    const { runPromise } = await startSession(io, {
      slashContext: baseSlashContext(
        async (ref) => {
          approveCalls.push(ref)
          // Simulate a decision that the backend has not confirmed yet: the
          // record stays pending, so the card must remain.
          return `approval ${ref} decision submitted`
        },
        async () => 'noop',
      ),
    })

    await wait(160)
    io.type('a')

    await wait(160)
    expect(approveCalls).toEqual([approval.id])

    let latest = io.frames[io.frames.length - 1]!
    // Uncertain outcome: record still pending -> card remains.
    expect(cardCount(latest.lines)).toBe(1)

    // Backend confirms the decision; next poll tick reconciles the card away.
    store.setApprovalStatus(approval.id, 'approved', { decidedBy: 'operator' })
    await wait(160)

    latest = io.frames[io.frames.length - 1]!
    expect(cardCount(latest.lines)).toBe(0)
    const latestText = stripAnsi(latest.lines.join('\n'))
    expect(latestText).not.toContain('APPROVAL REQUIRED')

    io.press('d', { ctrl: true })
    await runPromise
  })

  it('deny calls the backend denial op and the card disappears after the record is decided', async () => {
    const approval = seedPendingApproval()
    const io = new ScriptedIo()
    const denyCalls: string[] = []
    const { runPromise } = await startSession(io, {
      slashContext: baseSlashContext(
        async () => 'noop',
        async (ref) => {
          denyCalls.push(ref)
          store.setApprovalStatus(ref, 'denied', { decidedBy: 'operator' })
          return `approval ${ref} denied`
        },
      ),
    })

    await wait(160)
    io.type('d')

    await wait(160)
    expect(denyCalls).toEqual([approval.id])
    expect(store.getApproval(approval.id).status).toBe('denied')

    const latest = io.frames[io.frames.length - 1]!
    expect(cardCount(latest.lines)).toBe(0)

    io.press('d', { ctrl: true })
    await runPromise
  })

  it('view details opens a read-only overlay and never decides the approval', async () => {
    const approval = seedPendingApproval()
    const io = new ScriptedIo()
    const approveCalls: string[] = []
    const { runPromise } = await startSession(io, {
      slashContext: baseSlashContext(
        async (ref) => {
          approveCalls.push(ref)
          return 'noop'
        },
        async () => 'noop',
      ),
    })

    await wait(160)
    io.type('v')
    await wait(80)

    let latest = io.frames[io.frames.length - 1]!
    const detailsText = stripAnsi(latest.lines.join('\n'))
    expect(detailsText).toContain('APPROVAL DETAILS')
    expect(detailsText).toContain('read-only')
    expect(detailsText).toContain(approval.id)

    // Details view never approves: record still pending, no backend call made.
    expect(store.getApproval(approval.id).status).toBe('pending')
    expect(approveCalls).toEqual([])

    // Esc dismisses the overlay first without touching the approval.
    io.press('escape')
    await wait(80)
    latest = io.frames[io.frames.length - 1]!
    expect(stripAnsi(latest.lines.join('\n'))).not.toContain('APPROVAL DETAILS')
    expect(store.getApproval(approval.id).status).toBe('pending')

    io.press('d', { ctrl: true })
    await runPromise
  })

  it('engine-level permission requests surface as one honest notice, not an actionable card', async () => {
    const io = new ScriptedIo()
    const adapter = new MockEngineAdapter({
      script: [
        {
          events: [
            {
              kind: 'approval_request',
              requestId: 'req_engine_1',
              description: 'engine requested permission: run bash command',
            },
          ],
          text: 'Acknowledged.',
          outcome: 'success',
        },
      ],
    })
    const approveCalls: string[] = []
    const { runPromise } = await startSession(io, {
      adapter,
      slashContext: baseSlashContext(
        async (ref) => {
          approveCalls.push(ref)
          return 'noop'
        },
        async () => 'noop',
      ),
    })

    await wait(60)
    io.send('please run the test suite')
    await wait(120)

    const allCommits = io.commits.join('\n')
    expect(allCommits).toContain('engine permission request')
    expect(allCommits).toContain('req_engine_1')
    // Not rendered as an actionable approval card anywhere.
    expect(allCommits).not.toContain('[A] Approve once')
    for (const f of io.frames) {
      expect(cardCount(f.lines)).toBe(0)
    }

    // Pressing A must not invoke any backend approval operation. With no card
    // present it is plain typing, so the stray character is cleared after.
    io.type('a')
    await wait(60)
    expect(approveCalls).toEqual([])
    io.press('backspace')

    io.press('d', { ctrl: true })
    await runPromise
  })
})
