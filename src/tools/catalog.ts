import { z } from 'zod'
import { SHIP_ROLES } from '../domain/models.ts'
import type { Permission } from '../domain/permissions.ts'
import { WORKER_MESSAGE_KINDS } from '../orchestrator/messages.ts'
import type { McpToolInfo } from './mcp-server.ts'

/**
 * The restricted Pluton tool surface (ADR-0007). The Manager Ship (and, where
 * their permissions allow, worker Ships) affects the run ONLY through these
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
const writeScope = z.array(z.string().min(1).max(500)).max(100)

export const TOOL_SCHEMAS = {
  'task.create': z
    .object({
      title,
      brief,
      acceptanceCriteria,
      assigneeShipId: z.string().min(1).max(64).optional(),
      /** @deprecated Use `assigneeShipId`; accepted for backward compatibility. */
      assigneeMuseId: z.string().min(1).max(64).optional(),
      dependsOn: dependsOn.optional(),
      writeScope: writeScope.optional(),
    })
    .strict()
    .refine(
      (data) => data.assigneeShipId !== undefined || data.assigneeMuseId !== undefined,
      { message: 'either assigneeShipId or assigneeMuseId is required' },
    ),
  'task.delegate': z
    .object({
      title,
      brief,
      acceptanceCriteria,
      assigneeShipId: z.string().min(1).max(64).optional(),
      /** @deprecated Use `assigneeShipId`; accepted for backward compatibility. */
      assigneeMuseId: z.string().min(1).max(64).optional(),
      dependsOn: dependsOn.optional(),
      writeScope: writeScope.optional(),
    })
    .strict()
    .refine(
      (data) => data.assigneeShipId !== undefined || data.assigneeMuseId !== undefined,
      { message: 'either assigneeShipId or assigneeMuseId is required' },
    ),
  'scope.declare': z
    .object({
      paths: z.array(z.string().min(1).max(500)).min(1).max(100),
      symbols: z.record(z.string(), z.array(z.string().min(1).max(200))).optional(),
    })
    .strict(),
  'scope.release': z
    .object({
      paths: z.array(z.string().min(1).max(500)).optional(),
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
  'task.request_revision': z
    .object({
      taskId: taskRef,
      feedback: z.string().min(1).max(2_000),
    })
    .strict(),
  'review.report': z
    .object({
      taskId: taskRef,
      verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'REJECT', 'INSUFFICIENT_EVIDENCE']),
      summary: z.string().min(1).max(4_000),
      issues: z.array(z.string().min(1).max(2_000)).max(50).optional(),
    })
    .strict(),
  'ship.propose_create': z
    .object({
      shipId: z
        .string()
        .min(1)
        .max(48)
        .regex(/^[a-z][a-z0-9-]*$/, 'shipId must be a lowercase slug (letters, digits, dashes)'),
      displayName: z.string().min(1).max(80),
      role: z.enum(SHIP_ROLES),
      engine: z.string().min(1).max(40),
      model: z.string().min(1).max(200),
      reason: z.string().min(1).max(2_000),
    })
    .strict(),
  /** @deprecated Use `ship.propose_create`; kept for backward compatibility with engines that still file under the old name. */
  'muse.propose_create': z
    .object({
      museId: z
        .string()
        .min(1)
        .max(48)
        .regex(/^[a-z][a-z0-9-]*$/, 'museId must be a lowercase slug (letters, digits, dashes)'),
      displayName: z.string().min(1).max(80),
      role: z.enum(SHIP_ROLES),
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
  'ship.message': z
    .object({
      recipientShipId: z.string().min(1).max(64),
      kind: z.enum(WORKER_MESSAGE_KINDS),
      body: z.string().min(1).max(8_000),
      /** Specific recipient task; omitted = any session of that Ship. */
      taskId: taskRef.optional(),
      /** Message id this replies to (threading hint, not a contract). */
      replyTo: z.string().min(1).max(64).optional(),
    })
    .strict(),
  'ship.inbox': z
    .object({
      waitMs: z.number().int().min(0).max(60_000).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  'spec.read': z
    .object({
      specId: z.string().min(1).max(64).optional(),
      title: z.string().min(1).max(300).optional(),
      path: z.string().min(1).max(500).optional(),
      query: z.string().min(1).max(500).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  'spec.write': z
    .object({
      title: z.string().min(1).max(300),
      body: z.string().min(1).max(8_000),
      path: z.string().min(1).max(500),
      specId: z.string().min(1).max(64).optional(),
    })
    .strict(),
  'file.claim': z
    .object({
      path: z.string().min(1).max(500),
      intent: z.string().min(1).max(2_000),
    })
    .strict(),
  'file.release': z
    .object({
      claimId: z.string().min(1).max(64),
    })
    .strict(),
  'team.broadcast': z
    .object({
      body: z.string().min(1).max(8_000),
      kind: z.enum(WORKER_MESSAGE_KINDS),
    })
    .strict(),
  'file.write': z
    .object({
      path: z.string().min(1).max(500),
      content: z.string().max(2_000_000),
    })
    .strict(),
  'file.edit': z
    .object({
      path: z.string().min(1).max(500),
      oldText: z.string(),
      newText: z.string(),
    })
    .strict(),
  'file.search': z
    .object({
      pattern: z.string().min(1).max(500),
      isRegex: z.boolean().optional(),
      path: z.string().min(1).max(500).optional(),
    })
    .strict(),
  'command.exec': z
    .object({
      command: z.string().min(1).max(2000),
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
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
      'Create a top-level task in this run and assign it to a Ship. Use this for the first level of work; to split work under YOUR OWN task use task.delegate. The brief must state objective, inputs, done criteria and required evidence. The runtime validates budgets, team size, dependencies and graph rules before recording anything.',
  },
  'task.delegate': {
    permission: 'task.delegate',
    mutating: true,
    description:
      'Create a child task under YOUR current task and assign it to a different Ship. Rejected for delegation-depth, fan-out, dependency-cycle and budget overflows, and for any assignee that already owns an ancestor of your task (delegation can never cycle back up its own chain).',
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
      'Wait until every requested task is settled — a terminal state, or `verifying`: the work is done and the operator’s verification gate closes the task later — or the timeout elapses. Settled is not the same as successful: check `reason` (`settled` | `timeout` | `aborted`), timedOut, awaitingVerification and the returned states before acting. `aborted` means the wait was cancelled (shutdown or client disconnect) before the deadline: timedOut stays false and nothing was decided. Event wakeups are in-process; a standalone bridge (e.g. the stdio server) re-reads durable state every runtime heartbeat_seconds instead of waking instantly. Bounded to 600 seconds.',
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
      'Cancel a task that has not reached a terminal state. Recorded with your reason; a live engine attempt is interrupted by the runtime on its next control tick (within about a second), and an already terminal task is acknowledged idempotently instead of raising a conflict. Not-yet-terminal tasks that transitively depend on the cancelled task are cancelled too, because they can never become ready. Cancellation is not success: a run with any cancelled task cannot finish as completed.',
  },
  'task.request_revision': {
    permission: 'task.request_revision',
    mutating: true,
    description:
      'Manager-only: send a FAILED task back for one more attempt. Only a `failed` task is eligible; your feedback (bounded, sanitized) is recorded on the task and reaches the next attempt’s prompt, and the task is requeued with its attempt counter advanced. Rejected once the configured revision cap (runtime.max_revisions_per_task) is exhausted.',
  },
  'ship.propose_create': {
    permission: 'ship.propose_create',
    mutating: true,
    description:
      'Propose a new specialist Ship. Validated against team-size and policy limits, then recorded as a pending operator approval — nothing is instantiated until the operator decides. Especially relevant when the proposal would introduce a new engine.',
  },
  /** @deprecated Use `ship.propose_create` def; kept for backward compatibility with engines that still call the old name. */
  'muse.propose_create': {
    permission: 'muse.propose_create',
    mutating: true,
    description:
      'Propose a new specialist Ship. Validated against team-size and policy limits, then recorded as a pending operator approval — nothing is instantiated until the operator decides. Especially relevant when the proposal would introduce a new engine.',
  },
  'approval.request': {
    permission: 'approval.request',
    mutating: true,
    description:
      'File an approval request for a sensitive action and park the run in awaiting_approval where the state machine allows it. The request is durable; do not proceed as if approved.',
  },
  'review.report': {
    permission: 'review.report',
    mutating: true,
    description:
      'Record an independent review verdict for a task that is in `verifying`. Verdicts: APPROVE, REQUEST_CHANGES, REJECT, INSUFFICIENT_EVIDENCE. Anti-self-approval: the reviewer Ship cannot review its own task, and the supervisor cannot review a task it assigned to itself. A REQUEST_CHANGES verdict requeues the task for a bounded revision when the cap allows.',
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
      'Request that this run stops. Transitions the run state to cancelled where the state machine allows it and records your reason; in-flight attempts are wound down by the runtime. An already terminal run is acknowledged idempotently instead of raising a conflict.',
  },
  'scope.declare': {
    permission: 'scope.declare',
    mutating: true,
    description:
      'Declare intended file paths and symbols before modifying them. Prohibits conflicting concurrent edits and lockfile corruption across Ships.',
  },
  'scope.release': {
    permission: 'scope.release',
    mutating: true,
    description:
      'Release declared file paths so other Ships may acquire them after work is completed.',
  },
  'ship.message': {
    permission: 'worker.message',
    mutating: true,
    description:
      'Send a durable message to a specific active Ship: a finding, evidence, file path, interface contract, blocker, question, handoff or instruction. The recipient reads it with ship.inbox at its next tool call; delivery is at-most-once and recorded in the run event log. Acknowledge the message id in your final summary. A peer message never widens your assigned scope.',
  },
  'ship.inbox': {
    permission: 'worker.message',
    mutating: false,
    description:
      'Read messages addressed to you (optionally waiting up to 60 seconds for one). Returns message id, sender Ship, task association, kind, body and timestamp, and acknowledges the returned messages so they are never delivered twice. Check the inbox before finishing so a handoff or blocker is not missed.',
  },
  'spec.read': {
    permission: 'worker.message',
    mutating: false,
    description:
      'Read shared team specs, contracts, and plans. Filter by spec ID, title, path, or free-text query. Returns the specs (newest first). Always call this at session start to see what the team has already agreed on.',
  },
  'spec.write': {
    permission: 'worker.message',
    mutating: true,
    description:
      'Publish or update a shared team spec (contract, API shape, migration plan, data model, etc.). Updates bump the version and notify the team. Specs are the persistent memory of the run — write decisions here so other Ships can read them instead of guessing.',
  },
  'file.claim': {
    permission: 'worker.message',
    mutating: true,
    description:
      'Claim a file or directory for editing and broadcast your intent to the team. Other Ships see the claim and avoid conflicting edits. Returns a claim ID. Release with file.release when done.',
  },
  'file.release': {
    permission: 'worker.message',
    mutating: true,
    description:
      'Release a file claim so other Ships may acquire the file.',
  },
  'team.broadcast': {
    permission: 'worker.message',
    mutating: true,
    description:
      'Send a message to every active Ship in the team. Use for announcements, ideas, progress updates, and questions that affect the whole team. Delivery is durable and appears in the run event log.',
  },
  'file.write': {
    permission: 'project.write',
    mutating: true,
    description:
      'Write or overwrite a file within the workspace checkout. Validated against lease declarations, refused paths, and workspace boundaries.',
  },
  'file.edit': {
    permission: 'project.write',
    mutating: true,
    description:
      'Perform targeted find-and-replace text editing within a file in the workspace checkout. Requires exact unique match of oldText.',
  },
  'file.search': {
    permission: 'project.read',
    mutating: false,
    description:
      'Search for text or regex pattern across files within the session workspace.',
  },
  'command.exec': {
    permission: 'tests.run',
    mutating: true,
    description:
      'Execute a bounded shell command within the task workspace directory and capture stdout, stderr, and exit code.',
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
