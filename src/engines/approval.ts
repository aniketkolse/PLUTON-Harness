import type { ApprovalMode } from '../domain/models.ts'
import type { EngineAdapter } from './contract/types.ts'
import { QwenEngineAdapter, type QwenApprovalPolicy } from './qwen/adapter.ts'
import { getEngineAdapter } from './registry.ts'

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
 *   prompt; sensitive ones are denied and surfaced as `approval.requested`
 *   run events until an operator channel exists.
 * - `ask-always` → `default` + deny: every edit/shell asks and is therefore
 *   denied fail-closed; such a Muse stalls honestly instead of acting without
 *   approval.
 */
export function engineSessionMode(engineKind: string, approvalMode: ApprovalMode): string | undefined {
  if (engineKind !== 'qwen') return undefined // engines without a mode select keep their own default
  switch (approvalMode) {
    case 'autonomous-bounded':
    case 'ask-for-sensitive-actions':
      return 'auto'
    case 'ask-always':
      return 'default'
  }
}

/** Permission requests that reach Pluton: deny unless the Muse's mode grants bounded autonomy. */
export function engineApprovalPolicy(approvalMode: ApprovalMode): QwenApprovalPolicy {
  return approvalMode === 'autonomous-bounded' ? 'allow_once' : 'deny'
}

/**
 * The per-Muse engine adapter the run supervisor builds sessions from: engine
 * session settings come from the Muse's recorded approval mode, never from an
 * adapter default.
 */
export function engineAdapterForMuse(muse: { engineKind: string; approvalMode: ApprovalMode }): EngineAdapter {
  if (muse.engineKind === 'qwen') {
    return new QwenEngineAdapter({
      approvalMode: engineSessionMode('qwen', muse.approvalMode),
      approvalPolicy: engineApprovalPolicy(muse.approvalMode),
    })
  }
  return getEngineAdapter(muse.engineKind)
}
