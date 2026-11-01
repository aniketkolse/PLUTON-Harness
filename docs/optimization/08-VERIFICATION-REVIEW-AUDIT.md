# PLUTON 4.0 Phase 3 (P2) — Verification & Independent-Review Audit

**Date:** 2026-11-01  
**Milestone:** Phase 3 (P2), Batch B — Evidence-Based Verification & Independent Review  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED` (Windows host); POSIX-only sandbox checks remain `BLOCKED BY ENVIRONMENT`

---

## 1. Executive Summary

Batch B replaced the binary "checks configured or not" completion gate with an
evidence-based strategy and added an independent review workflow that cannot
self-approve.

Key changes:

1. **Task-level verification strategies.** `src/verify/strategy.ts` derives a
   `TaskKind` from the durable assignment snapshot and decides whether the
   project verification gate is required. Implementation, test and unknown work
   must pass the gate; research, review and coordination work is `NOT_REQUIRED`
   and completes on its own durable result.
2. **Uniform verification status vocabulary.** `NOT_REQUIRED`, `PENDING`,
   `RUNNING`, `PASSED`, `FAILED`, `BLOCKED`, `UNKNOWN` are now classified from
   durable rows for reporting/UI, independent of mutation logic.
3. **Independent review tool.** `review.report` lets a reviewer Ship record
   `APPROVE`, `REQUEST_CHANGES`, `REJECT` or `INSUFFICIENT_EVIDENCE` for a
   task in `verifying`. Anti-self-approval is enforced against both the
   assignee and the assignment snapshot.
4. **Bounded correction cycles.** `REQUEST_CHANGES` requeues a task with
   sanitized feedback and counts against `runtime.max_revisions_per_task`;
   `REJECT` terminalizes the task as failed; `INSUFFICIENT_EVIDENCE` leaves it
   visibly `verifying`.
5. **Evidence-owned approval.** `APPROVE` calls the same
   `applyTaskVerificationVerdict()` gate as the CLI/API. It cannot upgrade a
   task whose evidence is incomplete or inconsistent; such an attempt is recorded
   as `INSUFFICIENT_EVIDENCE` and refused.

Verification on this host: `npm run typecheck` passed, `npm run build` passed, and
the touched tool-bridge and verification integration suites passed.

---

## 2. Verification Strategy (`src/verify/strategy.ts`)

### 2.1 Task kind derivation

`taskKind()` reads the durable `assignment` snapshot captured at claim time
(`{ shipId, role, engine, model }`) and maps the Ship role:

| Assignment role | TaskKind |
| :--- | :--- |
| `coder`, `worker` | `implementation` |
| `tester` | `test` |
| `researcher` | `research` |
| `reviewer` | `review` |
| `supervisor` | `coordination` |
| anything else / missing | `unknown` |

The assignment snapshot is immutable, so the kind cannot be rewritten by later
Ship config edits.

### 2.2 Gate requirement

`verificationRequired(kind, projectHasChecks)`:

- If no project checks are configured → `false` for every kind (the gate cannot
  run).
- `implementation`, `test`, `unknown` → `true`.
- `research`, `review`, `coordination` → `false`.

The supervisor now enters `verifying` only when `verificationConfigured &&
verificationRequiredForTask(task, …)`. Otherwise a successful task completes
directly with its durable result. Non-required tasks are never forced through an
irrelevant test suite, but the reporting layer still classifies their state.

### 2.3 Status classification

`verificationStatus()` is a read-only classification over store rows:

| Status | Meaning |
| :--- | :--- |
| `NOT_REQUIRED` | Task kind does not need the project gate. |
| `PENDING` | Work not finished or blocked behind dependencies. |
| `RUNNING` | At least one current-attempt check is still `pending`. |
| `PASSED` | Evidence green and a verified verdict was recorded (or task already completed with green evidence). |
| `FAILED` | A failed check, a failed/non-verified verdict, or a terminal failure/cancellation. |
| `BLOCKED` | Required verification expected but no evidence row (or no verdict) exists. |
| `UNKNOWN` | Task is `unknown_outcome`. |

Terminal task failures/cancellations/interruptions are always `FAILED`, and
`unknown_outcome` is always `UNKNOWN`, regardless of kind.

---

## 3. Independent Review Workflow

### 3.1 Tool surface

`review.report` (permission `review.report`, mutating) accepts:

- `taskId` (task ref)
- `verdict`: `APPROVE | REQUEST_CHANGES | REJECT | INSUFFICIENT_EVIDENCE`
- `summary` (1–4000 chars)
- `issues` (optional, up to 50)

It is only callable for tasks in `verifying`.

### 3.2 Anti-self-approval

Two independent checks:

1. `env.callerShipId === task.assigneeShipId` → refused.
2. The durable assignment snapshot's `shipId` equals `env.callerShipId` → refused.

A worker cannot certify its own work, and the supervisor cannot certify a task it
assigned to itself. Both are durable comparisons, not in-memory ones.

### 3.3 Verdict handling

| Verdict | Effect | Bound |
| :--- | :--- | :--- |
| `APPROVE` | Calls `applyTaskVerificationVerdict()`; task completes only if evidence passes. Otherwise recorded as `INSUFFICIENT_EVIDENCE` and refused. | Evidence gate |
| `REQUEST_CHANGES` | Requeues task (`verifying → queued`, attempt + 1) with sanitized feedback; counts against `max_revisions_per_task`. | Revision cap |
| `REJECT` | Terminalizes task as `failed` (`review_rejected`). | None |
| `INSUFFICIENT_EVIDENCE` | No state change; leaves task in `verifying`. | None |

`REQUEST_CHANGES` uses the same CAS + event (`task.revision_scheduled`, via
`review`) discipline as the manager's `task.request_revision`, including
concurrent-write conflict reporting.

### 3.4 Evidence-owned approval

`APPROVE` never trusts the reviewer's prose. It invokes the production verdict
gate, which re-checks evidence identity, consistency, and tamper rules. If the
gate refuses, the attempt is audited as `INSUFFICIENT_EVIDENCE` with the
underlying reason, and the tool throws `PolicyDeniedError`. No task state changes
on that path.

---

## 4. Bounded Correction Cycles

- `REQUEST_CHANGES` increments the attempt and records feedback under
  `failure.code = 'review_changes_requested'`, preserving the previous failure
  under `previousFailure`.
- The revision count is derived from durable `review.reported` events with
  `verdict === 'REQUEST_CHANGES'`, not from memory, so a restarted process sees
  the same budget.
- The cap is `runtime.max_revisions_per_task` (default 1, max 10). Once exhausted,
  further `REQUEST_CHANGES` calls are refused with `PolicyDeniedError`.
- The manager's existing `task.request_revision` remains the separate,
  manager-only path for failed tasks and uses the same cap.

---

## 5. Reporting and UI

- `verificationStatus()` is available for TUI/SPA/operator surfaces to render the
  seven-state vocabulary without re-deriving it.
- The TUI already renders `verifying` as `[v]` and prints `✓ verified: …` when a
  verification summary exists; the new statuses give the reporting layer a
  consistent input.
- `task-detail.ts` continues to expose durable verification rows, verdict,
  criteria, tamper and evidence for operator inspection.
- Activity mapping already surfaces `task.awaiting_verification`,
  `verification.run` and `task.revision_scheduled`.

---

## 6. Audit / Test Coverage

- `tests/unit/tool-bridge.test.ts` — updated tool list expectations for the new
  `review.report` tool; all 51 tests pass.
- `tests/integration/verify.test.ts` — unchanged and passing (verification gate
  evidence rules, supersession, tamper).
- `src/verify/strategy.ts` is pure classification over store rows and is safe to
  unit-test without an engine.

---

## 7. Verification Evidence

| Command | Environment | Result |
| :--- | :--- | :--- |
| `npm run typecheck` | Windows 11, Node.js v24.20.0 | **PASSED** (0 errors) |
| `npm run build` | Windows 11, Node.js v24.20.0 | **PASSED** (0 errors) |
| `npx vitest run tests/unit/tool-bridge.test.ts` | Windows 11 | **PASSED** (51/51) |
| `npx vitest run tests/integration/verify.test.ts` | Windows 11 | **PASSED** |

---

## 8. Residual Risks and Follow-ups

1. `APPROVE` currently passes empty diff/changed-files to the verdict gate, so
   tamper detection is limited to check evidence unless the caller supplies a
   diff. Future work: wire the trusted worktree diff into `review.report` the
   same way the CLI does.
2. Review verdicts are recorded as events plus task state; there is no dedicated
   review table. This matches the no-new-table ruling from Batch A.
3. Per-task-type strategies are role-derived. A Ship with role `custom` is
   treated as `unknown` and therefore requires the gate; operators can narrow this
   by assigning a more specific role.
4. `NOT_REQUIRED` tasks complete without verification; this is intentional and
   visible in the status vocabulary, not a silent skip.

---

## 9. Files Changed in Batch B

| File | Change |
| :--- | :--- |
| `src/verify/strategy.ts` | **New.** Task kind, gate requirement, and verification status classification. |
| `src/orchestrator/supervisor.ts` | Per-task-type gate: only required kinds enter `verifying`. |
| `src/tools/catalog.ts` | `review.report` schema and tool definition. |
| `src/tools/handlers.ts` | `review.report` handler (anti-self-approval, verdicts, bounded revisions, evidence-owned approval). |
| `tests/unit/tool-bridge.test.ts` | Tool list expectation includes `review.report`. |
| `docs/optimization/08-VERIFICATION-REVIEW-AUDIT.md` | This audit. |
| `docs/optimization/PROGRESS.md` | Batch B status update. |

---

## 10. Sign-off

Batch B is **OPTIMIZED AND VERIFIED** on this host for TypeScript compilation,
production build, and the touched unit/integration suites. Verification is now
evidence-based and task-type aware; review verdicts cannot self-approve and are
bounded by durable revision caps.
