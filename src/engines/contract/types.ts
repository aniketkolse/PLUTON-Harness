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
}

export interface ModelAvailability {
  /** Exact provider-qualified id. */
  id: string
  available: boolean
  reason?: string
  source?: 'engine' | 'catalog' | 'static'
  label?: string
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
