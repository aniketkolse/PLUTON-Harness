# Parallel Muse Orchestration — Conformance Gap Plan (2026-10-18)

**Goal:** Close the remaining gaps between PLUTON's shipped parallel-worker runtime and the "Parallel Muse Orchestration with Isolated Workspaces" specification — inside the existing architecture: no second orchestrator, no second database, no new execution engine.

**Method:** Phase-0 reconnaissance (three independent read-only probes + spot checks on the working tree). The runtime already implements the large majority of the spec; this plan lists only **confirmed gaps**, each mapped to its spec bullet.

**Global constraints:** preserve existing architecture and all security policies; no stage/commit/push; forward-only migrations only (`src/store/migrations.ts`, `PRAGMA user_version`); TDD — failing test first for every change; `npm run typecheck` + full `npx vitest run` after each change set; release-gate file hashes must stay identical; Windows dev host — deterministic tests, no sleeps.

## As-is mapping (evidence)

| Spec area | Status | Evidence |
|---|---|---|
| Decomposition / DAG admission, cycle rejection, readiness | EXISTS | `src/orchestrator/task-graph.ts` (admitTask, `wouldCreateDependencyCycle`), `store.listReadyTasks` (`store.ts:541-555`) |
| Real concurrent workers, configurable cap (default 3) | EXISTS | dispatch cap `supervisor.ts:570`; `runtime.max_concurrent_workers` default 3 `config/schema.ts:47`; per-assignee mutex `mutex.ts` |
| Isolated per-task workspace (never shared, never destroyed) | EXISTS | `GitWorkspaceManager.createCheckout` clone+marker `workspace/manager.ts:131-215`; dirty work committed at integrate, conflicts preserved |
| Docker sandbox hardening / credential+network limits | EXISTS | `sandbox/docker.ts:68-161`; per-Muse engine home mount; `network_policy` |
| Structured results → manager | PARTIAL | `tasks.result_json` = `{summary, outcome, engine, textChars}` (`supervisor.ts:500-517`) — missing changed files / commit / tests+outcomes / blockers / cleanup status |
| Terminal-state durability, retry bounds, events | PARTIAL | state machine `domain/state.ts`; retries bounded `supervisor.ts:519-539`; but no CAS claim, no late-result record |
| Verification + protected-path + provenance gates | EXISTS | `verify/runner.ts`, `verify/independent.ts`, `integrate.ts:92-104, 231-256` |
| Approvals ↔ workers | PARTIAL | `needs_approval` state exists in machine + SPA CSS + TUI reads, but is **never set**; engine waits keep task `running` |
| TUI orchestra + SPA orchestra (same store) | EXISTS | `tui/orchestra.ts:52-204`; SPA `static-assets.ts:1853-1996` |
| Restart recovery | PARTIAL | only `running`→`queued` requeue `supervisor.ts:705-710`; `admitted`/`needs_approval` stranded; stale checkout makes requeued isolated tasks fail setup |
| tmux | EXISTS as operator shell only; orchestration is tmux-independent | `terminal/manager.ts`, `attach.ts`; not the worker transport — spec's optional Phase 7 is satisfied by documenting this mapping |

## Confirmed gaps → change sets (execution order)

### CS-1 — Transactional claim + late-result safety (spec Phases 1, 5)
- **Files:** `src/store/store.ts` (CAS transition), `src/orchestrator/supervisor.ts` (use CAS; record discarded late results), tests.
- **Mechanism:** add a compare-and-swap task transition (`UPDATE ... WHERE id=? AND state=?`, `changes===1`); dispatch claims `queued→admitted` through it; a result that arrives for a terminal task appends `task.late_result_discarded` instead of silently dropping.
- **Tests:** losing CAS does not start a duplicate; late result records event, state unchanged; same-tick double dispatch.

### CS-2 — Restart reconciliation (spec Phase 9)
- **Files:** `src/orchestrator/supervisor.ts` (recovery block), `src/workspace/manager.ts` (reattach/archive helpers), tests.
- **Mechanism:** recovery covers `running`, `admitted`, `needs_approval` (requeue, `attempt+1` as today), and `waiting_for_children` (requeue when children terminal); stale checkout dirs: validate marker+branch+base commit → reattach, else archive to `.pluton/workspaces-attic/<taskId>-<ts>` (never delete) and recreate; clear `engine_session_id` with `task.session_abandoned`; unrecoverable → `unknown_outcome`, never fabricated success.
- **Tests:** resume with each stranded state; reattach vs archive; no-success-fabrication.

### CS-3 — Structured worker result + assignment snapshot (spec Inputs/Outputs, Phase 5)
- **Files:** migration **v6** (`tasks.assignment_json` snapshot), `supervisor.ts` settle path, `src/tools/handlers.ts` `task.get_result`, tests.
- **Mechanism:** snapshot `{museId, role, engine, model}` at start so history survives config edits; `task.get_result` composes `{taskId, status, summary, changedFiles (lazy workspace diff), commit (head_commit), tests (verification_checks rows with real exit codes), blockers (failure + unmet criteria), workspace {id, branch, baseCommit, state, cleanup}}` — composed from durable rows, no double bookkeeping.
- **Tests:** composed result contains changed files + actual test outcomes + blockers; snapshot survives a muse config edit.

### CS-4 — waiting-for-approval worker state (spec Phase 4)
- **Files:** `src/engines/interactive-approval.ts` (`onSettled` callback), `src/orchestrator/supervisor.ts` (task-scoped channel flips state), tests.
- **Mechanism:** task-scoped engine approval requested → `running→needs_approval`; on settle → back to `running` **only if still `needs_approval`** (abort/close paths settle via normal prompt outcome, never fabricate). Session-scoped channels (chat/SPA) unchanged.
- **Tests:** flips under real channel+store with fake ACP; returns on approve/deny/expiry; abort leaves no false `running`.

### CS-5 — Bounded revisions requested by the manager (spec Phase 6)
- **Files:** `src/tools/catalog.ts` (new `task.request_revision`), `src/tools/handlers.ts`, `src/config/schema.ts` (`runtime.max_revisions_per_task` default 1), tests.
- **Mechanism:** manager-only tool; eligible state: `failed` (engine or verification failure); bounded feedback (≤2 000 chars, sanitized); requeue `failed→queued` with `attempt+1`; cap counted from durable `task.revision_scheduled` events; reject beyond cap, on non-failed states, and from non-manager callers.
- **Tests:** requeues failed task with feedback; cap enforced; non-failed rejected.

### CS-6 — Pre-merge overlap detection between tasks (spec Phase 6)
- **Files:** `src/cli/commands/integrate.ts`, `src/workspace/manager.ts` (reuse `changedFiles`), tests.
- **Mechanism:** before merging, map file→tasks across candidates; files claimed by ≥2 tasks block those tasks (reported as `blockedOverlap` with file lists + `integration.overlap_detected` event); **never auto-merged**. Disjoint tasks proceed. Existing protected-path gate, conflict preservation, and idempotent re-run behavior unchanged.
- **Tests:** overlapping pair blocked with file list and nothing merged; disjoint tasks still merge; overlap + protected-path compose.

### CS-7 — Workspace cleanup + orphan prevention (spec Phases 3, 9)
- **Files:** new `pluton workspace` command (`src/cli/commands/workspace.ts` + `main.ts` wiring), store workspace state transition, tests.
- **Mechanism:** operator-invoked `pluton workspace clean [--run <id> | --all-runs]`: marker-guarded removal under `.pluton/workspaces/` only; refuses non-terminal runs and tasks in `admitted`/`running`/`needs_approval`; sets workspace `state='removed'` after successful removal; verification/integration artifacts preserved. No automatic deletion (evidence preservation).
- **Tests:** removes only marker-owned; refuses in-use; state transition; artifacts preserved.

### CS-8 — Live orchestration state over SSE (spec Phase 8)
- **Files:** `src/server/*` (derive `run_state`/`task_state` frames from the durable event log for the existing SSE stream), SPA handler in `static-assets.ts`, tests.
- **Mechanism:** the durable log stays the source of truth; the server maps `run.*`/`task.*` events (existing `eventsSince` polling) to the two declared-but-unused frame types; TUI already polls the same store.
- **Tests:** SSE emits `run_state`/`task_state` on real transitions.

### CS-9 — Cancellation semantics + bounded shutdown (spec Phases 4, 9)
- **Files:** `src/tools/handlers.ts` (idempotent cancel), `src/orchestrator/supervisor.ts` (interrupt in-flight sessions of cancelled tasks/run), `src/cli/commands/run.ts` (SIGINT/SIGTERM → same cancel path, bounded drain), tests.
- **Mechanism:** cancel path interrupts assigned live sessions and awaits `inFlight` with a bound before finalizing; repeated cancel of a terminal task becomes an idempotent ack; signal triggers the same path.
- **Tests:** cancel interrupts a long fake prompt; repeated cancel idempotent; drain completes within bound.

## Explicitly not in scope (already conformant — no code change)
- Clones-not-worktrees workspace creation (spec prefers worktrees; the clone-per-task implementation is equivalent-or-stronger isolation and is the existing ADR-0005 contract — documented decision).
- tmux (optional Phase 7): exists only as operator shell inside containers, never the worker transport; workers and orchestration run fully without tmux (native runtime + Docker) — mapping documented.
- DAG admission/cycle rejection, Docker hardening, protected-path/provenance gate, verification runner — no changes.

## Acceptance-criteria coverage
1–5: already met (DAG scheduler, real concurrency, per-task checkouts, structured results — completed further by CS-3). 6: existing gates + CS-6. 7–8: CS-1/2/9, CS-8. 9: already met (documented mapping). 10: tests added per CS; final full-suite + typecheck each phase.

## Review focus (most likely to bite)
- Resume with a `needs_approval` or `admitted` task (CS-2) — must not spin to deadline or double-run.
- Cap boundary + same-tick dispatch (CS-1 tests) — no duplicate worker.
- Late results racing terminal states (CS-1) — must be recorded, never applied.
- Overlap detection must not weaken the protected-path gate or auto-merge anything (CS-6).
- CS-4 flips must never produce a `running` task with no session (abort/close paths).
