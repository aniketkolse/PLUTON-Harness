import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import type { PlanTask } from '../../src/domain/plan.ts'
import { NotFoundError } from '../../src/domain/errors.ts'

describe('plan persistence and migrations', () => {
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

  function freshStore(name: string): Store {
    const dir = mkdtempSync(join(tmpdir(), `pluton-plan-store-${name}-`))
    tmpDirs.push(dir)
    const path = join(dir, 'pluton.sqlite')
    const db = openDatabase(path)
    openDbs.push(db)
    migrate(db)
    return new Store(db)
  }

  it('creates, retrieves, and updates plans in the store', () => {
    const store = freshStore('plan')
    const project = store.ensureProject({
      name: 'Plan Test Project',
      rootPath: 'C:\\test\\plan-project',
      configPath: 'C:\\test\\plan-project\\pluton.yaml',
      defaultBranch: 'main',
    })
    store.syncMuses(project.id, [
      {
        id: 'lead',
        slug: 'lead',
        displayName: 'Lead',
        role: 'lead',
        engineKind: 'opencode',
        model: 'opencode/test',
        instructionsFile: null,
        workspacePolicy: 'isolated-task-checkout',
        permissions: ['task.create'],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/lead',
      },
    ])
    const muse = store.getMuse('lead')
    expect(muse).toBeDefined()
    const session = store.createChatSession({
      projectId: project.id,
      museId: muse!.id,
      title: 'Planning Session',
    })

    const tasks: PlanTask[] = [
      {
        id: 'task-1',
        title: 'Initial setup',
        description: 'Scaffold files',
        assigneeRole: 'lead',
        dependsOn: [],
        acceptanceCriteria: ['Files created'],
      },
    ]

    const plan = store.createPlan({
      projectId: project.id,
      sessionId: session.id,
      goal: 'Build feature X',
      tasks,
    })

    expect(plan.id).toBeDefined()
    expect(plan.goal).toBe('Build feature X')
    expect(plan.state).toBe('DRAFT')
    expect(plan.tasks).toHaveLength(1)
    expect(plan.tasks[0]?.title).toBe('Initial setup')

    // Retrieve plan
    const retrieved = store.getPlan(plan.id)
    expect(retrieved.id).toBe(plan.id)
    expect(retrieved.goal).toBe('Build feature X')

    // Retrieve latest plan for session
    const latest = store.getLatestPlanForSession(session.id)
    expect(latest?.id).toBe(plan.id)

    // Update plan state to REVIEW and APPROVED
    store.updatePlan(plan.id, { state: 'REVIEW' })
    const updated = store.updatePlan(plan.id, {
      state: 'APPROVED',
    })
    expect(updated.state).toBe('APPROVED')

    // Updating goal or tasks invalidates APPROVED back to DRAFT
    const modified = store.updatePlan(plan.id, {
      goal: 'Build feature X with extra scope',
    })
    expect(modified.goal).toBe('Build feature X with extra scope')
    expect(modified.state).toBe('DRAFT')

    // Not found throws
    expect(() => store.getPlan('unknown-plan-id')).toThrow(NotFoundError)
  })

  it('lists chat sessions for a project', () => {
    const store = freshStore('sessions')
    const project = store.ensureProject({
      name: 'Session Test Project',
      rootPath: 'C:\\test\\session-project',
      configPath: 'C:\\test\\session-project\\pluton.yaml',
      defaultBranch: 'main',
    })
    store.syncMuses(project.id, [
      {
        id: 'lead',
        slug: 'lead',
        displayName: 'Lead',
        role: 'lead',
        engineKind: 'opencode',
        model: 'opencode/test',
        instructionsFile: null,
        workspacePolicy: 'isolated-task-checkout',
        permissions: ['task.create'],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/lead',
      },
    ])
    const muse = store.getMuse('lead')!

    const s1 = store.createChatSession({ projectId: project.id, museId: muse.id, title: 'Session 1' })
    const s2 = store.createChatSession({ projectId: project.id, museId: muse.id, title: 'Session 2' })

    const list = store.listChatSessions(project.id)
    expect(list.length).toBeGreaterThanOrEqual(2)
    expect(list.some((s) => s.id === s1.id)).toBe(true)
    expect(list.some((s) => s.id === s2.id)).toBe(true)
  })
})
