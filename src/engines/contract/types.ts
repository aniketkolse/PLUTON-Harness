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

export interface EngineAuthStatus {
  /** Presence only — never a secret value. */
  configured: boolean
  /** Human instruction for configuring auth (e.g. which command to run). */
  hint: string
}

export interface McpServerSpec {
  name: string
  /** argv to launch a stdio MCP server. */
  command: string[]
  env?: Record<string, string>
}

export interface StartSessionRequest {
  muse: {
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
  /** Engine-specific config directory (the Muse's private home). */
  configDir: string
  /** Role instructions (file contents, already loaded by the caller). */
  instructions?: string
  /** Resume a previous native session when supported. */
  resumeToken?: string
  /** Pluton tool-bridge MCP server, when the engine supports MCP. */
  mcpServers?: McpServerSpec[]
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
  | { kind: 'tool'; name: string; phase: 'start' | 'end'; summary?: string; isError?: boolean }
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
