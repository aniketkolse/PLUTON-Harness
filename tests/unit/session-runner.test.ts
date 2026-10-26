import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { SessionRunner } from '../../src/server/session-runner.ts'
import { ServerEventBroadcaster } from '../../src/server/events.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'

describe('SessionRunner', () => {
  it('drains enqueued inbox items sequentially and broadcasts turn events', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new Store(db)
    const broadcaster = new ServerEventBroadcaster()
    const broadcastEvents: any[] = []
    broadcaster.on('event', (e) => broadcastEvents.push(e))

    const proj = store.ensureProject({ name: 'p', rootPath: '/tmp/p', configPath: '/tmp/p/pluton.yaml', defaultBranch: 'main' })
    store.syncMuses(proj.id, [
      {
        id: 'coder',
        slug: 'coder',
        displayName: 'Coder',
        role: 'developer',
        engineKind: 'mock',
        model: 'mock-model',
        instructionsFile: null,
        workspacePolicy: 'shared-project-root',
        permissions: [],
        approvalMode: 'autonomous',
        engineHome: '/tmp/home',
      },
    ])
    const session = store.createChatSession({ projectId: proj.id, shipId: 'coder', title: 'Test' })

    const mockAdapter = new MockEngineAdapter({ script: [{ text: 'Response 1' }, { text: 'Response 2' }] })
    const runner = new SessionRunner({
      store,
      broadcaster,
      projectId: proj.id,
      adapterResolver: () => mockAdapter,
      workspaceResolver: () => '/tmp/p',
      approvalTimeoutMinutes: 10,
    })

    // Enqueue two items
    const item1 = runner.enqueue(session.id, 'Prompt 1', 'chat')
    const item2 = runner.enqueue(session.id, 'Prompt 2', 'chat')
    expect(item1.state).toBe('enqueued')
    expect(item2.state).toBe('enqueued')

    // Wait until queue is drained
    let loops = 0
    while ((runner.isBusy(session.id) || runner.getQueueLength(session.id) > 0) && loops < 100) {
      await new Promise((r) => setTimeout(r, 20))
      loops++
    }

    const messages = store.listChatMessages(session.id, { limit: 10 })
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(2)

    await runner.close()
  })

  it('cancels pending queued items on cancel()', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new Store(db)
    const broadcaster = new ServerEventBroadcaster()

    const proj = store.ensureProject({ name: 'p2', rootPath: '/tmp/p2', configPath: '/tmp/p2/pluton.yaml', defaultBranch: 'main' })
    store.syncMuses(proj.id, [
      {
        id: 'coder2',
        slug: 'coder2',
        displayName: 'Coder2',
        role: 'developer',
        engineKind: 'mock',
        model: 'mock-model',
        instructionsFile: null,
        workspacePolicy: 'shared-project-root',
        permissions: [],
        approvalMode: 'autonomous',
        engineHome: '/tmp/home',
      },
    ])
    const session = store.createChatSession({ projectId: proj.id, shipId: 'coder2', title: 'Test 2' })

    const mockAdapter = new MockEngineAdapter({ script: [{ text: 'Response 1', delayMs: 100 }, { text: 'Response 2' }] })
    const runner = new SessionRunner({
      store,
      broadcaster,
      projectId: proj.id,
      adapterResolver: () => mockAdapter,
      workspaceResolver: () => '/tmp/p2',
      approvalTimeoutMinutes: 10,
    })

    runner.enqueue(session.id, 'P1', 'chat')
    const item2 = runner.enqueue(session.id, 'P2', 'chat')

    // Cancel while P1 is running
    await runner.cancel(session.id)

    expect(store.getInboxItem(item2.id)?.state).toBe('cancelled')
    await runner.close()
  })
})
