# PLUTON 4.0 Phase 4 (P2+) — Workspace Isolation & Git Workflows Audit

**Date:** 2026-11-01  
**Milestone:** Phase 4, Batch 4 — Workspace Isolation & Git Workflows  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED`

---

## 1. Executive Summary

Batch 4 audits PLUTON's workspace isolation, file-lease, and Git integration layer and identifies where it can be hardened without replacing the working architecture. The current design (per-task isolated clone, marker-based ownership, trusted-Git commit path, archive-never-delete recovery) is sound and verified. The gaps were operational: leases are in-memory-only with no TTL/renewal, write-scope conflict detection is exact-path-only (no directory-prefix overlap), and there is no cross-run conflict awareness.

**Implementation:** Batch 4 hardened the lease layer (directory-prefix conflict detection, optional TTL/renewal) without changing the isolation strategy. Git worktrees were evaluated and rejected — ADR-0005's clone-based isolation is retained with documented rationale. All verification passes: typecheck, build, full test suite (165 files, 1515 passed, 10 skipped), docs links, assets, and release gate.

### 2.1 Components

| Component | Location | Role |
| :--- | :--- | :--- |
| Per-task checkout | `GitWorkspaceManager` (`src/workspace/manager.ts`) | `git clone --local` of the user repo into `.pluton/workspaces/<task-id>` on branch `pluton/<run>/<slug>`; marker file `.git/pluton-workspace.json` proves Pluton ownership. |
| Trusted Git | `src/workspace/trusted-git.ts` | Host-side evidence/commit/integration path: throwaway GIT_DIR, `hash-object --no-filters`, `commit-tree` plumbing; worker `.git` metadata (hooks/filters/drivers) never executed on host. |
| Integration checkout | `integrateBranch` (`manager.ts`) | Copies task objects as data into a Pluton-managed integration checkout, merges under trusted config, preserves conflicts (never aborts/resets). |
| File leases | `FileLeaseManager` (`src/orchestrator/lease-manager.ts`) | In-memory per-(run, task, path) active leases; conflict on exact path match + dependency-file cross-conflict; `declareScope`/`releaseScope`/`recoverLeases`. |
| Workspace records | `src/store/store.ts` (`workspaces` table) | `state: active|archived|removed`; `getWorkspaceByTask` returns active row; `updateWorkspace` fences state changes. |
| Checkout recovery | `ensureTaskCheckout` (`supervisor.ts`) | Reattach if marker matches branch+baseCommit; archive (never delete) if stale; fresh clone if missing. |

### 2.2 Guarantees preserved

- User repository is clone source only; no Git command ever runs inside it.
- One self-contained clone per task; hardlinked object store via `--local`, honest full-clone fallback.
- Every checkout carries a Pluton marker; removal/archive refuses any directory without it.
- Task diffs/commits use trusted plumbing; worker `.git` metadata is treated as data.
- Integration preserves unresolved conflicts (never `merge --abort`/`reset`/`clean`).
- Checkout removal/archive never touches the user's repository or any path outside the workspaces root.

### 2.3 Known invariants (ADR-0005)

- Checkout granularity: per task.
- Cleanup: only Pluton-owned directories (marker + registry row); never forced.
- Fallback: full local clone when `--local` hardlinks unsupported; never shared worktrees.
- Git worktrees explicitly rejected for mount-semantics risk; "may be revisited with a tested volume strategy."

---

## 3. Audit Findings & Architectural Gaps

### Gap 1 — Leases are in-memory only with no TTL/renewal (HIGH impact)

`FileLeaseManager.leases` is a plain `Map` held in the supervisor process:

- **Crash between lease acquisition and task completion**: leases vanish with the process; on restart, `recoverLeases(activeRunning)` releases leases for tasks not in the active set, but `activeRunning` is derived from `ACTIVELY_RUNNING` task states (admitted/running/waiting_for_children/needs_input/needs_approval). A task left `running` by a dead process recovers its leases correctly; a task that completed but whose process died before `releaseScope` ran recovers correctly too. The residual window is tiny but real: a process that dies *after* `releaseScope` is called but *before* the `scope.released` event/append commits leaves a released lease with no event — harmless (lease is already released).
- **No TTL**: a leased path is held for the entire task lifetime regardless of how long the task stalls. A stalled task holds its write scope until supervisor interrupt (bounded by `defaultTaskTimeoutMs` + session interrupt) or run deadline.
- **No renewal**: a very long-lived task has no mechanism to prove liveness; the lease is implicitly trusted for the task's whole life.

### Gap 2 — Write-scope conflict detection is exact-path-only (MEDIUM impact)

`hasConflict` matches on `lease.path === norm` (exact normalized path) plus dependency-file cross-conflict. It does **not** detect:

- Directory-prefix overlap: `src/auth.ts` vs `src/auth/` (one is a file the other a directory) — neither matches exactly.
- Nested path overlap: `src/components/Button.tsx` vs `src/components/` — no prefix check.
- Glob-style overlaps: `src/*.ts` style scopes are not supported at all (paths are literal).

Two tasks with overlapping but non-identical write scopes can be dispatched concurrently and silently overwrite each other's files.

### Gap 3 — No cross-run conflict awareness (MEDIUM impact)

Each supervisor instance owns one run; leases are keyed by `runId` and `hasConflict` skips leases from other runs. Two concurrent runs (two supervisor processes) editing the same file in their respective task checkouts are not prevented from doing so at the lease layer. They operate on *separate checkouts* (per-task clones), so the conflict only materializes at integration time (`integrateBranch`), where Git merge conflicts surface. This is acceptable for isolation but means "concurrent modification of the same logical file" is only detected late, at integration.

### Gap 4 — Batch 3 deferred/suppressed tasks can hold leases until run deadline (MEDIUM impact)

Batch 3 defers tasks beyond the worker cap and suppresses duplicate-intent tasks, leaving them `queued`. A deferred task that was never dispatched holds no lease (leases are acquired at dispatch). However, a task that *was* dispatched, acquired leases, then was deferred on a later tick (e.g., reassessed) would hold leases while idle. More importantly, `recoverLeases` only releases leases for tasks **not** in `activeRunning`; a `queued` task (deferred/suppressed) is NOT in `ACTIVELY_RUNNING`, so its leases (if any were somehow acquired pre-deferral) would be released at recovery. Within a single process, though, deferred tasks that never acquired leases hold nothing — no leak. No fix strictly needed, but the lifecycle should be documented.

### Gap 5 — No Git worktrees; clone-based isolation retained (LOW impact, documented decision)

ADR-0005 explicitly rejected Git worktrees for mount-semantics risk. The current per-task clone approach:

- **Pros**: self-contained, independent `.git`, no worktree indirection, simple cleanup (rmSync), works identically on Windows/macOS/Linux.
- **Cons**: full clone per task (disk I/O), `--local` hardlinks unsupported on some filesystems (NTFS reparse points, some network shares) → slower full-clone fallback.

No worktree migration is recommended; the decision is documented and the existing tests pass on this Windows host.

### Gap 6 — No stale-ownership detection beyond startup recovery (LOW impact)

`recoverLeases` runs once at supervisor startup. Within a running process, there is no periodic sweep for leases held by tasks whose engine sessions have died but whose task rows are not yet terminal. The session-timeout path (`runPrompt` hard bound + `session.interrupt`) handles engine death, and `executeTask`'s finally releases leases. Residual risk: a process that is SIGKILLed (not graceful) loses in-memory leases entirely — recovery at next startup handles it.

---

## 4. Isolation Strategy Comparison

| Strategy | Isolation | Disk | Windows | Cleanup | Integration complexity | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Per-task clone (current)** | Strong (independent `.git`) | High per task | Verified on this host | Simple (rmSync + marker guard) | Low (separate integration checkout) | **Retain** |
| Per-task Git worktree | Medium (shared `.git` indirection) | Low | Risky (worktree `.git` is a file) | Complex (worktree pruning, lock files) | Medium | Rejected (ADR-0005 mount risk, untested volume strategy) |
| Per-worker checkout | Weak (shared across worker's tasks) | Medium | Verified | Simple | Low | Rejected (overlapping tasks interleave diffs) |
| Shared workspace + leases | Weak (relies solely on leases) | Low | Verified | Trivial | Low | Rejected (lease gaps above allow silent overwrite) |

**Decision:** Retain per-task clone isolation (ADR-0005). Do not migrate to worktrees until a tested volume/mount strategy exists. Harden leases instead.

---

## 5. Proposed Improvements (Batch 4 Scope)

All improvements are **additive and bounded**; none replace `GitWorkspaceManager`, `ensureTaskCheckout`, `commitAll`, `integrateBranch`, or `releaseScope`.

### 5.1 Lease persistence + TTL/renewal

- Persist active leases to a `task_leases` table (new migration v15) so a crash does not lose lease state; recovery reads persisted leases instead of only in-memory.
- Add `lease_ttl_seconds` (runtime config, default 300) and a renewal heartbeat: a task renews its leases each dispatch tick; a lease older than TTL without renewal is considered stale and released by recovery.
- Keep in-memory `FileLeaseManager` as the fast path; persist only on acquire/release/renew.

### 5.2 Directory-prefix write-scope conflict detection

- Extend `hasConflict`/`declareScope` to treat path `A` as conflicting with path `B` when one is a directory-prefix of the other (e.g., `src/auth.ts` conflicts with `src/auth/` and `src/auth/` conflicts with `src/auth/Button.tsx`).
- Keep exact-path and dependency-file rules unchanged.

### 5.3 Cross-run conflict awareness (documented, not enforced at lease layer)

- Since each task has its own checkout, cross-run conflicts only matter at integration. Document that `integrateBranch` reports conflicts and preserves them for operator resolution; no automatic merge.

### 5.4 Batch 3 lifecycle hygiene

- Deferred/suppressed tasks hold no leases (leases acquired at dispatch only) — verify this invariant in tests.
- `recoverLeases` releases leases for non-active tasks at startup — already correct; add a test.
- Cancellation path (`executeTask` finally + `releaseScope`) already releases leases — add a test.

---

## 6. What Is NOT in Scope (Preserve Working Architecture)

- Git worktree migration — rejected (ADR-0005, untested volume strategy).
- Automatic merge conflict resolution — explicitly forbidden (conflicts preserved for operator).
- Automatic force-push or history rewrite — explicitly forbidden.
- Cross-process lease locking (file-based or DB lock) — not needed; per-process supervisor + store CAS fencing is the existing boundary.
- Per-Muse (shared) checkout — rejected (ADR-0005).

---

## 7. Acceptance Criteria (Measurable)

| # | Criterion | How measured |
| :--- | :--- | :--- |
| 1 | No silent overwrite of concurrent write scopes | Directory-prefix conflict test: two tasks with overlapping scopes cannot both acquire leases |
| 2 | Leases released on task completion/failure | `releaseScope` called in `executeTask` finally; verified by supervisor tests |
| 3 | Stale leases recovered at startup | `recoverLeases` releases leases for non-active tasks; verified by unit test |
| 4 | User repository never modified | `createCheckout` clones from source; workspace tests assert source repo untouched |
| 5 | Checkout removal refuses unmarked paths | `removeCheckout`/`archiveCheckout` require Pluton marker; verified by workspace tests |
| 6 | Concurrency cap never exceeded | `maxConcurrentWorkers` backstop in `dispatchReadyTasks`; Batch 3 tests |
| 7 | No new dependencies; typecheck + build + tests pass | `npm run typecheck`, `npm run build`, `npm test` |

---

## 8. Residual Risks & Limitations

1. Lease TTL/renewal adds a new migration (v15) — owner decision needed before adding a table.
2. Directory-prefix conflict detection is heuristic (path-string based), not filesystem-aware (symlinks/junctions could bypass); Windows NTFS junctions are a residual risk documented separately.
3. Cross-run conflicts surface only at integration time (acceptable given per-task checkouts).
4. Deferred/suppressed tasks from Batch 3 can block run quiescence until run deadline (inherited from Batch 3 design; documented).

---

## 9. Files Changed

| File | Change |
| :--- | :--- |
| `docs/optimization/16-WORKSPACE-ISOLATION-AUDIT.md` | This audit (updated with implementation summary) |
| `src/orchestrator/lease-manager.ts` | Directory-prefix conflict detection (`pathsOverlap`); optional lease TTL (`leaseTtlSeconds`); `renewScope`, `expireStaleLeases`, `releaseLease` |
| `src/orchestrator/supervisor.ts` | Lease TTL wiring (`leaseTtlSeconds` option); lease renewal at dispatch tick; stale-lease expiry on each tick |
| `tests/unit/lease-manager.test.ts` | 16 tests: prefix conflict, TTL expiry, renewal, release-on-completion, startup recovery, single-path release |
| `tests/integration/supervisor.test.ts` | Duplicate-suppressed task lifecycle test (order-independent) |
| `docs/optimization/PROGRESS.md` | Batch 4 status + rulings 14–16 |

---

## 10. Sign-off

Batch 4 is **OPTIMIZED AND VERIFIED**. The workspace architecture is sound (clone-based isolation, trusted Git, marker-based recovery, archive-never-delete). Leases were hardened (prefix conflicts, optional TTL/renewal) without changing the isolation strategy. Git worktrees remain rejected per ADR-0005.

