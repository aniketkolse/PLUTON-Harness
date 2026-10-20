import type { ApprovalRecord, ApprovalStatus, JsonValue } from '../domain/models.ts'
import type { Store, SupervisorFence } from '../store/store.ts'
import { redactDeep } from '../util/redact.ts'
import { stripControlChars, stripControlDeep } from '../util/sanitize.ts'

/**
 * Interactive engine-approval bridge (ADR-0016): connects an engine's ACP
 * `session/request_permission` wait to Pluton's existing durable approval
 * lifecycle (the same store, decision funnel and UI surfaces the tool-bridge
 * approvals use — there is no second approval system).
 *
 * Safety contract:
 * - A request is only ever answered `allow` when the operator approved the
 *   durable record for that exact request (or the record is already approved
 *   when the waiter settles). Everything else — timeout, session teardown,
 *   store failure, unknown or stale ids — resolves `deny`.
 * - Correlated one-to-one: each request creates one approval row and one
 *   in-process waiter keyed by that id; a decision settles exactly one waiter
 *   and a duplicate/late decision is a no-op.
 * - `abort()` (run cancellation, engine shutdown, TUI/SPA disconnect) settles
 *   every pending request fail-closed — always `deny`, never a grant, even when
 *   another process recorded an approval for the same record in the same
 *   window (a cancelled turn must not proceed) — and expires the records so
 *   operator surfaces stop presenting them as actionable. The durable record
 *   itself stays truthful: a recorded approval remains approved.
 * - The wait is bounded: the approval TTL (config `approval_timeout_minutes`,
 *   0 = never expires) drives an expiry timer, and a bounded poll backstop
 *   observes decisions recorded by other processes through the shared SQLite
 *   store. Timers are always released when the request settles.
 */

export type EnginePermissionDecision = 'allow' | 'deny'

export interface EnginePermissionRequest {
  /** Engine-native request/tool-call id when the engine provides one (opaque). */
  requestId: string | null
  /** Short sanitized description of what the engine wants to do. */
  description: string
  /** Bounded, sanitized JSON snapshot (tool, option kinds, path hints). */
  scope: JsonValue
}

/**
 * What an engine session consults for permission requests it cannot answer
 * from its static policy. Implementations must settle exactly once and must
 * never reject: transport failures are answered as `deny` (fail closed).
 */
export interface EnginePermissionChannel {
  requestPermission(req: EnginePermissionRequest): Promise<EnginePermissionDecision>
  /**
   * Session teardown: settle every pending request fail-closed — always
   * `deny`, never a grant, even when the record was approved elsewhere in the
   * same window. Idempotent.
   */
  abort(reason: string): void
}

/** Why a waiter settled — UI broadcasters only need the non-decision outcomes. */
export type EngineApprovalSettlement = 'decision' | 'expiry' | 'abort'

/** Injectable timers so tests never sleep. */
export interface EngineApprovalTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

export interface EngineApprovalChannelOptions {
  store: Store
  projectId: string
  runId: string | null
  taskId: string | null
  museId: string | null
  /** runtime.approval_timeout_minutes; 0 = the record never expires. */
  ttlMinutes?: number
  now?: () => number
  /** Cross-process decision backstop cadence; 0 disables it. */
  pollIntervalMs?: number
  /** Per-session cap on concurrently pending requests (default 3). */
  maxPendingRequests?: number
  timers?: EngineApprovalTimers
  /** Called once when the durable pending record is created (UI surfaces). */
  onRequested?: (approval: ApprovalRecord) => void
  /** Called once when the wait settles, with the final record. */
  onSettled?: (approval: ApprovalRecord, settlement: EngineApprovalSettlement) => void
  /**
   * Run-ownership proof (supervisor duty path). When present, the channel's
   * `createApproval` and `approval.requested` append are fence-gated: a stale
   * owner's request fails closed to `deny` and never mints a row (the caller's
   * try/catch turns the `OwnershipLostError` into the fail-closed answer).
   */
  fence?: SupervisorFence
}

export const ENGINE_PERMISSION_ACTION = 'engine.permission'
export const DEFAULT_ENGINE_APPROVAL_TTL_MINUTES = 60
export const DEFAULT_ENGINE_APPROVAL_POLL_MS = 1_500
/**
 * Conservative per-session cap on concurrently open engine requests (matches
 * the tool-bridge approval cap). Past the cap the channel answers fail-closed
 * without creating a record, waiter or timer.
 */
export const DEFAULT_ENGINE_APPROVAL_MAX_PENDING = 3
const MAX_REASON_CHARS = 500
const MAX_SCOPE_CHARS = 2_000

const defaultTimers: EngineApprovalTimers = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const timer = setInterval(fn, ms)
    timer.unref?.()
    return timer
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
}

interface ApprovalWaiter {
  /** Exactly once: returns true only for the call that settled the waiter. */
  settle(status: ApprovalStatus, settlement: EngineApprovalSettlement): boolean
}

/**
 * In-process waiters, keyed by the durable approval id. The decision funnel
 * (`decideApproval`) and the expiry sweep call {@link settleApprovalWaiter};
 * decisions recorded by another process are picked up by the poll backstop.
 */
const waiters = new Map<string, ApprovalWaiter>()

/** Notify the waiting engine request (if any) for an approval. Exactly once. */
export function settleApprovalWaiter(
  approvalId: string,
  status: ApprovalStatus,
  settlement: EngineApprovalSettlement = 'decision',
): boolean {
  const waiter = waiters.get(approvalId)
  if (!waiter) return false
  return waiter.settle(status, settlement)
}

/** Number of engine requests currently waiting (diagnostics/tests). */
export function pendingApprovalWaiterCount(): number {
  return waiters.size
}

function readApproval(store: Store, id: string): ApprovalRecord | null {
  try {
    return store.getApprovalOrNull(id)
  } catch {
    return null
  }
}

/** One line, bounded — the reason is operator-facing text, never a payload. */
function boundedReason(text: string): string {
  const collapsed = stripControlChars(text).replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return 'engine permission request'
  return collapsed.length <= MAX_REASON_CHARS ? collapsed : `${collapsed.slice(0, MAX_REASON_CHARS - 1)}…`
}

/**
 * Redact (key-based), strip terminal control bytes, then bound the scope so
 * the operator card stays renderable and no stored string can drive the
 * operator's terminal. The redaction is a hygiene filter, not a guarantee:
 * values under unprefixed keys remain operator-visible text. Correlation
 * fields always win over engine-provided ones.
 */
function boundedScope(requestId: string | null, scope: JsonValue): JsonValue {
  const raw: JsonValue =
    scope !== null && typeof scope === 'object' && !Array.isArray(scope)
      ? { ...(scope as Record<string, JsonValue>), source: 'engine', engineRequestId: requestId }
      : { detail: scope, source: 'engine', engineRequestId: requestId }
  let redacted: JsonValue
  try {
    redacted = stripControlDeep(redactDeep(raw))
  } catch {
    redacted = { source: 'engine', engineRequestId: requestId, note: 'scope rejected' }
  }
  let json: string
  try {
    json = JSON.stringify(redacted)
  } catch {
    json = ''
  }
  if (json.length <= MAX_SCOPE_CHARS) return redacted
  return {
    source: 'engine',
    engineRequestId: requestId,
    truncated: true,
    excerpt: json.slice(0, MAX_SCOPE_CHARS),
  }
}

export function createEngineApprovalChannel(opts: EngineApprovalChannelOptions): EnginePermissionChannel {
  const store = opts.store
  const nowFn = opts.now ?? Date.now
  const timers = opts.timers ?? defaultTimers
  const ttlMinutes = opts.ttlMinutes ?? DEFAULT_ENGINE_APPROVAL_TTL_MINUTES
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_ENGINE_APPROVAL_POLL_MS
  const maxPending = opts.maxPendingRequests ?? DEFAULT_ENGINE_APPROVAL_MAX_PENDING
  /** Ids this channel created and has not settled yet (abort scope). */
  const pendingIds = new Set<string>()

  async function requestPermission(req: EnginePermissionRequest): Promise<EnginePermissionDecision> {
    if (pendingIds.size >= maxPending) {
      // Too many open questions for this session already: refuse fail-closed
      // instead of minting another actionable record. No record, waiter or
      // timer is created for a request Pluton will not ask. The check and the
      // pendingIds.add below run in one synchronous span (no await between),
      // so concurrent callers cannot race past the cap.
      return 'deny'
    }
    let approval: ApprovalRecord
    try {
      approval = store.createApproval(
        {
          projectId: opts.projectId,
          runId: opts.runId,
          taskId: opts.taskId,
          requestedByMuseId: opts.museId,
          action: ENGINE_PERMISSION_ACTION,
          reason: boundedReason(req.description),
          scope: boundedScope(req.requestId, req.scope),
          expiresAt: ttlMinutes > 0 ? new Date(nowFn() + ttlMinutes * 60_000).toISOString() : null,
        },
        opts.fence,
      )
      store.appendEvent(
        {
          projectId: opts.projectId,
          runId: opts.runId,
          taskId: opts.taskId,
          museId: opts.museId,
          type: 'approval.requested',
          payload: { approvalId: approval.id, action: approval.action, source: 'engine' },
        },
        opts.fence,
      )
    } catch {
      // No durable record → no authorization. Fail closed, never throw at the
      // engine: an unanswered ACP request would hang the agent. A missed fence
      // (a superseded owner) lands here too — a stale channel must never mint
      // an approval.
      return 'deny'
    }
    try {
      opts.onRequested?.(approval)
    } catch {
      // UI listeners must never break the engine's wait.
    }

    return await new Promise<EnginePermissionDecision>((resolve) => {
      const id = approval.id
      let done = false
      let expiryHandle: unknown = null
      let pollHandle: unknown = null

      const finish = (status: ApprovalStatus, settlement: EngineApprovalSettlement): void => {
        if (done) return
        done = true
        // Detach from the registries before timer cleanup: a throwing injected
        // timer seam must never strand a settled-but-unresolved waiter (the
        // engine would hang forever on an unanswered request).
        waiters.delete(id)
        pendingIds.delete(id)
        try {
          if (expiryHandle !== null) timers.clearTimeout(expiryHandle)
        } catch {
          // injected timer seam; the wait is already settled
        }
        try {
          if (pollHandle !== null) timers.clearInterval(pollHandle)
        } catch {
          // injected timer seam; the wait is already settled
        }
        let record: ApprovalRecord
        try {
          record = store.getApproval(id)
        } catch {
          // Store already closed (run teardown): report the last known record.
          record = { ...approval, status }
        }
        try {
          opts.onSettled?.(record, settlement)
        } catch {
          // Listeners must never break settlement.
        }
        // A cancelled/interrupted turn never receives a grant, even when the
        // record was approved concurrently elsewhere; every other settlement
        // resolves allow only from a durable `approved` status.
        resolve(settlement !== 'abort' && status === 'approved' ? 'allow' : 'deny')
      }

      const waiter: ApprovalWaiter = {
        settle: (status, settlement) => {
          if (done) return false
          finish(status, settlement)
          return true
        },
      }
      waiters.set(id, waiter)
      pendingIds.add(id)

      // Expiry: bounded wait, fail closed, and stop presenting the record as
      // actionable. `0` minutes means the operator chose "never expires" — the
      // session/prompt timeout still bounds the wait via session abort.
      const ttlMs = approval.expiresAt !== null ? Math.max(0, Date.parse(approval.expiresAt) - nowFn()) : 0
      if (ttlMs > 0) {
        expiryHandle = timers.setTimeout(() => {
          if (done) return
          try {
            store.setApprovalStatus(id, 'expired', { decidedBy: 'pluton:timeout' })
            // Same terminal durable event the abort and sweep paths append (B1):
            // an event-log consumer must see why this request closed.
            store.appendEvent({
              projectId: opts.projectId,
              runId: opts.runId,
              taskId: opts.taskId,
              museId: opts.museId,
              type: 'approval.expired',
              payload: { approvalId: id, action: ENGINE_PERMISSION_ACTION, reason: 'timeout' },
            })
            finish('expired', 'expiry')
          } catch {
            // Decided between the check and the write (or store failure):
            // settle from the persisted truth; unknown state fails closed.
            const current = readApproval(store, id)
            if (current !== null && current.status !== 'pending') {
              finish(current.status, current.status === 'expired' ? 'expiry' : 'decision')
            } else {
              finish('expired', 'expiry')
            }
          }
        }, ttlMs)
      }

      // Cross-process backstop: another Pluton process (CLI approvals decision,
      // expiry sweep) commits through the shared store; no in-process
      // notification can reach us, so poll the authoritative row.
      if (pollIntervalMs > 0) {
        pollHandle = timers.setInterval(() => {
          if (done) return
          const current = readApproval(store, id)
          if (current === null || current.status === 'pending') return
          finish(current.status, current.status === 'expired' ? 'expiry' : 'decision')
        }, pollIntervalMs)
      }
    })
  }

  function abort(reason: string): void {
    for (const id of [...pendingIds]) {
      const waiter = waiters.get(id)
      if (!waiter) continue
      let status: ApprovalStatus = 'expired'
      try {
        store.setApprovalStatus(id, 'expired', { decidedBy: 'pluton:aborted' })
        store.appendEvent({
          projectId: opts.projectId,
          runId: opts.runId,
          taskId: opts.taskId,
          museId: opts.museId,
          type: 'approval.expired',
          payload: { approvalId: id, action: ENGINE_PERMISSION_ACTION, reason },
        })
      } catch {
        // Already decided (or store gone): report the persisted status to
        // listeners; the engine answer stays fail-closed (resolve is
        // settlement-aware and forces `deny` for abort).
        const current = readApproval(store, id)
        if (current !== null) status = current.status
      }
      waiter.settle(status, 'abort')
    }
  }

  return { requestPermission, abort }
}
