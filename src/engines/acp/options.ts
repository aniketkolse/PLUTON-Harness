import { ValidationError } from '../../domain/errors.ts'
import type { JsonValue } from '../../domain/models.ts'
import { ENGINE_SCOPE_LIMITS } from '../../policy/engine-permissions.ts'
import type { McpServerSpec } from '../contract/types.ts'

/**
 * Shared pure helpers for engines that speak ACP (Agent Client Protocol).
 *
 * `configOptions` shapes were recorded live from `opencode acp` v2.0.29
 * (2026-10-16): the engine returns a select option `{id, name, category,
 * type:'select', currentValue, options: [{value, name, description}]}` for
 * `model`. Choice values are engine-native strings and must be used verbatim.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

export interface AcpOptionChoice {
  /** Exact value accepted by `session/set_config_option`. */
  value: string
  /** Human label as reported by the engine (may be the raw model id). */
  name?: string
  description?: string
}

export interface AcpSelectOption {
  id: string
  currentValue: unknown
  /** All choice values, flattened in engine order. */
  values: string[]
  choices: AcpOptionChoice[]
}

/**
 * Read one select option out of an ACP `configOptions` array. Nested option
 * groups are flattened (opencode groups variants under a sub-`options` field).
 */
export function readConfigOption(
  configOptions: unknown,
  match: (opt: Record<string, unknown>) => boolean,
): AcpSelectOption | null {
  if (!Array.isArray(configOptions)) return null
  for (const raw of configOptions) {
    const opt = asRecord(raw)
    if (!opt || !match(opt)) continue
    const choices: AcpOptionChoice[] = []
    const collect = (entries: unknown[]): void => {
      for (const entry of entries) {
        const e = asRecord(entry)
        if (!e) continue
        if (typeof e['value'] === 'string') {
          const choice: AcpOptionChoice = { value: e['value'] }
          if (typeof e['name'] === 'string') choice.name = e['name']
          if (typeof e['description'] === 'string') choice.description = e['description']
          choices.push(choice)
        } else if (Array.isArray(e['options'])) {
          collect(e['options'])
        }
      }
    }
    if (Array.isArray(opt['options'])) collect(opt['options'])
    return {
      id: typeof opt['id'] === 'string' ? opt['id'] : 'model',
      currentValue: opt['currentValue'],
      values: choices.map((c) => c.value),
      choices,
    }
  }
  return null
}

/** The `model` select option (matched by id or category, as OpenCode reports it). */
export function readModelOption(configOptions: unknown): AcpSelectOption | null {
  return readConfigOption(configOptions, (opt) => opt['id'] === 'model' || opt['category'] === 'model')
}

export function toAcpMcpServers(specs: McpServerSpec[] | undefined): unknown[] {
  return (specs ?? []).map((spec) => {
    if (spec.kind === 'http') {
      return {
        type: 'http',
        name: spec.name,
        url: spec.url,
        headers: Object.entries(spec.headers ?? {}).map(([name, value]) => ({ name, value })),
      }
    }
    const [command, ...args] = spec.command
    if (!command) throw new ValidationError(`MCP server '${spec.name}' has an empty command argv`)
    return {
      name: spec.name,
      command,
      args,
      env: Object.entries(spec.env ?? {}).map(([name, value]) => ({ name, value })),
    }
  })
}

/** Engine-agnostic argument guard shared by every adapter's startSession. */
export function assertNonEmptyModel(model: string): void {
  if (typeof model !== 'string' || model.trim() === '') {
    throw new ValidationError(
      "ship.model must be a non-empty engine model id (e.g. 'opencode/deepseek-v4.1-flash-free')",
    )
  }
}

const MAX_SCOPE_PATHS = ENGINE_SCOPE_LIMITS.maxPaths
const MAX_SCOPE_TEXT = ENGINE_SCOPE_LIMITS.maxCommandChars
const MAX_SCOPE_PATH_TEXT = ENGINE_SCOPE_LIMITS.maxPathChars
const MAX_SCOPE_DESCRIPTION = ENGINE_SCOPE_LIMITS.maxDescriptionChars

interface ScopeState {
  oversized: boolean
  malformed: boolean
  unrecognizedInput: boolean
}

function boundedText(text: string, max: number, state: ScopeState): string {
  if (text.length <= max) return text
  state.oversized = true
  return text.slice(0, max)
}

/**
 * Bounded, sanitized scope snapshot for an interactive permission request —
 * what the operator sees on the approval card. Only recognized fields are
 * copied (never the raw params); strings are bounded and path lists capped.
 * The broker applies redaction and a hard payload bound on top.
 *
 * A value that exceeds a bound is marked `oversized` (and the policy denies
 * the request) instead of being silently truncated into something that looks
 * benign. Security decisions never run on the shortened text. Unknown nested
 * input is marked so the policy does not auto-allow an operation it cannot map.
 */
export function permissionScope(parts: {
  toolCall: Record<string, unknown> | null
  optionKinds: string[]
}): JsonValue {
  const scope: Record<string, JsonValue> = {}
  const state: ScopeState = { oversized: false, malformed: false, unrecognizedInput: false }
  const toolCall = parts.toolCall
  const paths: JsonValue[] = []
  const addPath = (value: unknown, maxChars = MAX_SCOPE_PATH_TEXT): void => {
    if (value === null || value === undefined) return
    if (typeof value !== 'string') {
      state.malformed = true
      return
    }
    if (value === '') return
    const bounded = boundedText(value, maxChars, state)
    if (!paths.includes(bounded)) {
      if (paths.length >= MAX_SCOPE_PATHS) state.oversized = true
      else paths.push(bounded)
    }
  }
  const addPathList = (value: unknown, allowRecords: boolean): void => {
    if (value === null || value === undefined) return
    if (!Array.isArray(value)) {
      state.malformed = true
      return
    }
    if (value.length > MAX_SCOPE_PATHS) state.oversized = true
    for (const entry of value) {
      if (typeof entry === 'string') {
        addPath(entry)
        continue
      }
      const record = allowRecords ? asRecord(entry) : null
      if (record === null || !('path' in record)) {
        state.malformed = true
        continue
      }
      addPath(record['path'])
    }
  }
  const copyInput = (input: Record<string, unknown>): void => {
    const setField = (field: string, value: JsonValue): void => {
      const existing = scope[field]
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(value)) {
        // Two spellings of the same action must not let the later one hide a
        // destructive/escaping first one; refuse to guess which is real.
        state.malformed = true
        return
      }
      scope[field] = value
    }
    for (const key of Object.keys(input)) {
      if (
        key !== 'command' &&
        key !== 'cmd' &&
        key !== 'argv' &&
        key !== 'path' &&
        key !== 'filePath' &&
        key !== 'file_path' &&
        key !== 'cwd' &&
        key !== 'paths' &&
        key !== 'locations'
      ) {
        state.unrecognizedInput = true
      }
    }
    for (const field of ['command', 'cmd'] as const) {
      const value = input[field]
      if (value === null || value === undefined) continue
      if (typeof value !== 'string') {
        state.malformed = true
        continue
      }
      if (value !== '') setField(field, boundedText(value, MAX_SCOPE_TEXT, state))
    }
    if (
      typeof scope['command'] === 'string' &&
      typeof scope['cmd'] === 'string' &&
      scope['command'] !== scope['cmd']
    ) {
      state.malformed = true
    }
    const argv = input['argv']
    if (argv !== null && argv !== undefined) {
      if (!Array.isArray(argv)) {
        state.malformed = true
      } else {
        if (argv.length > ENGINE_SCOPE_LIMITS.maxArgvEntries) state.oversized = true
        const boundedArgv = argv
          .filter((entry): entry is string => typeof entry === 'string')
          .slice(0, ENGINE_SCOPE_LIMITS.maxArgvEntries)
          .map((entry) => boundedText(entry, MAX_SCOPE_TEXT, state))
        if (boundedArgv.length !== Math.min(argv.length, ENGINE_SCOPE_LIMITS.maxArgvEntries)) {
          state.malformed = true
        }
        if (boundedArgv.length > 0) {
          if (boundedArgv.join(' ').length > MAX_SCOPE_TEXT) state.oversized = true
          setField('argv', boundedArgv)
        }
      }
    }
    for (const field of ['path', 'filePath', 'file_path', 'cwd'] as const) {
      const value = input[field]
      if (value === null || value === undefined) continue
      if (typeof value !== 'string') {
        state.malformed = true
        continue
      }
      if (value !== '') setField(field, boundedText(value, MAX_SCOPE_PATH_TEXT, state))
    }
    addPath(input['path'])
    addPath(input['filePath'])
    addPath(input['file_path'])
    addPathList(input['paths'], false)
    addPathList(input['locations'], true)
  }

  if (toolCall) {
    if (typeof toolCall['kind'] === 'string') {
      scope['toolKind'] = boundedText(toolCall['kind'], MAX_SCOPE_DESCRIPTION, state)
    }
    if (typeof toolCall['title'] === 'string') {
      scope['toolTitle'] = boundedText(toolCall['title'], MAX_SCOPE_DESCRIPTION, state)
    }
    if (toolCall['locations'] !== undefined) addPathList(toolCall['locations'], true)
    // ACP engines put the concrete action in `rawInput`/`input`. Copy only the
    // recognized command/path fields: never the raw payload (it may contain
    // secrets or unbounded model-controlled text).
    for (const key of ['rawInput', 'input'] as const) {
      const value = toolCall[key]
      if (value === null || value === undefined) continue
      const input = asRecord(value)
      if (!input) {
        state.malformed = true
        continue
      }
      copyInput(input)
    }
  }
  if (paths.length > 0) scope['paths'] = paths
  scope['optionKinds'] = parts.optionKinds.slice(0, MAX_SCOPE_PATHS)
  if (state.oversized) scope['oversized'] = true
  if (state.malformed) scope['malformed'] = true
  if (state.unrecognizedInput) scope['unrecognizedInput'] = true
  return scope
}
