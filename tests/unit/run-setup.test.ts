import { describe, expect, it } from 'vitest'
import { runtimeConfigSchema } from '../../src/config/schema.ts'
import {
  runBudgetFromRuntime,
  supervisorSettingsFromRuntime,
  usageBudgetsFromRuntime,
} from '../../src/orchestrator/run-setup.ts'

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
        maxRetriesPerTask: 1,
      })
    })

    it('carries custom worker limits, timings, and retry budget through', () => {
      const runtime = runtimeConfigSchema.parse({
        max_concurrent_workers: 7,
        max_run_minutes: 60,
        default_task_minutes: 15,
        max_retries_per_task: 4,
      })
      expect(supervisorSettingsFromRuntime(runtime)).toEqual({
        maxConcurrentWorkers: 7,
        defaultTaskTimeoutMs: 900_000,
        runDeadlineMs: 3_600_000,
        maxRetriesPerTask: 4,
      })
    })
  })

  describe('usageBudgetsFromRuntime', () => {
    it('returns undefined when no budget key is configured (existing configs unchanged)', () => {
      expect(usageBudgetsFromRuntime(runtimeConfigSchema.parse({}))).toBeUndefined()
    })

    it('maps every configured axis into the ledger limit names', () => {
      const runtime = runtimeConfigSchema.parse({
        max_run_input_tokens: 1_000_000,
        max_run_output_tokens: 500_000,
        max_run_cost_usd: 12.5,
        max_muse_input_tokens: 200_000,
        max_muse_output_tokens: 100_000,
        max_muse_cost_usd: 2.5,
      })
      expect(usageBudgetsFromRuntime(runtime)).toEqual({
        maxRunInputTokens: 1_000_000,
        maxRunOutputTokens: 500_000,
        maxRunCostUsd: 12.5,
        maxPerMuseInputTokens: 200_000,
        maxPerMuseOutputTokens: 100_000,
        maxPerMuseCostUsd: 2.5,
      })
    })

    it('carries only the axes that are set', () => {
      const runtime = runtimeConfigSchema.parse({ max_run_cost_usd: 3 })
      expect(usageBudgetsFromRuntime(runtime)).toEqual({ maxRunCostUsd: 3 })
    })

    it('rejects out-of-range budgets at parse time', () => {
      for (const bad of [
        { max_run_input_tokens: 0 },
        { max_run_input_tokens: 1.5 },
        { max_run_output_tokens: 1_000_000_001 },
        { max_run_cost_usd: 0 },
        { max_run_cost_usd: -1 },
        { max_muse_input_tokens: -5 },
        { max_muse_cost_usd: 1_000_001 },
      ]) {
        expect(runtimeConfigSchema.safeParse(bad).success).toBe(false)
      }
    })

    it('still rejects unknown runtime keys (strict schema)', () => {
      expect(runtimeConfigSchema.safeParse({ max_run_tokens: 5 }).success).toBe(false)
    })
  })
})
