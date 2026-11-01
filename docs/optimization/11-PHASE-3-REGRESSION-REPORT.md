# PLUTON 4.0 Phase 3 (P2) — Regression Report

**Date:** 2026-11-01  
**Milestone:** Phase 3 (P2), Batch E/F — Full Regression & Release Readiness  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED` (Windows host); POSIX-only sandbox checks and the opt-in live engine discovery sub-test remain `BLOCKED BY ENVIRONMENT`

---

## 1. Executive Summary

Phase 3 delivered four batches:

- **Batch A** — persistent orchestration and crash recovery (`07`).
- **Batch B** — evidence-based verification and independent review (`08`).
- **Batch C** — TUI/graphical workspace reliability (`09`).
- **Batch D** — observability and performance (`10`).

This report records the full regression run after all four batches. No regressions
were introduced: TypeScript compilation, production build, the complete unit/
integration suite, asset verification, documentation links, and the release gate
all pass on this host. The only non-passing items are the documented
environment-blocked POSIX sandbox check and the opt-in live OpenCode discovery
sub-test (an OpenCode binary issue, not a Pluton regression).

---

## 2. Verification Commands and Results

| Command | Environment | Result | Counts / runtime |
| :--- | :--- | :--- | :--- |
| `npm run typecheck` | Windows 11, Node.js v24.20.0 | **PASSED** | 0 errors |
| `npm run build` | Windows 11, Node.js v24.20.0 | **PASSED** | 0 errors |
| `npm test` | Windows 11, NTFS | **PASSED** | 162 files, 1470 passed, 10 skipped, 280.31 s |
| `npm run test:live` | Windows 11 (opt-in, `PLUTON_LIVE_OPENCODE=1`) | **PARTIALLY VERIFIED** | 1 passed (ACP session), 1 failed (discovery — OpenCode `Location plugins did not finish activating`), 1 skipped (resume) |
| `npm run verify:assets` | Windows 11 | **PASSED** | 60 checks |
| `npm run verify:docs` | Windows 11 | **PASSED** | 89 files, 48 links, 0 broken |
| `npm run release:check -- --allow-dirty` | Windows 11 | **PASSED** | 16 checks: 15 passed, 0 failed, 1 not tested (POSIX 0600), 0 owner blockers |
| `git diff --check` | Windows 11 | **PASSED** | No whitespace errors |

---

## 3. Scope of Changes (Phase 3)

### Batch A — Persistence & Crash Recovery
- `src/orchestrator/recovery.ts` (new) — `RecoveryManager`, checkpoint folding, durable decisions.
- `src/orchestrator/supervisor.ts` — recovery wiring, tool checkpoints, continuation context.
- `src/store/store.ts` — `listTaskEvents()`.

### Batch B — Verification & Independent Review
- `src/verify/strategy.ts` (new) — task kind, gate requirement, status vocabulary.
- `src/orchestrator/supervisor.ts` — per-task-type gate.
- `src/tools/catalog.ts` + `src/tools/handlers.ts` — `review.report` tool.

### Batch C — Interface Reliability
- `src/tui/orchestra.ts` — `unknown_outcome`/`pending` state badges.

### Batch D — Observability & Performance
- `src/orchestrator/recovery.ts` — `durationMs` field.

### Tests
- `tests/integration/supervisor.test.ts` — T1–T16 (63/63).
- `tests/unit/tool-bridge.test.ts` — tool list expectation updated.

### Documentation
- `docs/optimization/07`–`10` (batch audits), `11` (this report), `12` (completion), `PROGRESS.md`.

---

## 4. Regression Coverage

- **Restart reconciliation:** T1–T16 all pass, covering requeue, unknown outcome,
  verification verdict resume, approval expiry, multi-worker recovery, and
  durable continuation context.
- **Verification gate:** `tests/integration/verify.test.ts` unchanged and passing
  (evidence identity, supersession, tamper, drift).
- **Tool bridge:** 51/51 tests pass including the new `review.report` surface.
- **TUI/chat/workspace:** 16 TUI unit files (109 tests) + 3 chat-session
  integration files + workspace suites all pass.
- **Full suite:** 1470 passed, 10 skipped (platform-guarded POSIX/Linux tests).

No test was weakened or skipped to make the suite pass.

---

## 5. Environment-Blocked Items

| Item | Status | Reason |
| :--- | :--- | :--- |
| POSIX 0600 file-mode enforcement | `BLOCKED BY ENVIRONMENT` | Windows does not enforce POSIX mode bits. |
| Linux Landlock / namespace / seccomp sandbox | `BLOCKED BY ENVIRONMENT` | Requires Linux kernel + helper binary. |
| `test:live` discovery sub-test | `BLOCKED BY ENVIRONMENT` | OpenCode binary reports `Location plugins did not finish activating` on this host. The ACP session sub-test passed. |

These are pre-existing environment constraints, not regressions introduced by
Phase 3.

---

## 6. Sign-off

Phase 3 regression is **OPTIMIZED AND VERIFIED** on this host for every command
that can run here. The release gate reports 15 passed, 0 failed, 1 not tested
(POSIX), 0 owner blockers.
