import type { z } from 'zod'
import type { runtimeConfigSchema } from '../config/schema.ts'
import type { RunBudget } from '../domain/models.ts'

/** The `runtime` section of a loaded project config, defaults applied. */
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>

export interface SupervisorSettings {
  maxConcurrentWorkers: number
  defaultTaskTimeoutMs: number
  runDeadlineMs: number
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
  }
}
