# PLUTON 4.0 Optimization & Reliability Progress

Last Updated: 2026-11-01  
Current Branch: `optimization/p0-reliability` (uncommitted local worktree; no remote pushes)  
Status Legend:
- `VERIFIED`: Implemented and verified by unit/integration/live tests.
- `OPTIMIZED AND VERIFIED`: Fixed/hardened in this milestone and passing all tests.
- `PARTIALLY VERIFIED`: Functioning with minor environment caveats noted.
- `BLOCKED BY ENVIRONMENT`: Cannot be tested or executed on current host OS (e.g. Linux Landlock on Windows).
- `NOT IMPLEMENTED`: Feature intentionally not present or deferred.
- `REQUIRES OWNER DECISION`: Pending product owner architectural direction.

---

## Roadmap Milestones & Phase Progress

### Phase 0 — Baseline Capture & Environment Audit `[OPTIMIZED AND VERIFIED]`
- [x] Environment audit (Node.js v24.20.0, Windows 11 Build 26300, Git 2.56.0, OpenCode v2.2.5).
- [x] Baseline test and build capture (`npm run typecheck`, `npm run build`, `npm test`).
- [x] Baseline test report generated (`docs/optimization/02-BASELINE-TEST-REPORT.md`).
- [x] Current state architecture audit documented (`docs/optimization/00-CURRENT-STATE-AUDIT.md`).
- [x] Feature maturity matrix documented (`docs/optimization/01-FEATURE-MATURITY-MATRIX.md`).

### Phase 1 — P0 Engine & Supervisor Reliability Hardening `[OPTIMIZED AND VERIFIED]`
- [x] Fix baseline TypeScript errors in tests (`tests/unit/opencode-model-fallback.test.ts`).
- [x] Enforce single fallback authority: eliminate adapter-level silent model auto-switching and hardcoded fallback chains from `src/engines/opencode/adapter.ts`.
- [x] Implement explicit session model switching via `OpenCodeEngineSession.switchModel()`.
- [x] Enforce engine kind boundaries: exclude dev-only engines (mock) from production discovery and isolate selection candidates to the Ship's engine kind.
- [x] Add bounded startup model discovery await in `RunSupervisor.runToCompletion()`.
- [x] Harden ACP session turn lifecycle (`src/engines/acp/session-base.ts`): cancel grace timing, guaranteed `cancelled`/`unknown` outcomes, poison session on early consumer exit.
- [x] Harden ACP client process management (`src/engines/acp/client.ts`): exit info checking before SIGKILL, process cleanup idempotency.
- [x] Fix supervisor fallback loop (`src/orchestrator/supervisor.ts`): persistent `ModelFallbackState` across attempts, replay safety verification against side-effect tool traces, structured `buildTaskRecoveryPrompt` context preservation.
- [x] Implement model health recovery on rediscovery in `ModelDiscoveryService`.
- [x] Real OpenCode live inference and session resume validation (`tests/live/opencode.live.test.ts` passed 3/3).

### Phase 2 — P1 Orchestration, Performance & Concurrency Hardening `[OPTIMIZED AND VERIFIED]`
- [x] Wire `ModelHealthMonitor` into `ModelDiscoveryService` in `src/orchestrator/service.ts`.
- [x] Audit MCP Tool Bridge rate-limiting, buffer limits, and concurrency (`docs/optimization/03-MCP-BRIDGE-AUDIT.md`).
- [x] Implement bounded concurrency, FIFO queueing, backpressure, and session teardown in `ToolHttpServer`.
- [x] Profile test suite execution performance and Windows NTFS concurrency hazards (`docs/optimization/04-TEST-PERFORMANCE-BASELINE.md`).
- [x] Verify FTS5 search query escaping, SQL/FTS injection security, BM25 bounds, and multilingual edge cases (`docs/optimization/05-FTS5-SEARCH-AUDIT.md`).

### Phase 3 — P2 Quality, Tool Bridge & Verification Loop `[OPTIMIZED AND VERIFIED]`

#### Batch A — Persistent Orchestration & Crash Recovery `[OPTIMIZED AND VERIFIED]`
- [x] Audit durable vs transient state, transaction boundaries, fencing, and crash points (`docs/optimization/07-PERSISTENCE-RECOVERY-AUDIT.md`).
- [x] Implement `RecoveryManager` (`src/orchestrator/recovery.ts`): task/approval/run classification, durable decisions, verification-verdict resume, and deterministic `RecoveryReport`.
- [x] Add durable per-tool checkpoints (`task.tool_started` / `task.tool_completed`) so recovery can distinguish safe requeue from unknown external outcomes.
- [x] Never replay an unmatched tool start, a failed tool, or a granted approval whose result was never persisted; terminalize as `unknown_outcome`.
- [x] Expire dead-session pending approvals (`decidedBy: 'pluton:recovery'`), resume parked `awaiting_approval` runs, and suppress manager startup for `verifying`/`awaiting_input`.
- [x] Inject completed-tool and existing-child context into requeued worker prompts; inject the durable task list into a restarted manager prompt.
- [x] Keep recovery at migration v14 (events, not a new table) — see Ruling 5.
- [x] Restart-reconciliation tests T1–T16 passing (63/63 supervisor integration tests).

#### Batch B — Evidence-Based Verification & Independent Review `[OPTIMIZED AND VERIFIED]`
- [x] Implement `src/verify/strategy.ts`: `TaskKind`, `verificationRequired`, `verificationStatus` (NOT_REQUIRED/PENDING/RUNNING/PASSED/FAILED/BLOCKED/UNKNOWN).
- [x] Make the supervisor gate per-task-type: only implementation/test/unknown work enters `verifying`; research/review/coordination completes on its durable result.
- [x] Add `review.report` tool with anti-self-approval (assignee + assignment snapshot), verdicts APPROVE/REQUEST_CHANGES/REJECT/INSUFFICIENT_EVIDENCE.
- [x] Evidence-owned APPROVE: approval is refused unless `applyTaskVerificationVerdict()` passes; refused attempts audited as INSUFFICIENT_EVIDENCE.
- [x] Bounded correction cycles: REQUEST_CHANGES requeues with sanitized feedback and counts durable revisions against `max_revisions_per_task`.
- [x] Verification/UI reporting vocabulary documented; TUI and task-detail surfaces consume durable verification rows.
- [x] `docs/optimization/08-VERIFICATION-REVIEW-AUDIT.md` written.

#### Batch C — TUI / Graphical Workspace Reliability `[OPTIMIZED AND VERIFIED]`
- [x] Audit TUI/graphical workspace surfaces and state coverage (`docs/optimization/09-INTERFACE-RELIABILITY-AUDIT.md`).
- [x] Add `unknown_outcome` and `pending` task-state badges to the Orchestra inspector (`src/tui/orchestra.ts`).
- [x] TUI unit suites (16 files, 109 tests) and chat-session integration suites pass.

#### Batch D — Observability & Performance `[OPTIMIZED AND VERIFIED]`
- [x] Audit observability surfaces (event log, SSE, activity, usage, recovery latency) and performance baseline.
- [x] `RecoveryReport.durationMs` records recovery-pass latency.
- [x] Full suite baseline re-verified: 162 files, 1470 passed, 10 skipped, 280.31 s.
- [x] `docs/optimization/10-OBSERVABILITY-PERFORMANCE-AUDIT.md` written.

#### Batch E/F — Full Regression & Release Readiness `[OPTIMIZED AND VERIFIED]`
- [x] Full suite: 162 files, 1470 passed, 10 skipped, 280.31 s.
- [x] Release gate: 16 checks, 15 passed, 0 failed, 1 not tested (POSIX), 0 owner blockers.
- [x] Assets (60) and docs (89 files, 48 links) verified.
- [x] `docs/optimization/11-PHASE-3-REGRESSION-REPORT.md` and `12-PHASE-3-COMPLETION-REPORT.md` written.
- [x] Phase 3 marked complete.

### Phase 4 — Adaptive Intelligence, Agent Coordination, Resource Optimization and Production Maturity `[IN PROGRESS]`

#### Batch 1 — Manager Intelligence & Adaptive Task Decomposition `[OPTIMIZED AND VERIFIED]`
- [x] Audit manager planning architecture (`docs/optimization/13-MANAGER-INTELLIGENCE-AUDIT.md`).
- [x] Implement `src/orchestrator/task-assessment.ts`: deterministic `TaskAssessment`, `allocateWorkers`, `assessmentToPromptSection`.
- [x] Record assessment durably as `run.assessed` at run start.
- [x] Inject bounded assessment section into the manager prompt.
- [x] Planning benchmark dataset (`tests/benchmarks/planning-cases.json`, 9 cases) with regression guard.
- [x] `tests/unit/task-assessment.test.ts` (9/9 passing).

#### Batch 2 — Intelligent Model Routing `[OPTIMIZED AND VERIFIED]`
- [x] Audit model discovery, capability, selection, health, and fallback (`docs/optimization/14-MODEL-ROUTING-AUDIT.md`).
- [x] Implement `src/engines/model-performance.ts`: observed-performance observations + summaries + bounded health adjustment.
- [x] Wire observed performance into `selectModel`/`evaluateModel` as a bounded routing input; `performanceApplied` reported on outcomes.
- [x] Emit durable `run.model_selected` events with score, exclusions, and performance applied at task model resolution (`src/orchestrator/supervisor.ts`).
- [x] `tests/unit/model-performance.test.ts` (6/6 passing).

#### Batch 3 — Adaptive Scheduler & Agent Coordination `[OPTIMIZED AND VERIFIED]`
- [x] Audit scheduler architecture and gaps (`docs/optimization/15-ADAPTIVE-SCHEDULER-AUDIT.md`).
- [x] Implement `src/orchestrator/scheduling-policy.ts`: deterministic readiness, dependency-criticality priority, adaptive worker cap from `TaskAssessment`, cross-tick duplicate-intent prevention, and `task.scheduled`/`task.deferred`/`task.duplicate_suppressed` events.
- [x] Integrate policy into `RunSupervisor.dispatchReadyTasks()`: persistent `dispatchedTaskRecords` and `duplicateSuppressedTaskIds`, DAG readiness preserved, `maxConcurrentWorkers` never exceeded.
- [x] Unit tests (`tests/unit/scheduling-policy.test.ts`, 18/18) and integration tests (priority ordering, duplicate suppression, concurrency cap) added to `tests/integration/supervisor.test.ts`.
- [x] Full suite re-verified: 165 files, 1515 passed, 10 skipped, 276.18 s.

#### Batch 4 — Workspace Isolation & Git Workflows `[OPTIMIZED AND VERIFIED]`
- [x] Audit workspace ownership, file leases, write-scope conflicts, Git integration (`docs/optimization/16-WORKSPACE-ISOLATION-AUDIT.md`).
- [x] Confirm Git worktree rejection stands (ADR-0005 mount risk; clone-based isolation retained).
- [x] Directory-prefix write-scope conflict detection in `FileLeaseManager` (`src/orchestrator/lease-manager.ts`).
- [x] In-memory lease TTL/staleness check with renewal heartbeat on dispatch tick (`leaseTtlSeconds`, `renewScope`, `expireStaleLeases`).
- [x] Lease lifecycle tests (prefix conflict, TTL expiry, release-on-completion, startup recovery, single-path release) in `tests/unit/lease-manager.test.ts` (16/16).
- [x] Integration test for duplicate-suppressed task lifecycle in `tests/integration/supervisor.test.ts`.
- [x] `docs/optimization/PROGRESS.md` Batch 4 status + rulings.

#### Batch 5 — Cost, Latency & Quality Optimization `[IN PROGRESS]`
- [x] Audit model usage, execution efficiency, context efficiency, task quality (`docs/optimization/17-COST-PERFORMANCE-AUDIT.md`).
- [x] Instrument task duration (startedAt in task.started, durationMs in terminal events).
- [x] Instrument queue wait time (task.dequeued events with queuedAt/dispatchedAt).
- [x] Persist model performance observations as durable `run.model_performance` events (fixed canonicalJson undefined-value bug).
- [ ] Instrument context size (promptChars, textTruncated, recovery context entries).
- [ ] Establish deterministic benchmark scenarios (8 scenarios) with observed duration/queue-wait/context metrics.
- [ ] Extend benchmark dataset (`tests/benchmarks/planning-cases.json`) with execution scenarios.
- [ ] Before/after comparison for any optimization; reject regressions in completion/verification/recovery.
- [ ] `docs/optimization/PROGRESS.md` Batch 5 status + rulings.

#### Remaining Phase 4 Work
- [ ] Batch 6 — MCP Ecosystem Maturity (`docs/optimization/18-MCP-ECOSYSTEM-AUDIT.md`).
- [ ] Batch 7 — Distribution & Installation Readiness (`docs/optimization/19-DISTRIBUTION-READINESS-AUDIT.md`).
- [ ] Batch 8 — Full-System Validation (`docs/optimization/20-PHASE-4-REGRESSION-REPORT.md`).
- [ ] `docs/optimization/21-PHASE-4-COMPLETION-REPORT.md`.

---

## Architectural Rulings Ledger

1. **Ruling: Supervisor as Sole Fallback Decision Maker**
   - *Decision:* Removed adapter-level silent auto-switch and preference lists from `src/engines/opencode/adapter.ts`.
   - *Rationale:* Having both the adapter and the supervisor attempt to handle model switches creates racing fallback loops, bypasses supervisor state/budgets, and prevents the supervisor from checking replay safety.
   - *Cost if wrong:* Models failing with usage limits must have their failure surfaced to the supervisor prompt loop (which is now verified and working).

2. **Ruling: Exclude Dev-Only Engines from Production Selection**
   - *Decision:* Configured `registeredEngineModelDiscovery` and `src/orchestrator/service.ts` to exclude `devOnly: true` engines (mock) unless explicitly requested.
   - *Rationale:* In production, mock models report 100% availability and synthetic capability metrics, which would improperly cause real OpenCode ships to be assigned mock models.
   - *Cost if wrong:* Tests using mock engines must specify `includeDevOnly: true` or pass the mock engine explicitly in `only: ['mock']`.

3. **Ruling: Structured Task Recovery Prompt Instead of Raw Replay**
   - *Decision:* Implemented `buildTaskRecoveryPrompt` providing prior failure reason, workspace directory, completed tool calls, and workspace resume instructions.
   - *Rationale:* Side-effecting operations (file edits, git commits, external calls) must not be blindly re-run when switching models. The replacement model must inspect existing workspace state.
   - *Cost if wrong:* Slightly longer recovery prompt text (bounded by `maxBriefChars`).

4. **Ruling: Model Health Recovery on Rediscovery**
   - *Decision:* When an engine probe succeeds and lists a model, `ModelDiscoveryService` clears any existing `unavailable` state in `ModelHealthMonitor`, while preserving `temporarily-ineligible` rate limit cooldowns.
   - *Rationale:* Temporary network outages or engine reboots should self-heal upon successful rediscovery without waiting for manual operator intervention.
   - *Cost if wrong:* If an adapter erroneously reports a broken model as healthy, it might be retried once before failing back into cooldown.

5. **Ruling: Recovery Decisions Live in the Event Log (No New Table)**
   - *Decision:* Persist `recovery.*` / `task.recovery_*` decisions as durable events and read authoritative `runs`/`tasks`/`approvals`/`verification_checks` rows; no recovery table or migration was added (schema stays at v14).
   - *Rationale:* The event log already carries identity, ordering, retention, redaction, and live SSE delivery. A derived table would add a second write path that could diverge from the authoritative state, and `listTaskEvents()` provides the bounded chronological reads recovery needs.
   - *Revisit condition:* Introduce a table in a later migration only if recovery needs transactional idempotency keys across control-plane processes or indexed per-decision queries the event table cannot serve. That is a separate ruling.
   - *Cost if wrong:* Event-log scans for very old runs; mitigated by bounded `listTaskEvents` reads and indexed run/task event access.

6. **Ruling: Unknown External Outcome Is Terminal, Never Replayed**
   - *Decision:* An unmatched `task.tool_started`, a failed tool completion, or a granted approval without a persisted result terminalizes the task as `unknown_outcome`; recovery never opens a new engine turn for it. Cleanly completed tool calls are requeued only with their durable summaries injected as context.
   - *Rationale:* A dead process cannot prove whether an in-flight operation reached the outside world. Re-running would risk duplicate external side effects; treating it as success would fabricate a result. `unknown_outcome` is the only honest durable label.
   - *Cost if wrong:* Some tasks that could have been safely retried are parked for manual review; operators can inspect the workspace and create a follow-up task deliberately.

7. **Ruling: `verifying` Is Not Session-Backed; Evidence Owns Completion**
   - *Decision:* Recovery treats `verifying` separately from session-backed states. Complete current-attempt evidence goes through the normal verdict gate; pending or missing evidence stays visibly `verifying`.
   - *Rationale:* Work-complete-but-unverified is not a dead worker. Requeueing would duplicate finished work, while auto-completing would trust the worker's claim without evidence.
   - *Cost if wrong:* A crash between `running → verifying` and the first check row can leave a task awaiting operator verification; Phase B's evidence gate must define an explicit `NOT_REQUIRED` path for task types that need no checks.

8. **Ruling: Decomposition Is a Signal, Not a Controller (Phase 4 Batch 1)**
   - *Decision:* Task assessment (`TaskAssessment`) and worker allocation are deterministic heuristics recorded as durable `run.assessed` events and injected into the manager prompt as a bounded signal. The manager may follow or override the recommendation; every override is observable in the event log.
   - *Rationale:* Planning quality cannot be proven by code alone; the runtime validates and bounds what the manager produces but does not replace its judgment. A durable assessment enables before/after comparison against actual outcomes.
   - *Cost if wrong:* The manager could ignore the recommendation and over-delegate; run budgets (`max_tasks_per_run`, `max_concurrent_workers`, `max_delegation_depth`) remain the hard guard.

9. **Ruling: Observed Performance Is a Bounded, Non-Fabricated Routing Input (Phase 4 Batch 2)**
   - *Decision:* Model performance measurement (`ModelPerformanceMonitor`) records observed latency/success/failure/fallback/completion and reduces them to a summary. Unknown performance is `undefined`, never estimated. It adjusts the health score component within [-10, +10] and never overrides a hard eligibility decision.
   - *Rationale:* Capability-based routing needs an observed-performance signal to prefer models that actually complete tasks, but rule 13 (never fabricate metrics) forbids inventing data.
   - *Cost if wrong:* Routing remains capability-first; poorly performing models are not automatically excluded unless they fail hard requirements or health cooldowns.

10. **Ruling: Routing Decisions Are Durably Auditable (Phase 4 Batch 2)**
    - *Decision:* Every task model selection is recorded as a `run.model_selected` event containing the selected model, score, selection mode, candidates considered, eligible count, top exclusions, and whether observed performance was applied.
    - *Rationale:* Model selection must be explainable and reproducible; the event log is the authoritative source (consistent with Ruling 5).
    - *Cost if wrong:* Slightly larger event payload; bounded to top 10 exclusions.

11. **Ruling: DAG Readiness Is Never Compromised by Scheduling Policy (Phase 4 Batch 3)**
    - *Decision:* The scheduling policy layer only reorders and gates already-ready tasks; `listReadyTasks()` DAG readiness (every dependency completed) is unchanged and authoritative. Priority is a tie-break on FIFO, not preemption.
    - *Rationale:* Dependency correctness is a hard guarantee; adaptive priority is an optimization layered on top.
    - *Cost if wrong:* A mis-prioritized task waits longer, but dependencies are never violated.

12. **Ruling: Duplicate Intent Is Suppressed, Not Discarded (Phase 4 Batch 3)**
    - *Decision:* A task flagged as duplicate intent (overlapping write scope + similar title/brief) is left `queued` and a `task.duplicate_suppressed` event is emitted; it is never auto-deleted, auto-rejected, or auto-replayed. The operator or manager may re-inspect and re-delegate deliberately.
    - *Rationale:* Suppressing duplicate intent reduces redundant work, but discarding a task would lose work and violate the "never silently discard persisted work" principle.
    - *Cost if wrong:* A suppressed task blocks run quiescence until resolved (consistent with how lease-conflicted tasks already behave).

13. **Ruling: Observed Performance Is Cross-Tick but In-Process Only (Phase 4 Batch 3)**
    - *Decision:* The scheduler uses `dispatchedTaskRecords` (persistent within a run process) for cross-tick duplicate detection, but model-performance observations remain in-process (Batch 2 ruling) and are not persisted across runs. Cross-run duplicate detection and cross-run performance aggregation are deferred.
    - *Rationale:* Within-run duplicate prevention is achievable and bounded; cross-run state would require a new table/migration and owner direction.
    - *Cost if wrong:* The same duplicate intent could be dispatched in two separate run processes; operators must rely on the event log to detect and resolve it.

14. **Ruling: Clone-Based Isolation Retained; Git Worktrees Not Adopted (Phase 4 Batch 4)**
    - *Decision:* Per-task isolated clones (`git clone --local` under `.pluton/workspaces/<task-id>`, branch `pluton/<run>/<slug>`, Pluton ownership marker) remain the isolation boundary. Git worktrees are NOT adopted (ADR-0005 mount-semantics risk; no tested volume strategy).
    - *Rationale:* Clones are self-contained with independent `.git`, work identically on Windows/macOS/Linux, and cleanup is simple (rmSync + marker guard). Worktrees share `.git` as a file indirection that is problematic for container mounts and untested on this stack.
    - *Cost if wrong:* Disk usage grows per task (mitigated by hardlinks + retention policy); revisit worktrees only with a tested volume/mount strategy.

15. **Ruling: Directory-Prefix Write-Scope Conflict Detection (Phase 4 Batch 4)**
    - *Decision:* `FileLeaseManager.hasConflict`/`declareScope` treats two paths as conflicting when they are identical OR one is a directory prefix of the other (`src/auth.ts` conflicts with `src/auth/` and vice versa). Exact-path and dependency-file cross-conflict rules are unchanged.
    - *Rationale:* Exact-path matching allowed two tasks with overlapping but non-identical scopes (e.g., a file and its containing directory) to run concurrently and silently overwrite each other. Prefix awareness closes that gap without filesystem calls.
    - *Cost if wrong:* Heuristic path-string matching (not symlink/junction-aware); Windows NTFS junctions remain a residual documented risk.

16. **Ruling: Lease TTL and In-Process Renewal (Phase 4 Batch 4)**
    - *Decision:* `FileLeaseManager` supports an optional `leaseTtlSeconds`; leases are renewed at each dispatch tick for in-flight tasks (`renewScope`) and stale leases are expired (`expireStaleLeases`). Lease persistence to SQLite (`file_leases` table) already exists; TTL expiry is in-process only (no new migration).
    - *Rationale:* A stalled task holds its write scope until TTL expiry instead of forever; recovery at startup releases leases for non-active tasks via `recoverLeases`. Persistence across crashes is already handled by the store; adding a TTL column/migration is deferred to an owner decision.
    - *Cost if wrong:* Stale leases for active tasks persist across restart until `recoverLeases` runs (which releases non-active task leases); a process SIGKILLed mid-task loses in-memory leases but store recovery handles it on restart.

