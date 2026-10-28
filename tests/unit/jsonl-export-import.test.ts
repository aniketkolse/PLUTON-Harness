import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import {
  exportSessionToJsonl,
  importSessionFromJsonl,
  exportRunToJsonl,
  importRunFromJsonl,
} from '../../src/store/jsonl.ts'

type JsonLine = Record<string, any>

function parseLines(jsonl: string): JsonLine[] {
  return jsonl
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as JsonLine)
}

function serializeLines(lines: JsonLine[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

const TEST_BUDGET = {
  maxTasks: 5,
  maxConcurrentWorkers: 1,
  maxDelegationDepth: 0,
  maxRunMinutes: 10,
  defaultTaskMinutes: 5,
}

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

    it('fails closed instead of overwriting a session that already exists', () => {
      const { store, project } = setupTestDb()
      const session = store.createChatSession({
        projectId: project.id,
        shipId: 'supervisor',
        title: 'Original',
      })
      store.appendChatMessage({ sessionId: session.id, role: 'user', text: 'first' })
      store.appendChatMessage({ sessionId: session.id, role: 'assistant', text: 'second' })
      const jsonl = exportSessionToJsonl(store, session.id)

      expect(() => importSessionFromJsonl(store, jsonl, { targetProjectId: project.id })).toThrow(
        /would overwrite existing session/,
      )
      expect(store.listChatMessages(session.id)).toHaveLength(2)
      expect(store.getChatSession(session.id).title).toBe('Original')
    })

    it('rejects malformed JSONL, invalid headers, and messages owned by another session', () => {
      const { store, project } = setupTestDb()
      expect(() => importSessionFromJsonl(store, 'not json\n')).toThrow(/Invalid JSONL header/)
      expect(() =>
        importSessionFromJsonl(store, JSON.stringify({ type: 'header', format: 'pluton-jsonl', entity: 'unknown' })),
      ).toThrow(/Invalid JSONL entity/)

      const session = store.createChatSession({ projectId: project.id, shipId: 'supervisor' })
      store.appendChatMessage({ sessionId: session.id, role: 'user', text: 'hello' })
      const lines = parseLines(exportSessionToJsonl(store, session.id))
      const malformed = structuredClone(lines)
      malformed[2]!.data.sessionId = 'chat_someone_else'
      expect(() => importSessionFromJsonl(store, serializeLines(malformed))).toThrow(/belongs to session/)

      const duplicateSeq = structuredClone(lines)
      duplicateSeq[3] = {
        type: 'message',
        data: { ...duplicateSeq[2]!.data, id: 'chatmsg_duplicate_seq', seq: duplicateSeq[2]!.data.seq },
      }
      expect(() => importSessionFromJsonl(store, serializeLines(duplicateSeq))).toThrow(
        /duplicate message sequence/,
      )

      const invalidRole = structuredClone(lines)
      invalidRole[2]!.data.role = 'root'
      expect(() => importSessionFromJsonl(store, serializeLines(invalidRole))).toThrow(/role must be one of/)

      const invalidSessionState = structuredClone(lines)
      invalidSessionState[1]!.data.state = 'invalid_session_state'
      expect(() => importSessionFromJsonl(store, serializeLines(invalidSessionState))).toThrow(
        /session\.state must be one of/,
      )

      const nonObjectPayload = structuredClone(lines)
      ;(nonObjectPayload[2] as unknown as { data: unknown }).data = 'not an object'
      expect(() => importSessionFromJsonl(store, serializeLines(nonObjectPayload))).toThrow(/must be an object/)
    })

    it('exports every message beyond the 1000-message reader default', () => {
      const { store, project } = setupTestDb()
      const session = store.createChatSession({ projectId: project.id, shipId: 'supervisor' })
      const total = 1005
      for (let i = 1; i <= total; i++) {
        store.appendChatMessage({
          sessionId: session.id,
          role: i % 2 === 0 ? 'assistant' : 'user',
          text: `message-${i}`,
        })
      }

      const lines = parseLines(exportSessionToJsonl(store, session.id))
      const exported = lines.filter((line) => line.type === 'message')
      expect(exported).toHaveLength(total)
      expect(exported[0]!.data.text).toBe('message-1')
      expect(exported[total - 1]!.data.text).toBe(`message-${total}`)

      const { store: destStore, project: destProject } = setupTestDb()
      const imported = importSessionFromJsonl(destStore, serializeLines(lines), {
        targetProjectId: destProject.id,
      })
      expect(imported.messageCount).toBe(total)
      const restored = destStore.listChatMessages(session.id, { limit: total })
      expect(restored[0]?.text).toBe('message-1')
      expect(restored[total - 1]?.text).toBe(`message-${total}`)
    })

    it('refuses a foreign workspace root unless an explicit local override is supplied', () => {
      const { store, project } = setupTestDb()
      const session = store.createChatSession({ projectId: project.id, shipId: 'supervisor' })
      store.appendChatMessage({ sessionId: session.id, role: 'user', text: 'hello' })
      const lines = parseLines(exportSessionToJsonl(store, session.id))

      const missing = mkdtempSync(join(tmpdir(), 'pluton-missing-workspace-'))
      rmSync(missing, { recursive: true, force: true })
      const foreign = structuredClone(lines)
      foreign[1]!.data.workspaceRoot = missing

      const { store: destStore, project: destProject } = setupTestDb()
      expect(() =>
        importSessionFromJsonl(destStore, serializeLines(foreign), { targetProjectId: destProject.id }),
      ).toThrow(/cannot be used on this host/)
      expect(destStore.getChatSessionOrNull(session.id)).toBeNull()

      const localRoot = mkdtempSync(join(tmpdir(), 'pluton-import-workspace-'))
      try {
        const imported = importSessionFromJsonl(destStore, serializeLines(foreign), {
          targetProjectId: destProject.id,
          workspaceRoot: localRoot,
        })
        expect(imported.session.workspaceRoot).toBe(realpathSync.native(localRoot))
      } finally {
        rmSync(localRoot, { recursive: true, force: true })
      }
    })
  })

  describe('Run JSONL', () => {
    it('exports and imports a run with tasks, dependency edges, and sequenced events', () => {
      const { store, project } = setupTestDb()

      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Fix authentication leak',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: ['pass verification'],
        budget: TEST_BUDGET,
      })

      const task = store.createTask({
        runId: run.id,
        assigneeShipId: 'coder',
        title: 'Fix token expiry',
        brief: 'Update token check in auth.ts',
        acceptanceCriteria: ['token <= now is expired'],
        writeScope: ['src/auth.ts'],
      })

      const followUp = store.createTask({
        runId: run.id,
        assigneeShipId: 'coder',
        title: 'Add regression test',
        brief: 'Cover the expired-token path',
        acceptanceCriteria: [],
      })

      store.addEdge(run.id, task.id, followUp.id)

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
      expect(lines.length).toBe(6) // header + run + 2 tasks + edge + event

      const { store: destStore, project: destProject } = setupTestDb()
      const imported = importRunFromJsonl(destStore, jsonl, { targetProjectId: destProject.id })

      expect(imported.run.id).toBe(run.id)
      expect(imported.taskCount).toBe(2)
      expect(imported.eventCount).toBe(1)

      const destRun = destStore.getRun(run.id)
      expect(destRun).not.toBeNull()
      expect(destRun?.goal).toBe('Fix authentication leak')

      const destTasks = destStore.listTasks(run.id)
      expect(destTasks).toHaveLength(2)
      expect(destTasks.map((item) => item.id)).toEqual(expect.arrayContaining([task.id, followUp.id]))

      const destEdges = destStore.listEdges(run.id)
      expect(destEdges).toEqual([
        { runId: run.id, fromTaskId: task.id, toTaskId: followUp.id, kind: 'depends_on' },
      ])

      const destEvents = destStore.listEvents(run.id)
      expect(destEvents).toHaveLength(1)
      expect(destEvents[0]?.type).toBe('task_started')
    })

    it('fails closed instead of merging a run that already exists', () => {
      const { store, project } = setupTestDb()
      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Original goal',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: [],
        budget: TEST_BUDGET,
      })
      store.createTask({ runId: run.id, title: 'Original task', brief: '', acceptanceCriteria: [] })
      const jsonl = exportRunToJsonl(store, run.id)

      expect(() => importRunFromJsonl(store, jsonl, { targetProjectId: project.id })).toThrow(
        /would overwrite existing run/,
      )
      expect(store.listTasks(run.id)).toHaveLength(1)
      expect(store.getRun(run.id).goal).toBe('Original goal')
    })

    it('rolls back every row when the database rejects a record mid-import', () => {
      const { store, project } = setupTestDb()
      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Atomic import',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: [],
        budget: TEST_BUDGET,
      })
      const task = store.createTask({ runId: run.id, title: 'Task', brief: '', acceptanceCriteria: [] })
      store.appendEvent({
        projectId: project.id,
        runId: run.id,
        taskId: task.id,
        type: 'task_started',
      })
      const jsonl = exportRunToJsonl(store, run.id)

      const { store: destStore, project: destProject } = setupTestDb()
      destStore.db.exec(
        `CREATE TRIGGER reject_event BEFORE INSERT ON events
         BEGIN SELECT RAISE(ABORT, 'constraint failed: injected for rollback test'); END`,
      )

      expect(() => importRunFromJsonl(destStore, jsonl, { targetProjectId: destProject.id })).toThrow(
        /transaction was rolled back/,
      )
      expect(destStore.getRunOrNull(run.id)).toBeNull()
      expect(destStore.listTasks(run.id)).toHaveLength(0)
      expect(destStore.listEdges(run.id)).toHaveLength(0)
      expect(destStore.listEvents(run.id)).toHaveLength(0)
    })

    it('rejects tasks or events that reference rows outside the export', () => {
      const { store, project } = setupTestDb()
      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Integrity check',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: [],
        budget: TEST_BUDGET,
      })
      const task = store.createTask({ runId: run.id, title: 'Task', brief: '', acceptanceCriteria: [] })
      store.appendEvent({ projectId: project.id, runId: run.id, taskId: task.id, type: 'task_started' })
      const lines = parseLines(exportRunToJsonl(store, run.id))

      const missingParent = structuredClone(lines)
      missingParent[2]!.data.parentTaskId = 'task_missing_parent'
      expect(() => importRunFromJsonl(store, serializeLines(missingParent))).toThrow(/references parent/)

      const orphanEvent = structuredClone(lines)
      orphanEvent[3]!.data.taskId = 'task_missing_event'
      expect(() => importRunFromJsonl(store, serializeLines(orphanEvent))).toThrow(
        /references a task that is not in the export/,
      )

      const wrongRun = structuredClone(lines)
      wrongRun[2]!.data.runId = 'run_other'
      expect(() => importRunFromJsonl(store, serializeLines(wrongRun))).toThrow(/belongs to run/)
    })

    it('rejects invalid run state, run origin, and task state enums', () => {
      const { store, project } = setupTestDb()
      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Enum validation',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: [],
        budget: TEST_BUDGET,
      })
      store.createTask({ runId: run.id, title: 'Task', brief: '', acceptanceCriteria: [] })
      const lines = parseLines(exportRunToJsonl(store, run.id))

      const invalidRunState = structuredClone(lines)
      invalidRunState[1]!.data.state = 'invalid_state'
      expect(() => importRunFromJsonl(store, serializeLines(invalidRunState))).toThrow(/run\.state must be one of/)

      const invalidRunOrigin = structuredClone(lines)
      invalidRunOrigin[1]!.data.origin = 'unknown_origin'
      expect(() => importRunFromJsonl(store, serializeLines(invalidRunOrigin))).toThrow(
        /run\.origin must be 'cli' or 'api'/,
      )

      const invalidTaskState = structuredClone(lines)
      invalidTaskState[2]!.data.state = 'bogus_task_state'
      expect(() => importRunFromJsonl(store, serializeLines(invalidTaskState))).toThrow(/task\[0\]\.state must be one of/)
    })

    it('exports every event beyond the newest-50 reader default in chronological order', () => {
      const { store, project } = setupTestDb()
      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Complete event export',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: [],
        budget: TEST_BUDGET,
      })
      const total = 60
      for (let i = 0; i < total; i++) {
        store.appendEvent({
          projectId: project.id,
          runId: run.id,
          type: 'test.progress',
          payload: { index: i },
        })
      }

      const lines = parseLines(exportRunToJsonl(store, run.id))
      const exported = lines.filter((line) => line.type === 'event')
      expect(exported).toHaveLength(total)
      expect(exported.map((line) => line.data.payload.index)).toEqual(
        Array.from({ length: total }, (_, i) => i),
      )

      const { store: destStore, project: destProject } = setupTestDb()
      const imported = importRunFromJsonl(destStore, serializeLines(lines), {
        targetProjectId: destProject.id,
      })
      expect(imported.eventCount).toBe(total)
      const restored = destStore.listEvents(run.id, { limit: total }).reverse()
      expect(restored.map((event) => (event.payload as { index: number }).index)).toEqual(
        Array.from({ length: total }, (_, i) => i),
      )
    })

    it('imports a child recorded before its parent in the JSONL file', () => {
      const { store, project } = setupTestDb()
      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Line-order independence',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: [],
        budget: TEST_BUDGET,
      })
      const parent = store.createTask({ runId: run.id, title: 'Parent', brief: '', acceptanceCriteria: [] })
      const child = store.createTask({
        runId: run.id,
        parentTaskId: parent.id,
        title: 'Child',
        brief: '',
        acceptanceCriteria: [],
      })
      const lines = parseLines(exportRunToJsonl(store, run.id))
      const reordered = [lines[0]!, lines[1]!, lines[3]!, lines[2]!]

      const { store: destStore, project: destProject } = setupTestDb()
      const imported = importRunFromJsonl(destStore, serializeLines(reordered), {
        targetProjectId: destProject.id,
      })
      expect(imported.taskCount).toBe(2)
      const restored = destStore.getTask(child.id)
      expect(restored.parentTaskId).toBe(parent.id)
      expect(restored.rootTaskId).toBe(parent.id)
      expect(restored.depth).toBe(1)
    })

    it('rejects dependency and ancestor cycles introduced by an edited export', () => {
      const { store, project } = setupTestDb()
      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Cycle checks',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: [],
        budget: TEST_BUDGET,
      })
      const first = store.createTask({ runId: run.id, title: 'First', brief: '', acceptanceCriteria: [] })
      const second = store.createTask({ runId: run.id, title: 'Second', brief: '', acceptanceCriteria: [] })
      store.addEdge(run.id, first.id, second.id)
      const lines = parseLines(exportRunToJsonl(store, run.id))

      const { store: destStore, project: destProject } = setupTestDb()
      const dependencyCycle = structuredClone(lines)
      dependencyCycle.push({
        type: 'edge',
        data: { runId: run.id, fromTaskId: second.id, toTaskId: first.id, kind: 'depends_on' },
      })
      expect(() =>
        importRunFromJsonl(destStore, serializeLines(dependencyCycle), { targetProjectId: destProject.id }),
      ).toThrow(/dependency cycle/)

      const ancestorCycle = structuredClone(lines)
      const firstTask = ancestorCycle.find((line) => line.type === 'task' && line.data.id === first.id)!
      firstTask.data.parentTaskId = second.id
      ancestorCycle.push({
        type: 'edge',
        data: { runId: run.id, fromTaskId: second.id, toTaskId: first.id, kind: 'depends_on' },
      })
      // Make the parent chain a two-node loop; the edge cycle check would also
      // fire, so assert the ancestor check runs first.
      const secondTask = ancestorCycle.find((line) => line.type === 'task' && line.data.id === second.id)!
      secondTask.data.parentTaskId = first.id
      const dest2 = setupTestDb()
      expect(() =>
        importRunFromJsonl(dest2.store, serializeLines(ancestorCycle), {
          targetProjectId: dest2.project.id,
        }),
      ).toThrow(/ancestor cycle/)
    })

    it('rejects depth or rootTaskId values that do not match the parent chain', () => {
      const { store, project } = setupTestDb()
      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Hierarchy reconciliation',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: [],
        budget: TEST_BUDGET,
      })
      const parent = store.createTask({ runId: run.id, title: 'Parent', brief: '', acceptanceCriteria: [] })
      store.createTask({
        runId: run.id,
        parentTaskId: parent.id,
        title: 'Child',
        brief: '',
        acceptanceCriteria: [],
      })
      const lines = parseLines(exportRunToJsonl(store, run.id))
      const childLine = lines.find((line) => line.type === 'task' && line.data.parentTaskId === parent.id)!

      const wrongDepth = structuredClone(lines)
      const wrongDepthChild = wrongDepth.find((line) => line.type === 'task' && line.data.parentTaskId === parent.id)!
      wrongDepthChild.data.depth = 9
      const destA = setupTestDb()
      expect(() =>
        importRunFromJsonl(destA.store, serializeLines(wrongDepth), { targetProjectId: destA.project.id }),
      ).toThrow(/depth is 9, expected 1/)

      const wrongRoot = structuredClone(lines)
      const wrongRootChild = wrongRoot.find((line) => line.type === 'task' && line.data.parentTaskId === parent.id)!
      wrongRootChild.data.rootTaskId = childLine.data.id
      const destB = setupTestDb()
      expect(() =>
        importRunFromJsonl(destB.store, serializeLines(wrongRoot), { targetProjectId: destB.project.id }),
      ).toThrow(/rootTaskId/)
    })

    it('maps a real SQLite UNIQUE violation to the rollback message', () => {
      const { store, project } = setupTestDb()
      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Unique violation',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: [],
        budget: TEST_BUDGET,
      })
      store.appendEvent({ projectId: project.id, runId: run.id, type: 'test.event' })
      const jsonl = exportRunToJsonl(store, run.id)

      const { store: destStore, project: destProject } = setupTestDb()
      destStore.db.exec(
        `CREATE TRIGGER force_event_unique BEFORE INSERT ON events
         BEGIN
           INSERT INTO events (id, project_id, run_id, task_id, ship_id, type, payload_json, created_at)
           VALUES (NEW.id, NEW.project_id, NEW.run_id, NEW.task_id, NEW.ship_id, NEW.type, NEW.payload_json, NEW.created_at);
         END`,
      )

      expect(() => importRunFromJsonl(destStore, jsonl, { targetProjectId: destProject.id })).toThrow(
        /transaction was rolled back/,
      )
      expect(destStore.getRunOrNull(run.id)).toBeNull()
      expect(destStore.listEvents(run.id)).toHaveLength(0)
    })

    it('applies and validates a run workspace root override', () => {
      const { store, project } = setupTestDb()
      const run = store.createRun({
        projectId: project.id,
        managerShipId: 'supervisor',
        goal: 'Workspace root',
        origin: 'cli',
        requestedBy: 'operator',
        acceptanceCriteria: [],
        budget: TEST_BUDGET,
      })
      const lines = parseLines(exportRunToJsonl(store, run.id))

      const missing = mkdtempSync(join(tmpdir(), 'pluton-missing-run-workspace-'))
      rmSync(missing, { recursive: true, force: true })
      const foreign = structuredClone(lines)
      foreign[1]!.data.workspaceRoot = missing

      const { store: destStore, project: destProject } = setupTestDb()
      expect(() =>
        importRunFromJsonl(destStore, serializeLines(foreign), { targetProjectId: destProject.id }),
      ).toThrow(/cannot be used on this host/)
      expect(destStore.getRunOrNull(run.id)).toBeNull()

      const localRoot = mkdtempSync(join(tmpdir(), 'pluton-import-run-workspace-'))
      try {
        const imported = importRunFromJsonl(destStore, serializeLines(foreign), {
          targetProjectId: destProject.id,
          workspaceRoot: localRoot,
        })
        expect(imported.run.workspaceRoot).toBe(realpathSync.native(localRoot))
      } finally {
        rmSync(localRoot, { recursive: true, force: true })
      }
    })
  })
})
