import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Permission } from '../../src/domain/permissions.ts'
import type { TaskRecord } from '../../src/domain/models.ts'
import { WorkerMessageBus } from '../../src/orchestrator/messages.ts'
import { WakeupRegistry } from '../../src/orchestrator/wakeups.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { PlutonToolBridge, type ToolBridgeLimits } from '../../src/tools/bridge.ts'

/**
 * PLUTON 3.0 worker-to-worker messaging: real store, real restricted bridge,
 * durable event history, at-most-once delivery. No simulated chat.
 */

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const LIMITS: ToolBridgeLimits = {
  maxChildrenPerTask: 5,
  maxBriefChars: 10_000,
  maxTeamSize: 8,
  maxToolResultChars: 120_000,
  defaultWaitSeconds: 5,
  waitHeartbeatSeconds: 1,
  approvalTtlMinutes: 60,
  maxRevisionsPerTask: 1,
}

const MESSAGING: Permission[] = ['worker.message', 'task.inspect', 'result.collect', 'diff.inspect']

interface World {
  dir: string
  store: Store
  projectId: string
  runId: string
  wakeups: WakeupRegistry
  bus: WorkerMessageBus
  t1: TaskRecord
  t2: TaskRecord
  bridge(shipId: string, taskId: string | null): PlutonToolBridge
}

function makeWorld(): World {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-messages-')))
  tmpDirs.push(dir)
  mkdirSync(join(dir, '.pluton', 'state'), { recursive: true })
  const db = openDatabase(join(dir, '.pluton', 'state', 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'messages-test',
    rootPath: dir,
    configPath: join(dir, 'pluton.yaml'),
    defaultBranch: 'main',
  })
  store.syncMuses(project.id, [
    {
      id: 'manager',
      slug: 'manager',
      displayName: 'Manager',
      role: 'supervisor',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'coordinator-read-only',
      permissions: MESSAGING,
      approvalMode: 'autonomous-bounded',
      engineHome: '.pluton/engine-homes/manager',
    },
    {
      id: 'r1',
      slug: 'researcher-x',
      displayName: 'Researcher X',
      role: 'researcher',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'read-only',
      permissions: MESSAGING,
      approvalMode: 'autonomous-bounded',
      engineHome: '.pluton/engine-homes/r1',
    },
    {
      id: 'r2',
      slug: 'researcher-z',
      displayName: 'Researcher Z',
      role: 'researcher',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'read-only',
      permissions: MESSAGING,
      approvalMode: 'autonomous-bounded',
      engineHome: '.pluton/engine-homes/r2',
    },
    {
      id: 'c1',
      slug: 'coder-x',
      displayName: 'Coder X',
      role: 'coder',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      // Deliberately no worker.message: the capability is permission-gated.
      permissions: ['project.read', 'project.write', 'tests.run', 'diff.inspect'],
      approvalMode: 'autonomous-bounded',
      engineHome: '.pluton/engine-homes/c1',
    },
  ])
  const run = store.createRun({
    projectId: project.id,
    goal: 'verify worker messaging',
    origin: 'cli',
    requestedBy: 'tester',
    acceptanceCriteria: ['messages are durable'],
    managerMuseId: 'manager',
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 20,
      maxDelegationDepth: 3,
      maxRunMinutes: 30,
      defaultTaskMinutes: 10,
    },
  })
  store.setRunState(run.id, 'active')
  const makeTask = (title: string, assignee: string): TaskRecord => {
    const task = store.createTask({
      runId: run.id,
      title,
      brief: 'do it well',
      acceptanceCriteria: ['done'],
      assigneeMuseId: assignee,
    })
    store.setTaskState(task.id, 'queued')
    store.setTaskState(task.id, 'admitted')
    return store.setTaskState(task.id, 'running')
  }
  const t1 = makeTask('independent investigation A', 'r1')
  const t2 = makeTask('independent investigation B', 'r2')
  const wakeups = new WakeupRegistry()
  const bus = new WorkerMessageBus({ store, projectId: project.id, runId: run.id, wakeups })
  return {
    dir,
    store,
    projectId: project.id,
    runId: run.id,
    wakeups,
    bus,
    t1,
    t2,
    bridge: (shipId, taskId) =>
      new PlutonToolBridge({
        store,
        projectId: project.id,
        rootDir: dir,
        runId: run.id,
        callerShipId: shipId,
        callerTaskId: taskId,
        limits: LIMITS,
        wakeups,
        messageBus: bus,
      }),
  }
}

describe('WorkerMessageBus', () => {
  it('routes a message to the intended recipient exactly once and persists the history', async () => {
    const w = makeWorld()
    const sender = w.bridge('r1', w.t1.id)
    const recipient = w.bridge('r2', w.t2.id)

    const sent = await sender.call('ship.message', {
      recipientShipId: 'r2',
      kind: 'finding',
      body: 'Claim C is supported by src/app.ts:1; please verify independently.',
      taskId: w.t2.id,
    })
    expect(sent.ok).toBe(true)
    const message = (sent.data as { message: { id: string; seq: number; kind: string } }).message
    expect(message.id).toMatch(/^msg_/)
    expect(message.kind).toBe('finding')

    const first = await recipient.call('ship.inbox', {})
    expect(first.ok).toBe(true)
    const firstMessages = (first.data as { messages: { id: string; body: string; senderShipId: string }[] }).messages
    expect(firstMessages).toHaveLength(1)
    expect(firstMessages[0]!.id).toBe(message.id)
    expect(firstMessages[0]!.senderShipId).toBe('r1')
    expect(firstMessages[0]!.body).toContain('src/app.ts:1')

    // Duplicate prevention: a second read returns nothing.
    const second = await recipient.call('ship.inbox', {})
    expect((second.data as { messages: unknown[] }).messages).toHaveLength(0)

    // Durable history is the event log, with one message and one delivered ack.
    const events = w.store.listEvents(w.runId, { type: 'worker.message', limit: 20 })
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ messageId: message.id, recipientShipId: 'r2' })
    expect(w.store.listEvents(w.runId, { type: 'worker.message.delivered', limit: 20 })).toHaveLength(1)
  })

  it('keeps concurrent conversations separate and never delivers to the wrong Ship', async () => {
    const w = makeWorld()
    const r1 = w.bridge('r1', w.t1.id)
    const r2 = w.bridge('r2', w.t2.id)

    await r1.call('ship.message', { recipientShipId: 'r2', kind: 'question', body: 'Q for Z' })
    await r2.call('ship.message', { recipientShipId: 'r1', kind: 'evidence', body: 'Evidence for X' })

    const fromR2 = (await r1.call('ship.inbox', {})).data as { messages: { body: string }[] }
    const fromR1 = (await r2.call('ship.inbox', {})).data as { messages: { body: string }[] }
    expect(fromR2.messages.map((m) => m.body)).toEqual(['Evidence for X'])
    expect(fromR1.messages.map((m) => m.body)).toEqual(['Q for Z'])
  })

  it('does not expose messaging to a Ship without the permission', async () => {
    const w = makeWorld()
    const coder = w.bridge('c1', w.t1.id)
    const result = await coder.call('ship.message', {
      recipientShipId: 'r2',
      kind: 'handoff',
      body: 'nope',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('policy_denied')
  })

  it('bounds an inbox wait and returns promptly when the bus closes (cancellation)', async () => {
    const w = makeWorld()
    const r2 = w.bridge('r2', w.t2.id)
    const started = Date.now()
    const timedOut = await r2.call('ship.inbox', { waitMs: 120 })
    expect(timedOut.ok).toBe(true)
    expect((timedOut.data as { messages: unknown[] }).messages).toHaveLength(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)

    const waiting = r2.call('ship.inbox', { waitMs: 5_000 })
    setTimeout(() => w.bus.close(), 20)
    const closed = await waiting
    expect(closed.ok).toBe(true)
    expect((closed.data as { messages: unknown[] }).messages).toHaveLength(0)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('rehydrates history from the event log without re-delivering acknowledged messages', async () => {
    const w = makeWorld()
    const r1 = w.bridge('r1', w.t1.id)
    const r2 = w.bridge('r2', w.t2.id)
    const sent = await r1.call('ship.message', { recipientShipId: 'r2', kind: 'handoff', body: 'Take over contract' })
    expect(sent.ok).toBe(true)
    await r2.call('ship.inbox', {})

    const restarted = new WorkerMessageBus({
      store: w.store,
      projectId: w.projectId,
      runId: w.runId,
      wakeups: w.wakeups,
    })
    expect(restarted.history()).toHaveLength(1)
    expect(restarted.history()[0]!.body).toBe('Take over contract')
    // The ack was durable: a restarted bus must not deliver it a second time.
    expect(await restarted.inbox({ recipientShipId: 'r2', taskId: w.t2.id })).toHaveLength(0)
  })

  it('rejects terminal recipients, terminal runs, and oversized bodies', async () => {
    const w = makeWorld()
    const r1 = w.bridge('r1', w.t1.id)

    w.store.setTaskState(w.t2.id, 'completed')
    const terminalTask = await r1.call('ship.message', {
      recipientShipId: 'r2',
      kind: 'finding',
      body: 'late',
      taskId: w.t2.id,
    })
    expect(terminalTask.ok).toBe(false)
    expect(terminalTask.error?.code).toBe('request_conflict')

    const oversized = await r1.call('ship.message', {
      recipientShipId: 'r2',
      kind: 'finding',
      body: 'x'.repeat(8_001),
    })
    expect(oversized.ok).toBe(false)
    expect(oversized.error?.code).toBe('invalid_arguments')

    w.store.setRunState(w.runId, 'cancelled')
    const terminalRun = await r1.call('ship.message', {
      recipientShipId: 'r2',
      kind: 'finding',
      body: 'too late',
    })
    expect(terminalRun.ok).toBe(false)
    expect(terminalRun.error?.code).toBe('request_conflict')
  })
})
