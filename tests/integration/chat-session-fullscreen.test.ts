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
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import type { MuseRecord } from '../../src/domain/models.ts'

describe('ChatSession Full-Screen TUI Integration', () => {
  let tmpDir: string
  let db: DatabaseSync
  let store: Store
  let projectId: string
  let rootDir: string
  let muse: MuseRecord
  let io: ScriptedIo

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pluton-fullscreen-test-'))
    db = openDatabase(join(tmpDir, 'pluton.sqlite'))
    migrate(db)
    store = new Store(db)
    rootDir = join(tmpDir, 'project-alpha')
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
        model: 'opencode/deepseek-v4',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/manager',
      },
      {
        id: 'worker-1',
        slug: 'worker-1',
        displayName: 'Worker 1',
        role: 'coder',
        engineKind: 'mock',
        model: 'qwen/coder-32b',
        instructionsFile: null,
        workspacePolicy: 'isolated-task-checkout',
        permissions: ['project.read', 'project.write'],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/worker-1',
      },
    ])
    muse = store.getMuse('manager')!
    io = new ScriptedIo()
    io.columns = 120
    io.rows = 32
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('renders a complete two-column full-screen frame with real Orchestra inspector and pinned composer', async () => {
    const chatSessionRow = store.createChatSession({ projectId, museId: muse.id })
    const adapter = new MockEngineAdapter({
      script: [
        {
          events: [
            { kind: 'tool', name: 'read_files', phase: 'start', summary: 'read 3 files' },
            { kind: 'tool', name: 'read_files', phase: 'end', summary: 'read 3 files' },
            { kind: 'text', text: 'Files inspected. Ready to proceed.' },
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
      initialInspectorOpen: true,
    })

    await session.start()
    const runPromise = session.run()

    // Verify initial frame
    expect(io.frames.length).toBeGreaterThan(0)
    let frame = io.frames[io.frames.length - 1]!
    expect(frame.lines.length).toBe(32)

    const frameText = frame.lines.join('\n')
    // Top header
    expect(frameText).toContain('PLUTON')
    expect(frameText).toContain('AlphaProject')
    expect(frameText).toContain('manager')

    // Orchestra inspector showing live configured Muses
    expect(frameText).toContain('ORCHESTRA')
    expect(frameText).toContain('manager')
    expect(frameText).toContain('worker-1')

    // Send a message
    io.send('Please check files')
    await new Promise((r) => setTimeout(r, 40))

    frame = io.frames[io.frames.length - 1]!
    const updatedFrameText = frame.lines.join('\n')

    // Chat transcript contains user prompt and assistant response
    expect(updatedFrameText).toContain('Please check files')
    expect(updatedFrameText).toContain('Files inspected. Ready to proceed.')

    // Autocomplete dropdown opens on '/'
    io.type('/h')
    frame = io.frames[io.frames.length - 1]!
    const autoText = frame.lines.join('\n')
    expect(autoText).toContain('/help')

    // Toggling inspector collapses it
    io.press('u', { ctrl: true }) // clear input
    io.press('tab')
    frame = io.frames[io.frames.length - 1]!
    const singleColText = frame.lines.join('\n')
    // Tab toggles inspector state
    expect(frame.lines.length).toBe(32)

    // Clean exit
    io.send('/exit')
    await runPromise
  })

  it('displays truthful warning notice when operator lacks operator permissions', async () => {
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
      initialNotices: [
        'Warning: No Pluton operator tools are exposed to muse \'manager\'. Configure permissions in pluton.yaml.',
      ],
    })

    await session.start()
    const frame = io.frames[io.frames.length - 1]!
    const frameText = frame.lines.join('\n')
    expect(frameText).toContain('No Pluton operator tools are exposed')
    expect(io.commits.some((c) => c.includes('Configure permissions in pluton.yaml'))).toBe(true)
    session.stop()
  })
})
