import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'

describe('Session Inbox Store', () => {
  it('applies Migration 11 and manages inbox lifecycle', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new Store(db)

    const proj = store.ensureProject({
      name: 'test',
      rootPath: '/tmp/test',
      configPath: '/tmp/test/pluton.yaml',
      defaultBranch: 'main',
    })
    store.syncMuses(proj.id, [
      {
        id: 'supervisor',
        slug: 'supervisor',
        displayName: 'Supervisor',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock-model',
        instructionsFile: null,
        workspacePolicy: 'shared-project-root',
        permissions: [],
        approvalMode: 'autonomous',
        engineHome: '/tmp/home',
      },
    ])
    const session = store.createChatSession({
      projectId: proj.id,
      shipId: 'supervisor',
      title: 'Inbox Test',
    })

    // Enqueue
    const item1 = store.enqueueInboxItem({ sessionId: session.id, text: 'First prompt', mode: 'chat' })
    const item2 = store.enqueueInboxItem({ sessionId: session.id, text: 'Second prompt', mode: 'plan' })
    expect(item1.seq).toBe(1)
    expect(item2.seq).toBe(2)
    expect(item1.state).toBe('enqueued')

    // List pending
    const pending = store.listPendingInbox(session.id)
    expect(pending).toHaveLength(2)
    expect(pending[0]!.text).toBe('First prompt')

    // Update state
    store.updateInboxState(item1.id, 'processing')
    expect(store.getInboxItem(item1.id)?.state).toBe('processing')

    // Cancel pending
    const cancelledCount = store.cancelPendingInbox(session.id)
    expect(cancelledCount).toBe(1) // item2 was enqueued, item1 was processing
    expect(store.getInboxItem(item2.id)?.state).toBe('cancelled')
  })
})
