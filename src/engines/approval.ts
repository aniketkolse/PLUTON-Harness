import { ValidationError } from '../domain/errors.ts'
import type { ApprovalMode } from '../domain/models.ts'
import type { EngineAdapter } from './contract/types.ts'
import { QwenEngineAdapter, type QwenApprovalPolicy } from './qwen/adapter.ts'
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
 * Mapping — there is no interactive operator approval channel yet (Phase 8),
 * so anything the engine still asks is answered fail-closed:
 * - `autonomous-bounded` → `auto` + allow_once: the classifier approves safe
 *   actions; whatever still asks is granted once. "Bounded" by Pluton's
 *   isolated checkout, budgets and the verification gate, not by per-action
 *   prompts.
 * - `ask-for-sensitive-actions` → `auto` + deny: safe actions pass without a
 *   prompt; sensitive ones are denied and surfaced as `approval.engine_decision`
 *   run events until an operator channel exists.
 * - `ask-always` → `default` + deny: every edit/shell asks and is denied
 *   fail-closed. A denial does not stall the turn — the engine ends it having
 *   done nothing, so the task can still record a syntactically "successful"
 *   no-op; only `approval.engine_decision` events (and an empty diff) show why.
 *   Keep `ask-always` off until Phase 8 provides an operator channel.
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

/** Permission requests that reach Pluton: deny unless the Muse's mode grants bounded autonomy. */
export function engineApprovalPolicy(approvalMode: ApprovalMode): QwenApprovalPolicy {
  return approvalMode === 'autonomous-bounded' ? 'allow_once' : 'deny'
}

/**
 * The per-Muse engine adapter the run supervisor builds sessions from: engine
 * session settings come from the Muse's recorded approval mode, never from an
 * adapter default. `opts` carries container-mode pins (spawn, in-image binary)
 * and test seams.
 */
export function engineAdapterForMuse(
  muse: { engineKind: string; approvalMode: ApprovalMode },
  opts: EngineCreateOptions = {},
): EngineAdapter {
  if (muse.engineKind === 'qwen') {
    return new QwenEngineAdapter({
      ...opts,
      approvalMode: engineSessionMode('qwen', muse.approvalMode),
      approvalPolicy: engineApprovalPolicy(muse.approvalMode),
    })
  }
  return getEngineAdapter(muse.engineKind, opts)
}
