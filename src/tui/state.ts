/**
 * Chat view state machine and pure engine event reducer (ADR-0012).
 * Accumulates streaming tokens, tool events, usage metrics, and finalizes turns.
 */

import type { EngineEvent } from '../engines/contract/types.ts'
import type { ToolActivityState } from './activity.ts'
import type { OrchestraInspectorData } from './orchestra.ts'
import type { ApprovalViewData } from './approval.ts'

export interface TranscriptBlock {
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error' | 'approval'
  text: string
  state?: 'streaming' | 'final' | 'interrupted' | 'failed'
  tool?: ToolActivityState
  approval?: ApprovalViewData
}

export interface ChatViewState {
  blocks: TranscriptBlock[]
  live: string
  busy: boolean
  toolExpanded: boolean
  inspectorOpen: boolean
  scrollOffset: number
  /** Accumulated tokens as reported; `costUsd` stays null until an engine reports one. */
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null
  approvalsPending: number
  pendingApprovalList: ApprovalViewData[]
  run: { id: string; state: string } | null
  orchestra: OrchestraInspectorData
  queue: string[]
}

export function initialViewState(opts?: { inspectorOpen?: boolean }): ChatViewState {
  return {
    blocks: [],
    live: '',
    busy: false,
    toolExpanded: false,
    inspectorOpen: opts?.inspectorOpen ?? false,
    scrollOffset: 0,
    usage: null,
    approvalsPending: 0,
    pendingApprovalList: [],
    run: null,
    orchestra: {
      muses: [],
      tasks: [],
      approvals: [],
      events: [],
    },
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
      const toolActivity: ToolActivityState = {
        id: ev.name,
        name: ev.name,
        summary: ev.summary ?? ev.name,
        status: ev.phase === 'start' ? 'running' : ev.isError ? 'failed' : 'succeeded',
      }
      return {
        ...s,
        blocks: [...s.blocks, { kind: 'tool', text: toolText, tool: toolActivity }],
      }
    }

    case 'usage': {
      const curIn = s.usage?.inputTokens ?? 0
      const curOut = s.usage?.outputTokens ?? 0
      // `costUsd` stays null until an engine reports one — never estimated.
      const curCost = s.usage?.costUsd ?? null
      const costUsd = ev.costUsd !== undefined ? (curCost ?? 0) + ev.costUsd : curCost
      return {
        ...s,
        usage: {
          inputTokens: curIn + (ev.inputTokens ?? 0),
          outputTokens: curOut + (ev.outputTokens ?? 0),
          costUsd,
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
