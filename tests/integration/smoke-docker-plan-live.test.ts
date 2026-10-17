import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { PlanManager } from '../../src/plan/manager.ts'
import { renderPlanGraph } from '../../src/tui/plan-graph.ts'
import { StateTransitionError, ValidationError } from '../../src/domain/errors.ts'

describe('live smoke-docker plan mode validation', () => {
  const smokeDir = join(process.cwd(), '.pluton-tmp', 'smoke-docker')

  it('validates plan creation, dependency constraints, approval invalidation, and execution handoff', async () => {
    const loaded = loadConfig(smokeDir)
    const { store, projectId } = bootstrapStore(loaded)

    const managerMuse = store.getMuse('manager') ?? store.listMuses().find((m) => m.slug === 'manager')!
    expect(managerMuse).toBeDefined()

    const session = store.createChatSession({
      projectId,
      museId: managerMuse.id,
      title: 'Live Smoke Plan Session',
    })

    const planMgr = new PlanManager(store, projectId, session.id)

    // 1. Planning does not execute tasks prematurely
    const plan = planMgr.createPlanDraft('Add ## Smoke documentation section')
    expect(plan.state).toBe('DRAFT')
    expect(plan.runId).toBeNull()

    // 2. Add structured tasks
    const t1 = planMgr.addTask(plan.id, {
      id: 'task-1',
      title: 'Inspect README.md and smoke test',
      description: 'Check smoke.test.js requirement',
      assigneeRole: 'manager',
      dependsOn: [],
      acceptanceCriteria: ['Identified required section format'],
    })
    expect(t1.tasks).toHaveLength(1)

    const t2 = planMgr.addTask(plan.id, {
      id: 'task-2',
      title: 'Append ## Smoke section to README.md',
      description: 'Add documentation section for verification',
      assigneeRole: 'worker',
      dependsOn: ['task-1'],
      acceptanceCriteria: ['README.md contains ## Smoke'],
    })
    expect(t2.tasks).toHaveLength(2)

    // 3. Task dependencies and cycle detection
    expect(() =>
      planMgr.editTask(plan.id, 'task-1', {
        dependsOn: ['task-2'],
      }),
    ).toThrow(ValidationError)

    // 4. Execution rejected in DRAFT
    let executed = false
    await expect(
      planMgr.executePlan(plan.id, async () => {
        executed = true
        return 'dummy'
      }),
    ).rejects.toThrow(StateTransitionError)
    expect(executed).toBe(false)

    // 5. Review & Approve
    planMgr.reviewPlan(plan.id)
    const approved = planMgr.approvePlan(plan.id)
    expect(approved.state).toBe('APPROVED')

    // 6. Invalidation upon modification
    const invalidated = planMgr.editTask(plan.id, 'task-2', {
      title: 'Append ## Smoke section with detailed notes',
    })
    expect(invalidated.state).toBe('DRAFT')

    // 7. Re-approve
    planMgr.reviewPlan(plan.id)
    planMgr.approvePlan(plan.id)

    // 8. Execution starts only after confirmation
    const run = store.createRun({
      projectId,
      goal: plan.goal,
      origin: 'cli',
      requestedBy: 'operator',
      acceptanceCriteria: ['smoke test passes'],
      managerMuseId: managerMuse.id,
      budget: {
        maxConcurrentWorkers: 1,
        maxTasks: 5,
        maxDelegationDepth: 2,
        maxRunMinutes: 10,
        defaultTaskMinutes: 5,
      },
    })

    const runningPlan = await planMgr.executePlan(plan.id, async () => {
      // Admit task graph to the run
      const idMap = new Map<string, string>()
      for (const t of invalidated.tasks) {
        const admitted = store.createTask({
          runId: run.id,
          parentTaskId: null,
          title: t.title,
          brief: t.description || t.title,
          acceptanceCriteria: t.acceptanceCriteria,
          assigneeMuseId: managerMuse.id,
        })
        idMap.set(t.id, admitted.id)
      }
      for (const t of invalidated.tasks) {
        const toId = idMap.get(t.id)!
        for (const dep of t.dependsOn) {
          const fromId = idMap.get(dep)
          if (fromId) store.addEdge(run.id, toId, fromId, 'depends_on')
        }
      }
      return run.id
    })

    expect(runningPlan.state).toBe('RUNNING')
    expect(runningPlan.runId).toBe(run.id)

    // 9. Verify graph in run store
    const runTasks = store.listTasks(run.id)
    expect(runTasks).toHaveLength(2)
    const runEdges = store.listEdges(run.id)
    expect(runEdges).toHaveLength(1)

    // 10. TUI graph rendering
    const graphOutput = renderPlanGraph(runningPlan, runTasks)
    expect(graphOutput).toContain('RUNNING')
    expect(graphOutput).toContain('task-1')
    expect(graphOutput).toContain('task-2')
    expect(graphOutput).toContain('needs: task-1')

    // 11. Cancellation stops work
    store.setRunState(run.id, 'cancelled')
    const cancelledPlan = planMgr.cancelPlan(plan.id)
    expect(cancelledPlan.state).toBe('CANCELLED')
  })
})
