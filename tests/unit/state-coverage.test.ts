import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StateTransitionError } from '../../src/domain/errors.ts'
import * as state from '../../src/domain/state.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'

/**
 * R3 state coverage: no declared state vocabulary without a producer, an exit,
 * and a test that exercises it. The test derives the graph from the exported
 * transition functions (the same ones production uses), so the table cannot
 * drift from the checks.
 *
 * The vocabulary scan is a ratchet: a new `*_STATES` array export fails until
 * it is either covered by a checker below or removed. This is why the unused
 * engine-process vocabulary was deleted rather than kept "for later".
 */

const COVERED_VOCABULARIES = new Set(['TASK_STATES', 'RUN_STATES', 'SANDBOX_STATES'])

function declaredVocabularies(): string[] {
  return Object.entries(state)
    .filter(([name, value]) => name.endsWith('_STATES') && Array.isArray(value))
    .map(([name]) => name)
    .sort()
}

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-state-coverage-'))
  tmpDirs.push(dir)
  const db: DatabaseSync = openDatabase(join(dir, 'pluton.sqlite'))
  migrate(db)
  return new Store(db)
}

describe('state vocabulary inventory', () => {
  it('covers every exported state vocabulary (add a checker or delete the state)', () => {
    expect(declaredVocabularies()).toEqual([...COVERED_VOCABULARIES].sort())
  })
})

describe('task state machine', () => {
  const states = [...state.TASK_STATES]
  const edges = states.flatMap((from) => state.allowedTransitions(from).map((to) => [from, to] as const))
  const incoming = new Map<string, number>(states.map((s) => [s, 0]))
  for (const [, to] of edges) incoming.set(to, (incoming.get(to) ?? 0) + 1)

  it('declares each state once and recognizes it', () => {
    expect(new Set(states).size).toBe(states.length)
    for (const s of states) expect(state.isTaskState(s)).toBe(true)
    expect(state.isTaskState('not_a_state')).toBe(false)
  })

  it('only transitions to declared states', () => {
    for (const [, to] of edges) expect(states).toContain(to)
  })

  it('gives every non-initial state an incoming edge and every non-terminal state an exit', () => {
    expect(incoming.get('created')).toBe(0)
    for (const s of states) {
      if (s !== 'created') expect(incoming.get(s), `'${s}' has no incoming edge`).toBeGreaterThan(0)
      if (!state.TERMINAL_TASK_STATES.has(s)) {
        expect(state.allowedTransitions(s).length, `non-terminal '${s}' has no outgoing edge`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps terminal states frozen except the one documented revision edge', () => {
    const terminalWithNoExit = states.filter(
      (s) => state.TERMINAL_TASK_STATES.has(s) && state.allowedTransitions(s).length === 0,
    )
    expect(new Set(terminalWithNoExit)).toEqual(
      new Set([...state.TERMINAL_TASK_STATES].filter((s) => s !== 'failed')),
    )

    const terminalExits = edges.filter(([from]) => state.TERMINAL_TASK_STATES.has(from))
    expect(terminalExits).toEqual([['failed', 'queued']])
    expect(state.canTransition('failed', 'queued')).toBe(true)
    for (const other of state.TERMINAL_TASK_STATES) {
      if (other !== 'failed') expect(state.allowedTransitions(other)).toEqual([])
    }
  })

  it('keeps the session-backed subset non-terminal and inside the vocabulary', () => {
    for (const s of state.SESSION_BACKED_TASK_STATES) {
      expect(states).toContain(s)
      expect(state.TERMINAL_TASK_STATES.has(s)).toBe(false)
    }
  })

  it('rejects transitions outside the table with a typed error', () => {
    expect(() => state.assertTransition('completed', 'running')).toThrow(StateTransitionError)
    expect(() => state.assertTransition('created', 'completed')).toThrow(StateTransitionError)
    expect(() => state.assertTransition('queued', 'admitted')).not.toThrow()
  })
})

describe('run state machine', () => {
  const states = [...state.RUN_STATES]
  const edges = states.flatMap((from) =>
    states.filter((to) => state.canRunTransition(from, to)).map((to) => [from, to] as const),
  )
  const incoming = new Map<string, number>(states.map((s) => [s, 0]))
  for (const [, to] of edges) incoming.set(to, (incoming.get(to) ?? 0) + 1)

  it('declares each state once and recognizes it', () => {
    expect(new Set(states).size).toBe(states.length)
    for (const s of states) expect(state.isRunState(s)).toBe(true)
    expect(state.isRunState('not_a_state')).toBe(false)
  })

  it('only transitions to declared states', () => {
    for (const [, to] of edges) expect(states).toContain(to)
  })

  it('gives every non-initial state an incoming edge and every non-terminal state an exit', () => {
    expect(incoming.get('created')).toBe(0)
    for (const s of states) {
      if (s !== 'created') expect(incoming.get(s), `'${s}' has no incoming edge`).toBeGreaterThan(0)
      if (!state.isTerminalRunState(s)) {
        expect(edges.some(([from]) => from === s), `non-terminal '${s}' has no outgoing edge`).toBe(true)
      }
    }
  })

  it('matches the terminal predicate to the states with no exit', () => {
    const noExit = states.filter((from) => !edges.some(([candidate]) => candidate === from))
    expect(new Set(noExit)).toEqual(new Set(states.filter((s) => state.isTerminalRunState(s))))
    for (const s of states) {
      expect(state.isTerminalRunState(s)).toBe(!edges.some(([from]) => from === s))
    }
  })
})

describe('sandbox state vocabulary', () => {
  it('can enter and leave every declared sandbox state through the store', () => {
    const store = freshStore()
    try {
      const project = store.ensureProject({
        name: 'state-coverage',
        rootPath: join(tmpdir(), 'pluton-state-coverage-project'),
        configPath: join(tmpdir(), 'pluton-state-coverage-project', 'pluton.yaml'),
        defaultBranch: 'main',
      })
      const sandbox = store.upsertSandbox({
        projectId: project.id,
        shipId: 'worker-a',
        kind: 'local-process',
        containerName: null,
        containerId: null,
        image: null,
        state: 'absent',
        createdBy: 'state-coverage-test',
      })

      for (const declared of state.SANDBOX_STATES) {
        const entered = store.setSandboxState(sandbox.id, declared)
        expect(entered.state).toBe(declared)
        expect(store.getSandbox(sandbox.id).state).toBe(declared)

        // Leave the state again: no sandbox state is a trap. The store keeps
        // no transition table (a sandbox can be recreated after any failure),
        // so "leavable" means a different declared state is accepted.
        const next = declared === 'absent' ? 'stopped' : 'absent'
        const left = store.setSandboxState(sandbox.id, next)
        expect(left.state).toBe(next)
        expect(store.getSandbox(sandbox.id).state).toBe(next)
      }
    } finally {
      store.close()
    }
  })
})
