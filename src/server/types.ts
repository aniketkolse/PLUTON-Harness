/**
 * Application Server data contracts and API types (ADR-0014).
 * Single authoritative contract shared across server, desktop, and browser.
 */

import type {
  ApprovalRecord,
  ApprovalStatus,
  ChatMessageRecord,
  ChatSessionRecord,
  JsonValue,
  ShipRecord,
  RunRecord,
  TaskEdgeRecord,
  TaskRecord,
} from '../domain/models.ts'
import type { ToolActivityState } from '../tui/activity.ts'

export interface ServerInstanceInfo {
  pid: number
  port: number
  token: string
  url: string
  rootDir: string
  startedAt: string
}

export interface WorkspaceSummary {
  name: string
  rootDir: string
  projectId: string
  defaultBranch: string
  ships: Array<{
    id: string
    slug: string
    displayName: string
    role: string
    engine: string
    model: string
    state: string
  }>
  /** @deprecated Use `ships`; kept for backward compatibility. */
  muses?: Array<{
    id: string
    slug: string
    displayName: string
    role: string
    engine: string
    model: string
    state: string
  }>
  activeRun: { id: string; state: string; goal: string } | null
  approvalsPending: number
  /**
   * Session-scoped workspace root, present only when the requested session
   * overrides the server project root. NULL/absent means the server pinned
   * the project root (the legacy behavior).
   */
  sessionId?: string | null
  workspaceRoot?: string | null
  sessionScoped?: boolean
  /** Durable Build anchor; null until the first Build runs in this project. */
  projectSession?: {
    id: string
    workspaceRoot: string
    buildCount: number
    activeRunId: string | null
    lastGoal: string | null
  } | null
}

export interface SessionDetailView {
  session: ChatSessionRecord
  messages: ChatMessageRecord[]
  activeShip: {
    id: string
    slug: string
    displayName: string
    role: string
    engine: string
    model: string
  }
  /** Backward-compatible alias for activeShip. */
  activeMuse?: {
    id: string
    slug: string
    displayName: string
    role: string
    engine: string
    model: string
  }
  /**
   * True while this session's engine turn is in flight. A client that reloads
   * mid-turn reads the real state here instead of showing a false "ready".
   */
  busy: boolean
  queueLength?: number
  workspaceRoot?: string | null
}

export interface RunTaskView extends TaskRecord {
  /** Claim-time assignment, surfaced for inspector partitions. */
  role?: string
  model?: string
  /** Assigned Ship, for the human-readable inspector label. */
  shipId?: string
  shipDisplayName?: string
  /** Active checkout path for isolated workers (absent for read-only roles). */
  workspace?: string
}

export interface RunDetailView {
  run: RunRecord
  tasks: RunTaskView[]
  edges: TaskEdgeRecord[]
  approvals: ApprovalRecord[]
  usage: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCostUsd: number
    perShip: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
  }
  /**
   * True on a non-terminal run whose supervisor heartbeat is stale far beyond
   * the ownership TTL (or absent): the run has no live driver. Observability
   * only — clients recover via the existing manual resume path; nothing on
   * the server fabricates a terminal state from this flag.
   */
  supervisorStale: boolean
}

export type RunActivityTone = 'info' | 'success' | 'warning' | 'error' | 'message'

/**
 * One concise, user-facing progress item in the main conversation. Derived
 * from a durable event; `seq` is the event seq, so reconnects can resume with
 * `afterSeq` and the client can dedupe without a second progress state.
 */
export interface RunActivityItem {
  seq: number
  /** Durable event id. */
  id: string
  runId: string
  taskId: string | null
  type: string
  /** ISO timestamp of the durable event. */
  at: string
  actor: 'supervisor' | 'worker' | 'system'
  actorLabel: string
  text: string
  tone: RunActivityTone
  detail?: string
}

export interface RunActivityView {
  runId: string
  /** Oldest first. */
  activity: RunActivityItem[]
  /** Highest seq returned (0 when none); resume from here. */
  latestSeq: number
}

/** One worker message as shown in the task detail view. */
export interface TaskDetailMessage {
  id: string
  seq: number
  /** Relative to the task being viewed. */
  direction: 'in' | 'out'
  senderShipId: string | null
  senderLabel: string
  senderTaskId: string | null
  recipientShipId: string
  recipientLabel: string
  recipientTaskId: string | null
  kind: string
  body: string
  replyTo: string | null
  createdAt: number
}

export interface TaskDetailToolCall {
  seq: number
  at: string
  step: string
  isError: boolean
}

export interface TaskDetailCheck {
  name: string
  status: string
  exitCode: number | null
  durationMs: number | null
  attempt: number
  note: string | null
}

/** Authoritative per-task detail for the worker inspector modal. */
export interface TaskDetailView {
  runId: string
  runState: string
  task: {
    id: string
    title: string
    brief: string
    state: string
    attempt: number
    parentTaskId: string | null
    assigneeShipId: string | null
    assigneeName: string | null
    role: string | null
    engine: string | null
    model: string | null
    workspaceId: string | null
    workspacePath: string | null
    writeScope: string[]
    dependsOn: string[]
    createdAt: string
    startedAt: string | null
    completedAt: string | null
  }
  acceptanceCriteria: string[]
  activity: RunActivityItem[]
  supervisorActivity: RunActivityItem[]
  messages: TaskDetailMessage[]
  toolCalls: TaskDetailToolCall[]
  files: {
    changed: string[]
    untracked: string[]
    truncated: boolean
  }
  verification: {
    verdict: string | null
    checks: TaskDetailCheck[]
    criteria: JsonValue | null
    tamper: JsonValue | null
    evidence: JsonValue | null
  }
  retries: {
    attempts: number
    retryScheduled: number
    revisions: number
    leaseBlockers: number
  }
  result: JsonValue | null
  failure: JsonValue | null
  canMessage: boolean
}

export const WORKER_EVENT_TYPES = [
  'worker.created',
  'worker.started',
  'worker.progress',
  'worker.question',
  'worker.waiting',
  'worker.report',
  'worker.completed',
  'worker.failed',
  'worker.cancelled',
  'worker.message',
] as const

export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number]

export interface WorkerSSEEvent {
  type: WorkerEventType
  runId: string
  taskId: string
  role: string
  /** Configured Ship display name (e.g. "Researcher - Z"), when known. */
  shipName?: string
  model?: string
  workspace?: string
  payload?: Record<string, unknown>
  timestamp?: number
}

export type ServerSSEEvent =
  | { type: 'token'; sessionId: string; text: string }
  | { type: 'thought'; sessionId: string; text: string }
  | { type: 'turn_start'; sessionId: string; userText: string; mode?: string }
  | { type: 'turn_end'; sessionId: string; interrupted: boolean; failed: boolean }
  | { type: 'tool'; sessionId: string; tool: ToolActivityState }
  | { type: 'usage'; sessionId: string; inputTokens: number; outputTokens: number; costUsd: number | null }
  | { type: 'approval_requested'; approval: ApprovalRecord }
  | { type: 'approval_decided'; approval: ApprovalRecord }
  | { type: 'run_state'; runId: string; state: string; goal: string; error?: string; summary?: string }
  | { type: 'task_state'; taskId: string; runId: string; state: string; title: string }
  | { type: 'run_activity'; activity: RunActivityItem }
  | { type: 'workspace_changed'; sessionId: string; workspaceRoot: string | null }
  | { type: 'heartbeat'; timestamp: number }
  | WorkerSSEEvent

export interface HealthResponse {
  ok: true
  version: string
  node: string
  platform: string
  projectId: string
  projectName: string
  rootDir: string
}

/**
 * One MCP server the runtime is actually serving to an engine session.
 *
 * Pluton is the MCP *server* here: it hands `McpServerSpec`s to engine sessions
 * over its own tool transport. There is no MCP client in the runtime and the
 * engine protocol never reports a connect acknowledgement, so `state` describes
 * what Pluton can prove — the transport is up and the bridge session is
 * registered — and `detail` says plainly what remains unobservable.
 */
export interface McpServerStatus {
  /** MCP server name as delivered to the engine (`pluton` for the tool bridge). */
  name: string
  /** Transport the engine was told to use. */
  kind: 'http' | 'stdio'
  /**
   * `connected` = the tool transport is listening and a bridge session for this
   * engine session is registered. `disconnected` = the transport or the owning
   * engine session went away.
   */
  state: 'connected' | 'disconnected'
  detail: string
  /** Chat session that owns this MCP server, when it is session-scoped. */
  sessionId: string | null
  shipId: string | null
  shipName: string | null
  engineKind: string | null
}

export interface McpStatusResponse {
  ok: true
  /** Number of MCP servers meeting the connected-state criteria. */
  connected: number
  /** Number of registered MCP servers in total. */
  total: number
  /** True when the shared tool transport is accepting authenticated requests. */
  transportUp: boolean
  servers: McpServerStatus[]
}
