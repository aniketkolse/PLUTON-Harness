import { describe, expect, it } from 'vitest'
import {
  applyEngineEvent,
  beginTurn,
  endTurn,
  initialViewState,
} from '../../src/tui/state.ts'

describe('chat view state reducer', () => {
  it('begins turn by recording user block and resetting live/busy', () => {
    let s = initialViewState()
    s = beginTurn(s, 'hello world')
    expect(s.busy).toBe(true)
    expect(s.live).toBe('')
    expect(s.blocks).toEqual([{ kind: 'user', text: 'hello world' }])
  })

  it('accumulates streaming text into live', () => {
    let s = initialViewState()
    s = beginTurn(s, 'hi')
    s = applyEngineEvent(s, { kind: 'text', text: 'Hel' })
    s = applyEngineEvent(s, { kind: 'text', text: 'lo!' })
    expect(s.live).toBe('Hello!')
    expect(s.blocks.length).toBe(1) // only user block so far
  })

  it('appends tool events as blocks', () => {
    let s = initialViewState()
    s = applyEngineEvent(s, { kind: 'tool', name: 'project.status', phase: 'start' })
    expect(s.blocks.length).toBe(1)
    expect(s.blocks[0]!.kind).toBe('tool')
    expect(s.blocks[0]!.text).toContain('project.status')

    s = applyEngineEvent(s, {
      kind: 'tool',
      name: 'project.status',
      phase: 'end',
      summary: 'clean',
    })
    expect(s.blocks.length).toBe(2)
    expect(s.blocks[1]!.kind).toBe('tool')
    expect(s.blocks[1]!.text).toContain('clean')
  })

  it('accumulates usage tokens', () => {
    let s = initialViewState()
    s = applyEngineEvent(s, { kind: 'usage', inputTokens: 100, outputTokens: 50 })
    expect(s.usage).toEqual({ inputTokens: 100, outputTokens: 50 })

    s = applyEngineEvent(s, { kind: 'usage', inputTokens: 50, outputTokens: 25 })
    expect(s.usage).toEqual({ inputTokens: 150, outputTokens: 75 })
  })

  it('handles error and approval_request events', () => {
    let s = initialViewState()
    s = applyEngineEvent(s, { kind: 'error', code: 'timeout', message: 'connection dropped' })
    expect(s.blocks).toEqual([{ kind: 'error', text: 'timeout: connection dropped' }])

    s = applyEngineEvent(s, {
      kind: 'approval_request',
      requestId: 'app_1',
      description: 'Run arbitrary bash command',
    })
    expect(s.approvalsPending).toBe(1)
    expect(s.blocks[1]!.kind).toBe('approval')
    expect(s.blocks[1]!.text).toContain('app_1')
  })

  it('finalizes assistant turn with endTurn', () => {
    let s = initialViewState()
    s = beginTurn(s, 'ask')
    s = applyEngineEvent(s, { kind: 'text', text: 'answer' })

    const res = endTurn(s, { interrupted: false, failed: false })
    expect(res.assistantText).toBe('answer')
    expect(res.block).toEqual({ kind: 'assistant', text: 'answer', state: 'final' })
    expect(res.state.busy).toBe(false)
    expect(res.state.live).toBe('')
    expect(res.state.blocks.length).toBe(2)
    expect(res.state.blocks[1]).toEqual(res.block)
  })

  it('marks assistant block as interrupted or failed when specified in endTurn', () => {
    let s = initialViewState()
    s = beginTurn(s, 'ask')
    s = applyEngineEvent(s, { kind: 'text', text: 'partial...' })

    const resInt = endTurn(s, { interrupted: true, failed: false })
    expect(resInt.block?.state).toBe('interrupted')

    const resFail = endTurn(s, { interrupted: false, failed: true })
    expect(resFail.block?.state).toBe('failed')
  })
})
