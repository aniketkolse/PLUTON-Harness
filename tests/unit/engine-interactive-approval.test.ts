import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { decideApproval } from '../../src/cli/commands/approvals.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import type { LoadedConfig } from '../../src/config/load.ts'
import type { ApprovalRecord } from '../../src/domain/models.ts'
import {
  createEngineApprovalChannel,
  ENGINE_PERMISSION_ACTION,
  pendingApprovalWaiterCount,
  settleApprovalWaiter,
  type EngineApprovalSettlement,
  type EngineApprovalTimers,
} from '../../src/engines/interactive-approval.ts'
import { admitTask } from '../../src/orchestrator/task-graph.ts'
import type { Store } from '../../src/store/store.ts'

/**
 * Interactive engine-approval bridge: correlates an ACP engine permission
 * request with the durable operator approval lifecycle. Every edge is
 * fail-closed: timeout, abort, unknown ids, races and store failures all deny.
 */

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

function makeProject(): { ctx: ProjectContext; store: Store; projectId: string } {
  const rootDir = mkdtempSync(join(tmpdir(), 'pluton-engine-approval-'))
  tmpDirs.push(rootDir)
  const loaded: LoadedConfig = {
    rootDir,
    configPath: join(rootDir, 'pluton.yaml'),
    config: {
      version: 1,
      project: { name: 'engine-approval-p', repository: '.', default_branch: 'main', verification: [] },
      runtime: {
        max_concurrent_workers: 2,
        max_team_size: 2,
        max_delegation_depth: 2,
        max_child_tasks_per_task: 5,
        max_tasks_per_run: 10,
        max_run_minutes: 10,
        default_task_minutes: 5,
        default_cpu_limit: 1,
        default_memory_mb: 512,
        max_retries_per_task: 1,
        max_revisions_per_task: 1,
        network_policy: 'restricted',
        max_prompt_chars: 1000,
        max_event_payload_chars: 1000,
        max_tool_result_chars: 1000,
        heartbeat_seconds: 5,
        approval_timeout_minutes: 10,
      },
      sandbox: {
        kind: 'local-process',
        local_process_acknowledged: true,
        native: {
          mode: 'workspace-write',
          acknowledge_partial_enforcement: false,
          acknowledge_host_network: false,
          env_allowlist: [],
          terminate_grace_seconds: 2,
          session_timeout_minutes: 0,
          max_output_bytes: 1_048_576,
        },
      },
      git: { protected_paths: [], require_approval_for_main_branch_integration: false },
      ships: {
        worker: {
          display_name: 'Worker',
          role: 'coder',
          engine: 'mock',
          model: 'mock/model',
          workspace_policy: 'isolated-task-checkout',
          approval_mode: 'ask-for-sensitive-actions',
        },
      },
      muses: {
        worker: {
          display_name: 'Worker',
          role: 'coder',
          engine: 'mock',
          model: 'mock/model',
          workspace_policy: 'isolated-task-checkout',
          approval_mode: 'ask-for-sensitive-actions',
        },
      },
    },
  }
  const { store, projectId } = bootstrapStore(loaded)
  const ctx: ProjectContext = { rootDir, configPath: loaded.configPath, loaded }
  return { ctx, store, projectId }
}

interface RecordedTimers extends EngineApprovalTimers {
  fireAllTimeouts(): void
  fireAllIntervals(): void
  readonly cleared: { timeouts: number; intervals: number }
  readonly live: () => { timeouts: number; intervals: number }
}

/** Deterministic timer seam: nothing fires unless the test says so. */
function recordedTimers(): RecordedTimers {
  let next = 1
  const timeouts = new Map<number, () => void>()
  const intervals = new Map<number, () => void>()
  const cleared = { timeouts: 0, intervals: 0 }
  return {
    setTimeout(fn: () => void, _ms: number) {
      const handle = next++
      timeouts.set(handle, fn)
      return handle
    },
    clearTimeout(handle: unknown) {
      cleared.timeouts += 1
      timeouts.delete(handle as number)
    },
    setInterval(fn: () => void, _ms: number) {
      const handle = next++
      intervals.set(handle, fn)
      return handle
    },
    clearInterval(handle: unknown) {
      cleared.intervals += 1
      intervals.delete(handle as number)
    },
    fireAllTimeouts() {
      for (const fn of [...timeouts.values()]) fn()
    },
    fireAllIntervals() {
      for (const fn of [...intervals.values()]) fn()
    },
    get cleared() {
      return cleared
    },
    live() {
      return { timeouts: timeouts.size, intervals: intervals.size }
    },
  }
}

interface ChannelFixture {
  channel: ReturnType<typeof createEngineApprovalChannel>
  requested: ApprovalRecord[]
  settled: Array<{ record: ApprovalRecord; settlement: EngineApprovalSettlement }>
  timers: RecordedTimers
}

function makeChannel(store: Store, projectId: string, overrides: Partial<Parameters<typeof createEngineApprovalChannel>[0]> = {}): ChannelFixture {
  const requested: ApprovalRecord[] = []
  const settled: Array<{ record: ApprovalRecord; settlement: EngineApprovalSettlement }> = []
  const timers = recordedTimers()
  const channel = createEngineApprovalChannel({
    store,
    projectId,
    runId: null,
    taskId: null,
    museId: 'worker',
    ttlMinutes: 10,
    timers,
    onRequested: (a) => requested.push(a),
    onSettled: (record, settlement) => settled.push({ record, settlement }),
    ...overrides,
  })
  return { channel, requested, settled, timers }
}

function makeRunAndTask(store: Store, projectId: string): { runId: string; taskId: string } {
  const run = store.createRun({
    projectId,
    goal: 'engine permission forwarding',
    origin: 'cli',
    requestedBy: 'test',
    acceptanceCriteria: [],
    managerMuseId: 'worker',
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
      title: 'task needing permissions',
      brief: 'brief',
      acceptanceCriteria: [],
      assigneeMuseId: 'worker',
    },
    { maxChildrenPerTask: 5 },
  )
  return { runId: run.id, taskId: task.id }
}

describe('interactive engine approval channel', () => {
  it('creates a durable pending approval bound to run/task/Muse and resolves allow through the decision funnel', async () => {
    const { store, projectId } = makeProject()
    const { runId, taskId } = makeRunAndTask(store, projectId)
    const { channel, requested, settled, timers } = makeChannel(store, projectId, { runId, taskId })

    const promise = channel.requestPermission({
      requestId: 'call_9122',
      description: 'engine requested permission: Writing to worker-note.txt',
      scope: { tool: 'write_file', path: 'src/a.ts' },
    })

    expect(requested).toHaveLength(1)
    const record = requested[0]!
    expect(record.action).toBe(ENGINE_PERMISSION_ACTION)
    expect(record.status).toBe('pending')
    expect(record.runId).toBe(runId)
    expect(record.taskId).toBe(taskId)
    expect(record.requestedByMuseId).toBe('worker')
    expect(record.reason).toContain('Writing to worker-note.txt')
    expect(record.expiresAt).not.toBeNull()
    expect(record.scope).toMatchObject({ source: 'engine', engineRequestId: 'call_9122', tool: 'write_file' })
    expect(timers.live().timeouts).toBe(1)
    expect(timers.live().intervals).toBe(1)

    const events = store.listEvents(runId, { type: 'approval.requested' })
    expect(events.some((e) => (e.payload as Record<string, unknown>)['approvalId'] === record.id)).toBe(true)

    // The funnel's order: the durable decision is written first, then the
    // waiting engine request is notified.
    store.setApprovalStatus(record.id, 'approved', { decidedBy: 'operator' })
    expect(settleApprovalWaiter(record.id, 'approved')).toBe(true)
    await expect(promise).resolves.toBe('allow')

    // Exactly once: a duplicate settle does nothing.
    expect(settleApprovalWaiter(record.id, 'approved')).toBe(false)
    expect(settled).toHaveLength(1)
    expect(settled[0]!.settlement).toBe('decision')
    expect(settled[0]!.record.status).toBe('approved')

    // Timers are released once the request settles.
    expect(timers.live()).toEqual({ timeouts: 0, intervals: 0 })
    expect(timers.cleared.timeouts + timers.cleared.intervals).toBeGreaterThanOrEqual(2)
    store.close()
  })

  it('resolves deny on a denied decision and keeps concurrent requests correlated one-to-one', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested } = makeChannel(store, projectId)

    const first = channel.requestPermission({ requestId: 'a', description: 'first', scope: {} })
    const second = channel.requestPermission({ requestId: 'b', description: 'second', scope: {} })
    expect(requested).toHaveLength(2)

    expect(settleApprovalWaiter(requested[1]!.id, 'denied', 'decision')).toBe(true)
    await expect(second).resolves.toBe('deny')

    // The first request is untouched by the second's decision: exactly one
    // waiter remains registered, and only the first's own settle releases it.
    expect(pendingApprovalWaiterCount()).toBe(1)

    expect(settleApprovalWaiter(requested[0]!.id, 'approved')).toBe(true)
    await expect(first).resolves.toBe('allow')
    expect(pendingApprovalWaiterCount()).toBe(0)
    store.close()
  })

  it('ignores settles for approvals it never requested', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested } = makeChannel(store, projectId)
    const promise = channel.requestPermission({ requestId: null, description: 'x', scope: {} })

    // The unknown id changed nothing: the real request is still waiting.
    expect(settleApprovalWaiter('approval_not_mine', 'approved')).toBe(false)
    expect(pendingApprovalWaiterCount()).toBe(1)

    settleApprovalWaiter(requested[0]!.id, 'denied')
    await expect(promise).resolves.toBe('deny')
    expect(pendingApprovalWaiterCount()).toBe(0)
    store.close()
  })

  it('expires the record and fails closed when the TTL runs out', async () => {
    const { store, projectId } = makeProject()
    const nowMs = Date.parse('2026-10-18T00:00:00.000Z')
    const { channel, requested, settled, timers } = makeChannel(store, projectId, { now: () => nowMs })

    const promise = channel.requestPermission({ requestId: 'call_1', description: 'engine requested permission: shell', scope: {} })
    const record = requested[0]!
    expect(record.expiresAt).toBe('2026-10-18T00:10:00.000Z')

    timers.fireAllTimeouts()
    await expect(promise).resolves.toBe('deny')

    const after = store.getApproval(record.id)
    expect(after.status).toBe('expired')
    expect(after.decidedBy).toBe('pluton:timeout')
    expect(settled).toHaveLength(1)
    expect(settled[0]!.settlement).toBe('expiry')
    expect(timers.live()).toEqual({ timeouts: 0, intervals: 0 })

    // The timer path records the expiry durably, exactly like abort and the
    // sweep: every pending record must leave the inbox through a visible event.
    const expiryEvents = store.eventsSince(projectId, 0).filter((e) => e.type === 'approval.expired')
    expect(expiryEvents).toHaveLength(1)
    expect(expiryEvents[0]!.payload).toEqual({
      approvalId: record.id,
      action: ENGINE_PERMISSION_ACTION,
      reason: 'timeout',
    })

    // A late approval of an expired request is refused.
    expect(() => store.setApprovalStatus(record.id, 'approved')).toThrow()
    store.close()
  })

  it('aborts pending requests fail-closed on session teardown and cleans up', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested, settled, timers } = makeChannel(store, projectId)

    const promise = channel.requestPermission({ requestId: 'call_1', description: 'engine requested permission: edit', scope: {} })
    const record = requested[0]!

    channel.abort('session closed')
    await expect(promise).resolves.toBe('deny')

    const after = store.getApproval(record.id)
    expect(after.status).toBe('expired')
    expect(after.decidedBy).toBe('pluton:aborted')
    expect(settled).toHaveLength(1)
    expect(settled[0]!.settlement).toBe('abort')
    expect(timers.live()).toEqual({ timeouts: 0, intervals: 0 })

    // Abort is idempotent and never re-settles.
    channel.abort('again')
    expect(settled).toHaveLength(1)
    store.close()
  })

  it('abort never grants, even when another process approved the very same record first', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested, settled, timers } = makeChannel(store, projectId)

    const promise = channel.requestPermission({ requestId: 'call_race', description: 'engine requested permission: edit', scope: {} })
    const record = requested[0]!

    // Another Pluton process (TUI/CLI) approves the durable record; this
    // process has not observed it yet (the poll has not fired).
    store.setApprovalStatus(record.id, 'approved', { decidedBy: 'operator' })

    // The session is cancelled in the same window: a cancelled turn must
    // never receive a grant, while the durable record stays truthful.
    channel.abort('turn cancelled by operator')
    await expect(promise).resolves.toBe('deny')

    expect(store.getApproval(record.id).status).toBe('approved')
    expect(settled).toHaveLength(1)
    expect(settled[0]!.settlement).toBe('abort')
    expect(pendingApprovalWaiterCount()).toBe(0)
    expect(timers.live()).toEqual({ timeouts: 0, intervals: 0 })

    // And no late in-process settle can resurrect the grant either.
    expect(settleApprovalWaiter(record.id, 'approved')).toBe(false)
    store.close()
  })

  it('settles even when the injected timer seam throws during cleanup', async () => {
    const { store, projectId } = makeProject()
    const throwingTimers: EngineApprovalTimers = {
      setTimeout: () => 1,
      clearTimeout: () => {
        throw new Error('clearTimeout boom')
      },
      setInterval: () => 2,
      clearInterval: () => {
        throw new Error('clearInterval boom')
      },
    }
    const { channel, requested } = makeChannel(store, projectId, { timers: throwingTimers })

    const promise = channel.requestPermission({ requestId: null, description: 'engine requested permission: edit', scope: {} })
    expect(settleApprovalWaiter(requested[0]!.id, 'approved')).toBe(true)
    await expect(promise).resolves.toBe('allow')
    expect(pendingApprovalWaiterCount()).toBe(0)
    store.close()
  })

  it('observes a decision made outside this process via the bounded poll backstop', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested, settled, timers } = makeChannel(store, projectId, { pollIntervalMs: 1_000 })

    const promise = channel.requestPermission({ requestId: 'call_1', description: 'engine requested permission: shell', scope: {} })
    const record = requested[0]!

    timers.fireAllIntervals()
    // Nothing decided elsewhere yet: the request is still waiting.
    expect(pendingApprovalWaiterCount()).toBe(1)
    expect(settled).toHaveLength(0)

    // Another process records the operator decision in the shared store.
    store.setApprovalStatus(record.id, 'approved', { decidedBy: 'operator' })
    timers.fireAllIntervals()
    await expect(promise).resolves.toBe('allow')
    expect(settled[0]!.settlement).toBe('decision')
    expect(pendingApprovalWaiterCount()).toBe(0)
    expect(timers.live()).toEqual({ timeouts: 0, intervals: 0 })
    store.close()
  })

  it('bounds the reason and redacts/bounds the operator-visible scope', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested } = makeChannel(store, projectId)

    const promise = channel.requestPermission({
      requestId: null,
      description: `secret${'x'.repeat(1_200)}\n\ttrailing`,
      scope: { apiKey: 'sk-must-not-leak', blob: 'y'.repeat(10_000) },
    })
    const record = requested[0]!

    expect(record.reason.length).toBeLessThanOrEqual(500)
    expect(record.reason).not.toContain('\n')
    expect(record.reason).not.toContain('\t')
    const scopeJson = JSON.stringify(record.scope)
    expect(scopeJson).not.toContain('sk-must-not-leak')
    expect(scopeJson).toContain('[redacted]')
    expect(scopeJson.length).toBeLessThanOrEqual(2_100)

    settleApprovalWaiter(record.id, 'denied')
    await expect(promise).resolves.toBe('deny')
    store.close()
  })

  it('strips terminal control escapes from the operator-visible reason and scope', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested } = makeChannel(store, projectId)

    const promise = channel.requestPermission({
      requestId: 'call_esc',
      description: 'engine requested permission: \u001b[2Jclear\u0007 screen\u202ereversed',
      scope: { toolTitle: '\u001b[31mred\u001b[0m', paths: ['src/\u001b[2Ja.ts'] },
    })
    const record = requested[0]!

    // Text survives; bytes that could drive or spoof the operator's terminal
    // (ESC/CR/BEL/CSI, bidi controls) never reach the durable record.
    expect(record.reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/)
    expect(record.reason).toContain('clear')
    expect(record.reason).toContain('screen')
    const scopeJson = JSON.stringify(record.scope)
    expect(scopeJson).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/)
    expect(scopeJson).toContain('a.ts')

    settleApprovalWaiter(record.id, 'denied')
    await expect(promise).resolves.toBe('deny')
    store.close()
  })

  it('fails closed when the durable record cannot be created', async () => {
    const { store, projectId } = makeProject()
    store.close()
    const { channel } = makeChannel(store, projectId)
    await expect(
      channel.requestPermission({ requestId: null, description: 'engine requested permission: edit', scope: {} }),
    ).resolves.toBe('deny')
  })

  it('wakes a waiting engine request through the real operator decision funnel', async () => {
    const { ctx, store, projectId } = makeProject()
    const { channel, requested } = makeChannel(store, projectId)

    const promise = channel.requestPermission({ requestId: 'call_7', description: 'engine requested permission: shell', scope: { tool: 'exec' } })
    const record = requested[0]!

    const report = await decideApproval(ctx, { approvalRef: record.id, decision: 'approve' })
    expect(report.approval.status).toBe('approved')
    await expect(promise).resolves.toBe('allow')

    // And a denied request stays denied through the same funnel.
    const denied = channel.requestPermission({ requestId: 'call_8', description: 'engine requested permission: exec', scope: {} })
    const deniedRecord = requested[1]!
    await decideApproval(ctx, { approvalRef: deniedRecord.id, decision: 'deny' })
    await expect(denied).resolves.toBe('deny')
    store.close()
  })
})

describe('interactive engine approval channel: per-session pending cap', () => {
  const ask = (channel: ReturnType<typeof createEngineApprovalChannel>, n: number) =>
    channel.requestPermission({ requestId: `call_${String(n)}`, description: `engine asked ${String(n)}`, scope: {} })

  it('rejects requests past the cap without records, waiters or timers, then recovers as they settle', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested, timers } = makeChannel(store, projectId)
    const base = pendingApprovalWaiterCount()

    const open = [1, 2, 3].map((n) => ask(channel, n))
    expect(requested).toHaveLength(3)
    expect(pendingApprovalWaiterCount()).toBe(base + 3)

    // The fourth concurrent question is refused fail-closed: no durable record,
    // no waiter, no timer — nothing actionable lands in the operator inbox.
    const fourth = ask(channel, 4)
    expect(requested).toHaveLength(3)
    expect(store.listApprovalsByProject(projectId)).toHaveLength(3)
    expect(timers.live()).toEqual({ timeouts: 3, intervals: 3 })
    await expect(fourth).resolves.toBe('deny')
    expect(pendingApprovalWaiterCount()).toBe(base + 3)

    // Settlement frees capacity one-for-one: the next request is admitted.
    for (const record of requested) settleApprovalWaiter(record.id, 'denied')
    await expect(Promise.all(open)).resolves.toEqual(['deny', 'deny', 'deny'])
    expect(pendingApprovalWaiterCount()).toBe(base)

    const after = ask(channel, 5)
    expect(requested).toHaveLength(4)
    expect(pendingApprovalWaiterCount()).toBe(base + 1)
    settleApprovalWaiter(requested[3]!.id, 'denied')
    await expect(after).resolves.toBe('deny')
    store.close()
  })

  it('admits exactly the cap when many requests race in the same tick', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested } = makeChannel(store, projectId)
    const base = pendingApprovalWaiterCount()

    const all = [1, 2, 3, 4, 5, 6].map((n) => ask(channel, n))
    // Admission stays synchronous up to waiter registration, so nothing can
    // interleave between the size check and the pending-set add.
    expect(requested).toHaveLength(3)
    expect(store.listApprovalsByProject(projectId)).toHaveLength(3)
    expect(pendingApprovalWaiterCount()).toBe(base + 3)

    for (const record of requested) settleApprovalWaiter(record.id, 'denied')
    await expect(Promise.all(all)).resolves.toEqual(['deny', 'deny', 'deny', 'deny', 'deny', 'deny'])
    expect(pendingApprovalWaiterCount()).toBe(base)
    store.close()
  })

  it('releases capacity on session abort (cancellation) and recovers afterwards', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested, timers } = makeChannel(store, projectId)
    const base = pendingApprovalWaiterCount()

    const open = [1, 2, 3].map((n) => ask(channel, n))
    expect(pendingApprovalWaiterCount()).toBe(base + 3)

    channel.abort('session closed')
    await expect(Promise.all(open)).resolves.toEqual(['deny', 'deny', 'deny'])
    expect(pendingApprovalWaiterCount()).toBe(base)
    expect(timers.live()).toEqual({ timeouts: 0, intervals: 0 })
    for (const record of requested) expect(store.getApproval(record.id).status).toBe('expired')

    const after = ask(channel, 4)
    expect(requested).toHaveLength(4)
    settleApprovalWaiter(requested[3]!.id, 'denied')
    await expect(after).resolves.toBe('deny')
    store.close()
  })

  it('releases capacity when the TTL expires pending requests and recovers afterwards', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested, timers } = makeChannel(store, projectId)
    const base = pendingApprovalWaiterCount()

    const open = [1, 2, 3].map((n) => ask(channel, n))
    timers.fireAllTimeouts()

    await expect(Promise.all(open)).resolves.toEqual(['deny', 'deny', 'deny'])
    expect(pendingApprovalWaiterCount()).toBe(base)
    expect(timers.live()).toEqual({ timeouts: 0, intervals: 0 })
    for (const record of requested) expect(store.getApproval(record.id).status).toBe('expired')

    const after = ask(channel, 4)
    expect(requested).toHaveLength(4)
    settleApprovalWaiter(requested[3]!.id, 'denied')
    await expect(after).resolves.toBe('deny')
    store.close()
  })

  it('honours a configured cap', async () => {
    const { store, projectId } = makeProject()
    const { channel, requested } = makeChannel(store, projectId, { maxPendingRequests: 1 })
    const base = pendingApprovalWaiterCount()

    const first = ask(channel, 1)
    const second = ask(channel, 2)
    expect(requested).toHaveLength(1)
    await expect(second).resolves.toBe('deny')
    expect(pendingApprovalWaiterCount()).toBe(base + 1)

    settleApprovalWaiter(requested[0]!.id, 'denied')
    await expect(first).resolves.toBe('deny')
    store.close()
  })
})
