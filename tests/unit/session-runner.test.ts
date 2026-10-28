import { describe, expect, it, vi } from 'vitest'
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

  it('does not strand a prompt enqueued after the drain saw an empty queue', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new Store(db)
    const broadcaster = new ServerEventBroadcaster()
    const proj = store.ensureProject({ name: 'p3', rootPath: '/tmp/p3', configPath: '/tmp/p3/pluton.yaml', defaultBranch: 'main' })
    store.syncMuses(proj.id, [
      {
        id: 'coder3',
        slug: 'coder3',
        displayName: 'Coder3',
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
    const session = store.createChatSession({ projectId: proj.id, shipId: 'coder3', title: 'Race' })
    const mockAdapter = new MockEngineAdapter({ script: [{ text: 'Response 1' }, { text: 'Response 2' }] })
    const runner = new SessionRunner({
      store,
      broadcaster,
      projectId: proj.id,
      adapterResolver: () => mockAdapter,
      workspaceResolver: () => '/tmp/p3',
      approvalTimeoutMinutes: 10,
    })

    // Inject the second prompt at the exact race window: the drain has just
    // observed an empty queue, but its active marker is still set, so the
    // enqueue's wake() call returns early.
    const original = store.listPendingInbox.bind(store)
    let injected = false
    vi.spyOn(store, 'listPendingInbox').mockImplementation((sessionId: string) => {
      const rows = original(sessionId)
      if (!injected && rows.length === 0) {
        injected = true
        runner.enqueue(session.id, 'Racing prompt', 'chat')
      }
      return rows
    })

    runner.enqueue(session.id, 'First prompt', 'chat')
    let loops = 0
    while ((runner.isBusy(session.id) || runner.getQueueLength(session.id) > 0) && loops < 200) {
      await new Promise((r) => setTimeout(r, 10))
      loops++
    }

    expect(injected).toBe(true)
    const messages = store.listChatMessages(session.id)
    expect(messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
      'First prompt',
      'Racing prompt',
    ])
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(2)
    await runner.close()
  })

  it('fails the inbox row and keeps draining when turn persistence throws', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new Store(db)
    const broadcaster = new ServerEventBroadcaster()
    const events: Array<{ type: string; failed?: boolean }> = []
    broadcaster.on('event', (e) => events.push(e as { type: string; failed?: boolean }))
    const proj = store.ensureProject({ name: 'p4', rootPath: '/tmp/p4', configPath: '/tmp/p4/pluton.yaml', defaultBranch: 'main' })
    store.syncMuses(proj.id, [
      {
        id: 'coder4',
        slug: 'coder4',
        displayName: 'Coder4',
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
    const session = store.createChatSession({ projectId: proj.id, shipId: 'coder4', title: 'Failure' })
    const mockAdapter = new MockEngineAdapter({ script: [{ text: 'Response 1' }, { text: 'Response 2' }] })
    const runner = new SessionRunner({
      store,
      broadcaster,
      projectId: proj.id,
      adapterResolver: () => mockAdapter,
      workspaceResolver: () => '/tmp/p4',
      approvalTimeoutMinutes: 10,
    })

    const append = vi.spyOn(store, 'appendChatMessage')
    append.mockImplementationOnce(() => {
      throw new Error('simulated store failure')
    })

    const failedItem = runner.enqueue(session.id, 'Doomed', 'chat')
    let loops = 0
    while (runner.isBusy(session.id) && loops < 100) {
      await new Promise((r) => setTimeout(r, 10))
      loops++
    }
    expect(store.getInboxItem(failedItem.id)?.state).toBe('failed')
    expect(events.some((e) => e.type === 'turn_end' && e.failed === true)).toBe(true)

    // The runner must remain usable after a failed turn.
    append.mockRestore()
    runner.enqueue(session.id, 'Recovered', 'chat')
    loops = 0
    while ((runner.isBusy(session.id) || runner.getQueueLength(session.id) > 0) && loops < 100) {
      await new Promise((r) => setTimeout(r, 10))
      loops++
    }
    expect(store.listChatMessages(session.id).some((m) => m.text === 'Recovered')).toBe(true)
    await runner.close()
  })

  it('does not spin when the durable processing claim fails', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new Store(db)
    const broadcaster = new ServerEventBroadcaster()
    const proj = store.ensureProject({ name: 'p5', rootPath: '/tmp/p5', configPath: '/tmp/p5/pluton.yaml', defaultBranch: 'main' })
    store.syncMuses(proj.id, [
      {
        id: 'coder5',
        slug: 'coder5',
        displayName: 'Coder5',
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
    const session = store.createChatSession({ projectId: proj.id, shipId: 'coder5', title: 'Claim failure' })
    const mockAdapter = new MockEngineAdapter({ script: [{ text: 'Response 1' }, { text: 'Response 2' }] })
    const runner = new SessionRunner({
      store,
      broadcaster,
      projectId: proj.id,
      adapterResolver: () => mockAdapter,
      workspaceResolver: () => '/tmp/p5',
      approvalTimeoutMinutes: 10,
    })

    const originalUpdate = store.updateInboxState.bind(store)
    let claimAttempts = 0
    const updateSpy = vi.spyOn(store, 'updateInboxState').mockImplementation((id, state, processedAt) => {
      if (state === 'processing') {
        claimAttempts++
        if (claimAttempts === 1) throw new Error('simulated claim failure')
      }
      originalUpdate(id, state, processedAt)
    })

    const item = runner.enqueue(session.id, 'First prompt', 'chat')
    let loops = 0
    while (runner.isBusy(session.id) && loops < 100) {
      await new Promise((r) => setTimeout(r, 10))
      loops++
    }
    // Give a broken wake() loop a window to re-enter before asserting.
    await new Promise((r) => setTimeout(r, 50))
    expect(claimAttempts).toBe(1)
    expect(store.getInboxItem(item.id)?.state).toBe('enqueued')

    // The durable row is still there; the next prompt retries and drains both.
    runner.enqueue(session.id, 'Second prompt', 'chat')
    loops = 0
    while ((runner.isBusy(session.id) || runner.getQueueLength(session.id) > 0) && loops < 100) {
      await new Promise((r) => setTimeout(r, 10))
      loops++
    }
    expect(claimAttempts).toBe(3)
    expect(store.getInboxItem(item.id)?.state).toBe('delivered')
    expect(
      store.listChatMessages(session.id).filter((m) => m.role === 'user').map((m) => m.text),
    ).toEqual(['First prompt', 'Second prompt'])
    updateSpy.mockRestore()
    await runner.close()
  })

  it('does not downgrade a delivered row when a post-turn broadcast fails', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new Store(db)
    const broadcaster = new ServerEventBroadcaster()
    const proj = store.ensureProject({ name: 'p6', rootPath: '/tmp/p6', configPath: '/tmp/p6/pluton.yaml', defaultBranch: 'main' })
    store.syncMuses(proj.id, [
      {
        id: 'coder6',
        slug: 'coder6',
        displayName: 'Coder6',
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
    const session = store.createChatSession({ projectId: proj.id, shipId: 'coder6', title: 'Broadcast failure' })
    const mockAdapter = new MockEngineAdapter({ script: [{ text: 'Response 1' }] })
    const runner = new SessionRunner({
      store,
      broadcaster,
      projectId: proj.id,
      adapterResolver: () => mockAdapter,
      workspaceResolver: () => '/tmp/p6',
      approvalTimeoutMinutes: 10,
    })

    const originalBroadcast = broadcaster.broadcast.bind(broadcaster)
    let threw = false
    const broadcastSpy = vi.spyOn(broadcaster, 'broadcast').mockImplementation((event) => {
      if (!threw && event.type === 'turn_end') {
        threw = true
        throw new Error('simulated broadcast failure')
      }
      originalBroadcast(event)
    })

    const item = runner.enqueue(session.id, 'Prompt', 'chat')
    let loops = 0
    while (runner.isBusy(session.id) && loops < 100) {
      await new Promise((r) => setTimeout(r, 10))
      loops++
    }
    expect(threw).toBe(true)
    expect(store.getInboxItem(item.id)?.state).toBe('delivered')
    expect(store.listChatMessages(session.id).some((m) => m.text === 'Response 1')).toBe(true)
    broadcastSpy.mockRestore()
    await runner.close()
  })

  it('cancels pending inbox items when chat session is missing', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new Store(db)
    const broadcaster = new ServerEventBroadcaster()
    const proj = store.ensureProject({ name: 'p7', rootPath: '/tmp/p7', configPath: '/tmp/p7/pluton.yaml', defaultBranch: 'main' })
    store.syncMuses(proj.id, [
      {
        id: 'coder7',
        slug: 'coder7',
        displayName: 'Coder7',
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
    const session = store.createChatSession({ projectId: proj.id, shipId: 'coder7', title: 'Missing session' })
    const mockAdapter = new MockEngineAdapter({ script: [{ text: 'Response 1' }] })
    const runner = new SessionRunner({
      store,
      broadcaster,
      projectId: proj.id,
      adapterResolver: () => mockAdapter,
      workspaceResolver: () => '/tmp/p7',
      approvalTimeoutMinutes: 10,
    })

    const item = store.enqueueInboxItem({ sessionId: session.id, text: 'Prompt for deleted session', mode: 'chat' })
    const getSessionSpy = vi.spyOn(store, 'getChatSessionOrNull').mockReturnValue(null)

    await runner.wake(session.id)

    expect(store.getInboxItem(item.id)?.state).toBe('cancelled')
    getSessionSpy.mockRestore()
    await runner.close()
  })

  it('safely handles broadcaster failures during turn_start and token streaming', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new Store(db)
    const broadcaster = new ServerEventBroadcaster()
    const proj = store.ensureProject({ name: 'p8', rootPath: '/tmp/p8', configPath: '/tmp/p8/pluton.yaml', defaultBranch: 'main' })
    store.syncMuses(proj.id, [
      {
        id: 'coder8',
        slug: 'coder8',
        displayName: 'Coder8',
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
    const session = store.createChatSession({ projectId: proj.id, shipId: 'coder8', title: 'Safe broadcast' })
    const mockAdapter = new MockEngineAdapter({ script: [{ text: 'Response from mock' }] })
    const runner = new SessionRunner({
      store,
      broadcaster,
      projectId: proj.id,
      adapterResolver: () => mockAdapter,
      workspaceResolver: () => '/tmp/p8',
      approvalTimeoutMinutes: 10,
    })

    const broadcastSpy = vi.spyOn(broadcaster, 'broadcast').mockImplementation((event) => {
      if (event.type === 'turn_start' || event.type === 'token') {
        throw new Error('transient broadcast failure')
      }
    })

    const item = runner.enqueue(session.id, 'Prompt', 'chat')
    let loops = 0
    while ((runner.isBusy(session.id) || runner.getQueueLength(session.id) > 0) && loops < 100) {
      await new Promise((r) => setTimeout(r, 10))
      loops++
    }

    expect(store.getInboxItem(item.id)?.state).toBe('delivered')
    expect(store.listChatMessages(session.id).some((m) => m.text === 'Response from mock')).toBe(true)
    broadcastSpy.mockRestore()
    await runner.close()
  })

  it('broadcasts thought chunks and persists think tags in assistant messages', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new Store(db)
    const proj = store.ensureProject({ name: 'p', rootPath: '/tmp/p', configPath: '/tmp/p/pluton.yaml', defaultBranch: 'main' })
    store.syncShips(proj.id, [
      {
        id: 'thinker',
        slug: 'thinker',
        displayName: 'Thinker',
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
    const session = store.createChatSession({ projectId: proj.id, shipId: 'thinker', title: 'Thinking test' })
    const broadcaster = new ServerEventBroadcaster()
    const broadcastEvents: any[] = []
    broadcaster.on('event', (e) => broadcastEvents.push(e))

    const mockAdapter = new MockEngineAdapter({
      script: [
        {
          events: [
            { kind: 'thought', text: 'Considering possibilities...' },
            { kind: 'text', text: 'Here is the final answer.' },
          ],
        },
      ],
    })

    const runner = new SessionRunner({
      store,
      broadcaster,
      projectId: proj.id,
      adapterResolver: () => mockAdapter,
      workspaceResolver: () => '/tmp/p',
      approvalTimeoutMinutes: 10,
    })

    const item = runner.enqueue(session.id, 'Solve problem', 'chat')
    let loops = 0
    while ((runner.isBusy(session.id) || runner.getQueueLength(session.id) > 0) && loops < 100) {
      await new Promise((r) => setTimeout(r, 10))
      loops++
    }

    expect(store.getInboxItem(item.id)?.state).toBe('delivered')
    const thoughtBroadcast = broadcastEvents.find((e) => e.type === 'thought')
    expect(thoughtBroadcast).toBeDefined()
    expect(thoughtBroadcast?.text).toBe('Considering possibilities...')

    const messages = store.listChatMessages(session.id)
    const assistantMsg = messages.find((m) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.text).toContain('<think>')
    expect(assistantMsg?.text).toContain('Considering possibilities...')
    expect(assistantMsg?.text).toContain('Here is the final answer.')

    await runner.close()
  })
})
