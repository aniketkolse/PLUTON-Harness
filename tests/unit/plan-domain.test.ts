import { describe, expect, it } from 'vitest'
import { StateTransitionError, ValidationError } from '../../src/domain/errors.ts'
import {
  type PlanState,
  type PlanTask,
  canTransitionPlan,
  transitionPlanState,
  validatePlanTasks,
} from '../../src/domain/plan.ts'

describe('plan domain and state machine', () => {
  describe('state transitions', () => {
    it('allows valid forward and backward transitions', () => {
      expect(canTransitionPlan('DRAFT', 'REVIEW')).toBe(true)
      expect(canTransitionPlan('REVIEW', 'APPROVED')).toBe(true)
      expect(canTransitionPlan('APPROVED', 'RUNNING')).toBe(true)
      expect(canTransitionPlan('RUNNING', 'COMPLETED')).toBe(true)
      expect(canTransitionPlan('RUNNING', 'FAILED')).toBe(true)
      expect(canTransitionPlan('RUNNING', 'CANCELLED')).toBe(true)
      // Invalidating approval back to DRAFT when plan changes
      expect(canTransitionPlan('APPROVED', 'DRAFT')).toBe(true)
      expect(canTransitionPlan('REVIEW', 'DRAFT')).toBe(true)
    })

    it('rejects invalid state transitions', () => {
      expect(canTransitionPlan('DRAFT', 'RUNNING')).toBe(false)
      expect(canTransitionPlan('DRAFT', 'COMPLETED')).toBe(false)
      expect(canTransitionPlan('COMPLETED', 'RUNNING')).toBe(false)
      expect(canTransitionPlan('FAILED', 'RUNNING')).toBe(false)
    })

    it('throws StateTransitionError on illegal transitions', () => {
      expect(() => transitionPlanState('DRAFT', 'RUNNING')).toThrow(StateTransitionError)
      expect(transitionPlanState('DRAFT', 'REVIEW')).toBe('REVIEW')
    })
  })

  describe('task dependency and graph validation', () => {
    it('accepts a valid linear and branching task DAG', () => {
      const tasks: PlanTask[] = [
        {
          id: 'task-1',
          title: 'Setup schema',
          description: 'Create database migration',
          assigneeRole: 'developer',
          dependsOn: [],
          acceptanceCriteria: ['Table exists'],
        },
        {
          id: 'task-2',
          title: 'Implement repository',
          description: 'Add query methods',
          assigneeRole: 'developer',
          dependsOn: ['task-1'],
          acceptanceCriteria: ['Tests pass'],
        },
        {
          id: 'task-3',
          title: 'Add API endpoint',
          description: 'Expose REST API',
          assigneeRole: 'developer',
          dependsOn: ['task-2'],
          acceptanceCriteria: ['Returns 200 OK'],
        },
      ]

      const result = validatePlanTasks(tasks)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('rejects duplicate task IDs', () => {
      const tasks: PlanTask[] = [
        {
          id: 'task-1',
          title: 'Task A',
          description: '',
          assigneeRole: 'dev',
          dependsOn: [],
          acceptanceCriteria: ['Done'],
        },
        {
          id: 'task-1',
          title: 'Task B',
          description: '',
          assigneeRole: 'dev',
          dependsOn: [],
          acceptanceCriteria: ['Done'],
        },
      ]

      const result = validatePlanTasks(tasks)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('duplicate'))).toBe(true)
    })

    it('rejects tasks with missing dependencies', () => {
      const tasks: PlanTask[] = [
        {
          id: 'task-1',
          title: 'Task A',
          description: '',
          assigneeRole: 'dev',
          dependsOn: ['non-existent'],
          acceptanceCriteria: ['Done'],
        },
      ]

      const result = validatePlanTasks(tasks)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('unknown dependency'))).toBe(true)
    })

    it('rejects self-dependencies', () => {
      const tasks: PlanTask[] = [
        {
          id: 'task-1',
          title: 'Task A',
          description: '',
          assigneeRole: 'dev',
          dependsOn: ['task-1'],
          acceptanceCriteria: ['Done'],
        },
      ]

      const result = validatePlanTasks(tasks)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('depend on itself'))).toBe(true)
    })

    it('rejects direct and indirect dependency cycles', () => {
      const tasks: PlanTask[] = [
        {
          id: 'task-1',
          title: 'Task A',
          description: '',
          assigneeRole: 'dev',
          dependsOn: ['task-3'],
          acceptanceCriteria: ['Done'],
        },
        {
          id: 'task-2',
          title: 'Task B',
          description: '',
          assigneeRole: 'dev',
          dependsOn: ['task-1'],
          acceptanceCriteria: ['Done'],
        },
        {
          id: 'task-3',
          title: 'Task C',
          description: '',
          assigneeRole: 'dev',
          dependsOn: ['task-2'],
          acceptanceCriteria: ['Done'],
        },
      ]

      const result = validatePlanTasks(tasks)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('cycle'))).toBe(true)
    })

    it('rejects tasks missing title or acceptance criteria', () => {
      const tasks: PlanTask[] = [
        {
          id: 'task-1',
          title: '',
          description: '',
          assigneeRole: 'dev',
          dependsOn: [],
          acceptanceCriteria: [],
        },
      ]

      const result = validatePlanTasks(tasks)
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThanOrEqual(2)
    })
  })
})
