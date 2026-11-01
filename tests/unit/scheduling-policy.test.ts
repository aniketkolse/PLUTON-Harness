import { describe, expect, it } from 'vitest'
import type { TaskEdgeRecord, TaskRecord } from '../../src/domain/models.ts'
import type { TaskState } from '../../src/domain/state.ts'
import type { Store } from '../../src/store/store.ts'
import type { TaskAssessment } from '../../src/orchestrator/task-assessment.ts'
import {
  buildSchedulePlan,
  computeAllocation,
  detectDuplicateIntent,
  prioritizeReadyTasks,
  readRunAssessment,
  scheduledDecision,
  type SchedulePlan,
  type SchedulingAction,
  type SchedulingDecision,
} from '../../src/orchestrator/scheduling-policy.ts'

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return ({
    id: 'task_0',
    runId: 'run_1',
    parentTaskId: null,
    rootTaskId: 'task_0',
    depth: 0,
    title: 'task',
    brief: 'brief',
    acceptanceCriteria: [],
    state: 'queued' as TaskState,
    attempt: 0,
    workspaceId: null,
    engineSessionId: null,
    result: null,
    failure: null,
    assignment: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as unknown) as TaskRecord
}

function makeEdge(fromTaskId: string, toTaskId: string): TaskEdgeRecord {
  return { runId: 'run_1', fromTaskId, toTaskId, kind: 'depends_on' }
}

function makeAssessment(overrides: Partial<TaskAssessment>): TaskAssessment {
  return {
    complexity: 'simple',
    estimatedWorkers: 1,
    requiredCapabilities: [],
    requiredTools: [],
    dependencyDepth: 0,
    parallelizableUnits: 1,
    verificationRequired: false,
    resourceConstraints: { maxWorkers: 4, maxTasks: 20, maxDepth: 3 },
    confidence: 'low',
    signals: [],
    ...overrides,
  }
}

function makeStoreWithAssessment(assessment: TaskAssessment | null): Store {
  return {
    listEvents: (_runId: string, opts: { type?: string; limit?: number }) => {
      if (opts.type !== 'run.assessed' || assessment === null) return []
      const payload = { assessment, allocation: { workerCap: 2 } }
      return [
        {
          id: 'event_1',
          project_id: 'proj_1',
          run_id: 'run_1',
          task_id: null,
          ship_id: null,
          type: 'run.assessed',
          payload,
          created_at: '2026-01-01T00:00:00.000Z',
        } as unknown as never,
      ]
    },
  } as unknown as Store
}

describe('scheduling policy (Phase 4 Batch 3)', () => {
  describe('readRunAssessment', () => {
    it('returns null when no assessment event exists', () => {
      const store = makeStoreWithAssessment(null)
      expect(readRunAssessment(store, 'run_1')).toBeNull()
    })

    it('parses the latest assessment event', () => {
      const assessment = makeAssessment({ complexity: 'complex', estimatedWorkers: 3 })
      const store = makeStoreWithAssessment(assessment)
      expect(readRunAssessment(store, 'run_1')).toEqual(assessment)
    })
  })

  describe('prioritizeReadyTasks', () => {
    it('orders by dependency criticality then FIFO', () => {
      // task-a blocks task-c and task-d; task-b blocks nothing. Both ready.
      const a = makeTask({ id: 'task-a', title: 'A', createdAt: '2026-01-01T00:00:00.000Z' })
      const b = makeTask({ id: 'task-b', title: 'B', createdAt: '2026-01-01T00:00:00.000Z' })
      const c = makeTask({ id: 'task-c', title: 'C', state: 'queued' })
      const d = makeTask({ id: 'task-d', title: 'D', state: 'queued' })
      const ready = [b, a] // out of order input
      const edges = [
        makeEdge('task-c', 'task-a'), // c depends on a -> a blocks c
        makeEdge('task-d', 'task-a'), // d depends on a -> a blocks d
        makeEdge('task-c', 'task-b'), // c depends on b -> b blocks c
      ]
      const states = new Map<string, TaskState>([
        ['task-a', 'queued'],
        ['task-b', 'queued'],
        ['task-c', 'queued'],
        ['task-d', 'queued'],
      ])
      const ordered = prioritizeReadyTasks(ready, edges, states)
      expect(ordered.map((t) => t.id)).toEqual(['task-a', 'task-b'])
    })

    it('breaks ties by created_at FIFO', () => {
      const earlier = makeTask({ id: 't1', title: 'Earlier', createdAt: '2026-01-01T00:00:00.000Z' })
      const later = makeTask({ id: 't2', title: 'Later', createdAt: '2026-01-01T00:00:01.000Z' })
      const ordered = prioritizeReadyTasks([later, earlier], [], new Map())
      expect(ordered.map((t) => t.id)).toEqual(['t1', 't2'])
    })
  })

  describe('computeAllocation', () => {
    it('uses hard cap when no assessment', () => {
      const a = computeAllocation(null, 4, 0)
      expect(a.workerCap).toBe(4)
      expect(a.assessmentDriven).toBe(false)
    })

    it('never exceeds maxConcurrentWorkers', () => {
      const assessment = makeAssessment({ complexity: 'complex', parallelizableUnits: 100 })
      const a = computeAllocation(assessment, 2, 0)
      expect(a.workerCap).toBeLessThanOrEqual(2)
    })

    it('never drops below 1', () => {
      const assessment = makeAssessment({ complexity: 'simple' })
      const a = computeAllocation(assessment, 4, 3)
      expect(a.workerCap).toBeGreaterThanOrEqual(1)
    })

    it('accounts for in-flight tasks', () => {
      const assessment = makeAssessment({ complexity: 'complex', parallelizableUnits: 4 })
      const a = computeAllocation(assessment, 4, 2)
      expect(a.workerCap).toBeLessThanOrEqual(2)
    })

    it('returns sequential_fallback for dependency-heavy complex tasks', () => {
      const assessment = makeAssessment({
        complexity: 'complex',
        parallelizableUnits: 4,
        dependencyDepth: 3,
      })
      const a = computeAllocation(assessment, 4, 0)
      expect(a.strategy).toBe('sequential_fallback')
      expect(a.workerCap).toBeLessThanOrEqual(2)
    })
  })

  describe('detectDuplicateIntent', () => {
    it('flags overlapping scope with high title/brief similarity', () => {
      const candidate = makeTask({
        id: 'cand',
        title: 'Implement the login endpoint',
        brief: 'Implement the login endpoint with validation',
        writeScope: ['src/auth.ts'],
      })
      const existing = makeTask({
        id: 'exist',
        title: 'Implement the login endpoint',
        brief: 'Implement the login endpoint with validation',
        writeScope: ['src/auth.ts'],
      })
      const result = detectDuplicateIntent(candidate, [existing])
      expect(result.isDuplicate).toBe(true)
      expect(result.reason).toContain('overlapping write scope')
    })

    it('does not flag disjoint scope even with similar title', () => {
      const candidate = makeTask({
        id: 'cand',
        title: 'Implement the login endpoint',
        brief: 'Implement the login endpoint with validation',
        writeScope: ['src/auth.ts'],
      })
      const existing = makeTask({
        id: 'exist',
        title: 'Implement the login endpoint',
        brief: 'Implement the login endpoint with validation',
        writeScope: ['src/db.ts'],
      })
      const result = detectDuplicateIntent(candidate, [existing])
      expect(result.isDuplicate).toBe(false)
    })

    it('does not flag low similarity', () => {
      const candidate = makeTask({
        id: 'cand',
        title: 'Add a new button',
        brief: 'Add a blue submit button to the form',
        writeScope: ['src/ui.ts'],
      })
      const existing = makeTask({
        id: 'exist',
        title: 'Refactor the data layer',
        brief: 'Refactor database queries for performance',
        writeScope: ['src/ui.ts'],
      })
      const result = detectDuplicateIntent(candidate, [existing])
      expect(result.isDuplicate).toBe(false)
    })
  })

  describe('buildSchedulePlan', () => {
    it('dispatches ready tasks up to the worker cap', () => {
      const a = makeTask({ id: 'a', title: 'A', createdAt: 't1' })
      const b = makeTask({ id: 'b', title: 'B', createdAt: 't2' })
      const c = makeTask({ id: 'c', title: 'C', createdAt: 't3' })
      const ready = [a, b, c]
      const plan = buildSchedulePlan(ready, [], new Map(), [], null, 2, 0)
      expect(plan.dispatchOrder.length).toBe(2)
      expect(plan.allocation.workerCap).toBe(2)
      expect(plan.deferred.filter((d) => d.action === 'deferred').length).toBe(1)
    })

    it('applies the assessment cap below maxConcurrentWorkers', () => {
      const a = makeTask({ id: 'a', title: 'A', createdAt: 't1' })
      const b = makeTask({ id: 'b', title: 'B', createdAt: 't2' })
      const assessment = makeAssessment({ complexity: 'simple', estimatedWorkers: 1 })
      const plan = buildSchedulePlan([a, b], [], new Map(), [], assessment, 4, 0)
      expect(plan.dispatchOrder.length).toBe(1)
      expect(plan.allocation.assessmentDriven).toBe(true)
    })

    it('suppresses duplicate intent and leaves it queued', () => {
      const candidate = makeTask({
        id: 'task_cand',
        title: 'Implement the login endpoint',
        brief: 'Implement the login endpoint with validation',
        writeScope: ['src/auth.ts'],
        state: 'queued',
      })
      const existing = makeTask({
        id: 'task_exist',
        title: 'Implement the login endpoint',
        brief: 'Implement the login endpoint with validation',
        writeScope: ['src/auth.ts'],
        state: 'queued',
      })
      const plan = buildSchedulePlan([candidate, existing], [], new Map(), [], null, 4, 0)
      expect(plan.dispatchOrder).toEqual(['task_cand'])
      expect(plan.duplicateSuppressed.length).toBe(1)
      expect(plan.duplicateSuppressed[0]!.taskId).toBe('task_exist')
      expect(plan.duplicateSuppressed[0]!.action).toBe('duplicate_suppressed')
      expect(plan.duplicateSuppressed[0]!.reason).toContain('overlapping write scope')
    })

    it('defers tasks beyond the worker cap', () => {
      const a = makeTask({ id: 'a', title: 'A', createdAt: 't1' })
      const b = makeTask({ id: 'b', title: 'B', createdAt: 't2' })
      const c = makeTask({ id: 'c', title: 'C', createdAt: 't3' })
      const plan = buildSchedulePlan([a, b, c], [], new Map(), [], null, 1, 0)
      expect(plan.dispatchOrder.length).toBe(1)
      const deferred = plan.deferred.filter((d) => d.action === 'deferred')
      expect(deferred.length).toBe(2)
    })
  })

  describe('scheduledDecision', () => {
    it('creates a scheduled decision with timestamp', () => {
      const d = scheduledDecision('task_x', 2, 'dispatched; complex request')
      expect(d.taskId).toBe('task_x')
      expect(d.action).toBe('scheduled')
      expect(d.workerCap).toBe(2)
      expect(d.reason).toBe('dispatched; complex request')
      expect(d.at).toMatch(/\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('plan shape', () => {
    it('returns dispatchOrder, deferred, duplicateSuppressed, allocation', () => {
      const a = makeTask({ id: 'a', title: 'A' })
      const plan = buildSchedulePlan([a], [], new Map(), [], null, 4, 0)
      expect(plan).toHaveProperty('dispatchOrder')
      expect(plan).toHaveProperty('deferred')
      expect(plan).toHaveProperty('duplicateSuppressed')
      expect(plan).toHaveProperty('allocation')
      expect(plan.allocation).toHaveProperty('workerCap')
      expect(plan.allocation).toHaveProperty('strategy')
      expect(plan.allocation).toHaveProperty('reason')
      expect(plan.allocation).toHaveProperty('assessmentDriven')
    })
  })
})
