import { basename } from 'node:path'
import type { ApprovalMode, JsonValue, WorkspacePolicy } from '../domain/models.ts'
import {
  canonicalizePathWithin,
  caseInsensitivePlatform,
  relativeWithin,
  reservedPathSegment,
  type PathContainmentResult,
} from '../util/path-safety.ts'
import { stripControlChars } from '../util/sanitize.ts'
import { matchProtectedPath } from '../workspace/protected-paths.ts'

/**
 * Pure engine-permission policy (ADR-0007 / ADR-0018 boundary).
 *
 * The engine is semi-trusted: the ACP request's tool kind, title, command and
 * paths are all model-influenced data. This module therefore never upgrades an
 * unrecognized request to `allow`. It returns:
 *
 * - `deny` for an unknown/autonomous mode, a mutating manager/read-only action,
 *   a destructive shell command, an oversized/malformed scope, an alias or
 *   symlink escape, or a path outside the session workdir/project;
 * - `ask` for a protected/sensitive path, a non-destructive shell command, a
 *   read without a concrete path, or anything it does not understand;
 * - `allow` only for a recognized read-only tool with no command, at least one
 *   concrete validated path, and no conflicting/mutating signals.
 *
 * The decision is pure and testable; the caller (interactive-approval channel)
 * is responsible for durably auditing the outcome and enforcing it.
 */

export type PermissionOutcome = 'allow' | 'ask' | 'deny'
export type PermissionRisk = 'low' | 'medium' | 'high' | 'critical'

export interface EnginePermissionContext {
  approvalMode: ApprovalMode
  workspacePolicy: WorkspacePolicy
  /** The session's working directory (task checkout or project root). */
  workdir: string
  /** The project root the session is bound to. */
  projectRoot: string
  /** Configured `git.protected_paths`, repo-relative. */
  protectedPaths?: readonly string[]
  /** True for the manager/coordinator session. */
  isManager?: boolean
  /** Platform override for deterministic tests; defaults to the host. */
  platform?: NodeJS.Platform
}

export interface EnginePermissionRequestView {
  description: string
  scope: JsonValue
}

export interface EnginePermissionVerdict {
  outcome: PermissionOutcome
  risk: PermissionRisk
  /** Short operator-facing reason; never contains a full command line. */
  reason: string
  /** Bounded, non-secret signals for audit/debugging. */
  signals: string[]
}

/**
 * Bounds shared with the ACP scope snapshot. The adapter marks a scope
 * `oversized` instead of silently truncating it, and this policy refuses to
 * decide on that scope. Security never runs on a truncated action.
 */
export const ENGINE_SCOPE_LIMITS = {
  maxCommandChars: 2_048,
  maxPathChars: 512,
  maxPaths: 10,
  maxArgvEntries: 10,
  maxDescriptionChars: 4_096,
} as const

const MAX_SIGNALS = 10
const MAX_SIGNAL_CHARS = 200

const READ_ONLY_TOOL_KINDS = new Set(['read', 'search', 'list', 'find', 'grep', 'view', 'inspect'])
const MUTATING_TOOL_KINDS = new Set([
  'edit',
  'write',
  'delete',
  'remove',
  'move',
  'rename',
  'execute',
  'exec',
  'run',
  'shell',
  'bash',
  'terminal',
  'patch',
])
const MUTATING_DESCRIPTION = /\b(?:edit|write|delete|remove|move|rename|execute|exec|run|shell|command|patch|chmod|chown|create)\b/i

const RESERVED_ENGINE_SEGMENTS: ReadonlySet<string> = new Set(['.git', '.pluton'])

const RECOGNIZED_INPUT_KEYS: ReadonlySet<string> = new Set([
  'command',
  'cmd',
  'argv',
  'path',
  'filePath',
  'file_path',
  'cwd',
  'paths',
  'locations',
])

const DESTRUCTIVE_COMMANDS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'recursive-force-delete', pattern: /\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+/i },
  { name: 'windows-recursive-delete', pattern: /\b(?:del|erase)\s+\/[a-z]*[sfq]/i },
  { name: 'powershell-recursive-delete', pattern: /\bRemove-Item\b[^\n]*(?:-Recurse|-Force)/i },
  { name: 'rmdir-recursive', pattern: /\brmdir\s+\/s\b/i },
  { name: 'disk-format', pattern: /\b(?:format|mkfs(?:\.\w+)?|diskpart|fdisk|dd\s+if=)\b/i },
  { name: 'git-hard-reset', pattern: /\bgit\s+reset\s+--hard\b/i },
  { name: 'git-clean-force', pattern: /\bgit\s+clean\s+-[a-z]*[fdx]/i },
  { name: 'git-force-push', pattern: /\bgit\s+push\b[^\n]*--force\b/i },
  { name: 'privilege-escalation', pattern: /\b(?:sudo|su|doas)\b/i },
  { name: 'host-power', pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i },
  { name: 'permission-widening', pattern: /\bchmod\s+(?:777|a\+rwx)\b/i },
  { name: 'ownership-change', pattern: /\bchown\b/i },
  { name: 'remote-code-pipe', pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh|dash|powershell|pwsh)\b/i },
  { name: 'powershell-expression', pattern: /\b(?:Invoke-Expression|iex)\b/i },
  { name: 'fork-bomb', pattern: /:\(\)\s*\{/ },
]

const SENSITIVE_BASENAME = [
  /^\.env(?:\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /^(?:credentials|secrets?)(?:\..*)?$/i,
]

function boundedSignal(text: string): string {
  const clean = stripControlChars(text).replace(/\s+/g, ' ').trim()
  return clean.length <= MAX_SIGNAL_CHARS ? clean : `${clean.slice(0, MAX_SIGNAL_CHARS - 1)}…`
}

function asRecord(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null
}

function readString(record: Record<string, JsonValue> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

interface ScopeReadState {
  commands: string[]
  paths: string[]
  malformed: boolean
  oversized: boolean
  unrecognizedInput: boolean
}

function readCommandFields(record: Record<string, JsonValue>, state: ScopeReadState): void {
  for (const key of ['command', 'cmd'] as const) {
    if (!(key in record)) continue
    const value = record[key]
    if (value === null || value === undefined) continue
    if (typeof value !== 'string') {
      state.malformed = true
      continue
    }
    if (value.trim() === '') continue
    if (value.length > ENGINE_SCOPE_LIMITS.maxCommandChars) {
      state.oversized = true
      state.commands.push(value.slice(0, ENGINE_SCOPE_LIMITS.maxCommandChars))
      continue
    }
    state.commands.push(value)
  }

  if (!('argv' in record)) return
  const argv = record['argv']
  if (argv === null || argv === undefined) return
  if (!Array.isArray(argv)) {
    state.malformed = true
    return
  }
  if (argv.length > ENGINE_SCOPE_LIMITS.maxArgvEntries) state.oversized = true
  const parts: string[] = []
  for (const entry of argv.slice(0, ENGINE_SCOPE_LIMITS.maxArgvEntries)) {
    if (typeof entry !== 'string') {
      state.malformed = true
      continue
    }
    if (entry.length > ENGINE_SCOPE_LIMITS.maxCommandChars) {
      state.oversized = true
      parts.push(entry.slice(0, ENGINE_SCOPE_LIMITS.maxCommandChars))
      continue
    }
    if (entry !== '') parts.push(entry)
  }
  if (parts.length > 0) {
    const joined = parts.join(' ')
    if (joined.length > ENGINE_SCOPE_LIMITS.maxCommandChars) {
      state.oversized = true
      state.commands.push(joined.slice(0, ENGINE_SCOPE_LIMITS.maxCommandChars))
    } else {
      state.commands.push(joined)
    }
  }
}

function addPathValue(state: ScopeReadState, value: JsonValue | undefined): void {
  if (value === null || value === undefined) return
  if (typeof value !== 'string') {
    state.malformed = true
    return
  }
  if (value.trim() === '') return
  if (value.length > ENGINE_SCOPE_LIMITS.maxPathChars) {
    state.oversized = true
    state.paths.push(value.slice(0, ENGINE_SCOPE_LIMITS.maxPathChars))
    return
  }
  state.paths.push(value)
}

function readPathFields(record: Record<string, JsonValue>, state: ScopeReadState): void {
  for (const key of ['path', 'filePath', 'file_path', 'cwd'] as const) {
    if (key in record) addPathValue(state, record[key])
  }
  for (const key of ['paths', 'locations'] as const) {
    if (!(key in record)) continue
    const value = record[key]
    if (value === null || value === undefined) continue
    if (!Array.isArray(value)) {
      state.malformed = true
      continue
    }
    if (value.length > ENGINE_SCOPE_LIMITS.maxPaths) state.oversized = true
    for (const entry of value.slice(0, ENGINE_SCOPE_LIMITS.maxPaths)) {
      if (typeof entry === 'string') {
        addPathValue(state, entry)
        continue
      }
      const location = asRecord(entry)
      if (location === null || !('path' in location)) {
        state.malformed = true
        continue
      }
      addPathValue(state, location['path'])
    }
  }
}

/**
 * Read every recognized command/path shape, including nested `rawInput`/
 * `input`. Any malformed or unbounded value is a problem the policy refuses to
 * decide on; it is never silently dropped. Unknown nested keys downgrade an
 * otherwise-allowable read to `ask` because the policy cannot map them.
 */
function readScope(scope: Record<string, JsonValue> | null): ScopeReadState {
  const state: ScopeReadState = {
    commands: [],
    paths: [],
    malformed: false,
    oversized: false,
    unrecognizedInput: false,
  }
  if (scope === null) return state

  if (scope['oversized'] === true) state.oversized = true
  if (scope['malformed'] === true) state.malformed = true
  if (scope['unrecognizedInput'] === true) state.unrecognizedInput = true

  readCommandFields(scope, state)
  readPathFields(scope, state)

  for (const key of ['rawInput', 'input', 'raw_input'] as const) {
    if (!(key in scope)) continue
    const value = scope[key]
    if (value === null || value === undefined) continue
    const nested = asRecord(value)
    if (nested === null) {
      state.malformed = true
      continue
    }
    readCommandFields(nested, state)
    readPathFields(nested, state)
    for (const nestedKey of Object.keys(nested)) {
      if (!RECOGNIZED_INPUT_KEYS.has(nestedKey)) state.unrecognizedInput = true
    }
  }

  state.commands = [...new Set(state.commands)]
  state.paths = [...new Set(state.paths)]
  return state
}

function toolKind(scope: Record<string, JsonValue> | null): string {
  const value = scope === null ? null : readString(scope, 'toolKind')
  return (value ?? '').toLowerCase()
}

function isSensitivePath(relPath: string): boolean {
  const name = basename(relPath)
  return SENSITIVE_BASENAME.some((pattern) => pattern.test(name))
}

function protectedMatches(pattern: string, relPath: string, platform: NodeJS.Platform): boolean {
  if (caseInsensitivePlatform(platform)) {
    return matchProtectedPath(pattern.toLowerCase(), relPath.toLowerCase())
  }
  return matchProtectedPath(pattern, relPath)
}

function isMutatingRequest(
  kind: string,
  commands: readonly string[],
  paths: readonly string[],
  description: string,
): boolean {
  if (MUTATING_TOOL_KINDS.has(kind)) return true
  if (commands.length > 0) return true
  if (paths.length > 0 && MUTATING_DESCRIPTION.test(description)) return true
  // A manager/session request that says it will write/run is mutating even when
  // the engine omitted its tool kind and paths.
  return MUTATING_DESCRIPTION.test(description)
}

function containmentDenial(
  result: PathContainmentResult,
  scope: 'workdir' | 'project',
): { reason: string; signal: string } {
  switch (result.problem) {
    case 'control-character':
      return { reason: 'engine path contains control characters', signal: 'path:control' }
    case 'unstable-segment':
      return {
        reason: 'engine path uses a Win32-unstable segment (trailing dot or space)',
        signal: `path:unstable:${result.segment ?? ''}`,
      }
    case 'short-name-alias':
      return {
        reason: 'engine path uses a Win32 8.3 short-name alias',
        signal: `path:short-name:${result.segment ?? ''}`,
      }
    case 'outside':
      return scope === 'project'
        ? { reason: 'engine path is outside the project root', signal: 'path:outside-project' }
        : { reason: 'engine path is outside the session workdir', signal: 'path:outside-workdir' }
    default:
      return { reason: 'engine path cannot be resolved safely', signal: 'path:unresolved' }
  }
}

export function evaluateEnginePermission(
  request: EnginePermissionRequestView,
  context: EnginePermissionContext,
): EnginePermissionVerdict {
  const platform = context.platform ?? process.platform
  const signals: string[] = []
  const addSignal = (signal: string): void => {
    if (signals.length >= MAX_SIGNALS) return
    const bounded = boundedSignal(signal)
    if (!signals.includes(bounded)) signals.push(bounded)
  }

  if (
    context.approvalMode !== 'autonomous-bounded' &&
    context.approvalMode !== 'ask-for-sensitive-actions' &&
    context.approvalMode !== 'ask-always'
  ) {
    addSignal(`mode:${String(context.approvalMode as string)}`)
    return {
      outcome: 'deny',
      risk: 'critical',
      reason: `unknown approval mode '${String(context.approvalMode as string)}'; refusing fail-closed`,
      signals,
    }
  }

  if (context.approvalMode === 'autonomous-bounded') {
    addSignal('mode:autonomous-bounded')
    return {
      outcome: 'deny',
      risk: 'high',
      reason: 'autonomous-bounded denies engine permission requests (no blanket engine consent)',
      signals,
    }
  }

  const scope = asRecord(request.scope)
  const state = readScope(scope)
  const kind = scope === null ? '' : toolKind(scope)
  if (kind !== '') addSignal(`tool:${kind}`)

  if (state.malformed) {
    addSignal('scope:malformed')
    return {
      outcome: 'deny',
      risk: 'high',
      reason: 'engine permission scope is malformed; refusing to evaluate an ambiguous action',
      signals,
    }
  }
  if (state.oversized) {
    addSignal('scope:oversized')
    return {
      outcome: 'deny',
      risk: 'high',
      reason: 'engine permission scope is too large to evaluate safely; refusing to truncate a security decision',
      signals,
    }
  }

  const title = readString(scope, 'toolTitle') ?? ''
  const description = request.description
  const commandHaystack = [...state.commands, title, description]
    .filter((text) => text.trim() !== '')
    .join('\n')
  const mutating = isMutatingRequest(kind, state.commands, state.paths, `${title} ${description}`)

  if ((context.isManager === true || context.workspacePolicy !== 'isolated-task-checkout') && mutating) {
    addSignal(context.isManager === true ? 'session:manager' : `workspace:${context.workspacePolicy}`)
    return {
      outcome: 'deny',
      risk: 'high',
      reason: `a ${context.isManager === true ? 'manager' : context.workspacePolicy} session may not perform a mutating engine action`,
      signals,
    }
  }

  if (commandHaystack.trim() !== '') {
    for (const rule of DESTRUCTIVE_COMMANDS) {
      if (!rule.pattern.test(commandHaystack)) continue
      addSignal(`command:${rule.name}`)
      return {
        outcome: 'deny',
        risk: 'high',
        reason: `destructive command shape '${rule.name}' is denied at the engine boundary`,
        signals,
      }
    }
  }
  if (state.commands.length > 0) {
    const first = state.commands[0]?.split(/\s+/, 1)[0] ?? 'command'
    addSignal(`command:${basename(first)}`)
  }

  let pathAskReason: string | null = null
  for (const rawPath of state.paths) {
    // Paths in an engine request are relative to the session workdir. Prove
    // containment twice: workdir first (the worker may not read a sibling
    // checkout), then the project root (the worker may not read host files).
    const work = canonicalizePathWithin(context.workdir, rawPath, platform)
    if (!work.ok) {
      const denial = containmentDenial(work, 'workdir')
      addSignal(denial.signal)
      return { outcome: 'deny', risk: 'high', reason: denial.reason, signals }
    }
    const project = canonicalizePathWithin(context.projectRoot, work.path as string, platform)
    if (!project.ok) {
      const denial = containmentDenial(project, 'project')
      addSignal(denial.signal)
      return { outcome: 'deny', risk: 'high', reason: denial.reason, signals }
    }

    const relFromWorkdir = relativeWithin(work.root as string, work.path as string, platform)
    const relFromProject = relativeWithin(project.root as string, project.path as string, platform)
    addSignal(`path:${relFromProject}`)

    const reserved = reservedPathSegment(relFromWorkdir, RESERVED_ENGINE_SEGMENTS, platform)
    if (reserved !== null) {
      return {
        outcome: 'deny',
        risk: 'high',
        reason: 'engine path targets a reserved Pluton/git control directory',
        signals,
      }
    }
    if (isSensitivePath(relFromWorkdir)) {
      pathAskReason = 'engine action targets a sensitive file; operator approval is required'
      continue
    }
    if ((context.protectedPaths ?? []).some((pattern) => protectedMatches(pattern, relFromWorkdir, platform))) {
      pathAskReason = 'engine action targets a protected path; operator approval is required'
    }
  }
  if (pathAskReason !== null) {
    return { outcome: 'ask', risk: 'high', reason: pathAskReason, signals }
  }

  if (state.commands.length > 0) {
    return {
      outcome: 'ask',
      risk: 'high',
      reason: 'non-destructive shell command requires operator approval',
      signals,
    }
  }

  if (
    READ_ONLY_TOOL_KINDS.has(kind) &&
    state.paths.length > 0 &&
    !state.unrecognizedInput &&
    !MUTATING_DESCRIPTION.test(`${title} ${description}`)
  ) {
    return {
      outcome: 'allow',
      risk: 'low',
      reason: 'recognized read-only action with concrete paths inside the session boundary',
      signals,
    }
  }

  if (READ_ONLY_TOOL_KINDS.has(kind) && state.paths.length === 0) {
    return {
      outcome: 'ask',
      risk: 'medium',
      reason: 'read-only action has no concrete path; operator approval is required',
      signals,
    }
  }

  if (state.unrecognizedInput) {
    return {
      outcome: 'ask',
      risk: 'medium',
      reason: 'engine request contains input Pluton cannot map to a trusted operation',
      signals,
    }
  }

  return {
    outcome: 'ask',
    risk: 'medium',
    reason: 'unrecognized engine action requires operator approval',
    signals,
  }
}
