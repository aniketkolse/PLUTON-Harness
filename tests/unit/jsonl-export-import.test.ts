import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import {
  exportSessionToJsonl,
  importSessionFromJsonl,
  exportRunToJsonl,
  importRunFromJsonl,
} from '../../src/store/jsonl.ts'

describe('JSONL Export & Import', () => {
  function setupTestDb() {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new Store(db)
    const project = store.ensureProject({
      name: 'test-project',
      rootPath: '/tmp/test',
      configPath: '/tmp/test/pluton.yaml',
      defaultBranch: 'main',
    })
    store.syncShips(project.id, [
      {
        id: 'supervisor',
        slug: 'supervisor',
        displayName: 'Supervisor',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/m',
        instructionsFile: 'inst',
        workspacePolicy: 'isolated',
        permissions: { terminal: 'allow', files: 'read-write' } as any,
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '/tmp/h',
      },
      {
        id: 'coder',
        slug: 'coder',
        displayName: 'Coder',
        role: 'coder',
        engineKind: 'mock',
        model: 'mock/m',
        instructionsFile: 'inst',
        workspacePolicy: 'isolated',
        permissions: { terminal: 'allow', files: 'read-write' } as any,
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '/tmp/h2',
      },
    ])
    return { store, project }
  }

  describe('Chat Session JSONL', () => {
    it('exports and imports a chat session with messages preserving order and attributes', () => {
      const { store, project } = setupTestDb()

      const session = store.createChatSession({
        projectId: project.id,
        shipId: 'supervisor',
        title: 'Refactor Auth Pipeline',
      })

      store.appendChatMessage({
        sessionId: session.id,
        role: 'user',
        text: 'Hello, please review auth.ts',
      })

      store.appendChatMessage({
        sessionId: session.id,
        role: 'assistant',
        text: 'Auth middleware looks secure.',
        meta: { tokens: 42 },
      })

      const jsonl = exportSessionToJsonl(store, session.id)
      expect(typeof jsonl).toBe('string')
      const lines = jsonl.trim().split('\n')
      expect(lines.length).toBe(4) // 1 header + 1 session + 2 messages

      const parsedLines = lines.map((l) => JSON.parse(l))
      expect(parsedLines[0]).toMatchObject({ type: 'header', entity: 'session', version: 1 })
      expect(parsedLines[1]).toMatchObject({ type: 'session', data: { id: session.id, title: 'Refactor Auth Pipeline' } })
      expect(parsedLines[2]).toMatchObject({ type: 'message', data: { role: 'user', text: 'Hello, please review auth.ts' } })
      expect(parsedLines[3]).toMatchObject({ type: 'message', data: { role: 'assistant', text: 'Auth middleware looks secure.' } })

      // Import into a target project
      const { store: destStore, project: destProject } = setupTestDb()
      const imported = importSessionFromJsonl(destStore, jsonl, { targetProjectId: destProject.id })

      expect(imported.session.id).toBe(session.id)
      expect(imported.session.title).toBe('Refactor Auth Pipeline')
      expect(imported.messageCount).toBe(2)

      const destSession = destStore.getChatSession(session.id)
      expect(destSession).not.toBeNull()
      expect(destSession?.projectId).toBe(destProject.id)

      const destMessages = destStore.listChatMessages(session.id)
      expect(destMessages).toHaveLength(2)
      expect(destMessages[0]?.text).toBe('Hello, please review auth.ts')
      expect(destMessages[1]?.text).toBe('Auth middleware looks secure.')
      expect(destMessages[1]?.meta).toEqual({ tokens: 42 })
    })

    it('rejects malformed JSONL or invalid header', () => {
      const { store } = setupTestDb()
      expect(() => importSessionFromJsonl(store, 'not json\n')).toThrow(/Invalid JSONL header/)
      expect(() =>
        importSessionFromJsonl(store, JSON.stringify({ type: 'header', format: 'pluton-jsonl', entity: 'unknown' })),
      ).toThrow(/Invalid JSONL entity/)
    })
  })

  describe('Run JSONL', () => {
    it('exports and imports a run with tasks and sequenced events', () => {
      const { store, project } = setupTestDb()

      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Fix authentication leak',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: ['pass verification'],
        budget: {
          maxTasks: 5,
          maxRetries: 2,
          maxConcurrentWorkers: 1,
          maxDelegationDepth: 0,
          maxRunMinutes: 10,
          defaultTaskMinutes: 5,
        },
      })

      const task = store.createTask({
        runId: run.id,
        assigneeShipId: 'coder',
        title: 'Fix token expiry',
        brief: 'Update token check in auth.ts',
        acceptanceCriteria: ['token <= now is expired'],
        writeScope: ['src/auth.ts'],
      })

      store.appendEvent({
        projectId: project.id,
        runId: run.id,
        taskId: task.id,
        shipId: 'coder',
        type: 'task_started',
        payload: { attempt: 1 },
      })

      const jsonl = exportRunToJsonl(store, run.id)
      const lines = jsonl.trim().split('\n')
      expect(lines.length).toBe(4) // header + run + task + event

      const { store: destStore, project: destProject } = setupTestDb()
      const imported = importRunFromJsonl(destStore, jsonl, { targetProjectId: destProject.id })

      expect(imported.run.id).toBe(run.id)
      expect(imported.taskCount).toBe(1)
      expect(imported.eventCount).toBe(1)

      const destRun = destStore.getRun(run.id)
      expect(destRun).not.toBeNull()
      expect(destRun?.goal).toBe('Fix authentication leak')

      const destTasks = destStore.listTasks(run.id)
      expect(destTasks).toHaveLength(1)
      expect(destTasks[0]?.id).toBe(task.id)

      const destEvents = destStore.listEvents(run.id)
      expect(destEvents).toHaveLength(1)
      expect(destEvents[0]?.type).toBe('task_started')
    })
  })
})
