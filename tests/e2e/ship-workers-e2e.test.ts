import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { createTestContext, type TestContext } from '../helpers/context.ts'
import { handleQuestionDecision } from '../../src/server/routes.ts'

describe('Ship Workers Complete Orchestration E2E', () => {
  let ctx: TestContext | null = null

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup()
      ctx = null
    }
  })

  it('runs complete multi-agent workflow with selective pausing and isolated workspaces', async () => {
    ctx = await createTestContext()
    const runId = await ctx.startRun('Investigate architecture and fix reliability')

    // 1. Manager delegates tasks: QA (task-qa), Researcher (task-researcher), Coder (task-coder), Reviewer (task-reviewer)
    const taskQa = await ctx.admitTask({
      id: 'task-qa',
      title: 'QA architecture investigation',
      brief: 'Investigate test coverage and reliability bottlenecks',
      assigneeMuseId: 'qa',
      acceptanceCriteria: ['Architecture bottlenecks identified'],
    })

    const taskResearcher = await ctx.admitTask({
      id: 'task-researcher',
      title: 'Research resilience patterns',
      brief: 'Research circuit breaker and failover patterns',
      assigneeMuseId: 'researcher',
      acceptanceCriteria: ['Resilience recommendations provided'],
    })

    // 2. task-coder depends on task-qa
    const taskCoder = await ctx.admitTask({
      id: 'task-coder',
      title: 'Implement reliability fix',
      brief: 'Implement circuit breaker mechanism in src/index.ts',
      assigneeMuseId: 'coder',
      acceptanceCriteria: ['Circuit breaker fix implemented with tests'],
      dependsOn: ['task-qa'],
    })

    const taskReviewer = await ctx.admitTask({
      id: 'task-reviewer',
      title: 'Review implementation diff',
      brief: 'Review code changes and verify tests pass',
      assigneeMuseId: 'reviewer',
      acceptanceCriteria: ['Code review completed and diff verified'],
      dependsOn: ['task-coder'],
    })

    expect(taskQa.id).toBe('task-qa')
    expect(taskResearcher.id).toBe('task-researcher')
    expect(taskCoder.id).toBe('task-coder')
    expect(taskReviewer.id).toBe('task-reviewer')

    // 3. QA emits question (enters waiting / needs_approval), which selectively pauses task-coder, while task-researcher proceeds
    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.started',
      runId,
      taskId: taskQa.id,
      role: 'qa',
      model: 'mock/model',
      workspace: '.pluton/workspaces/task-qa',
    })

    ctx.store.setTaskState(taskQa.id, 'admitted')
    ctx.store.setTaskState(taskQa.id, 'running')

    const approval = ctx.store.createApproval({
      projectId: ctx.projectId,
      runId,
      taskId: taskQa.id,
      requestedByMuseId: 'qa',
      action: 'qa.question',
      reason: 'Select heartbeat failover strategy',
      scope: {
        question: 'Which heartbeat failover strategy should we use?',
        options: ['Circuit breaker with fallback', 'Exponential backoff'],
      },
    })

    ctx.store.setTaskState(taskQa.id, 'needs_approval')

    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.waiting',
      runId,
      taskId: taskQa.id,
      role: 'qa',
      payload: {
        questionId: approval.id,
        title: 'Select heartbeat failover strategy',
        dependentTasks: [taskCoder.id],
      },
    })

    // Selective pausing: task-coder paused while QA is in needs_approval, task-researcher is independent and ready
    const readyTasks1 = ctx.store.listReadyTasks(runId).map((t) => t.id)
    expect(readyTasks1).toContain(taskResearcher.id)
    expect(readyTasks1).not.toContain(taskCoder.id)

    // Researcher proceeds independently and completes
    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.started',
      runId,
      taskId: taskResearcher.id,
      role: 'researcher',
      model: 'mock/model',
    })
    ctx.store.setTaskState(taskResearcher.id, 'admitted')
    ctx.store.setTaskState(taskResearcher.id, 'running')

    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.progress',
      runId,
      taskId: taskResearcher.id,
      role: 'researcher',
      payload: { step: 'evaluating circuit breaker pattern' },
    })

    ctx.store.setTaskState(taskResearcher.id, 'completed', {
      result: { outcome: 'success', summary: 'Recommended circuit breaker with fallback' },
    })

    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.completed',
      runId,
      taskId: taskResearcher.id,
      role: 'researcher',
      payload: { outcome: 'success', summary: 'Research completed' },
    })

    // 4. Operator answers QA question via handleQuestionDecision with selectedOption
    const decisionResult = await handleQuestionDecision({
      approvalId: approval.id,
      decision: 'approved',
      selectedOption: 'Circuit breaker with fallback',
      answer: 'Approved circuit breaker with fallback strategy',
      store: ctx.store,
      projectId: ctx.projectId,
    })

    expect(decisionResult.status).toBe('resolved')
    expect(decisionResult.unblockedTasks).toContain(taskCoder.id)

    // 5. QA task is completed, unblocking task-coder
    const qaTaskUpdated = ctx.store.getTask(taskQa.id)
    expect(qaTaskUpdated.state).toBe('completed')

    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.completed',
      runId,
      taskId: taskQa.id,
      role: 'qa',
      payload: { outcome: 'success', selectedOption: 'Circuit breaker with fallback' },
    })

    const readyTasks2 = ctx.store.listReadyTasks(runId).map((t) => t.id)
    expect(readyTasks2).toContain(taskCoder.id)

    // 6. Coder executes in isolated checkout (isolated-task-checkout)
    const coderCheckout = await ctx.workspaceManager.createCheckout({
      repoPath: ctx.rootDir,
      kind: 'task-checkout',
      runId,
      slug: 'task-coder',
      destName: taskCoder.id,
    })

    expect(existsSync(coderCheckout.path)).toBe(true)
    expect(coderCheckout.branch).toBe(`pluton/${runId}/task-coder`)

    const coderWorkspace = ctx.store.createWorkspace({
      projectId: ctx.projectId,
      runId,
      taskId: taskCoder.id,
      museId: 'coder',
      kind: 'task-checkout',
      path: coderCheckout.path,
      branch: coderCheckout.branch,
      baseCommit: coderCheckout.baseCommit,
    })

    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.started',
      runId,
      taskId: taskCoder.id,
      role: 'coder',
      model: 'mock/model',
      workspace: coderCheckout.path,
    })

    ctx.store.setTaskState(taskCoder.id, 'admitted')
    ctx.store.setTaskState(taskCoder.id, 'running', { workspaceId: coderWorkspace.id })

    // Coder writes fix inside isolated checkout
    writeFileSync(
      join(coderCheckout.path, 'src', 'index.ts'),
      'export const ready = true;\nexport const fix = "circuit-breaker";\n',
      'utf8',
    )

    // Verify workspace isolation: root repository file remains unchanged
    const rootIndexContent = readFileSync(join(ctx.rootDir, 'src', 'index.ts'), 'utf8')
    const isolatedIndexContent = readFileSync(join(coderCheckout.path, 'src', 'index.ts'), 'utf8')
    expect(rootIndexContent).not.toContain('circuit-breaker')
    expect(isolatedIndexContent).toContain('circuit-breaker')

    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.progress',
      runId,
      taskId: taskCoder.id,
      role: 'coder',
      workspace: coderCheckout.path,
      payload: { step: 'circuit breaker implemented in isolated workspace' },
    })

    ctx.store.setTaskState(taskCoder.id, 'completed', {
      result: { outcome: 'success', summary: 'Implemented circuit breaker' },
    })

    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.completed',
      runId,
      taskId: taskCoder.id,
      role: 'coder',
      workspace: coderCheckout.path,
      payload: { filesChanged: ['src/index.ts'] },
    })

    // 7. Reviewer executes in read-only checkout
    const readyTasks3 = ctx.store.listReadyTasks(runId).map((t) => t.id)
    expect(readyTasks3).toContain(taskReviewer.id)

    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.started',
      runId,
      taskId: taskReviewer.id,
      role: 'reviewer',
      model: 'mock/model',
      workspace: ctx.rootDir,
    })

    ctx.store.setTaskState(taskReviewer.id, 'admitted')
    ctx.store.setTaskState(taskReviewer.id, 'running', { workspaceId: null })

    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.progress',
      runId,
      taskId: taskReviewer.id,
      role: 'reviewer',
      payload: { step: 'verifying diff and isolated changes' },
    })

    ctx.store.setTaskState(taskReviewer.id, 'completed', {
      result: { outcome: 'success', summary: 'Diff verified and clean' },
    })

    ctx.broadcaster.broadcastWorkerEvent({
      type: 'worker.completed',
      runId,
      taskId: taskReviewer.id,
      role: 'reviewer',
      payload: { approved: true },
    })

    // 8. Broadcaster persists and streams worker.* events
    const persistedEvents = ctx.store.listEvents(runId)
    const workerEvents = persistedEvents.filter((e) => e.type.startsWith('worker.'))
    expect(workerEvents.length).toBeGreaterThanOrEqual(6)

    const eventTypes = workerEvents.map((e) => e.type)
    expect(eventTypes).toContain('worker.started')
    expect(eventTypes).toContain('worker.progress')
    expect(eventTypes).toContain('worker.completed')

    // 9. Run completes cleanly with state succeeded
    const finalRun = await ctx.waitForRunCompletion(runId)
    expect(finalRun.state).toBe('succeeded')
  })
})
