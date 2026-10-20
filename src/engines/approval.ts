import { ValidationError } from '../domain/errors.ts'
import type { ApprovalMode } from '../domain/models.ts'
import type { EngineAdapter } from './contract/types.ts'
import { OpenCodeEngineAdapter } from './opencode/adapter.ts'
import { QwenEngineAdapter } from './qwen/adapter.ts'
import { getEngineAdapter, type EngineCreateOptions } from './registry.ts'

/**
 * Pluton approval mode → engine session settings.
 *
 * Host-mode smoke lesson (2026-10-16, run_mvb95krv38bcb72a): nothing wired the
 * Muse's approval mode into engine session construction, so the qwen adapter
 * fell back to session mode `default` — where every edit raises
 * `session/request_permission` — and its default `deny` policy rejected the
 * worker's edit fail-closed. The task recorded "success" with zero changes.
 * These mappings are the fix; every adapter constructed for a Muse must go
 * through {@link engineAdapterForMuse} so the recorded mode is never ignored.
 *
 * qwen session modes (live probe, qwen-code v0.25.2) are
 * `plan | default | auto-edit | auto | yolo`:
 * - `default`: every edit and shell command asks for permission;
 * - `auto`: an LLM classifier auto-approves safe actions; risky ones ask;
 * - `yolo`: every tool is auto-approved.
 *
 * Mapping — the interactive operator approval channel (Phase 8) exists now,
 * so anything the engine still asks can be forwarded to the operator:
 * - `autonomous-bounded` → qwen `auto` + allow_once, but ONLY when the runtime
 *   can prove the session is bounded by a Pluton-owned throwaway checkout
 *   (task sessions): the classifier approves safe actions and whatever still
 *   asks is granted once there. A project-root session (chat/SPA/manager)
 *   cannot prove that bound, so its residual asks go to the operator instead.
 *   Engines with no engine-side auto mode keep `deny` fail-closed.
 * - `ask-for-sensitive-actions` → qwen `auto` + interactive, other engines
 *   interactive: safe actions pass without a prompt; sensitive ones become
 *   durable operator approvals (TUI/SPA) while the engine's request is held
 *   open. With no operator surface the adapter answers deny fail-closed.
 * - `ask-always` → qwen `default` + interactive: every edit/shell asks and is
 *   forwarded to the operator. A denial does not stall the turn — the engine
 *   ends it having done nothing, and the approval record shows why.
 */
export function engineSessionMode(engineKind: string, approvalMode: ApprovalMode): string | undefined {
  if (engineKind !== 'qwen') return undefined // engines without a mode select keep their own default
  switch (approvalMode) {
    case 'autonomous-bounded':
    case 'ask-for-sensitive-actions':
      return 'auto'
    case 'ask-always':
      return 'default'
    default:
      // Unreachable through parsed config (the schema enum validates), but Muse
      // rows are read from the store with a blind cast: an unrecognised stored
      // mode must fail loudly at construction instead of silently falling back
      // to fail-closed `default` — the no-op "success" shape this wiring
      // exists to prevent.
      throw new ValidationError(
        `qwen has no session-mode mapping for approval mode '${String(approvalMode as string)}'`,
      )
  }
}

/** How a given engine answers permission requests under a Muse's approval mode. */
export type EngineApprovalPolicy = 'deny' | 'allow_once' | 'allow_always' | 'interactive'

/** Runtime-proven session isolation. Never inferred from a Muse mode name. */
export interface EngineIsolationFacts {
  /** True only when the session's workdir is a Pluton-owned throwaway checkout. */
  isolatedCheckout: boolean
}

/**
 * Permission requests that reach Pluton for a given engine + Muse mode.
 *
 * - qwen `autonomous-bounded` + proven isolation → `allow_once`: the session
 *   runs `auto` (classifier approves safe actions) inside a throwaway task
 *   checkout; whatever still asks is granted once.
 * - qwen `autonomous-bounded` without that proof (project root) → the operator
 *   channel (`interactive`); with no operator channel the adapter denies
 *   fail-closed.
 * - ask-* modes → `interactive` on every engine: the request becomes a
 *   durable operator approval and the engine's request is held open until the
 *   decision; no operator channel → the adapter denies fail-closed.
 * - other engines under `autonomous-bounded` keep the fail-closed `deny`:
 *   only qwen has an engine-side auto-approval mode to lean on.
 */
export function engineApprovalPolicy(
  engineKind: string,
  approvalMode: ApprovalMode,
  isolation: EngineIsolationFacts = { isolatedCheckout: false },
): EngineApprovalPolicy {
  switch (approvalMode) {
    case 'autonomous-bounded':
      if (engineKind !== 'qwen') return 'deny'
      return isolation.isolatedCheckout ? 'allow_once' : 'interactive'
    case 'ask-for-sensitive-actions':
    case 'ask-always':
      return 'interactive'
    default:
      // Same blind-cast rationale as engineSessionMode: refuse loudly rather
      // than silently falling back to a deny that looks like "nothing happened".
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
  if (muse.engineKind === 'qwen') {
    return new QwenEngineAdapter({
      ...opts,
      approvalMode: engineSessionMode('qwen', muse.approvalMode),
      approvalPolicy: policy,
    })
  }
  if (muse.engineKind === 'opencode') {
    return new OpenCodeEngineAdapter({
      ...opts,
      approvalPolicy: policy === 'interactive' ? 'interactive' : 'deny',
    })
  }
  return getEngineAdapter(muse.engineKind, opts)
}
