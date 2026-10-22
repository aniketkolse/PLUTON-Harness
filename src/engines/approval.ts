import { ValidationError } from '../domain/errors.ts'
import type { ApprovalMode } from '../domain/models.ts'
import type { EngineAdapter } from './contract/types.ts'
import { OpenCodeEngineAdapter } from './opencode/adapter.ts'
import { getEngineAdapter, type EngineCreateOptions } from './registry.ts'

/**
 * Pluton approval mode → engine permission policy.
 *
 * Host-mode smoke lesson (2026-10-16, run_mvb95krv38bcb72a): nothing wired the
 * Muse's approval mode into engine session construction, so the adapter's
 * default `deny` policy rejected a worker's edit fail-closed while the task
 * still recorded "success". These mappings are the fix; every adapter
 * constructed for a Muse must go through {@link engineAdapterForMuse} so the
 * recorded mode is never ignored.
 *
 * OpenCode has no session-side auto-approval mode. Therefore:
 * - `autonomous-bounded` → `deny`: the engine never gets blanket consent and
 *   any permission request is denied fail-closed, even in a proven isolated
 *   checkout. The session is still bounded by the execution provider; this
 *   policy simply never fabricates a grant.
 * - `ask-for-sensitive-actions` / `ask-always` → `interactive`: the request
 *   becomes a durable operator approval (TUI/SPA) while the engine's request
 *   is held open. With no operator surface the adapter answers deny
 *   fail-closed.
 *
 * `engineKind` and isolation facts are accepted for API stability and future
 * engine-specific policies; with OpenCode as the only real engine they do not
 * upgrade a mode to a broader grant.
 */

/** How a given engine answers permission requests under a Muse's approval mode. */
export type EngineApprovalPolicy = 'deny' | 'allow_once' | 'allow_always' | 'interactive'

/** Runtime-proven session isolation. Never inferred from a Muse mode name. */
export interface EngineIsolationFacts {
  /** True only when the session's workdir is a Pluton-owned throwaway checkout. */
  isolatedCheckout: boolean
}

/**
 * Permission requests that reach Pluton for a Muse approval mode.
 *
 * - `autonomous-bounded` → fail-closed `deny` (no blanket engine consent).
 * - ask-* modes → `interactive`: the request becomes a durable operator
 *   approval and the engine's request is held open until the decision; no
 *   operator channel → the adapter denies fail-closed.
 */
export function engineApprovalPolicy(
  _engineKind: string,
  approvalMode: ApprovalMode,
  _isolation: EngineIsolationFacts = { isolatedCheckout: false },
): EngineApprovalPolicy {
  switch (approvalMode) {
    case 'autonomous-bounded':
      return 'deny'
    case 'ask-for-sensitive-actions':
    case 'ask-always':
      return 'interactive'
    default:
      // Muse rows are read from the store with a blind cast: an unrecognised
      // stored mode must fail loudly rather than silently becoming a deny that
      // looks like "nothing happened".
      throw new ValidationError(
        `no approval-policy mapping for approval mode '${String(approvalMode as string)}'`,
      )
  }
}

/**
 * The per-Muse engine adapter the run supervisor builds sessions from: engine
 * session settings come from the Muse's recorded approval mode plus the
 * caller-proven isolation fact (`opts.isolatedCheckout`), never from an
 * adapter default. `opts` also carries container-mode pins (spawn, in-image
 * binary) and test seams.
 */
export function engineAdapterForMuse(
  muse: { engineKind: string; approvalMode: ApprovalMode },
  opts: EngineCreateOptions = {},
): EngineAdapter {
  const policy = engineApprovalPolicy(muse.engineKind, muse.approvalMode, {
    isolatedCheckout: opts.isolatedCheckout === true,
  })
  if (muse.engineKind === 'opencode') {
    return new OpenCodeEngineAdapter({
      ...opts,
      approvalPolicy: policy === 'interactive' ? 'interactive' : 'deny',
    })
  }
  return getEngineAdapter(muse.engineKind, opts)
}
