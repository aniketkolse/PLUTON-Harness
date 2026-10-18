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
}

export interface RunDetailView {
  run: RunRecord
  tasks: TaskRecord[]
  edges: TaskEdgeRecord[]
  approvals: ApprovalRecord[]
  usage: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCostUsd: number
    perMuse: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
  }
}

export type ServerSSEEvent =
  | { type: 'token'; sessionId: string; text: string }
  | { type: 'turn_start'; sessionId: string; userText: string }
  | { type: 'turn_end'; sessionId: string; interrupted: boolean; failed: boolean }
  | { type: 'tool'; sessionId: string; tool: ToolActivityState }
  | { type: 'usage'; sessionId: string; inputTokens: number; outputTokens: number; costUsd: number | null }
  | { type: 'approval_requested'; approval: ApprovalRecord }
  | { type: 'approval_decided'; approval: ApprovalRecord }
  | { type: 'run_state'; runId: string; state: string; goal: string }
  | { type: 'task_state'; taskId: string; runId: string; state: string; title: string }
  | { type: 'heartbeat'; timestamp: number }

export interface HealthResponse {
  ok: true
  version: string
  node: string
  platform: string
  projectId: string
  projectName: string
  rootDir: string
}
