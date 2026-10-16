import { ValidationError } from '../../domain/errors.ts'
import type { McpServerSpec } from '../contract/types.ts'

/**
 * Shared pure helpers for engines that speak ACP (Agent Client Protocol).
 *
 * `configOptions` shapes were recorded live from both engines (2026-10-16):
 * `opencode acp` v2.0.29 and `qwen --acp` (Qwen Code v0.25.2) both return a
 * select option `{id, name, category, type:'select', currentValue, options:
 * [{value, name, description}]}` for `model`; qwen additionally exposes `mode`.
 * Choice values are engine-native strings (for qwen they are composite runtime
 * ids like `$runtime|openai|cbai/glm-5.2(openai)`) and must be used verbatim.
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

/** The `model` select option (matched by id or category, as both engines report it). */
export function readModelOption(configOptions: unknown): AcpSelectOption | null {
  return readConfigOption(configOptions, (opt) => opt['id'] === 'model' || opt['category'] === 'model')
}

/** The `mode`/approval select option (qwen reports id/category `mode`). */
export function readModeOption(configOptions: unknown): AcpSelectOption | null {
  return readConfigOption(configOptions, (opt) => opt['id'] === 'mode' || opt['category'] === 'mode')
}

/**
 * Find the engine choice for a model the user wrote down. Accepts either the
 * exact option value or its display name (Qwen Code labels choices with the
 * bare model id while values are composite runtime ids).
 */
export function matchModelChoice(option: AcpSelectOption, want: string): AcpOptionChoice | null {
  return option.choices.find((c) => c.value === want) ?? option.choices.find((c) => c.name === want) ?? null
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
      "muse.model must be a non-empty engine model id (e.g. 'opencode/deepseek-v4.1-flash-free' or 'cbai/glm-5.2')",
    )
  }
}
