import { describe, expect, it } from 'vitest'
import { runtimeConfigSchema } from '../../src/config/schema.ts'
import { runBudgetFromRuntime, supervisorSettingsFromRuntime } from '../../src/orchestrator/run-setup.ts'

describe('run-setup', () => {
  describe('runBudgetFromRuntime', () => {
    it('maps runtime defaults into the run budget', () => {
      const runtime = runtimeConfigSchema.parse({})
      expect(runBudgetFromRuntime(runtime)).toEqual({
        maxConcurrentWorkers: 3,
        maxTasks: 20,
        maxDelegationDepth: 3,
        maxRunMinutes: 90,
        defaultTaskMinutes: 30,
      })
    })

    it('maps custom runtime values exactly', () => {
      const runtime = runtimeConfigSchema.parse({
        max_concurrent_workers: 5,
        max_tasks_per_run: 42,
        max_delegation_depth: 1,
        max_run_minutes: 120,
        default_task_minutes: 10,
      })
      expect(runBudgetFromRuntime(runtime)).toEqual({
        maxConcurrentWorkers: 5,
        maxTasks: 42,
        maxDelegationDepth: 1,
        maxRunMinutes: 120,
        defaultTaskMinutes: 10,
      })
    })
  })

  describe('supervisorSettingsFromRuntime', () => {
    it('converts minutes to milliseconds for task timeout and run deadline', () => {
      const runtime = runtimeConfigSchema.parse({})
      expect(supervisorSettingsFromRuntime(runtime)).toEqual({
        maxConcurrentWorkers: 3,
        defaultTaskTimeoutMs: 1_800_000,
        runDeadlineMs: 5_400_000,
      })
    })

    it('carries custom worker limits and timings through', () => {
      const runtime = runtimeConfigSchema.parse({
        max_concurrent_workers: 7,
        max_run_minutes: 60,
        default_task_minutes: 15,
      })
      expect(supervisorSettingsFromRuntime(runtime)).toEqual({
        maxConcurrentWorkers: 7,
        defaultTaskTimeoutMs: 900_000,
        runDeadlineMs: 3_600_000,
      })
    })
  })
})
