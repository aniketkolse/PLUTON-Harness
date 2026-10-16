/**
 * Chat view state machine and pure engine event reducer (ADR-0012).
 * Accumulates streaming tokens, tool events, usage metrics, and finalizes turns.
 */

import type { EngineEvent } from '../engines/contract/types.ts'

export interface TranscriptBlock {
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error' | 'approval'
  text: string
  state?: 'streaming' | 'final' | 'interrupted' | 'failed'
}

export interface ChatViewState {
  blocks: TranscriptBlock[]
  live: string
  busy: boolean
  toolExpanded: boolean
  usage: { inputTokens: number; outputTokens: number } | null
  approvalsPending: number
  run: { id: string; state: string } | null
  queue: string[]
}

export function initialViewState(): ChatViewState {
  return {
    blocks: [],
    live: '',
    busy: false,
    toolExpanded: false,
    usage: null,
    approvalsPending: 0,
    run: null,
    queue: [],
  }
}

export function beginTurn(s: ChatViewState, userText: string): ChatViewState {
  return {
    ...s,
    busy: true,
    live: '',
    blocks: [...s.blocks, { kind: 'user', text: userText }],
  }
}

export function applyEngineEvent(s: ChatViewState, ev: EngineEvent): ChatViewState {
  switch (ev.kind) {
    case 'text':
      return {
        ...s,
        live: s.live + ev.text,
      }

    case 'tool': {
      const icon = ev.phase === 'start' ? '▶' : ev.isError ? '✖' : '✔'
      const summary = ev.summary ? ` (${ev.summary})` : ''
      const toolText = `${icon} ${ev.name}${summary}`
      return {
        ...s,
        blocks: [...s.blocks, { kind: 'tool', text: toolText }],
      }
    }

    case 'usage': {
      const curIn = s.usage?.inputTokens ?? 0
      const curOut = s.usage?.outputTokens ?? 0
      return {
        ...s,
        usage: {
          inputTokens: curIn + (ev.inputTokens ?? 0),
          outputTokens: curOut + (ev.outputTokens ?? 0),
        },
      }
    }

    case 'error':
      return {
        ...s,
        blocks: [...s.blocks, { kind: 'error', text: `${ev.code}: ${ev.message}` }],
      }

    case 'approval_request':
      return {
        ...s,
        approvalsPending: s.approvalsPending + 1,
        blocks: [
          ...s.blocks,
          { kind: 'approval', text: `Approval requested: ${ev.description} [${ev.requestId}]` },
        ],
      }

    case 'status':
      return {
        ...s,
        busy: ev.status === 'busy' || ev.status === 'starting',
      }

    case 'result':
      return s
  }
}

export function endTurn(
  s: ChatViewState,
  opts: { interrupted: boolean; failed: boolean },
): { state: ChatViewState; assistantText: string; block: TranscriptBlock | null } {
  const assistantText = s.live
  if (!assistantText) {
    return {
      state: { ...s, busy: false, live: '' },
      assistantText: '',
      block: null,
    }
  }

  const blockState: TranscriptBlock['state'] = opts.interrupted
    ? 'interrupted'
    : opts.failed
      ? 'failed'
      : 'final'

  const block: TranscriptBlock = {
    kind: 'assistant',
    text: assistantText,
    state: blockState,
  }

  return {
    state: {
      ...s,
      busy: false,
      live: '',
      blocks: [...s.blocks, block],
    },
    assistantText,
    block,
  }
}
