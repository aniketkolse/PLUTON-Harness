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
      // CS-5: `failed` carries the ONE deliberate reverse edge (failed → queued,
      // the manager's bounded revision requeue) — asserted exhaustively below.
      if (s === 'failed') continue
      expect(allowedTransitions(s)).toHaveLength(0)
      expect(isTerminal(s)).toBe(true)
    }
    for (const s of TASK_STATES) {
      if (!TERMINAL_TASK_STATES.has(s)) expect(isTerminal(s)).toBe(false)
    }
  })

  it('offers failed → queued for the manager’s bounded revision, and exactly that one door', () => {
    expect(canTransition('failed', 'queued')).toBe(true)
    // The revision door is exactly one edge wide: nothing else leaves `failed`…
    expect(allowedTransitions('failed')).toEqual(['queued'])
    expect(canTransition('failed', 'running')).toBe(false)
    expect(canTransition('failed', 'admitted')).toBe(false)
    expect(canTransition('failed', 'completed')).toBe(false)
    expect(() => assertTransition('failed', 'running')).toThrowError(StateTransitionError)
    // …and no other terminal state gains an exit.
    expect(canTransition('completed', 'queued')).toBe(false)
    expect(canTransition('cancelled', 'queued')).toBe(false)
    expect(canTransition('interrupted', 'queued')).toBe(false)
    expect(canTransition('unknown_outcome', 'queued')).toBe(false)
  })

  it('an interrupted run can become unknown_outcome, never completed', () => {
    expect(canTransition('running', 'unknown_outcome')).toBe(true)
    expect(canTransition('running', 'interrupted')).toBe(true)
    expect(canTransition('interrupted', 'completed')).toBe(false)
    expect(canTransition('unknown_outcome', 'completed')).toBe(false)
  })

  it('recovery edges: session-backed states requeue after a restart or terminalize honestly', () => {
    // A process that died cannot resume any engine session, so `queued` is the
    // only non-stranding recovery for the session-backed states.
    for (const from of ['admitted', 'waiting_for_children', 'needs_input', 'needs_approval'] as const) {
      expect(canTransition(from, 'queued')).toBe(true)
    }
    // An exhausted recovery must be able to record `unknown_outcome` — never
    // route into `completed`.
    for (const from of ['admitted', 'needs_input', 'needs_approval'] as const) {
      expect(canTransition(from, 'unknown_outcome')).toBe(true)
      expect(canTransition(from, 'completed')).toBe(false)
    }
    // Controls: the new edges open no path to a fabricated success.
    expect(canTransition('completed', 'queued')).toBe(false)
    expect(canTransition('queued', 'unknown_outcome')).toBe(false)
    expect(canTransition('interrupted', 'queued')).toBe(false)
  })

  it('isTaskState narrows strings', () => {
    expect(isTaskState('running')).toBe(true)
    expect(isTaskState('Running')).toBe(false)
    expect(isTaskState('nonsense')).toBe(false)
  })
})
