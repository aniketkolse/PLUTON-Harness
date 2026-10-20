import { describe, expect, it } from 'vitest'
import type { AcpClient } from '../../src/engines/acp/client.ts'
import {
  AcpEngineSessionBase,
  TURN_EVENT_BUFFER,
  type AcpTurnSessionArgs,
} from '../../src/engines/acp/session-base.ts'
import type { EngineEvent } from '../../src/engines/contract/types.ts'

/**
 * Turn-lifecycle pins (post-P1 hardening): a queue that closed because the
 * turn's result already settled the stream is NOT a buffer overflow — late
 * engine frames are stale protocol leftovers and must not poison an otherwise
 * successful turn. A queue that is genuinely full still aborts the turn.
 */

class TestSession extends AcpEngineSessionBase {
  constructor(args: AcpTurnSessionArgs) {
    super(args)
  }

  handleServerRequest(): null {
    return null
  }

  async close(): Promise<void> {
    this.markClosed()
  }

  /** Test seam for the protected emit path (adapter notification handlers). */
  feed(event: EngineEvent): void {
    this.emit(event)
  }
}

interface StubSession {
  session: TestSession
  resolvePrompt: (result: unknown) => void
  notices: string[]
}

function makeStubSession(): StubSession {
  let resolvePrompt!: (result: unknown) => void
  const promptResult = new Promise<unknown>((resolve) => {
    resolvePrompt = resolve
  })
  const notices: string[] = []
  const client = {
    request: () => promptResult,
    notify: (method: string) => {
      notices.push(method)
    },
    isDead: false,
  } as unknown as AcpClient
  const session = new TestSession({
    client,
    nativeSessionId: 'sess_turn_test',
    pinnedModel: 'mock/model-a',
    cancelGraceMs: 5,
  })
  return { session, resolvePrompt, notices }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function drain(iter: AsyncIterator<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for (;;) {
    const next = await iter.next()
    if (next.done === true) break
    events.push(next.value)
  }
  return events
}

describe('AcpEngineSessionBase turn lifecycle', () => {
  it('ignores frames that arrive after the turn result closed the stream (no overflow poisoning)', async () => {
    const { session, resolvePrompt } = makeStubSession()
    const iter = session.sendPrompt({ text: 'go', timeoutMs: 60_000 })[Symbol.asyncIterator]()

    const first = await iter.next()
    expect(first.value).toEqual({ kind: 'status', status: 'busy' })

    // The engine answers the prompt: the result closes the turn's queue while
    // the consumer is still (deliberately) paused mid-turn — exactly the window
    // in which engines send trailing session/update frames.
    resolvePrompt({ stopReason: 'end_turn' })
    await tick()
    expect(session.ignoredUpdates).toBe(0)

    session.feed({ kind: 'text', text: 'late frame after the result' })

    // The stale frame is dropped (counted as ignored), never overflow.
    expect(session.ignoredUpdates).toBe(1)

    const rest = await drain(iter)
    expect(rest).toEqual([{ kind: 'result', outcome: 'success', summary: 'stopReason: end_turn' }])
    expect(rest.some((event) => event.kind === 'error')).toBe(false)
  })

  it('still aborts and poisons the session when the event buffer genuinely overflows', async () => {
    const { session, resolvePrompt, notices } = makeStubSession()
    const iter = session.sendPrompt({ text: 'go', timeoutMs: 60_000 })[Symbol.asyncIterator]()
    await iter.next() // busy; the prompt request stays unanswered on purpose

    for (let i = 0; i < TURN_EVENT_BUFFER; i++) session.feed({ kind: 'text', text: `event-${String(i)}` })
    expect(session.ignoredUpdates).toBe(0)
    session.feed({ kind: 'text', text: 'one too many' }) // full and still open → genuine overflow

    await tick()
    // The overflow interrupts the engine (cancel notification), as before.
    expect(notices).toContain('session/cancel')

    resolvePrompt({ stopReason: 'end_turn' })
    await tick()
    const rest = await drain(iter)

    expect(rest.filter((event) => event.kind === 'text')).toHaveLength(TURN_EVENT_BUFFER)
    expect(rest.at(-2)).toMatchObject({ kind: 'error' })
    expect((rest.at(-2) as { message: string }).message).toContain(`more than ${String(TURN_EVENT_BUFFER)} events`)
    expect(rest.at(-1)).toMatchObject({
      kind: 'result',
      outcome: 'unknown',
      summary: 'event buffer overflow; session state unknown',
    })

    // The poisoned session refuses further prompts (state unknown).
    const again = session.sendPrompt({ text: 'again' })
    await expect(drain(again[Symbol.asyncIterator]())).rejects.toThrow(/more than .* events/)
  })
})
