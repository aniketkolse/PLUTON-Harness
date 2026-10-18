import type { z } from 'zod'
import type { runtimeConfigSchema } from '../config/schema.ts'
import type { RunBudget } from '../domain/models.ts'
import type { BudgetLimits } from './usage-ledger.ts'

/** The `runtime` section of a loaded project config, defaults applied. */
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>

export interface SupervisorSettings {
  maxConcurrentWorkers: number
  defaultTaskTimeoutMs: number
  runDeadlineMs: number
  maxRetriesPerTask: number
}

/** Map project runtime limits into the durable per-run budget (ADR-0006). */
export function runBudgetFromRuntime(runtime: RuntimeConfig): RunBudget {
  return {
    maxConcurrentWorkers: runtime.max_concurrent_workers,
    maxTasks: runtime.max_tasks_per_run,
    maxDelegationDepth: runtime.max_delegation_depth,
    maxRunMinutes: runtime.max_run_minutes,
    defaultTaskMinutes: runtime.default_task_minutes,
  }
}

/** Supervisor timing knobs derived from the same runtime limits (minutes → milliseconds). */
export function supervisorSettingsFromRuntime(runtime: RuntimeConfig): SupervisorSettings {
  return {
    maxConcurrentWorkers: runtime.max_concurrent_workers,
    defaultTaskTimeoutMs: runtime.default_task_minutes * 60_000,
    runDeadlineMs: runtime.max_run_minutes * 60_000,
    maxRetriesPerTask: runtime.max_retries_per_task,
  }
}

/**
 * Map configured usage budgets into ledger limits. Returns `undefined` when no
 * budget key is set, so unconfigured runs keep their current behavior exactly
 * (PR-1 / audit gap G1: budgets were configurable nowhere and never applied).
 */
export function usageBudgetsFromRuntime(runtime: RuntimeConfig): BudgetLimits | undefined {
  const limits: BudgetLimits = {
    ...(runtime.max_run_input_tokens !== undefined ? { maxRunInputTokens: runtime.max_run_input_tokens } : {}),
    ...(runtime.max_run_output_tokens !== undefined ? { maxRunOutputTokens: runtime.max_run_output_tokens } : {}),
    ...(runtime.max_run_cost_usd !== undefined ? { maxRunCostUsd: runtime.max_run_cost_usd } : {}),
    ...(runtime.max_muse_input_tokens !== undefined ? { maxPerMuseInputTokens: runtime.max_muse_input_tokens } : {}),
    ...(runtime.max_muse_output_tokens !== undefined ? { maxPerMuseOutputTokens: runtime.max_muse_output_tokens } : {}),
    ...(runtime.max_muse_cost_usd !== undefined ? { maxPerMuseCostUsd: runtime.max_muse_cost_usd } : {}),
  }
  return Object.keys(limits).length > 0 ? limits : undefined
}
