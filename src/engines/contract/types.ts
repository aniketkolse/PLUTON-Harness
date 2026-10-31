/**
 * Engine adapter contract (ADR-0003).
 *
 * Rules encoded here:
 * - Adapters speak each engine's official structured protocol. TUI text is
 *   never the managed channel.
 * - Capabilities are reported, never faked: an unsupported feature must fail
 *   with CapabilityError rather than pretend.
 * - Events are normalized; engine-native identifiers are preserved in
 *   engine-specific fields (never overwritten with Pluton ids).
 */

import type { EnginePermissionChannel } from '../interactive-approval.ts'

export interface EngineCapabilities {
  resumeSession: boolean
  interrupt: boolean
  approvals: boolean
  usage: boolean
  modelList: boolean
  mcpServers: boolean
  sessionExport: boolean
}

export interface EngineDiscovery {
  engineKind: string
  installed: boolean
  binaryPath: string | null
  version: string | null
  /** Exact setup instruction shown when installed === false. */
  fix: string
}

export interface EngineModel {
  /** Exact provider-qualified id as reported by the engine (never normalized). */
  id: string
  label?: string
  source: 'engine' | 'static'
  /** Availability observation supplied alongside the model, when known. */
  availability?: ModelAvailability
  /** Opaque provider identity as reported by the adapter, when known.
   * Never inferred from the model id or label. */
  provider?: string
  /** Capability metadata reported by the provider or discovered at runtime.
   * All fields optional: missing metadata is treated as unknown, never fabricated. */
  capabilities?: ModelCapabilities
  /** Context window size in tokens, when known. */
  contextWindow?: number
  /** Whether the model supports tool / function calling, when known. */
  toolCalling?: boolean
  /** Whether the model supports multimodal input, when known. */
  multimodal?: boolean
  /** Whether the model is suited for coding tasks, when known. */
  codingCapable?: boolean
  /** Whether the model is suited for reasoning tasks, when known. */
  reasoningCapable?: boolean
  /** Cost in USD per million tokens, when known. */
  costUsdPerMillionTokens?: number
  /** Observed or reported latency in milliseconds, when known. */
  latencyMs?: number
  /** ISO timestamp when this model was first discovered. */
  discoveredAt?: string
  /** ISO timestamp when this model's metadata was last refreshed. */
  lastRefreshedAt?: string
}

/** Capability and quota metadata for a discovered model.
 * Every field is optional: unknown values are treated conservatively
 * (do not assume capability; do not fabricate data). */
export interface ModelCapabilities {
  /** Task classes this model is reported or suited for. */
  taskFit?: ('research' | 'coding' | 'testing' | 'simple')[]
  /** Quota / usage information when exposed by the provider. */
  quota?: {
    /** True if the model is currently at or over its usage limit. */
    limitReached?: boolean
    /** ISO timestamp when the limit may reset, if known. */
    resetAt?: string
    /** Estimated remaining quota units, if known. */
    remaining?: number
  }
  /** Provider health information. */
  providerHealth?: {
    /** Whether the provider is currently healthy. */
    healthy: boolean
    /** Last observed error message, if any. */
    lastError?: string
    /** ISO timestamp of the last error, if any. */
    lastErrorAt?: string
  }
}

export interface ModelAvailability {
  /** Exact provider-qualified id. */
  id: string
  available: boolean
  reason?: string
  source?: 'engine' | 'catalog' | 'static'
  label?: string
  /** Classified error category when the model is unavailable or degraded. */
  category?: ModelErrorCategory
  /** ISO timestamp when availability was last checked. */
  healthCheckedAt?: string
  /** ISO timestamp until which the model is temporarily ineligible (cooldown). */
  temporarilyIneligibleUntil?: string
}

/** Classified error category for model failures.
 * Not every model error is a usage limit: execution errors do not trigger fallback. */
export type ModelErrorCategory =
  | 'usage-limit'
  | 'provider-unavailable'
  | 'auth-failure'
  | 'context-limit-exceeded'
  | 'unsupported-tool-capability'
  | 'temporary-network-error'
  | 'execution-error'
  | 'unknown'

/** Scope of a model ineligibility: task-level failures do not disable
 * unrelated provider accounts or other workers. */
export type FallbackScope = 'task' | 'provider' | 'global'

/** Requirements derived from a task for model selection. */
export interface TaskModelRequirements {
  /** High-level task class derived from description, acceptance criteria, or ship role. */
  taskType: 'research' | 'coding' | 'testing' | 'simple' | 'planning'
  /** Whether the task requires tool / function calling support. */
  requiresToolCalling: boolean
  /** Whether the task requires multimodal input support. */
  requiresMultimodal: boolean
  /** Minimum context window in tokens, when known. */
  minContextWindow?: number
  /** Capabilities the model should have, in priority order. */
  preferredCapabilities: ('research' | 'coding' | 'testing' | 'simple')[]
  /** Hard-required capabilities; unknown never satisfies these. */
  requiredCapabilities?: ('research' | 'coding' | 'testing' | 'simple')[]
  /** Cost preference: 'low' prefers cheaper models when cost data is known. */
  costPreference?: 'low' | 'balanced' | 'indifferent'
  /** Latency preference: 'low' prefers faster models when latency data is known. */
  latencyPreference?: 'low' | 'balanced' | 'indifferent'
  /** Optional hard cost ceiling (USD per million tokens). Unknown values cannot establish compliance. */
  maxCostUsdPerMillionTokens?: number
  /** Optional hard latency ceiling (ms). Unknown values cannot establish compliance. */
  maxLatencyMs?: number
  /** How the task type was determined (optional, for explainability). */
  classificationSource?: 'hint' | 'content' | 'role' | 'general'
  /** Confidence in the classification. */
  classificationConfidence?: 'high' | 'medium' | 'low'
}

/** Optional task-level hints for model classification (backward compatible). */
export interface TaskClassificationHint {
  /** Explicit task type override. */
  taskType?: 'research' | 'coding' | 'testing' | 'simple' | 'planning'
  /** Explicit capability requirements override. */
  requiredCapabilities?: ('research' | 'coding' | 'testing' | 'simple')[]
  /** Whether tool calling is explicitly required. */
  requiresToolCalling?: boolean
  /** Whether multimodal is explicitly required. */
  requiresMultimodal?: boolean
  /** Minimum context window in tokens. */
  minContextWindow?: number
}

/** The result of a model selection: which model was chosen and why. */
export interface ModelSelection {
  /** Selected provider-qualified model id. */
  modelId: string
  /** Engine adapter kind that reported the selected model, when known. */
  engineKind?: string
  /** Opaque provider identity, when known. */
  provider?: string
  /** Human-readable selection reason, persisted for observability. */
  reason: string
  /** Selection score (higher = better match). */
  score: number
  /** Total number of candidate models considered. */
  candidatesConsidered: number
  /** Model ids that passed eligibility filters. */
  eligibleCandidates: string[]
  /** ISO timestamp when the selection was made. */
  selectedAt: string
  /** How the selection was made: automatic, user-pinned, or fallback. */
  selectionMode: 'automatic' | 'pinned' | 'fallback'
  /** Optional score breakdown for explainability. */
  scoreBreakdown?: {
    capabilityFit: number
    context: number
    health: number
    cost: number
    latency: number
    verified: number
    total: number
  }
}

/** Current fallback state for a task. */
export type FallbackState =
  | 'healthy'
  | 'degraded'
  | 'switching'
  | 'exhausted'

/** A fallback decision: which model to switch to and why. */
export interface FallbackDecision {
  /** The model that failed and triggered the fallback. */
  fromModelId: string
  /** The model selected as replacement, or null when no eligible model remains. */
  toModelId: string | null
  /** Error category that triggered the fallback. */
  category: ModelErrorCategory
  /** Scope of the ineligibility. */
  scope: FallbackScope
  /** Whether the fallback was allowed to proceed. */
  allowed: boolean
  /** Reason if the fallback was not allowed. */
  reason?: string
  /** ISO timestamp when the decision was made. */
  decidedAt: string
}

export interface EngineAuthStatus {
  /** Presence only — never a secret value. */
  configured: boolean
  /** Human instruction for configuring auth (e.g. which command to run). */
  hint: string
}

/**
 * Pluton tool-bridge MCP server as delivered to an engine (ACP `mcpServers`).
 * - `stdio`: the engine spawns the server; argv arrays only, never a shell string.
 * - `http`: the engine connects to a URL; auth rides in headers (never argv/env).
 */
export type McpServerSpec =
  | {
      kind: 'stdio'
      name: string
      /** argv to launch a stdio MCP server. */
      command: string[]
      env?: Record<string, string>
    }
  | {
      kind: 'http'
      name: string
      url: string
      headers?: Record<string, string>
    }

export interface StartSessionRequest {
  ship?: {
    id: string
    slug: string
    role: string
    /** Exact provider-qualified model id. */
    model: string
  }
  /** @deprecated Use `ship`; kept for backward compatibility. */
  muse?: {
    id: string
    slug: string
    role: string
    /** Exact provider-qualified model id. */
    model: string
  }
  /** Working directory for the engine process (a Pluton-owned path). */
  workdir: string
  /** Sanitized, explicit env allowlist for the engine process. */
  env: Record<string, string>
  /** Engine-specific config directory (the Ship's private home). */
  configDir: string
  /** Role instructions (file contents, already loaded by the caller). */
  instructions?: string
  /** Resume a previous native session when supported. */
  resumeToken?: string
  /** Pluton tool-bridge MCP server, when the engine supports MCP. */
  mcpServers?: McpServerSpec[]
  /**
   * Operator approval channel for interactive permission policies. Absent
   * (or null) means no operator surface can answer: interactive requests fail
   * closed immediately. The channel never changes engine capabilities — it is
   * only consulted by a policy that explicitly forwards.
   */
  approvals?: EnginePermissionChannel | null
}

export interface EngineSessionInfo {
  /** Pluton-side session record id. */
  id: string
  /** Engine-native session identifier (opaque; persisted verbatim). */
  nativeSessionId: string | null
  /** Token usable with a later startSession({resumeToken}) when supported. */
  resumeToken: string | null
}

export type EngineEvent =
  | { kind: 'status'; status: 'starting' | 'ready' | 'busy' | 'idle'; detail?: string }
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | {
      kind: 'tool'
      name: string
      phase: 'start' | 'end'
      callId?: string
      summary?: string
      input?: unknown
      output?: string
      isError?: boolean
    }
  | { kind: 'approval_request'; requestId: string; description: string }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | {
      kind: 'result'
      outcome: 'success' | 'failure' | 'cancelled' | 'unknown'
      summary?: string
    }
  | { kind: 'error'; code: string; message: string }

export interface PromptRequest {
  text: string
  /** Hard wall-clock bound for this prompt turn. */
  timeoutMs?: number
}

export interface EngineSession {
  readonly info: EngineSessionInfo
  /**
   * Send a prompt and stream normalized events until a `result` event or the
   * stream ends. Implementations must be interruptible: after interrupt(),
   * the stream ends with a `result` of outcome 'cancelled' or 'unknown'
   * (never silently 'success').
   */
  sendPrompt(req: PromptRequest): AsyncIterable<EngineEvent>
  interrupt(): Promise<void>
  close(): Promise<void>
}

export interface EngineAdapter {
  readonly kind: string
  capabilities(): EngineCapabilities
  discover(): Promise<EngineDiscovery>
  /** Empty array when capabilities().modelList is false (say so, don't fabricate). */
  listModels(): Promise<EngineModel[]>
  listModelsWithAvailability?(candidateModels?: string[]): Promise<ModelAvailability[]>
  authStatus(configDir: string): Promise<EngineAuthStatus>
  startSession(req: StartSessionRequest): Promise<EngineSession>
}

export function defaultCapabilities(): EngineCapabilities {
  return {
    resumeSession: false,
    interrupt: false,
    approvals: false,
    usage: false,
    modelList: false,
    mcpServers: false,
    sessionExport: false,
  }
}
