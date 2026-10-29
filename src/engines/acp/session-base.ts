import { EngineProtocolError, isPlutonError } from '../../domain/errors.ts'
import { newId } from '../../domain/ids.ts'
import { AsyncQueue } from '../../util/async-queue.ts'
import type { EnginePermissionChannel } from '../interactive-approval.ts'
import type { AcpClient, AcpServerRequestResponse } from './client.ts'
import { normalizeSessionUpdate, summarizePromptResult, type PromptOutcome, type PromptResultSummary } from './normalize.ts'
import { ValidationError } from '../../domain/errors.ts'
import type { EngineEvent, EngineSession, EngineSessionInfo, PromptRequest } from '../contract/types.ts'

/**
 * Turn lifecycle shared by every ACP-speaking engine session.
 *
 * Behavior contract (verified against opencode v2.0.29):
 * - one prompt at a time; overlapping prompts are refused (per-Ship
 *   serialization is the runtime's job; the adapter refuses to interleave)
 * - `session/cancel` is a notification; a cancelled turn must end as
 *   'cancelled'/'unknown', never silently 'success'
 * - a prompt that times out and whose cancellation is not acknowledged taints
 *   the session: it is poisoned and refuses further prompts (state unknown)
 * - event buffer overflow aborts the turn and poisons the session
 * - updates outside an active turn (history replay on resume) are counted,
 *   not emitted
 *
 * Engine subclasses provide server-request handling (approvals), the close
 * strategy, and notification side effects.
 */

export interface AcpTurnSessionArgs {
  client: AcpClient
  nativeSessionId: string
  pinnedModel: string
  cancelGraceMs: number
  /**
   * Operator approval channel for engines running an interactive approval
   * policy. When the session is interrupted, closed or the run is cancelled,
   * pending permission waits are aborted fail-closed through it.
   */
  permissionChannel?: EnginePermissionChannel | null
}

interface TurnState {
  queue: AsyncQueue<EngineEvent>
  interrupted: boolean
  overflowed: boolean
  error: Error | null
  resultSummary: PromptResultSummary | null
  timedOut: boolean
}

export const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000
export const CANCEL_GRACE_MS = 10_000
export const TURN_EVENT_BUFFER = 8192

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function errorCodeOf(e: unknown): string {
  return isPlutonError(e) ? e.code : 'engine_protocol_error'
}

export abstract class AcpEngineSessionBase implements EngineSession {
  readonly info: EngineSessionInfo
  protected readonly client: AcpClient
  pinnedModel: string
  protected readonly nativeSessionId: string
  private busy = false
  private closed = false
  private poisoned: Error | null = null
  private activeTurn: TurnState | null = null
  private pendingInstructions: string | null = null
  private readonly cancelGraceMs: number
  /** Operator approval channel (interactive policies); may be null. */
  protected readonly permissionChannel: EnginePermissionChannel | null

  /** Diagnostics for tests/doctor (never part of the event stream). */
  ignoredUpdates = 0
  modelDriftSeen = false

  constructor(args: AcpTurnSessionArgs) {
    this.client = args.client
    this.nativeSessionId = args.nativeSessionId
    this.pinnedModel = args.pinnedModel
    this.cancelGraceMs = args.cancelGraceMs
    this.permissionChannel = args.permissionChannel ?? null
    this.info = {
      id: newId('session'),
      nativeSessionId: args.nativeSessionId,
      resumeToken: args.nativeSessionId,
    }
  }

  /** Prepend instructions to the first prompt of a fresh session only. */
  protected setPendingInstructions(instructions: string | null | undefined): void {
    this.pendingInstructions =
      instructions !== null && instructions !== undefined && instructions.trim() !== '' ? instructions : null
  }

  protected get isClosed(): boolean {
    return this.closed
  }

  /** Called by the adapter's client handlers (routed by sessionId). */
  handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return
    const p = asRecord(params)
    if (!p || p['sessionId'] !== this.nativeSessionId) return
    const normalized = normalizeSessionUpdate(p['update'], { pinnedModel: this.pinnedModel })
    for (const event of normalized.events) {
      if (event.kind === 'error' && event.code === 'engine_model_changed') this.modelDriftSeen = true
      this.emit(event)
    }
    if (normalized.ignored) this.ignoredUpdates += 1
    this.onNotificationHandled(method, params, normalized.ignored)
  }

  /** Engine-specific notification side effects (default: none). */
  protected onNotificationHandled(_method: string, _params: unknown, _ignored: boolean): void {}

  /** Server -> client requests. Return null for unsupported (client answers -32601). */
  abstract handleServerRequest(
    method: string,
    params: unknown,
  ): AcpServerRequestResponse | null | Promise<AcpServerRequestResponse | null>

  async *sendPrompt(req: PromptRequest): AsyncIterable<EngineEvent> {
    if (this.closed) throw new EngineProtocolError(`session ${this.info.id} is closed`)
    if (this.poisoned) throw this.poisoned
    if (this.busy) {
      throw new EngineProtocolError(
        `session ${this.info.id} already has an in-flight prompt; per-Ship serialization is the runtime's job and the adapter refuses to overlap turns`,
      )
    }
    if (typeof req.text !== 'string' || req.text.trim() === '') {
      throw new ValidationError('prompt text must be a non-empty string')
    }

    this.busy = true
    const queue = new AsyncQueue<EngineEvent>(TURN_EVENT_BUFFER)
    const turn: TurnState = {
      queue,
      interrupted: false,
      overflowed: false,
      error: null,
      resultSummary: null,
      timedOut: false,
    }
    this.activeTurn = turn

    const timeoutMs = req.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
    const promptParts: unknown[] = []
    if (this.pendingInstructions !== null) {
      promptParts.push({ type: 'text', text: this.pendingInstructions })
      this.pendingInstructions = null
    }
    promptParts.push({ type: 'text', text: req.text })

    const request = this.client.request(
      'session/prompt',
      { sessionId: this.nativeSessionId, prompt: promptParts },
      { timeoutMs: timeoutMs + 30_000 },
    )
    const requestSettled = request.then(
      () => 'settled' as const,
      () => 'settled' as const,
    )
    request.then(
      (result) => {
        const summary = summarizePromptResult(result)
        turn.resultSummary = summary
        if (summary.usage) queue.push({ kind: 'usage', ...summary.usage })
        queue.close()
      },
      (err: Error) => {
        turn.error = err
        queue.close()
      },
    )

    let adapterTimer: NodeJS.Timeout | null = null
    const timeoutSignal = new Promise<'timeout'>((resolve) => {
      adapterTimer = setTimeout(() => {
        turn.timedOut = true
        resolve('timeout')
      }, timeoutMs)
      adapterTimer.unref?.()
    })
    void Promise.race([requestSettled, timeoutSignal]).then(async (which) => {
      if (which !== 'timeout') return
      try {
        this.client.notify('session/cancel', { sessionId: this.nativeSessionId })
      } catch {
        // transport may already be dead; the stream will end as unknown below
      }
      const settled = await Promise.race([
        requestSettled,
        new Promise<'grace'>((resolve) => {
          const t = setTimeout(() => resolve('grace'), this.cancelGraceMs)
          t.unref?.()
        }),
      ])
      // The engine has processed (or ignored) session/cancel: the turn is over
      // either way, so any operator permission wait this turn opened is moot —
      // settle it fail-closed now instead of leaking it until the TTL.
      this.permissionChannel?.abort('prompt timed out')
      if (settled === 'settled') return
      turn.error = new EngineProtocolError(
        `prompt timed out after ${timeoutMs}ms and the engine did not acknowledge session/cancel within ${this.cancelGraceMs}ms; session state is unknown — close it and start a new one`,
        { details: { timeoutMs, cancelGraceMs: this.cancelGraceMs } },
      )
      queue.close()
    })

    yield { kind: 'status', status: 'busy' }

    try {
      for await (const event of queue) yield event
    } finally {
      if (adapterTimer) clearTimeout(adapterTimer)
      this.busy = false
      this.activeTurn = null
      // A dead transport can never deliver a permission answer: settle any
      // still-pending operator wait fail-closed instead of leaving an
      // actionable record the engine can no longer act on.
      if (this.client.isDead) this.permissionChannel?.abort('transport dead')
    }

    if (turn.overflowed) {
      const err = new EngineProtocolError(
        `engine produced more than ${TURN_EVENT_BUFFER} events for one prompt; turn aborted and session marked unknown`,
      )
      this.poisoned = err
      yield { kind: 'error', code: err.code, message: err.message }
      yield { kind: 'result', outcome: 'unknown', summary: 'event buffer overflow; session state unknown' }
      return
    }

    if (turn.resultSummary) {
      yield { kind: 'result', outcome: turn.resultSummary.outcome, summary: turn.resultSummary.summary }
      return
    }

    const err =
      turn.error ??
      new EngineProtocolError('prompt stream ended without a result from the engine', {
        details: { sessionId: this.nativeSessionId },
      })
    if (turn.timedOut) this.poisoned = err
    yield { kind: 'error', code: errorCodeOf(err), message: err.message }
    const outcome: PromptOutcome = 'unknown'
    yield {
      kind: 'result',
      outcome,
      summary: turn.timedOut ? 'prompt timed out; cancellation not acknowledged' : 'no result from engine; outcome unknown',
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn
    if (turn) turn.interrupted = true
    if (this.closed) return
    // Settle any pending operator permission wait fail-closed first: the
    // engine must never keep waiting on a question this session no longer
    // asks, and interrupt must not leave a decision dangling.
    this.permissionChannel?.abort('session interrupted')
    try {
      this.client.notify('session/cancel', { sessionId: this.nativeSessionId })
    } catch (err) {
      // If the transport is already gone the stream ends via the error path;
      // interrupt must not mask that with a second failure.
      if (!this.client.isDead) throw err
    }
  }

  /** Mark closed and release any active turn; subclasses handle engine cleanup. */
  protected markClosed(): void {
    if (this.closed) return
    this.closed = true
    // TUI/SPA disconnect, engine shutdown or run cancellation: every pending
    // permission wait settles deny and its record is expired (no orphans).
    this.permissionChannel?.abort('session closed')
    if (this.activeTurn) this.activeTurn.queue.close()
  }

  abstract close(): Promise<void>

  protected emit(event: EngineEvent): void {
    const turn = this.activeTurn
    if (!turn) {
      // Updates outside a turn are history replay / informational frames.
      this.ignoredUpdates += 1
      return
    }
    if (turn.queue.isClosed) {
      // The turn's result already settled the stream: frames the engine sends
      // after that are stale leftovers of its own drain, not a buffer
      // overflow, and must not poison an otherwise successful turn.
      this.ignoredUpdates += 1
      return
    }
    if (!turn.queue.push(event)) {
      turn.overflowed = true
      void this.interrupt()
    }
  }
}
