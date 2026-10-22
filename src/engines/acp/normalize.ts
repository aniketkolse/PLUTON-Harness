import type { EngineEvent } from '../contract/types.ts'

/**
 * Normalization of ACP `session/update` notifications into Pluton's engine
 * event vocabulary, plus prompt-result classification. Pure functions: the
 * shapes replayed here are the ones actually recorded from `opencode acp`
 * v2.0.29 on 2026-10-16 (`.pluton-tmp/acp-probe*.log`). Unknown update kinds
 * are ignored and counted — never guessed into a fabricated event.
 */

export interface NormalizedUpdate {
  /** Normalized events produced by this update (possibly empty). */
  events: EngineEvent[]
  /** The `sessionUpdate` discriminator as reported (null when absent). */
  kind: string | null
  /** True when the update produced no events (skipped or unknown kind). */
  ignored: boolean
}

export interface NormalizeContext {
  /** The model this Muse is pinned to; a model change is surfaced as an error. */
  pinnedModel?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function textOf(content: unknown): string | null {
  const c = asRecord(content)
  if (!c) return null
  if (c['type'] !== 'text') return null
  return typeof c['text'] === 'string' ? c['text'] : null
}

function modelOptionValue(configOptions: unknown): string | null {
  if (!Array.isArray(configOptions)) return null
  for (const raw of configOptions) {
    const opt = asRecord(raw)
    if (!opt) continue
    if (opt['id'] === 'model' || opt['category'] === 'model') {
      return typeof opt['currentValue'] === 'string' ? opt['currentValue'] : null
    }
  }
  return null
}

/**
 * Name for a tool event: explicit `_meta.toolName`, then `name`, then the human `title`
 * (opencode's update frames carry title but not name), then the `kind` category.
 */
function toolEventName(u: Record<string, unknown>): string {
  for (const key of ['name', 'title'] as const) {
    const value = u[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const meta = asRecord(u['_meta'])
  if (typeof meta?.['toolName'] === 'string' && meta['toolName'] !== '') {
    return meta['toolName']
  }
  if (typeof u['kind'] === 'string' && u['kind'] !== '') {
    return u['kind']
  }
  return 'tool'
}

function toolCallId(u: Record<string, unknown>): string | undefined {
  if (typeof u['toolCallId'] === 'string' && u['toolCallId'] !== '') return u['toolCallId']
  if (typeof u['id'] === 'string' && u['id'] !== '') return u['id']
  return undefined
}

function toolSummary(u: Record<string, unknown>, toolName: string): string | undefined {
  const title = typeof u['title'] === 'string' ? u['title'] : undefined
  const clean = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '')

  // If there's a specific path or target in rawInput/locations, prefer that over a generic title
  const rawInput = asRecord(u['rawInput'] ?? u['input'])
  if (rawInput) {
    if (typeof rawInput['file_path'] === 'string' && rawInput['file_path'] !== '') {
      return rawInput['file_path']
    }
    if (typeof rawInput['path'] === 'string' && rawInput['path'] !== '') {
      return rawInput['path']
    }
    if (typeof rawInput['command'] === 'string' && rawInput['command'] !== '') {
      return rawInput['command']
    }
    if (typeof rawInput['query'] === 'string' && rawInput['query'] !== '') {
      return rawInput['query']
    }
    if (typeof rawInput['goal'] === 'string' && rawInput['goal'] !== '') {
      return rawInput['goal']
    }
    if (typeof rawInput['runId'] === 'string' && rawInput['runId'] !== '') {
      return rawInput['runId']
    }
  }

  // Check locations
  if (Array.isArray(u['locations']) && u['locations'].length > 0) {
    const loc = asRecord(u['locations'][0])
    if (typeof loc?.['path'] === 'string' && loc['path'] !== '') {
      return loc['path']
    }
  }

  return title
}

function toolOutputText(u: Record<string, unknown>): string | undefined {
  if (typeof u['output'] === 'string' && u['output'] !== '') return u['output']
  if (Array.isArray(u['content'])) {
    const parts: string[] = []
    for (const item of u['content']) {
      const rec = asRecord(item)
      if (!rec) continue
      if (typeof rec['text'] === 'string') {
        parts.push(rec['text'])
      } else if (rec['type'] === 'content') {
        const inner = asRecord(rec['content'])
        if (typeof inner?.['text'] === 'string') {
          parts.push(inner['text'])
        }
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return undefined
}

export function normalizeSessionUpdate(update: unknown, ctx: NormalizeContext = {}): NormalizedUpdate {
  const u = asRecord(update)
  const kind = typeof u?.['sessionUpdate'] === 'string' ? (u['sessionUpdate'] as string) : null
  if (!u || kind === null) return { events: [], kind, ignored: true }

  switch (kind) {
    case 'agent_message_chunk': {
      const text = textOf(u['content'])
      if (text === null || text === '') return { events: [], kind, ignored: true }
      return { events: [{ kind: 'text', text }], kind, ignored: false }
    }
    case 'tool_call': {
      const name = toolEventName(u)
      const callId = toolCallId(u)
      const summary = toolSummary(u, name)
      const input = u['rawInput'] ?? u['input']
      const events: EngineEvent[] = [
        {
          kind: 'tool',
          name,
          phase: 'start',
          ...(callId ? { callId } : {}),
          ...(summary ? { summary } : {}),
          ...(input !== undefined ? { input } : {}),
        },
      ]
      // Some agents report the call already finished in the creation frame.
      if (u['status'] === 'completed' || u['status'] === 'failed') {
        const output = toolOutputText(u)
        events.push({
          kind: 'tool',
          name,
          phase: 'end',
          ...(callId ? { callId } : {}),
          ...(summary ? { summary } : {}),
          ...(output ? { output } : {}),
          isError: u['status'] === 'failed',
        })
      }
      return { events, kind, ignored: false }
    }
    case 'tool_call_update': {
      const status = u['status']
      if (status !== 'completed' && status !== 'failed') return { events: [], kind, ignored: true }
      const name = toolEventName(u)
      const callId = toolCallId(u)
      const summary = toolSummary(u, name)
      const output = toolOutputText(u)
      return {
        events: [
          {
            kind: 'tool',
            name,
            phase: 'end',
            ...(callId ? { callId } : {}),
            ...(summary ? { summary } : {}),
            ...(output ? { output } : {}),
            isError: status === 'failed',
          },
        ],
        kind,
        ignored: false,
      }
    }
    case 'usage_update': {
      const cost = asRecord(u['cost'])
      const costUsd =
        cost && cost['currency'] === 'USD' && typeof cost['amount'] === 'number'
          ? cost['amount']
          : undefined
      const event: EngineEvent = { kind: 'usage' }
      if (costUsd !== undefined) event.costUsd = costUsd
      // `used`/`size` are context-window figures, not prompt token counts —
      // they are deliberately not mapped onto inputTokens/outputTokens.
      return { events: [event], kind, ignored: false }
    }
    case 'config_option_update': {
      if (ctx.pinnedModel === undefined) return { events: [], kind, ignored: true }
      const now = modelOptionValue(u['configOptions'])
      if (now === null || now === ctx.pinnedModel) return { events: [], kind, ignored: true }
      return {
        events: [
          {
            kind: 'error',
            code: 'engine_model_changed',
            message: `engine changed the session model from '${ctx.pinnedModel}' to '${now}' during the turn; Pluton pins models per Muse and does not accept silent switches`,
          },
        ],
        kind,
        ignored: false,
      }
    }
    case 'agent_thought_chunk':
    case 'user_message_chunk':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'plan':
    case 'plan_update':
      return { events: [], kind, ignored: true }
    default:
      return { events: [], kind, ignored: true }
  }
}

export type PromptOutcome = 'success' | 'failure' | 'cancelled' | 'unknown'

export interface PromptResultSummary {
  outcome: PromptOutcome
  summary: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

/**
 * Map an ACP `session/prompt` result to a Pluton outcome. The ACP-defined
 * stop reasons are end_turn / max_tokens / max_turn_requests / refusal /
 * cancelled; anything unrecognised (including a missing stopReason) maps to
 * 'unknown' — a prompt must never be optimistically reported as success.
 */
export function summarizePromptResult(result: unknown): PromptResultSummary {
  const r = asRecord(result)
  const stopReason = typeof r?.['stopReason'] === 'string' ? (r['stopReason'] as string) : null
  const usageRecord = asRecord(r?.['usage'])
  const usage: PromptResultSummary['usage'] = {}
  if (usageRecord && typeof usageRecord['inputTokens'] === 'number') usage.inputTokens = usageRecord['inputTokens']
  if (usageRecord && typeof usageRecord['outputTokens'] === 'number') usage.outputTokens = usageRecord['outputTokens']
  const hasUsage = usage.inputTokens !== undefined || usage.outputTokens !== undefined

  let outcome: PromptOutcome
  switch (stopReason) {
    case 'end_turn':
      outcome = 'success'
      break
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
      outcome = 'failure'
      break
    case 'cancelled':
      outcome = 'cancelled'
      break
    default:
      outcome = 'unknown'
  }
  const summary =
    stopReason === null ? 'prompt result had no stopReason (unknown outcome)' : `stopReason: ${stopReason}`
  return hasUsage ? { outcome, summary, usage } : { outcome, summary }
}
