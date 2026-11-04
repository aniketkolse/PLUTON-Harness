import type { RunState, SandboxState, TaskState } from './state.ts'

/** JSON-safe value (persisted in events/results). Bounded at the edges by the writer. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

// ---------------------------------------------------------------------------
// Identity & roles
// ---------------------------------------------------------------------------

export const SHIP_ROLES = [
  'supervisor',
  'researcher',
  'coder',
  'tester',
  'reviewer',
  'custom',
] as const
export type ShipRole = (typeof SHIP_ROLES)[number]
/** @deprecated Use `ShipRole`; kept for backward compatibility. */
export type MuseRole = ShipRole
/** @deprecated Use `SHIP_ROLES`; kept for backward compatibility. */
export const MUSE_ROLES = SHIP_ROLES

/** Canonical five persistent roles for ship workers. */
export const PERSISTENT_SHIP_ROLES = [
  'supervisor',
  'tester',
  'researcher',
  'coder',
  'reviewer',
] as const
export type PersistentShipRole = (typeof PERSISTENT_SHIP_ROLES)[number]
/** @deprecated Use `PERSISTENT_SHIP_ROLES`; kept for backward compatibility. */
export const PERSISTENT_MUSE_ROLES = PERSISTENT_SHIP_ROLES
/** @deprecated Use `PersistentShipRole`; kept for backward compatibility. */
export type PersistentMuseRole = PersistentShipRole

export const WORKSPACE_POLICIES = [
  'coordinator-read-only',
  'read-only',
  'isolated-task-checkout',
] as const
export type WorkspacePolicy = (typeof WORKSPACE_POLICIES)[number]

export const ROLE_DEFAULT_WORKSPACE_POLICIES: Readonly<Record<ShipRole, WorkspacePolicy>> = {
  supervisor: 'coordinator-read-only',
  researcher: 'read-only',
  coder: 'isolated-task-checkout',
  tester: 'isolated-task-checkout',
  reviewer: 'read-only',
  custom: 'isolated-task-checkout',
}

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

/**
 * The durable anchor for successive Build runs in one project (PLUTON 4.1
 * Phase 4). One row per project; `workspaceRoot` is the stable Build workspace
 * and `buildCount` is the plan revision seen by the manager.
 */
export interface ProjectSessionRecord {
  id: string
  projectId: string
  workspaceRoot: string
  /** Informational anchor for the newest Build; run state is authoritative. */
  activeRunId: string | null
  buildCount: number
  lastGoal: string | null
  createdAt: string
  updatedAt: string
}

export interface ShipRecord {
  id: string
  projectId: string
  slug: string
  displayName: string
  role: ShipRole
  engineKind: string
  /** Explicit provider identity (e.g. '9router', 'ollama'). Null for built-in/default provider. */
  provider?: string | null
  /** Exact provider-qualified model id as the engine reports it (never normalized). */
  model: string
  instructionsFile: string | null
  workspacePolicy: WorkspacePolicy
  permissions: string[]
  approvalMode: ApprovalMode
  /** Relative path under .pluton/engine-homes/ for this Ship's private engine config. */
  engineHome: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** @deprecated Use `ShipRecord`; kept for backward compatibility. */
export type MuseRecord = ShipRecord

export interface RunRecord {
  id: string
  projectId: string
  goal: string
  origin: 'cli' | 'api'
  requestedBy: string
  state: RunState
  acceptanceCriteria: string[]
  /** The Manager Ship authorized to coordinate this run. */
  managerShipId: string
  /** @deprecated Use `managerShipId`; kept for backward compatibility. */
  managerMuseId?: string
  budget: RunBudget
  /** Supervisor process that owns the live run loop (PID), for stop/status. */
  supervisorPid: number | null
  /** Opaque run-ownership fencing token; NULL = no supervisor owns this run. */
  supervisorToken: string | null
  /** Epoch ms of the owner's last heartbeat; NULL = unowned. */
  supervisorHeartbeatAt: number | null
  /** Workspace this run operates on (NULL = the server project root). */
  workspaceRoot: string | null
  /** Chat session that started this run, so background work stays bound to it. */
  originSessionId: string | null
  /** Persistent Build session this run belongs to (NULL for legacy runs). */
  projectSessionId: string | null
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
  writeScope?: string[]
  assigneeShipId: string | null
  /** @deprecated Use `assigneeShipId`; kept for backward compatibility. */
  assigneeMuseId?: string | null
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
  /**
   * Bounded JSON snapshot `{shipId, role, engine, model}` captured when the task
   * is claimed, so history survives later Ship config edits.
   */
  assignment: JsonValue | null
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
  shipId: string | null
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string | null
  kind: 'task-checkout' | 'integration-checkout'
  path: string
  branch: string
  baseCommit: string
  headCommit: string | null
  state: 'active' | 'archived' | 'removed'
  createdAt: string
  updatedAt: string
}

/**
 * Native execution policy vocabulary (ADR-0013). These live in the domain layer
 * because they are persisted on every sandbox session row and rendered in
 * status/doctor output; the execution provider imports them rather than
 * defining a second, drifting copy.
 */
export const EXECUTION_MODES = ['read-only', 'workspace-write', 'unconfined'] as const
export type ExecutionMode = (typeof EXECUTION_MODES)[number]

export const EXECUTION_NETWORK_POLICIES = ['open', 'restricted', 'none'] as const
export type ExecutionNetworkPolicy = (typeof EXECUTION_NETWORK_POLICIES)[number]

export const SANDBOX_KINDS = ['native', 'docker', 'local-process'] as const
export type SandboxKind = (typeof SANDBOX_KINDS)[number]

/**
 * Lifecycle of one execution session. `legacy` marks pre-v10 Docker/
 * local-process history that is kept for audit and terminal references but can
 * never become active again.
 */
export const SANDBOX_SESSION_STATES = [
  'starting',
  'running',
  'exited',
  'failed',
  'legacy',
] as const
export type SandboxSessionState = (typeof SANDBOX_SESSION_STATES)[number]

export interface SandboxRecord {
  id: string
  projectId: string
  shipId: string | null
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string | null
  kind: SandboxKind
  containerName: string | null
  containerId: string | null
  image: string | null
  state: SandboxState
  createdBy: string
  createdAt: string
  updatedAt: string
  /** At most one active session per (project, ship); enforced by a partial unique index. */
  active: boolean
  /** Row preserved from the Docker/local-process era; read-only history. */
  legacy: boolean
  executionMode: ExecutionMode | null
  networkPolicy: ExecutionNetworkPolicy | null
  helperVersion: string | null
  /** Frozen capability/policy snapshot used to start this session. */
  policy: JsonValue | null
  sessionState: SandboxSessionState | null
  lastSeenAt: string | null
  exitCode: number | null
  startedAt: string | null
  endedAt: string | null
}

export interface TerminalRecord {
  id: string
  projectId: string
  shipId: string
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string
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
  | 'ship.create'
  | 'ship.propose-create'
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
  shipId: string | null
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string | null
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
  requestedByShipId: string | null
  /** @deprecated Use `requestedByShipId`; kept for backward compatibility. */
  requestedByMuseId?: string | null
  action: string
  reason: string
  /** Bounded JSON scope: what exactly would happen if approved. */
  scope: JsonValue
  status: ApprovalStatus
  decidedBy: string | null
  decidedAt: string | null
  expiresAt: string | null
  createdAt: string
  selectedOption?: string | null
  answer?: string | null
}

/**
 * What the workspace evidence capture actually found.
 *
 * - `git`: a complete, trusted Git snapshot.
 * - `non-git`: the directory is deliberately not a Git checkout.
 * - `capture-failed`: Git metadata existed but could not be trusted/read.
 *
 * NULL on a verification row means legacy/incomplete evidence and is never
 * accepted as fresh.
 */
export type VerificationEvidenceKind = 'git' | 'non-git' | 'capture-failed'

export interface VerificationCheckRecord {
  id: string
  projectId: string
  runId: string
  taskId: string | null
  /** The task attempt this evidence belongs to (0 for run-level checks). */
  attempt: number
  name: string
  /** argv array — never a shell string. */
  command: string[]
  cwd: string | null
  /** Which workspace/checkout the check ran in (null until executed). */
  workspaceId: string | null
  /** What the pre-check evidence capture found; NULL is legacy/incomplete. */
  evidenceKind: VerificationEvidenceKind | null
  /** HEAD revision the check was run against; null when git evidence is unavailable. */
  revision: string | null
  /** Whether the worktree was dirty before the check; null when unknown. */
  worktreeDirty: boolean | null
  /** Fingerprint of the worktree state the check was run against. */
  worktreeFingerprint: string | null
  /** What the post-check evidence capture found. */
  postEvidenceKind: VerificationEvidenceKind | null
  /** HEAD revision immediately after the check's evidence was captured. */
  postRevision: string | null
  /** Fingerprint after the check finished; integration must match this exactly. */
  postWorktreeFingerprint: string | null
  /** Whether the worktree was dirty after the check; null when unknown. */
  postWorktreeDirty: boolean | null
  /** Confinement mechanism that actually ran (or refused) the check. */
  executor: string | null
  /** Set when an interrupted run was superseded by a fresh run of the same attempt. */
  supersededAt: string | null
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
  shipId: string
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string
  title: string | null
  state: ChatSessionState
  /** Engine-native session id for resume, when the engine exposes one. */
  nativeSessionId: string | null
  /** Opaque token the adapter needs to reopen the native session. */
  resumeToken: string | null
  /** Pluton-side engine session id (diagnostics/audit). */
  engineSessionId: string | null
  /** Absolute workspace root this session operates on (NULL = server project root). */
  workspaceRoot: string | null
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

export const INBOX_ITEM_STATES = ['enqueued', 'processing', 'delivered', 'cancelled', 'failed'] as const
export type InboxItemState = (typeof INBOX_ITEM_STATES)[number]

export interface InboxItemRecord {
  id: string
  sessionId: string
  seq: number
  text: string
  mode: string
  state: InboxItemState
  createdAt: string
  processedAt: string | null
}
