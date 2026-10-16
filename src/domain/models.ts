import type { RunState, SandboxState, TaskState } from './state.ts'

/** JSON-safe value (persisted in events/results). Bounded at the edges by the writer. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

// ---------------------------------------------------------------------------
// Identity & roles
// ---------------------------------------------------------------------------

export const MUSE_ROLES = [
  'supervisor',
  'researcher',
  'coder',
  'tester',
  'reviewer',
  'custom',
] as const
export type MuseRole = (typeof MUSE_ROLES)[number]

export const WORKSPACE_POLICIES = [
  'coordinator-read-only',
  'read-only',
  'isolated-task-checkout',
] as const
export type WorkspacePolicy = (typeof WORKSPACE_POLICIES)[number]

export const APPROVAL_MODES = [
  'autonomous-bounded',
  'ask-for-sensitive-actions',
  'ask-always',
] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]

// ---------------------------------------------------------------------------
// Durable records (mirrors persistence schema; no I/O here)
// ---------------------------------------------------------------------------

export interface ProjectRecord {
  id: string
  name: string
  rootPath: string
  configPath: string
  defaultBranch: string
  createdAt: string
  updatedAt: string
}

export interface MuseRecord {
  id: string
  projectId: string
  slug: string
  displayName: string
  role: MuseRole
  engineKind: string
  /** Exact provider-qualified model id as the engine reports it (never normalized). */
  model: string
  instructionsFile: string | null
  workspacePolicy: WorkspacePolicy
  permissions: string[]
  approvalMode: ApprovalMode
  /** Relative path under .pluton/engine-homes/ for this Muse's private engine config. */
  engineHome: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface RunRecord {
  id: string
  projectId: string
  goal: string
  origin: 'cli' | 'api'
  requestedBy: string
  state: RunState
  acceptanceCriteria: string[]
  /** The Manager Muse authorized to coordinate this run. */
  managerMuseId: string
  budget: RunBudget
  /** Supervisor process that owns the live run loop (PID), for stop/status. */
  supervisorPid: number | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  finalSummary: string | null
}

export interface RunBudget {
  maxConcurrentWorkers: number
  maxTasks: number
  maxDelegationDepth: number
  maxRunMinutes: number
  defaultTaskMinutes: number
}

export interface TaskRecord {
  id: string
  runId: string
  parentTaskId: string | null
  rootTaskId: string
  depth: number
  title: string
  brief: string
  acceptanceCriteria: string[]
  assigneeMuseId: string | null
  state: TaskState
  attempt: number
  /** Workspace (checkout) id once provisioned. */
  workspaceId: string | null
  /** Native engine session id for the live attempt (opaque, engine-specific). */
  engineSessionId: string | null
  /** Bounded JSON: outcome summary, changed files, commit refs, test evidence. */
  result: JsonValue | null
  /** Last failure/uncertainty classification, bounded JSON. */
  failure: JsonValue | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface TaskEdgeRecord {
  runId: string
  fromTaskId: string
  toTaskId: string
  kind: 'depends_on'
}

export interface WorkspaceRecord {
  id: string
  projectId: string
  runId: string | null
  taskId: string | null
  museId: string | null
  kind: 'task-checkout' | 'integration-checkout'
  path: string
  branch: string
  baseCommit: string
  headCommit: string | null
  state: 'active' | 'archived' | 'removed'
  createdAt: string
  updatedAt: string
}

export interface SandboxRecord {
  id: string
  projectId: string
  museId: string | null
  kind: 'docker' | 'local-process'
  containerName: string | null
  containerId: string | null
  image: string | null
  state: SandboxState
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface TerminalRecord {
  id: string
  projectId: string
  museId: string
  sandboxId: string | null
  tmuxSessionName: string
  state: 'present' | 'absent' | 'recreated' | 'unknown'
  createdAt: string
  updatedAt: string
}

export type RequestTargetKind =
  | 'run.create'
  | 'task.create'
  | 'task.retry'
  | 'task.cancel'
  | 'run.stop'
  | 'muse.create'
  | 'muse.propose-create'
  | 'approval.decide'
  | 'verification.run'
  | 'integration.apply'
  | 'wakeup'

export interface RequestReceiptRecord {
  id: string
  projectId: string
  targetKind: RequestTargetKind
  targetId: string | null
  /** sha256 of the canonical JSON payload. */
  payloadHash: string
  canonicalPayload: string
  state: 'accepted' | 'completed' | 'failed' | 'conflict'
  result: JsonValue | null
  error: JsonValue | null
  createdAt: string
  updatedAt: string
}

export interface EventRecord {
  /** Monotonic global sequence assigned by SQLite (INTEGER PRIMARY KEY AUTOINCREMENT). */
  seq: number
  id: string
  projectId: string
  runId: string | null
  taskId: string | null
  museId: string | null
  type: string
  /** Bounded, redacted structured payload. */
  payload: JsonValue
  createdAt: string
}

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export interface ApprovalRecord {
  id: string
  projectId: string
  runId: string | null
  taskId: string | null
  requestedByMuseId: string | null
  action: string
  reason: string
  /** Bounded JSON scope: what exactly would happen if approved. */
  scope: JsonValue
  status: ApprovalStatus
  decidedBy: string | null
  decidedAt: string | null
  expiresAt: string | null
  createdAt: string
}

export interface VerificationCheckRecord {
  id: string
  projectId: string
  runId: string
  taskId: string | null
  name: string
  /** argv array — never a shell string. */
  command: string[]
  cwd: string | null
  /** Which workspace/checkout the check ran in (null until executed). */
  workspaceId: string | null
  status: 'pending' | 'passed' | 'failed' | 'skipped'
  exitCode: number | null
  /** Bounded stdout/stderr artifacts written under .pluton/state/artifacts/. */
  stdoutArtifact: string | null
  stderrArtifact: string | null
  durationMs: number | null
  createdAt: string
  updatedAt: string
}

export const CHAT_SESSION_STATES = ['active', 'closed'] as const
export type ChatSessionState = (typeof CHAT_SESSION_STATES)[number]

export interface ChatSessionRecord {
  id: string
  projectId: string
  museId: string
  title: string | null
  state: ChatSessionState
  /** Engine-native session id for resume, when the engine exposes one. */
  nativeSessionId: string | null
  /** Opaque token the adapter needs to reopen the native session. */
  resumeToken: string | null
  /** Pluton-side engine session id (diagnostics/audit). */
  engineSessionId: string | null
  createdAt: string
  updatedAt: string
}

export const CHAT_MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number]

export interface ChatMessageRecord {
  id: string
  sessionId: string
  /** Per-session monotonic sequence, 1-based. */
  seq: number
  role: ChatMessageRole
  text: string
  meta: JsonValue
  createdAt: string
}
