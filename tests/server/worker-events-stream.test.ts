import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { ServerEventBroadcaster } from '../../src/server/events.ts'
import type { WorkerSSEEvent } from '../../src/server/types.ts'

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

describe('Worker Events SSE Broadcast', () => {
  it('broadcasts sanitized worker events with run and role correlation', () => {
    const broadcaster = new ServerEventBroadcaster()
    let emitted: any = null
    broadcaster.on('event', (e) => {
      emitted = e
    })

    broadcaster.broadcastWorkerEvent({
      type: 'worker.progress',
      runId: 'run-101',
      taskId: 'task-coder-1',
      role: 'coder',
      model: 'gemini-3.8-flash',
      workspace: '.pluton/workspaces/task-1',
      payload: { step: 'editing src/store.ts' },
    })

    expect(emitted).not.toBeNull()
    expect(emitted.type).toBe('worker.progress')
    expect(emitted.runId).toBe('run-101')
    expect(emitted.taskId).toBe('task-coder-1')
    expect(emitted.role).toBe('coder')
    expect(emitted.model).toBe('gemini-3.8-flash')
    expect(emitted.workspace).toBe('.pluton/workspaces/task-1')
    expect(emitted.payload).toEqual({ step: 'editing src/store.ts' })
    expect(typeof emitted.timestamp).toBe('number')
  })

  it('emits both event and worker_event on the broadcaster instance', () => {
    const broadcaster = new ServerEventBroadcaster()
    const onEvent = vi.fn()
    const onWorkerEvent = vi.fn()

    broadcaster.on('event', onEvent)
    broadcaster.on('worker_event', onWorkerEvent)

    const event: WorkerSSEEvent = {
      type: 'worker.started',
      runId: 'run-202',
      taskId: 'task-tester-1',
      role: 'qa',
      model: 'claude-3.7-sonnet',
      timestamp: 1729440000000,
    }

    broadcaster.broadcastWorkerEvent(event)

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onWorkerEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'worker.started',
      runId: 'run-202',
      taskId: 'task-tester-1',
      role: 'qa',
      timestamp: 1729440000000,
    }))
    expect(onWorkerEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'worker.started',
      runId: 'run-202',
      role: 'qa',
    }))
  })

  it('redacts secrets and bounds long string buffers in payload', () => {
    const broadcaster = new ServerEventBroadcaster()
    let emitted: any = null
    broadcaster.on('worker_event', (e) => {
      emitted = e
    })

    const longText = 'x'.repeat(10000)
    broadcaster.broadcastWorkerEvent({
      type: 'worker.progress',
      runId: 'run-303',
      taskId: 'task-researcher-1',
      role: 'researcher',
      payload: {
        apiKey: 'sk-proj-secret-token-12345',
        password: 'super-secret-password',
        auth_token: 'bearer abcdef123456',
        buffer: longText,
        normalKey: 'visible value',
      },
    })

    expect(emitted.payload.apiKey).toBe('[redacted]')
    expect(emitted.payload.password).toBe('[redacted]')
    expect(emitted.payload.auth_token).toBe('[redacted]')
    expect(emitted.payload.normalKey).toBe('visible value')
    expect(emitted.payload.buffer.length).toBeLessThan(10000)
    expect(emitted.payload.buffer).toContain('[truncated')
  })

  it('persists durable event to store when store is provided in call', () => {
    const broadcaster = new ServerEventBroadcaster()
    const mockStore = {
      appendEvent: vi.fn(),
    }

    broadcaster.broadcastWorkerEvent(
      {
        type: 'worker.question',
        runId: 'run-404',
        taskId: 'task-qa-1',
        role: 'qa',
        payload: { questionId: 'q-1', title: 'Need decision' },
      },
      mockStore as any,
      'proj-alpha',
    )

    expect(mockStore.appendEvent).toHaveBeenCalledTimes(1)
    const appendArg = mockStore.appendEvent.mock.calls[0]![0]
    expect(appendArg.projectId).toBe('proj-alpha')
    expect(appendArg.runId).toBe('run-404')
    expect(appendArg.taskId).toBe('task-qa-1')
    expect(appendArg.type).toBe('worker.question')
    expect(appendArg.museId).toBe('qa')
    expect(appendArg.payload).toEqual(expect.objectContaining({
      role: 'qa',
      questionId: 'q-1',
      title: 'Need decision',
    }))
  })

  it('persists durable event using broadcaster store context when store is omitted', () => {
    const mockStore = {
      appendEvent: vi.fn(),
    }
    const broadcaster = new ServerEventBroadcaster(15000, mockStore as any, 'proj-context')

    broadcaster.broadcastWorkerEvent({
      type: 'worker.completed',
      runId: 'run-505',
      taskId: 'task-coder-2',
      role: 'coder',
      payload: { filesChanged: ['src/index.ts'] },
    })

    expect(mockStore.appendEvent).toHaveBeenCalledTimes(1)
    const appendArg = mockStore.appendEvent.mock.calls[0]![0]
    expect(appendArg.projectId).toBe('proj-context')
    expect(appendArg.runId).toBe('run-505')
    expect(appendArg.taskId).toBe('task-coder-2')
    expect(appendArg.type).toBe('worker.completed')
  })

  it('broadcasts SSE formatted payload to connected HTTP clients', () => {
    const broadcaster = new ServerEventBroadcaster()
    const writtenChunks: string[] = []
    const mockRes = {
      writeHead: vi.fn(),
      write: vi.fn((data: string) => {
        writtenChunks.push(data)
        return true
      }),
      on: vi.fn(),
      end: vi.fn(),
    }

    broadcaster.addClient(mockRes as any)
    expect(writtenChunks.length).toBe(1) // initial connected event
    expect(writtenChunks[0]).toContain('"type":"connected"')

    broadcaster.broadcastWorkerEvent({
      type: 'worker.report',
      runId: 'run-606',
      taskId: 'task-reviewer-1',
      role: 'reviewer',
      payload: { approved: true },
    })

    expect(writtenChunks.length).toBe(2)
    const sseChunk = writtenChunks[1]!
    expect(sseChunk.startsWith('data: ')).toBe(true)
    expect(sseChunk.endsWith('\n\n')).toBe(true)
    const parsed = JSON.parse(sseChunk.slice(6, -2))
    expect(parsed.type).toBe('worker.report')
    expect(parsed.role).toBe('reviewer')
    expect(parsed.payload).toEqual({ approved: true })
  })

  it('durably persists worker events into real SQLite store and queries via eventsSince', () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-worker-events-'))
    tmpDirs.push(root)
    const testConfig = `version: 1
project:
  name: worker-events-test
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
  network_policy: open
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
    writeFileSync(join(root, 'pluton.yaml'), testConfig, 'utf8')
    const { store, projectId } = bootstrapStore(loadConfig(root))
    const broadcaster = new ServerEventBroadcaster(15000, store, projectId)

    broadcaster.broadcastWorkerEvent({
      type: 'worker.started',
      runId: 'run-sql-1',
      taskId: 'task-sql-1',
      role: 'coder',
      model: 'gemini-3.8-flash',
      workspace: '.pluton/workspaces/task-sql-1',
      payload: { branch: 'pluton/run-sql-1/coder' },
    })

    const events = store.eventsSince(projectId, 0, 10)
    expect(events.length).toBeGreaterThan(0)
    const workerEvent = events.find((e) => e.type === 'worker.started')
    expect(workerEvent).toBeDefined()
    expect(workerEvent?.runId).toBe('run-sql-1')
    expect(workerEvent?.taskId).toBe('task-sql-1')
    expect(workerEvent?.museId).toBe('coder')
    expect(workerEvent?.payload).toMatchObject({
      role: 'coder',
      model: 'gemini-3.8-flash',
      workspace: '.pluton/workspaces/task-sql-1',
      branch: 'pluton/run-sql-1/coder',
    })
  })
})
