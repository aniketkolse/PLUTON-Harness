/**
 * Operator-scoped tool catalog and handlers (ADR-0012).
 * Run-less command surface for the chat operator Muse: project status,
 * listing runs, inspecting a run, starting runs, and listing approvals.
 */

import { z } from 'zod'
import { NotFoundError } from '../domain/errors.ts'
import type { Permission } from '../domain/permissions.ts'
import type { Store } from '../store/store.ts'
import { runByRef } from '../orchestrator/service.ts'
import type { McpToolInfo } from './mcp-server.ts'

export interface OperatorToolEnv {
  store: Store
  projectId: string
  rootDir: string
  callerShipId: string
  now: () => number
  signal?: AbortSignal
  /** Injected by `pluton chat`: create + drive a supervised run in the background. */
  startRun: (input: { goal: string; acceptance: string[]; requestId?: string }) => Promise<{ runId: string }>
}

export interface OperatorToolDef {
  name: string
  permission: Permission
  mutating: boolean
  description: string
  schema: z.ZodTypeAny
}

export const OPERATOR_TOOL_SCHEMAS = {
  'project.status': z.object({}).strict(),
  'run.list': z
    .object({
      limit: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
  'run.get': z
    .object({
      run: z.string().min(1).max(64),
    })
    .strict(),
  'run.start': z
    .object({
      goal: z.string().min(1).max(2_000),
      acceptance: z.array(z.string().min(1).max(500)).max(20).optional(),
      requestId: z.string().optional(),
    })
    .strict(),
  'approvals.list': z
    .object({
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
}

export type OperatorToolName = keyof typeof OPERATOR_TOOL_SCHEMAS

export const OPERATOR_TOOL_DEFS: readonly OperatorToolDef[] = [
  {
    name: 'project.status',
    permission: 'project.status',
    mutating: false,
    description: 'Inspect the project root, configuration, and recent runs with task summary counts.',
    schema: OPERATOR_TOOL_SCHEMAS['project.status'],
  },
  {
    name: 'run.list',
    permission: 'run.list',
    mutating: false,
    description: 'List recent runs in this project (newest first, limit up to 20).',
    schema: OPERATOR_TOOL_SCHEMAS['run.list'],
  },
  {
    name: 'run.get',
    permission: 'run.inspect',
    mutating: false,
    description: 'Get details, task tree, and status of a specific run by ID or suffix.',
    schema: OPERATOR_TOOL_SCHEMAS['run.get'],
  },
  {
    name: 'run.start',
    permission: 'run.start',
    mutating: true,
    description: 'Start a new supervised run in the background.',
    schema: OPERATOR_TOOL_SCHEMAS['run.start'],
  },
  {
    name: 'approvals.list',
    permission: 'approvals.list',
    mutating: false,
    description: 'List pending and recently decided human approvals in this project.',
    schema: OPERATOR_TOOL_SCHEMAS['approvals.list'],
  },
]

export const OPERATOR_TOOL_HANDLERS: Record<string, (env: OperatorToolEnv, args: unknown) => Promise<unknown>> = {
  'project.status': async (env) => {
    const project = env.store.getProject(env.projectId)
    const recentRuns = env.store.listRuns(5)
    const runs = recentRuns.map((r) => {
      const tasks = env.store.listTasks(r.id)
      const taskCounts: Record<string, number> = {}
      for (const t of tasks) {
        taskCounts[t.state] = (taskCounts[t.state] ?? 0) + 1
      }
      return {
        ...r,
        taskCounts,
      }
    })
    return { project, runs }
  },

  'run.list': async (env, rawArgs) => {
    const args = OPERATOR_TOOL_SCHEMAS['run.list'].parse(rawArgs ?? {})
    const limit = Math.min(20, args.limit ?? 10)
    return env.store.listRuns(limit)
  },

  'run.get': async (env, rawArgs) => {
    const args = OPERATOR_TOOL_SCHEMAS['run.get'].parse(rawArgs)
    const run = runByRef(env.store, args.run)
    const tasks = env.store.listTasks(run.id)
    const taskCounts: Record<string, number> = {}
    for (const t of tasks) {
      taskCounts[t.state] = (taskCounts[t.state] ?? 0) + 1
    }
    return { run, tasks, taskCounts }
  },

  'run.start': async (env, rawArgs) => {
    const args = OPERATOR_TOOL_SCHEMAS['run.start'].parse(rawArgs)
    const res = await env.startRun({
      goal: args.goal,
      acceptance: args.acceptance ?? [],
      requestId: args.requestId,
    })
    return { runId: res.runId }
  },

  'approvals.list': async (env, rawArgs) => {
    const args = OPERATOR_TOOL_SCHEMAS['approvals.list'].parse(rawArgs ?? {})
    const limit = Math.min(50, args.limit ?? 20)
    return env.store.listApprovalsByProject(env.projectId, { limit })
  },
}

export function getOperatorToolDef(name: string): OperatorToolDef | null {
  return OPERATOR_TOOL_DEFS.find((d) => d.name === name) ?? null
}

export function operatorToolInfosForMcp(): McpToolInfo[] {
  return OPERATOR_TOOL_DEFS.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: z.toJSONSchema(def.schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>,
  }))
}
