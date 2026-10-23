import { describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { finalizeRunVerdict, applyTaskVerificationVerdict } from '../../src/verify/runner.ts'
import { admitTask } from '../../src/orchestrator/task-graph.ts'
import type { Store } from '../../src/store/store.ts'

function createTestSetup(): { store: Store; runId: string; task1Id: string; task2Id: string } {
  const loaded = {
    rootDir: '/tmp/test-proj',
    configPath: '/tmp/test-proj/pluton.yaml',
    config: {
      version: 1 as const,
      project: { name: 'test-p', repository: '.', default_branch: 'main', verification: [] },
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
        network_policy: 'restricted' as const,
        max_prompt_chars: 1000,
        max_event_payload_chars: 1000,
        max_tool_result_chars: 1000,
        heartbeat_seconds: 5,
        approval_timeout_minutes: 10,
      },
      sandbox: {
        kind: 'local-process' as const,
        local_process_acknowledged: true,
        native: {
          mode: 'workspace-write' as const,
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
          role: 'coder' as const,
          engine: 'mock',
          model: 'mock/model',
          workspace_policy: 'isolated-task-checkout' as const,
          approval_mode: 'autonomous-bounded' as const,
        },
      },
      muses: {
        worker: {
          display_name: 'Worker',
          role: 'coder' as const,
          engine: 'mock',
          model: 'mock/model',
          workspace_policy: 'isolated-task-checkout' as const,
          approval_mode: 'autonomous-bounded' as const,
        },
      },
    },
  }
  const { store, projectId } = bootstrapStore(loaded)
  const run = store.createRun({
    projectId,
    goal: 'test pipeline goal',
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
  store.setRunState(run.id, 'active')

  // Task 1: in verifying state
  const task1 = admitTask(
    store,
    {
      runId: run.id,
      parentTaskId: null,
      title: 'upstream task 1',
      brief: 'upstream brief',
      acceptanceCriteria: [],
      assigneeMuseId: 'worker',
    },
    { maxChildrenPerTask: 5 },
  )
  store.setTaskState(task1.id, 'admitted')
  store.setTaskState(task1.id, 'running')
  store.setTaskState(task1.id, 'verifying', { result: { outcome: 'success' } })

  // Task 2: queued, depends on task 1
  const task2 = admitTask(
    store,
    {
      runId: run.id,
      parentTaskId: null,
      title: 'downstream task 2',
      brief: 'downstream brief',
      acceptanceCriteria: [],
      assigneeMuseId: 'worker',
      dependsOn: [task1.id],
    },
    { maxChildrenPerTask: 5 },
  )

  store.setRunState(run.id, 'verifying')

  return { store, runId: run.id, task1Id: task1.id, task2Id: task2.id }
}

describe('PR-4: Verification Gate Re-dispatch', () => {
  it('unblocks downstream dependent task and transitions run to active with redispatched outcome', () => {
    const { store, runId, task1Id, task2Id } = createTestSetup()

    try {
      // Before task 1 verification: task 2 is blocked (not ready)
      expect(store.listReadyTasks(runId).map((t) => t.id)).toEqual([])

      // Simulate passing verification checks for task 1
      const check = store.createVerificationCheck({
        projectId: store.getRun(runId).projectId,
        runId,
        taskId: task1Id,
        name: 'test-check',
        command: ['echo', 'ok'],
        cwd: '/tmp',
        workspaceId: null,
      })
      store.setVerificationCheckResult(check.id, {
        status: 'passed',
        exitCode: 0,
      })

      const task1Verdict = applyTaskVerificationVerdict(store, task1Id)
      expect(task1Verdict.state).toBe('completed')
      expect(task1Verdict.passed).toBe(true)

      // Task 2 is now unblocked and ready!
      const readyAfter = store.listReadyTasks(runId)
      expect(readyAfter.map((t) => t.id)).toEqual([task2Id])

      // Finalize run verdict should now detect unblocked tasks and redispatch
      const runVerdict = finalizeRunVerdict(store, runId)
      expect(runVerdict).not.toBeNull()
      expect(runVerdict?.state).toBe('active')
      expect(runVerdict?.outcome).toBe('redispatched')
      expect(runVerdict?.redispatchedTasks).toEqual([task2Id])

      // Run state must now be 'active' in store, not stuck in 'verifying'
      const updatedRun = store.getRun(runId)
      expect(updatedRun.state).toBe('active')

      // Events must contain 'run.redispatched'
      const events = store.db
        .prepare("SELECT type, payload_json FROM events WHERE run_id = ? AND type = 'run.redispatched'")
        .all(runId) as { type: string; payload_json: string }[]
      expect(events).toHaveLength(1)
      const payload = JSON.parse(events[0]!.payload_json) as { unblockedTaskIds: string[] }
      expect(payload.unblockedTaskIds).toEqual([task2Id])
    } finally {
      store.close()
    }
  })

  it('fails the run when open tasks are permanently blocked by failed upstream dependency', () => {
    const { store, runId, task1Id, task2Id } = createTestSetup()

    try {
      // Simulate failing verification check for task 1
      const check = store.createVerificationCheck({
        projectId: store.getRun(runId).projectId,
        runId,
        taskId: task1Id,
        name: 'fail-check',
        command: ['echo', 'bad'],
        cwd: '/tmp',
        workspaceId: null,
      })
      store.setVerificationCheckResult(check.id, {
        status: 'failed',
        exitCode: 1,
      })

      const task1Verdict = applyTaskVerificationVerdict(store, task1Id)
      expect(task1Verdict.state).toBe('failed')
      expect(task1Verdict.passed).toBe(false)

      // Task 2 can never become ready
      expect(store.listReadyTasks(runId)).toEqual([])

      // Finalize run verdict detects all open tasks are permanently blocked
      const runVerdict = finalizeRunVerdict(store, runId)
      expect(runVerdict).not.toBeNull()
      expect(runVerdict?.state).toBe('failed')
      expect(runVerdict?.outcome).toBe('failure')

      const updatedRun = store.getRun(runId)
      expect(updatedRun.state).toBe('failed')
    } finally {
      store.close()
    }
  })

  it('does not call a run verified when terminal tasks were cancelled, and records why', () => {
    const { store, runId, task1Id, task2Id } = createTestSetup()

    try {
      // The documented manager failure mode: it cancels a dependent while the
      // prerequisite is verifying. Both end terminal, but neither is success.
      store.setTaskState(task1Id, 'cancelled', { failure: { code: 'operator_cancelled' } })
      store.setTaskState(task2Id, 'cancelled', { failure: { code: 'dependency_cancelled' } })

      const runVerdict = finalizeRunVerdict(store, runId)
      expect(runVerdict).toMatchObject({ state: 'failed', outcome: 'failure' })

      const run = store.getRun(runId)
      expect(run.state).toBe('failed')
      expect(run.finalSummary).toContain('cancelled')

      const row = store.db
        .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'run.finished'")
        .get(runId) as { payload_json: string } | undefined
      expect(JSON.parse(row?.payload_json as string)).toMatchObject({
        outcome: 'failure',
        via: 'verification',
        cancelledTasks: 2,
      })
    } finally {
      store.close()
    }
  })
})
