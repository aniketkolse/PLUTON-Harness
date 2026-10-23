import { ValidationError } from '../../domain/errors.ts'
import type { JsonValue } from '../../domain/models.ts'
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

const MAX_SCOPE_TEXT = 300
const MAX_SCOPE_PATHS = 10

function boundedText(text: string, max = MAX_SCOPE_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Bounded, sanitized scope snapshot for an interactive permission request —
 * what the operator sees on the approval card. Only recognized fields are
 * copied (never the raw params); strings are bounded and path lists capped.
 * The broker applies redaction and a hard payload bound on top.
 */
export function permissionScope(parts: {
  toolCall: Record<string, unknown> | null
  optionKinds: string[]
}): JsonValue {
  const scope: Record<string, JsonValue> = {}
  const toolCall = parts.toolCall
  if (toolCall) {
    if (typeof toolCall['kind'] === 'string') scope['toolKind'] = boundedText(toolCall['kind'])
    if (typeof toolCall['title'] === 'string') scope['toolTitle'] = boundedText(toolCall['title'])
    const locations = toolCall['locations']
    if (Array.isArray(locations)) {
      const paths: JsonValue[] = []
      for (const raw of locations.slice(0, MAX_SCOPE_PATHS)) {
        const location = asRecord(raw)
        const path = location && typeof location['path'] === 'string' ? location['path'] : null
        if (path !== null && path !== '') paths.push(boundedText(path))
      }
      if (paths.length > 0) scope['paths'] = paths
    }
  }
  scope['optionKinds'] = parts.optionKinds.slice(0, MAX_SCOPE_PATHS)
  return scope
}
