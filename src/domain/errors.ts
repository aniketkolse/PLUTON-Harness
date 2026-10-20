/**
 * Typed, coded errors. Codes are stable strings: the CLI prints them, `--json`
 * output carries them, and tests assert on them. Never invent ad-hoc error
 * strings at call sites — add a code here.
 */
export type ErrorCode =
  | 'config_invalid'
  | 'config_version_unsupported'
  | 'validation_failed'
  | 'not_found'
  | 'request_conflict'
  | 'state_transition_invalid'
  | 'ownership_lost'
  | 'policy_denied'
  | 'capability_unsupported'
  | 'engine_missing'
  | 'engine_auth_missing'
  | 'engine_protocol_error'
  | 'sandbox_unavailable'
  | 'terminal_unavailable'
  | 'workspace_error'
  | 'verification_failed'
  | 'not_implemented'
  | 'external_tool_error'
  | 'internal_error'

export interface PlutonErrorOptions {
  details?: unknown
  cause?: unknown
}

export class PlutonError extends Error {
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, options: PlutonErrorOptions = {}) {
    super(message)
    this.name = 'PlutonError'
    this.code = code
    if (options.details !== undefined) this.details = options.details
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export class ConfigError extends PlutonError {
  constructor(message: string, options: PlutonErrorOptions = {}) {
    super('config_invalid', message, options)
    this.name = 'ConfigError'
  }
}

export class ValidationError extends PlutonError {
  constructor(message: string, options: PlutonErrorOptions = {}) {
    super('validation_failed', message, options)
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends PlutonError {
  constructor(what: string, id: string) {
    super('not_found', `${what} not found: ${id}`, { details: { what, id } })
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends PlutonError {
  constructor(message: string, details?: unknown) {
    super('request_conflict', message, { details })
    this.name = 'ConflictError'
  }
}

export class StateTransitionError extends PlutonError {
  /**
   * `note` explains a durable loser that the pre-read alone cannot see (e.g. a
   * CAS miss because another process moved the entity between the read and the
   * UPDATE). Only the `note`-bearing message differs from the original.
   */
  constructor(from: string, to: string, entity: string, note?: string) {
    super(
      'state_transition_invalid',
      `invalid ${entity} transition: ${from} -> ${to}${note !== undefined ? ` (${note})` : ''}`,
      { details: { from, to, entity, ...(note !== undefined ? { note } : {}) } },
    )
    this.name = 'StateTransitionError'
  }
}

/**
 * The durable `runs` row proves this process no longer owns the run: a fenced
 * mutation matched no row because the supervisor token has been taken over.
 * The write did not happen — the current owner's state is intact.
 */
export class OwnershipLostError extends PlutonError {
  constructor(runId: string, details?: unknown) {
    super('ownership_lost', `run '${runId}' is no longer owned by this supervisor`, {
      details: details ?? { runId },
    })
    this.name = 'OwnershipLostError'
  }
}

export class PolicyDeniedError extends PlutonError {
  constructor(message: string, details?: unknown) {
    super('policy_denied', message, { details })
    this.name = 'PolicyDeniedError'
  }
}

export class CapabilityError extends PlutonError {
  constructor(engineKind: string, capability: string) {
    super(
      'capability_unsupported',
      `engine '${engineKind}' does not support '${capability}'; the runtime must not fake it`,
      { details: { engineKind, capability } },
    )
    this.name = 'CapabilityError'
  }
}

export class EngineMissingError extends PlutonError {
  constructor(engineKind: string, fix: string) {
    super('engine_missing', `engine '${engineKind}' is not installed or not on PATH. Fix: ${fix}`, {
      details: { engineKind, fix },
    })
    this.name = 'EngineMissingError'
  }
}

export class EngineAuthMissingError extends PlutonError {
  constructor(engineKind: string, hint: string) {
    super('engine_auth_missing', `engine '${engineKind}' is not authenticated. ${hint}`, {
      details: { engineKind, hint },
    })
    this.name = 'EngineAuthMissingError'
  }
}

/**
 * The engine's structured protocol misbehaved: malformed frames, timeouts,
 * unexpected responses, or a transport that died mid-request. Distinct from
 * `engine_missing` (not installed) and `capability_unsupported` (declared gap).
 */
export class EngineProtocolError extends PlutonError {
  constructor(message: string, options: PlutonErrorOptions = {}) {
    super('engine_protocol_error', message, options)
    this.name = 'EngineProtocolError'
  }
}

export class NotImplementedError extends PlutonError {
  constructor(what: string) {
    super('not_implemented', `${what} is not implemented in this build`, { details: { what } })
    this.name = 'NotImplementedError'
  }
}

export interface FixableErrorOptions extends PlutonErrorOptions {
  /** Exact human remediation shown by CLI/doctor. */
  fix?: string
}

export class WorkspaceError extends PlutonError {
  constructor(message: string, options: PlutonErrorOptions = {}) {
    super('workspace_error', message, options)
    this.name = 'WorkspaceError'
  }
}

/** The sandbox provider cannot run (e.g. Docker daemon down) — dispatch fails closed. */
export class SandboxUnavailableError extends PlutonError {
  constructor(message: string, options: FixableErrorOptions = {}) {
    super('sandbox_unavailable', options.fix ? `${message} Fix: ${options.fix}` : message, options)
    this.name = 'SandboxUnavailableError'
  }
}

/** tmux (or the transport to the Muse container) is unavailable — terminals are an honest gap. */
export class TerminalUnavailableError extends PlutonError {
  constructor(message: string, options: FixableErrorOptions = {}) {
    super('terminal_unavailable', options.fix ? `${message} Fix: ${options.fix}` : message, options)
    this.name = 'TerminalUnavailableError'
  }
}

export class InternalError extends PlutonError {
  constructor(message: string, options: PlutonErrorOptions = {}) {
    super('internal_error', message, options)
    this.name = 'InternalError'
  }
}

export class ExternalToolError extends PlutonError {
  constructor(tool: string, message: string, details?: unknown) {
    super('external_tool_error', `${tool}: ${message}`, { details })
    this.name = 'ExternalToolError'
  }
}

export function isPlutonError(e: unknown): e is PlutonError {
  return e instanceof PlutonError
}

/** JSON-safe rendering of any error for CLI/JSON output. Never includes stack in JSON mode. */
export function errorToJson(e: unknown): { code: string; message: string; details?: unknown } {
  if (isPlutonError(e)) {
    const out: { code: string; message: string; details?: unknown } = {
      code: e.code,
      message: e.message,
    }
    if (e.details !== undefined) out.details = e.details
    return out
  }
  if (e instanceof Error) return { code: 'internal_error', message: e.message }
  return { code: 'internal_error', message: String(e) }
}
