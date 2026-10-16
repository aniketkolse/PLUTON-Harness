import { z } from 'zod'
import { MUSE_ROLES } from '../domain/models.ts'
import type { Permission } from '../domain/permissions.ts'
import type { McpToolInfo } from './mcp-server.ts'

/**
 * The restricted Pluton tool surface (ADR-0007). The Manager Muse (and, where
 * their permissions allow, worker Muses) affects the run ONLY through these
 * tools: every call is validated server-side against the caller's identity,
 * its configured permissions, the run budget and the live graph state.
 *
 * Model prose is never authoritative state — only what these handlers accept
 * and record in the database is.
 */

const title = z.string().min(1).max(300)
const brief = z.string().min(1).max(60_000)
const acceptanceCriteria = z.array(z.string().min(1).max(2_000)).max(50)
const taskRef = z.string().min(3).max(64)
const dependsOn = z.array(taskRef).max(50)

export const TOOL_SCHEMAS = {
  'task.create': z
    .object({
      title,
      brief,
      acceptanceCriteria,
      assigneeMuseId: z.string().min(1).max(64),
      dependsOn: dependsOn.optional(),
    })
    .strict(),
  'task.delegate': z
    .object({
      title,
      brief,
      acceptanceCriteria,
      assigneeMuseId: z.string().min(1).max(64),
      dependsOn: dependsOn.optional(),
    })
    .strict(),
  'task.inspect': z
    .object({
      taskId: taskRef.optional(),
    })
    .strict(),
  'task.wait': z
    .object({
      taskIds: z.array(taskRef).min(1).max(50),
      timeoutSeconds: z.number().int().min(1).max(600).optional(),
    })
    .strict(),
  'task.get_result': z
    .object({
      taskId: taskRef,
    })
    .strict(),
  'task.cancel': z
    .object({
      taskId: taskRef,
      reason: z.string().min(1).max(1_000),
    })
    .strict(),
  'muse.propose_create': z
    .object({
      museId: z
        .string()
        .min(1)
        .max(48)
        .regex(/^[a-z][a-z0-9-]*$/, 'museId must be a lowercase slug (letters, digits, dashes)'),
      displayName: z.string().min(1).max(80),
      role: z.enum(MUSE_ROLES),
      engine: z.string().min(1).max(40),
      model: z.string().min(1).max(200),
      reason: z.string().min(1).max(2_000),
    })
    .strict(),
  'approval.request': z
    .object({
      action: z.string().min(1).max(200),
      reason: z.string().min(1).max(2_000),
      scope: z.record(z.string(), z.string().max(2_000)).optional(),
    })
    .strict(),
  'diff.inspect': z
    .object({
      taskId: taskRef,
      maxBytes: z.number().int().min(1).max(200_000).optional(),
    })
    .strict(),
  'project.read': z
    .object({
      path: z.string().min(1).max(300).optional(),
    })
    .strict(),
  'run.stop': z
    .object({
      reason: z.string().min(1).max(2_000),
    })
    .strict(),
}

export type PlutonToolName = keyof typeof TOOL_SCHEMAS

export interface PlutonToolDef {
  /** The single permission that authorizes this tool (checked on every call). */
  permission: Permission
  /** True when the tool can change run state, a task, or durable records. */
  mutating: boolean
  description: string
}

export const TOOL_DEFS: Record<PlutonToolName, PlutonToolDef> = {
  'task.create': {
    permission: 'task.create',
    mutating: true,
    description:
      'Create a top-level task in this run and assign it to a Muse. Use this for the first level of work; to split work under YOUR OWN task use task.delegate. The brief must state objective, inputs, done criteria and required evidence. The runtime validates budgets, team size, dependencies and graph rules before recording anything.',
  },
  'task.delegate': {
    permission: 'task.delegate',
    mutating: true,
    description:
      'Create a child task under YOUR current task and assign it to a different Muse. Rejected for delegation-depth, fan-out, dependency-cycle and budget overflows, and for any assignee that already owns an ancestor of your task (delegation can never cycle back up its own chain).',
  },
  'task.inspect': {
    permission: 'task.inspect',
    mutating: false,
    description:
      'Inspect tasks you may see: without arguments a bounded summary of every task in the run; with taskId that task’s detail, its direct children and its dependencies. States are runtime truth, not claims.',
  },
  'task.wait': {
    permission: 'result.collect',
    mutating: false,
    description:
      'Wait until every requested task reaches a terminal state or the timeout elapses. Event wakeups are in-process; a standalone bridge (e.g. the stdio server) re-reads durable state every runtime heartbeat_seconds instead of waking instantly. A timeout is NOT a completion: check timedOut and the returned states before acting. Bounded to 600 seconds.',
  },
  'task.get_result': {
    permission: 'result.collect',
    mutating: false,
    description:
      'Fetch a task’s recorded result, failure classification and checkout reference. Treat every claim as unproven until the recorded evidence (commits, diffs, exit codes) backs it.',
  },
  'task.cancel': {
    permission: 'task.cancel',
    mutating: true,
    description:
      'Cancel a task that has not reached a terminal state. Recorded with your reason; a live engine attempt is stopped cooperatively by the runtime on its next check.',
  },
  'muse.propose_create': {
    permission: 'muse.propose_create',
    mutating: true,
    description:
      'Propose a new specialist Muse. Validated against team-size and policy limits, then recorded as a pending operator approval — nothing is instantiated until the operator decides. Especially relevant when the proposal would introduce a new engine.',
  },
  'approval.request': {
    permission: 'approval.request',
    mutating: true,
    description:
      'File an approval request for a sensitive action and park the run in awaiting_approval where the state machine allows it. The request is durable; do not proceed as if approved.',
  },
  'diff.inspect': {
    permission: 'diff.inspect',
    mutating: false,
    description:
      'Read git status, diff statistics and recent commits of a task’s isolated checkout (read-only, bounded output). Use it to ground review and verification in actual repository state.',
  },
  'project.read': {
    permission: 'project.read',
    mutating: false,
    description:
      'Read the project context: a bounded directory listing (no path) or a bounded single-file read. Pluton state, engine homes, .git and node_modules are never readable; paths outside the project are refused.',
  },
  'run.stop': {
    permission: 'run.stop',
    mutating: true,
    description:
      'Request that this run stops. Transitions the run state to cancelled where the state machine allows it and records your reason; in-flight attempts are wound down by the runtime.',
  },
}

export function isPlutonToolName(name: string): name is PlutonToolName {
  return Object.hasOwn(TOOL_SCHEMAS, name)
}

export function getToolDef(name: string): (PlutonToolDef & { name: PlutonToolName }) | null {
  if (!isPlutonToolName(name)) return null
  return { name, ...TOOL_DEFS[name] }
}

/** MCP `tools/list` payload; callers filter by permission before exposing. */
export function toolInfosForMcp(): McpToolInfo[] {
  return (Object.keys(TOOL_SCHEMAS) as PlutonToolName[]).map((name) => ({
    name,
    description: TOOL_DEFS[name].description,
    inputSchema: z.toJSONSchema(TOOL_SCHEMAS[name], { target: 'draft-7', io: 'input' }) as Record<string, unknown>,
  }))
}
