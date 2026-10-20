import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { admitTask } from '../../src/orchestrator/task-graph.ts'
import type { ServerEventBroadcaster } from '../../src/server/events.ts'
import { ServerLogWatcher } from '../../src/server/log-watcher.ts'
import type { ServerSSEEvent } from '../../src/server/types.ts'
import type { Store } from '../../src/store/store.ts'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

const TEST_CONFIG = `version: 1
project:
  name: log-watcher-test
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: local-process
  local_process_acknowledged: true
runtime:
  max_concurrent_workers: 2
  max_team_size: 4
  max_delegation_depth: 3
  max_child_tasks_per_task: 5
  max_tasks_per_run: 10
  max_run_minutes: 30
  default_task_minutes: 10
  default_cpu_limit: 2
  default_memory_mb: 2048
  max_retries_per_task: 1
  network_policy: restricted
  max_prompt_chars: 60000
  max_event_payload_chars: 8000
  max_tool_result_chars: 120000
  heartbeat_seconds: 30
muses:
  supervisor:
    display_name: Supervisor
    role: supervisor
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
`

const RUN_GOAL = 'log watcher fixture goal'
const TASK_TITLE = 'log watcher fixture task'

interface Fixture {
  store: Store
  projectId: string
  runId: string
  taskId: string
}

/** Real tmp-dir store (server-api TEST_CONFIG shape) with one run and one queued task. */
function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'pluton-log-watcher-'))
  tmpDirs.push(root)
  writeFileSync(join(root, 'pluton.yaml'), TEST_CONFIG, 'utf8')

  const { store, projectId } = bootstrapStore(loadConfig(root))
  const run = store.createRun({
    projectId,
    goal: RUN_GOAL,
    origin: 'cli',
    requestedBy: 'operator',
    acceptanceCriteria: [],
    managerMuseId: 'supervisor',
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 10,
      maxDelegationDepth: 2,
      maxRunMinutes: 10,
      defaultTaskMinutes: 5,
    },
  })
  const task = admitTask(
    store,
    {
      runId: run.id,
      parentTaskId: null,
      title: TASK_TITLE,
      brief: 'exercise the watcher',
      acceptanceCriteria: [],
      assigneeMuseId: 'supervisor',
    },
    { maxChildrenPerTask: 5 },
  )
  return { store, projectId, runId: run.id, taskId: task.id }
}

interface FakeBroadcaster {
  broadcast: ReturnType<typeof vi.fn>
}

function emitted(fake: FakeBroadcaster): ServerSSEEvent[] {
  return fake.broadcast.mock.calls.map((call) => call[0] as ServerSSEEvent)
}

function makeWatcher(
  fixture: Fixture,
  fake: FakeBroadcaster,
  options: { pollIntervalMs?: number } = {},
): ServerLogWatcher {
  return new ServerLogWatcher({
    store: fixture.store,
    projectId: fixture.projectId,
    broadcaster: fake as unknown as ServerEventBroadcaster,
    ...options,
  })
}

/** Bounded wait for a deterministic start()/stop() test; no fake timers needed. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${String(timeoutMs)}ms waiting for condition`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('ServerLogWatcher (CS-8: live orchestration state over SSE)', () => {
  it('maps run.* events to a single run_state frame with the fresh durable run state and goal', () => {
    const fixture = createFixture()
    try {
      const fake: FakeBroadcaster = { broadcast: vi.fn() }
      const watcher = makeWatcher(fixture, fake)

      fixture.store.setRunState(fixture.runId, 'active')
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        type: 'run.started',
        payload: { goal: RUN_GOAL, managerMuseId: 'supervisor' },
      })

      watcher.pollOnce()

      expect(emitted(fake)).toEqual([
        { type: 'run_state', runId: fixture.runId, state: 'active', goal: RUN_GOAL },
      ])
    } finally {
      fixture.store.close()
    }
  })

  it('maps task.* events to a single task_state frame with the fresh durable task state', () => {
    const fixture = createFixture()
    try {
      const fake: FakeBroadcaster = { broadcast: vi.fn() }
      const watcher = makeWatcher(fixture, fake)

      fixture.store.setTaskState(fixture.taskId, 'admitted')
      fixture.store.setTaskState(fixture.taskId, 'running')
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        taskId: fixture.taskId,
        type: 'task.started',
        payload: { museId: 'supervisor', engine: 'mock', workspaceId: null },
      })

      watcher.pollOnce()

      expect(emitted(fake)).toEqual([
        {
          type: 'task_state',
          taskId: fixture.taskId,
          runId: fixture.runId,
          state: 'running',
          title: TASK_TITLE,
        },
      ])
    } finally {
      fixture.store.close()
    }
  })

  it('maps worker approval events to live approval frames (QA question cards)', () => {
    const fixture = createFixture()
    try {
      const fake: FakeBroadcaster = { broadcast: vi.fn() }
      const watcher = makeWatcher(fixture, fake)

      const approval = fixture.store.createApproval({
        projectId: fixture.projectId,
        runId: fixture.runId,
        taskId: fixture.taskId,
        requestedByMuseId: 'tester',
        action: 'qa.question',
        reason: 'Which database should the migration target?',
        scope: { options: ['PostgreSQL', 'SQLite'] },
        expiresAt: null,
      })
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        taskId: fixture.taskId,
        museId: 'tester',
        type: 'approval.requested',
        payload: { approvalId: approval.id, action: approval.action },
      })

      watcher.pollOnce()

      expect(emitted(fake)).toEqual([
        expect.objectContaining({
          type: 'approval_requested',
          approval: expect.objectContaining({ id: approval.id, action: 'qa.question' }),
        }),
      ])
    } finally {
      fixture.store.close()
    }
  })

  it('emits no frame for events that are neither run.* nor task.*', () => {
    const fixture = createFixture()
    try {
      const fake: FakeBroadcaster = { broadcast: vi.fn() }
      const watcher = makeWatcher(fixture, fake)

      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        type: 'approval.expired',
        payload: { approvalId: 'appr_1' },
      })
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        taskId: fixture.taskId,
        museId: 'supervisor',
        type: 'token.usage',
        payload: { inputTokens: 3, outputTokens: 5 },
      })

      watcher.pollOnce()

      expect(fake.broadcast).not.toHaveBeenCalled()
    } finally {
      fixture.store.close()
    }
  })

  it('tails from construction: history is never replayed, new events are, once', () => {
    const fixture = createFixture()
    try {
      const fake: FakeBroadcaster = { broadcast: vi.fn() }

      // Appended BEFORE the watcher exists: must never be replayed.
      fixture.store.setRunState(fixture.runId, 'active')
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        type: 'run.started',
        payload: { goal: RUN_GOAL },
      })

      const watcher = makeWatcher(fixture, fake)
      watcher.pollOnce()
      expect(fake.broadcast).not.toHaveBeenCalled()

      // Appended after: emitted exactly once, cursor advances.
      fixture.store.setRunState(fixture.runId, 'completed')
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        type: 'run.finished',
        payload: { state: 'completed', outcome: 'success' },
      })
      watcher.pollOnce()
      expect(emitted(fake)).toEqual([
        { type: 'run_state', runId: fixture.runId, state: 'completed', goal: RUN_GOAL },
      ])

      // Idempotent: a second poll with no new events emits nothing again.
      watcher.pollOnce()
      expect(fake.broadcast).toHaveBeenCalledTimes(1)
    } finally {
      fixture.store.close()
    }
  })

  it('skips events whose referent is gone without throwing, and still advances the cursor', () => {
    const fixture = createFixture()
    try {
      const fake: FakeBroadcaster = { broadcast: vi.fn() }
      const watcher = makeWatcher(fixture, fake)

      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: 'run_does_not_exist',
        type: 'run.finished',
        payload: { state: 'completed' },
      })
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        taskId: 'task_does_not_exist',
        type: 'task.failed',
        payload: { failure: { code: 'missing' } },
      })

      expect(() => {
        watcher.pollOnce()
      }).not.toThrow()
      expect(fake.broadcast).not.toHaveBeenCalled()

      // The cursor moved past the unmappable events: the next real one is emitted.
      fixture.store.setRunState(fixture.runId, 'active')
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        type: 'run.started',
        payload: { goal: RUN_GOAL },
      })
      watcher.pollOnce()
      expect(emitted(fake)).toEqual([
        { type: 'run_state', runId: fixture.runId, state: 'active', goal: RUN_GOAL },
      ])
    } finally {
      fixture.store.close()
    }
  })

  it('collapses a burst for one entity into one frame carrying the final state', () => {
    const fixture = createFixture()
    try {
      const fake: FakeBroadcaster = { broadcast: vi.fn() }
      const watcher = makeWatcher(fixture, fake)

      fixture.store.setTaskState(fixture.taskId, 'admitted')
      fixture.store.setTaskState(fixture.taskId, 'running')
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        taskId: fixture.taskId,
        type: 'task.started',
        payload: { museId: 'supervisor', engine: 'mock' },
      })
      fixture.store.setTaskState(fixture.taskId, 'completed')
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        taskId: fixture.taskId,
        type: 'task.completed',
        payload: { outcome: 'success' },
      })

      watcher.pollOnce()

      expect(emitted(fake)).toEqual([
        {
          type: 'task_state',
          taskId: fixture.taskId,
          runId: fixture.runId,
          state: 'completed',
          title: TASK_TITLE,
        },
      ])
    } finally {
      fixture.store.close()
    }
  })

  it('delivers a mapped event that lands in the second batch of a multi-batch drain', () => {
    const fixture = createFixture()
    try {
      const fake: FakeBroadcaster = { broadcast: vi.fn() }
      const watcher = makeWatcher(fixture, fake)

      // 201 unmapped events overrun the watcher's 200-event batch, so anything
      // appended after them must be read from the second batch of one pass.
      for (let i = 0; i < 201; i += 1) {
        fixture.store.appendEvent({
          projectId: fixture.projectId,
          runId: fixture.runId,
          type: 'approval.expired',
          payload: { i },
        })
      }
      fixture.store.setTaskState(fixture.taskId, 'admitted')
      fixture.store.setTaskState(fixture.taskId, 'running')
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        taskId: fixture.taskId,
        type: 'task.started',
        payload: { museId: 'supervisor', engine: 'mock' },
      })

      watcher.pollOnce()

      expect(emitted(fake)).toEqual([
        {
          type: 'task_state',
          taskId: fixture.taskId,
          runId: fixture.runId,
          state: 'running',
          title: TASK_TITLE,
        },
      ])

      // Cursor advanced past both batches: a second pass emits nothing.
      watcher.pollOnce()
      expect(fake.broadcast).toHaveBeenCalledTimes(1)
    } finally {
      fixture.store.close()
    }
  })

  it('surfaces a parked needs_approval task as exactly one task_state frame', () => {
    const fixture = createFixture()
    try {
      const fake: FakeBroadcaster = { broadcast: vi.fn() }
      const watcher = makeWatcher(fixture, fake)

      // Park the task exactly as the supervisor's approval channel does: the
      // CAS flips running → needs_approval, then the durable event is appended.
      fixture.store.setTaskState(fixture.taskId, 'admitted')
      fixture.store.setTaskState(fixture.taskId, 'running')
      const parked = fixture.store.setTaskStateIf(fixture.taskId, 'running', 'needs_approval')
      expect(parked?.state).toBe('needs_approval')
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        taskId: fixture.taskId,
        museId: 'supervisor',
        type: 'task.approval_waiting',
        payload: { approvalId: 'approval_engine_1' },
      })

      watcher.pollOnce()

      expect(emitted(fake)).toEqual([
        {
          type: 'task_state',
          taskId: fixture.taskId,
          runId: fixture.runId,
          state: 'needs_approval',
          title: TASK_TITLE,
        },
      ])
    } finally {
      fixture.store.close()
    }
  })

  it('bounds the per-tick drain: a backlog larger than the budget resumes on the next poll', () => {
    const fixture = createFixture()
    try {
      const fake: FakeBroadcaster = { broadcast: vi.fn() }
      const watcher = makeWatcher(fixture, fake)

      // 2 001 unmapped events: one more than one tick's 10-batch (2 000-event)
      // budget, so the mapped event appended after them sits past the budget.
      for (let i = 0; i < 2_001; i += 1) {
        fixture.store.appendEvent({
          projectId: fixture.projectId,
          runId: fixture.runId,
          type: 'approval.expired',
          payload: { i },
        })
      }
      fixture.store.setTaskState(fixture.taskId, 'admitted')
      fixture.store.setTaskState(fixture.taskId, 'running')
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        taskId: fixture.taskId,
        type: 'task.started',
        payload: { museId: 'supervisor', engine: 'mock' },
      })

      // The first tick spends its whole budget on the backlog and emits nothing.
      watcher.pollOnce()
      expect(fake.broadcast).not.toHaveBeenCalled()

      // The cursor advanced with every batch read: the next tick delivers the
      // single frame.
      watcher.pollOnce()
      expect(emitted(fake)).toEqual([
        {
          type: 'task_state',
          taskId: fixture.taskId,
          runId: fixture.runId,
          state: 'running',
          title: TASK_TITLE,
        },
      ])

      // …and the cursor is fully advanced: a third pass is silent again.
      watcher.pollOnce()
      expect(fake.broadcast).toHaveBeenCalledTimes(1)
    } finally {
      fixture.store.close()
    }
  })

  it('start() broadcasts on its own cadence and stop() halts it (idempotent start/stop)', async () => {
    const fixture = createFixture()
    try {
      const fake: FakeBroadcaster = { broadcast: vi.fn() }
      const watcher = makeWatcher(fixture, fake, { pollIntervalMs: 25 })

      watcher.start()
      // A second start() must not leave an extra timer behind: the single stop()
      // below has to halt everything, which the post-stop assertion verifies.
      watcher.start()
      try {
        fixture.store.setRunState(fixture.runId, 'active')
        fixture.store.appendEvent({
          projectId: fixture.projectId,
          runId: fixture.runId,
          type: 'run.started',
          payload: { goal: RUN_GOAL },
        })

        // The timer alone (no manual pollOnce) must deliver the frame.
        await waitFor(() => fake.broadcast.mock.calls.length >= 1)
        expect(emitted(fake)[0]).toEqual({
          type: 'run_state',
          runId: fixture.runId,
          state: 'active',
          goal: RUN_GOAL,
        })
      } finally {
        watcher.stop()
      }

      const callsAfterStop = fake.broadcast.mock.calls.length
      fixture.store.setRunState(fixture.runId, 'completed')
      fixture.store.appendEvent({
        projectId: fixture.projectId,
        runId: fixture.runId,
        type: 'run.finished',
        payload: { state: 'completed' },
      })

      // Four poll intervals with the timer cleared: nothing more may arrive.
      await delay(100)
      expect(fake.broadcast).toHaveBeenCalledTimes(callsAfterStop)
      watcher.stop() // idempotent
    } finally {
      fixture.store.close()
    }
  })
})
