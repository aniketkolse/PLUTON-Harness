import { describe, expect, it, vi } from 'vitest'
import { decideApproval } from '../../src/cli/commands/approvals.ts'
import { bootstrapStore } from '../../src/bootstrap.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { admitTask } from '../../src/orchestrator/task-graph.ts'
import type { Store } from '../../src/store/store.ts'
import type { LoadedConfig } from '../../src/config/load.ts'
import type { IntegrateReport } from '../../src/cli/commands/integrate.ts'

function createTestProject(): { ctx: ProjectContext; store: Store; runId: string; taskId: string; approvalId: string } {
  const loaded: LoadedConfig = {
    rootDir: '/tmp/test-approvals',
    configPath: '/tmp/test-approvals/pluton.yaml',
    config: {
      version: 1,
      project: { name: 'test-approvals-p', repository: '.', default_branch: 'main', verification: [] },
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
      git: { protected_paths: ['src/sensitive/**'], require_approval_for_main_branch_integration: false },
      muses: {
        manager: {
          display_name: 'Manager',
          role: 'supervisor',
          engine: 'mock',
          model: 'mock/model',
          workspace_policy: 'coordinator-read-only',
          approval_mode: 'autonomous-bounded',
        },
      },
    },
  }

  const { store, projectId } = bootstrapStore(loaded)
  const run = store.createRun({
    projectId,
    goal: 'test approval auto-continue',
    origin: 'cli',
    requestedBy: 'test',
    acceptanceCriteria: [],
    managerMuseId: 'manager',
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
      title: 'task touching protected',
      brief: 'brief',
      acceptanceCriteria: [],
      assigneeMuseId: 'manager',
    },
    { maxChildrenPerTask: 5 },
  )

  const approval = store.createApproval({
    projectId,
    runId: run.id,
    taskId: task.id,
    requestedByMuseId: 'manager',
    action: 'integration.apply',
    reason: 'touches protected paths',
    scope: { taskId: task.id, runId: run.id, files: ['src/sensitive/secret.ts'] },
    expiresAt: null,
  })

  const ctx: ProjectContext = {
    rootDir: loaded.rootDir,
    configPath: loaded.configPath,
    loaded,
  }

  return { ctx, store, runId: run.id, taskId: task.id, approvalId: approval.id }
}

describe('PR-4 Step 3: Auto-continue Path for Approvals', () => {
  it('decides approval and calls integrateRun when autoContinue is true for integration.apply', async () => {
    const { ctx, store, runId, taskId, approvalId } = createTestProject()

    try {
      const integrateMock = vi.fn().mockResolvedValue({
        runId,
        checkout: { id: 'ws_1', path: '/work', branch: 'pluton/integration' },
        integrated: [{ taskId, title: 'task touching protected', status: 'merged', commit: 'abc1234' }],
        committed: [],
        conflicts: [],
        blockedProtected: [],
        blockedOverlap: [],
        failed: [],
        notAttempted: [],
        stoppedAfterConflict: false,
        checks: [{ name: 'test', status: 'passed', exitCode: 0, outputTail: 'ok' }],
        artifactPath: null,
      } as IntegrateReport)

      const report = await decideApproval(
        ctx,
        {
          approvalRef: approvalId,
          decision: 'approve',
          autoContinue: true,
        },
        {
          integrateRunFn: integrateMock,
        },
      )

      expect(report.approval.status).toBe('approved')
      expect(integrateMock).toHaveBeenCalledTimes(1)
      expect(integrateMock).toHaveBeenCalledWith(ctx, { runRef: runId, taskRefs: [taskId] })
      expect(report.integrationReport).toBeDefined()
      expect(report.integrationReport?.integrated).toHaveLength(1)

      // Durable store records approval as approved
      expect(store.getApproval(approvalId).status).toBe('approved')
    } finally {
      store.close()
    }
  })

  it('decides approval without auto-continue when autoContinue is false', async () => {
    const { ctx, store, runId, taskId, approvalId } = createTestProject()

    try {
      const integrateMock = vi.fn()

      const report = await decideApproval(
        ctx,
        {
          approvalRef: approvalId,
          decision: 'approve',
          autoContinue: false,
        },
        {
          integrateRunFn: integrateMock,
        },
      )

      expect(report.approval.status).toBe('approved')
      expect(integrateMock).not.toHaveBeenCalled()
      expect(report.integrationReport).toBeNull()
      expect(store.getApproval(approvalId).status).toBe('approved')
    } finally {
      store.close()
    }
  })

  it('unparks and resumes a run when autoContinue is true', async () => {
    const { ctx, store, runId, approvalId } = createTestProject()

    try {
      // Settle the initial approval so only runApproval is pending
      store.setApprovalStatus(approvalId, 'approved')

      store.setRunState(runId, 'active')
      store.setRunState(runId, 'awaiting_approval')

      const runApproval = store.createApproval({
        projectId: store.getRun(runId).projectId,
        runId,
        taskId: null,
        requestedByMuseId: 'manager',
        action: 'tool.execute',
        reason: 'execute sensitive command',
        scope: { command: 'deploy' },
        expiresAt: null,
      })

      const resumeMock = vi.fn().mockResolvedValue({
        runId,
        state: 'completed',
        outcome: 'success',
        taskCounts: {},
        managerSummary: 'resumed',
        unfinishedTasks: [],
        blockedTasks: [],
        verificationPending: false,
      })

      const report = await decideApproval(
        ctx,
        {
          approvalRef: runApproval.id,
          decision: 'approve',
          autoContinue: true,
        },
        {
          resumeRunFn: resumeMock,
        },
      )

      expect(report.approval.status).toBe('approved')
      expect(report.run?.resumed).toBe(true)
      expect(resumeMock).toHaveBeenCalledTimes(1)
      expect(resumeMock).toHaveBeenCalledWith(ctx, runId, { skipManager: true })
      expect(report.run?.resumeSummary?.state).toBe('completed')
    } finally {
      store.close()
    }
  })
})
