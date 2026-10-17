import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { PlanManager } from '../../src/plan/manager.ts'
import { renderPlanGraph } from '../../src/tui/plan-graph.ts'
import { StateTransitionError, ValidationError } from '../../src/domain/errors.ts'

describe('PlanManager and plan-graph', () => {
  const tmpDirs: string[] = []
  const openDbs: DatabaseSync[] = []

  afterEach(() => {
    while (openDbs.length > 0) {
      try {
        openDbs.pop()?.close()
      } catch {
        // best effort
      }
    }
    while (tmpDirs.length > 0) {
      const d = tmpDirs.pop()
      if (d) {
        try {
          rmSync(d, { recursive: true, force: true })
        } catch {
          // best effort
        }
      }
    }
  })

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'pluton-plan-mgr-'))
    tmpDirs.push(dir)
    const db = openDatabase(join(dir, 'pluton.sqlite'))
    openDbs.push(db)
    migrate(db)
    const store = new Store(db)

    const project = store.ensureProject({
      name: 'PlanMgr Test',
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
        engineKind: 'opencode',
        model: 'opencode/test',
        instructionsFile: null,
        workspacePolicy: 'isolated-task-checkout',
        permissions: ['task.create', 'task.delegate'],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: join(dir, '.pluton/engine-homes/manager'),
      },
      {
        id: 'developer',
        slug: 'developer',
        displayName: 'Developer',
        role: 'developer',
        engineKind: 'opencode',
        model: 'opencode/test',
        instructionsFile: null,
        workspacePolicy: 'isolated-task-checkout',
        permissions: ['task.create'],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: join(dir, '.pluton/engine-homes/developer'),
      },
    ])
    const session = store.createChatSession({
      projectId: project.id,
      museId: 'manager',
      title: 'Planning Session',
    })

    const manager = new PlanManager(store, project.id, session.id)
    return { store, project, session, manager, dir }
  }

  it('creates draft, adds tasks, and transitions states through review and approval', () => {
    const { manager } = setup()

    const plan = manager.createPlanDraft('Refactor authentication module')
    expect(plan.state).toBe('DRAFT')
    expect(plan.goal).toBe('Refactor authentication module')
    expect(plan.tasks).toHaveLength(0)

    // Add first task
    const p1 = manager.addTask(plan.id, {
      id: 'task-1',
      title: 'Design interface',
      description: 'Create types and schemas',
      assigneeRole: 'developer',
      dependsOn: [],
      acceptanceCriteria: ['Types export correctly'],
    })
    expect(p1.tasks).toHaveLength(1)

    // Add second task depending on first
    const p2 = manager.addTask(plan.id, {
      id: 'task-2',
      title: 'Implement provider',
      description: 'Implement JWT provider',
      assigneeRole: 'developer',
      dependsOn: ['task-1'],
      acceptanceCriteria: ['Passes unit tests'],
    })
    expect(p2.tasks).toHaveLength(2)

    // Move to REVIEW
    const pReview = manager.reviewPlan(plan.id)
    expect(pReview.state).toBe('REVIEW')

    // Approve plan
    const pApproved = manager.approvePlan(plan.id)
    expect(pApproved.state).toBe('APPROVED')

    // Modifying a task invalidates approval back to DRAFT
    const pModified = manager.editTask(plan.id, 'task-2', {
      title: 'Implement JWT and OAuth provider',
    })
    expect(pModified.state).toBe('DRAFT')
    expect(pModified.tasks.find((t) => t.id === 'task-2')?.title).toBe('Implement JWT and OAuth provider')

    // Re-approving requires review
    manager.reviewPlan(plan.id)
    const reApproved = manager.approvePlan(plan.id)
    expect(reApproved.state).toBe('APPROVED')

    // Modifying goal also invalidates approval
    const pGoalChanged = manager.setGoal(plan.id, 'New goal')
    expect(pGoalChanged.state).toBe('DRAFT')
  })

  it('rejects dependency cycles and missing dependencies when adding or editing tasks', () => {
    const { manager } = setup()
    const plan = manager.createPlanDraft('Cycle test')

    manager.addTask(plan.id, {
      id: 'task-1',
      title: 'Task 1',
      description: '',
      assigneeRole: 'developer',
      dependsOn: [],
      acceptanceCriteria: ['Done'],
    })

    // Missing dependency
    expect(() =>
      manager.addTask(plan.id, {
        id: 'task-2',
        title: 'Task 2',
        description: '',
        assigneeRole: 'developer',
        dependsOn: ['non-existent'],
        acceptanceCriteria: ['Done'],
      }),
    ).toThrow(ValidationError)

    // Add task-2 depending on task-1
    manager.addTask(plan.id, {
      id: 'task-2',
      title: 'Task 2',
      description: '',
      assigneeRole: 'developer',
      dependsOn: ['task-1'],
      acceptanceCriteria: ['Done'],
    })

    // Add task-3 depending on task-2
    manager.addTask(plan.id, {
      id: 'task-3',
      title: 'Task 3',
      description: '',
      assigneeRole: 'developer',
      dependsOn: ['task-2'],
      acceptanceCriteria: ['Done'],
    })

    // Edit task-1 to depend on task-3 (creating cycle 1 -> 3 -> 2 -> 1)
    expect(() =>
      manager.editTask(plan.id, 'task-1', {
        dependsOn: ['task-3'],
      }),
    ).toThrow(ValidationError)
  })

  it('removes tasks and cleans up or detects dependent tasks', () => {
    const { manager } = setup()
    const plan = manager.createPlanDraft('Remove test')

    manager.addTask(plan.id, {
      id: 'task-1',
      title: 'Task 1',
      description: '',
      assigneeRole: 'developer',
      dependsOn: [],
      acceptanceCriteria: ['Done'],
    })
    manager.addTask(plan.id, {
      id: 'task-2',
      title: 'Task 2',
      description: '',
      assigneeRole: 'developer',
      dependsOn: ['task-1'],
      acceptanceCriteria: ['Done'],
    })

    // Cannot remove task-1 while task-2 depends on it
    expect(() => manager.removeTask(plan.id, 'task-1')).toThrow(ValidationError)

    // Remove task-2 first, then task-1
    manager.removeTask(plan.id, 'task-2')
    const finalPlan = manager.removeTask(plan.id, 'task-1')
    expect(finalPlan.tasks).toHaveLength(0)
  })

  it('requires approval before execution and rejects premature execution', async () => {
    const { manager, store, project } = setup()
    const plan = manager.createPlanDraft('Exec test')

    manager.addTask(plan.id, {
      id: 'task-1',
      title: 'Task 1',
      description: '',
      assigneeRole: 'developer',
      dependsOn: [],
      acceptanceCriteria: ['Done'],
    })

    // In DRAFT state, execution must throw StateTransitionError
    let executed = false
    await expect(
      manager.executePlan(plan.id, async () => {
        executed = true
        return 'run-123'
      }),
    ).rejects.toThrow(StateTransitionError)
    expect(executed).toBe(false)

    // Approve plan first
    manager.reviewPlan(plan.id)
    manager.approvePlan(plan.id)

    // Now execution succeeds and transitions to RUNNING with runId
    const run = store.createRun({
      projectId: project.id,
      goal: plan.goal,
      origin: 'cli',
      requestedBy: 'cli',
      acceptanceCriteria: ['Pass'],
      managerMuseId: 'manager',
      budget: {
        maxConcurrentWorkers: 2,
        maxTasks: 10,
        maxDelegationDepth: 2,
        maxRunMinutes: 30,
        defaultTaskMinutes: 10,
      },
    })

    const runningPlan = await manager.executePlan(plan.id, async () => {
      executed = true
      return run.id
    })
    expect(executed).toBe(true)
    expect(runningPlan.state).toBe('RUNNING')
    expect(runningPlan.runId).toBe(run.id)
  })

  it('renders a readable TUI task graph with dependencies and states', () => {
    const { manager } = setup()
    const plan = manager.createPlanDraft('Render test')

    manager.addTask(plan.id, {
      id: 'task-1',
      title: 'Create migration',
      description: '',
      assigneeRole: 'developer',
      dependsOn: [],
      acceptanceCriteria: ['Table created'],
    })
    manager.addTask(plan.id, {
      id: 'task-2',
      title: 'Add API endpoint',
      description: '',
      assigneeRole: 'developer',
      dependsOn: ['task-1'],
      acceptanceCriteria: ['API returns 200'],
    })

    const latest = manager.getPlan(plan.id)
    const rendered = renderPlanGraph(latest)

    expect(rendered).toContain('Render test')
    expect(rendered).toContain('DRAFT')
    expect(rendered).toContain('task-1')
    expect(rendered).toContain('Create migration')
    expect(rendered).toContain('task-2')
    expect(rendered).toContain('needs: task-1')
    expect(rendered).toContain('developer')
  })
})
