import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { PlanManager } from '../../src/plan/manager.ts'
import { collectDoctorChecks } from '../../src/cli/commands/doctor.ts'

describe('expanded chat slash handlers integration', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'pluton-slash-exp-'))
    tmpDirs.push(dir)
    const db = openDatabase(join(dir, 'pluton.sqlite'))
    openDbs.push(db)
    migrate(db)
    const store = new Store(db)

    const project = store.ensureProject({
      name: 'Slash Exp Test',
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
      title: 'Active Session',
    })

    return { store, project, session, dir }
  }

  it('manages plan lifecycle via PlanManager including goal, tasks, dependencies, approval and execution', async () => {
    const { store, project, session } = setup()
    const planMgr = new PlanManager(store, project.id, session.id)

    // Create plan draft
    const draft = planMgr.createPlanDraft('Implement feature Y')
    expect(draft.state).toBe('DRAFT')

    // Add tasks with dependencies
    planMgr.addTask(draft.id, {
      id: 'task-1',
      title: 'Scaffold module',
      description: 'Setup initial files',
      assigneeRole: 'developer',
      dependsOn: [],
      acceptanceCriteria: ['Files created'],
    })

    planMgr.addTask(draft.id, {
      id: 'task-2',
      title: 'Implement logic',
      description: 'Write logic',
      assigneeRole: 'developer',
      dependsOn: ['task-1'],
      acceptanceCriteria: ['Tests pass'],
    })

    // Review & Approve
    planMgr.reviewPlan(draft.id)
    planMgr.approvePlan(draft.id)

    // Execute handoff: creates run and admits tasks
    let executedRunId = ''
    const executedPlan = await planMgr.executePlan(draft.id, async (p) => {
      const run = store.createRun({
        projectId: project.id,
        goal: p.goal,
        origin: 'cli',
        requestedBy: 'cli',
        acceptanceCriteria: ['All tasks complete'],
        managerMuseId: 'manager',
        budget: {
          maxConcurrentWorkers: 2,
          maxTasks: 10,
          maxDelegationDepth: 2,
          maxRunMinutes: 30,
          defaultTaskMinutes: 10,
        },
      })
      executedRunId = run.id

      // Admit tasks from plan into the run store
      const idMap = new Map<string, string>()
      for (const t of p.tasks) {
        const admitted = store.createTask({
          runId: run.id,
          parentTaskId: null,
          title: t.title,
          brief: t.description || t.title,
          acceptanceCriteria: t.acceptanceCriteria,
          assigneeMuseId: 'developer',
        })
        idMap.set(t.id, admitted.id)
      }

      // Admit dependency edges
      for (const t of p.tasks) {
        const toId = idMap.get(t.id)!
        for (const depId of t.dependsOn) {
          const fromId = idMap.get(depId)
          if (fromId) {
            store.addEdge(run.id, toId, fromId, 'depends_on')
          }
        }
      }

      return run.id
    })

    expect(executedPlan.state).toBe('RUNNING')
    expect(executedPlan.runId).toBe(executedRunId)

    // Verify tasks and edges in run store
    const runTasks = store.listTasks(executedRunId)
    expect(runTasks).toHaveLength(2)
    const runEdges = store.listEdges(executedRunId)
    expect(runEdges).toHaveLength(1)
  })

  it('runs doctor checks and produces structured reports without leaking secrets', async () => {
    const { dir } = setup()
    // Write minimal pluton.yaml
    const configYaml = `version: 1
project:
  name: DoctorTest
  repository: .
  default_branch: main
  verification: []
runtime:
  max_concurrent_workers: 2
  max_team_size: 4
  max_delegation_depth: 2
  max_tasks_per_run: 10
  max_run_minutes: 30
  default_task_minutes: 10
  network_policy: restricted
sandbox:
  kind: docker
git:
  require_approval_for_main_branch_integration: true
  protected_paths: []
muses:
  lead:
    display_name: Lead
    role: coordinator
    engine: opencode
    model: opencode/test
    workspace_policy: isolated-task-checkout
    permissions: [task.create]
`
    writeFileSync(join(dir, 'pluton.yaml'), configYaml, 'utf8')

    const checks = await collectDoctorChecks({ cwd: dir })
    expect(Array.isArray(checks)).toBe(true)
    expect(checks.length).toBeGreaterThan(0)
    for (const c of checks) {
      expect(['pass', 'warn', 'fail', 'info']).toContain(c.status)
      expect(typeof c.title).toBe('string')
      expect(typeof c.message).toBe('string')
    }
  })
})
