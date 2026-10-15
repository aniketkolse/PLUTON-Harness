import { describe, expect, it } from 'vitest'
import { isId, newId, shortId, slugify } from '../../src/domain/ids.ts'
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  isTerminal,
  isTaskState,
  TASK_STATES,
  TERMINAL_TASK_STATES,
} from '../../src/domain/state.ts'
import { StateTransitionError } from '../../src/domain/errors.ts'

describe('ids', () => {
  it('generates unique, well-formed ids per prefix', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const id = newId('task')
      expect(isId(id)).toBe(true)
      expect(id.startsWith('task_')).toBe(true)
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  })

  it('shortId returns the tail for display', () => {
    const id = 'task_abc123def45678'
    expect(shortId(id)).toHaveLength(6)
    expect(id.endsWith(shortId(id))).toBe(true)
  })

  it('slugify is strict and never returns empty', () => {
    expect(slugify('Worker A')).toBe('worker-a')
    expect(slugify('  ###  ')).toBe('unnamed')
    expect(slugify('../../etc/passwd')).toBe('etc-passwd')
    expect(slugify('a'.repeat(200))).toHaveLength(48)
    // no path separators, no shell metacharacters, ever
    const s = slugify('x/../y;rm -rf z$(oops)`tick`')
    expect(s).toMatch(/^[a-z0-9-]+$/)
  })
})

describe('task state machine', () => {
  it('exposes a transition row for every state', () => {
    for (const s of TASK_STATES) expect(allowedTransitions(s)).toBeDefined()
  })

  it('happy path transitions are allowed', () => {
    const path = [
      ['created', 'queued'],
      ['queued', 'admitted'],
      ['admitted', 'running'],
      ['running', 'waiting_for_children'],
      ['waiting_for_children', 'running'],
      ['running', 'verifying'],
      ['verifying', 'completed'],
    ] as const
    for (const [from, to] of path) expect(canTransition(from, to)).toBe(true)
  })

  it('rejects invalid transitions with a coded error', () => {
    expect(canTransition('completed', 'running')).toBe(false)
    expect(canTransition('cancelled', 'queued')).toBe(false)
    expect(canTransition('created', 'running')).toBe(false)
    expect(canTransition('queued', 'completed')).toBe(false)
    expect(() => assertTransition('completed', 'running')).toThrowError(StateTransitionError)
  })

  it('terminal states have no outgoing transitions and cannot be re-entered', () => {
    for (const s of TERMINAL_TASK_STATES) {
      expect(allowedTransitions(s)).toHaveLength(0)
      expect(isTerminal(s)).toBe(true)
    }
    for (const s of TASK_STATES) {
      if (!TERMINAL_TASK_STATES.has(s)) expect(isTerminal(s)).toBe(false)
    }
  })

  it('an interrupted run can become unknown_outcome, never completed', () => {
    expect(canTransition('running', 'unknown_outcome')).toBe(true)
    expect(canTransition('running', 'interrupted')).toBe(true)
    expect(canTransition('interrupted', 'completed')).toBe(false)
    expect(canTransition('unknown_outcome', 'completed')).toBe(false)
  })

  it('isTaskState narrows strings', () => {
    expect(isTaskState('running')).toBe(true)
    expect(isTaskState('Running')).toBe(false)
    expect(isTaskState('nonsense')).toBe(false)
  })
})
