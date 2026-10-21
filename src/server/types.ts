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
  MuseRecord,
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
  muses: Array<{
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
}

export interface SessionDetailView {
  session: ChatSessionRecord
  messages: ChatMessageRecord[]
  activeMuse: {
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
}

export interface RunTaskView extends TaskRecord {
  /** Claim-time assignment, surfaced for inspector partitions. */
  role?: string
  model?: string
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
    perMuse: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
  }
  /**
   * True on a non-terminal run whose supervisor heartbeat is stale far beyond
   * the ownership TTL (or absent): the run has no live driver. Observability
   * only — clients recover via the existing manual resume path; nothing on
   * the server fabricates a terminal state from this flag.
   */
  supervisorStale: boolean
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
] as const

export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number]

export interface WorkerSSEEvent {
  type: WorkerEventType
  runId: string
  taskId: string
  role: string
  model?: string
  workspace?: string
  payload?: Record<string, unknown>
  timestamp?: number
}

export type ServerSSEEvent =
  | { type: 'token'; sessionId: string; text: string }
  | { type: 'turn_start'; sessionId: string; userText: string; mode?: string }
  | { type: 'turn_end'; sessionId: string; interrupted: boolean; failed: boolean }
  | { type: 'tool'; sessionId: string; tool: ToolActivityState }
  | { type: 'usage'; sessionId: string; inputTokens: number; outputTokens: number; costUsd: number | null }
  | { type: 'approval_requested'; approval: ApprovalRecord }
  | { type: 'approval_decided'; approval: ApprovalRecord }
  | { type: 'run_state'; runId: string; state: string; goal: string; error?: string; summary?: string }
  | { type: 'task_state'; taskId: string; runId: string; state: string; title: string }
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
  museId: string | null
  museName: string | null
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
