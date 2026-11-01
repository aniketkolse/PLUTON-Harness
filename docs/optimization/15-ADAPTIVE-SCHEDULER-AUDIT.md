# PLUTON 4.0 Phase 4 (P2+) — Adaptive Scheduler Audit

**Date:** 2026-11-01  
**Milestone:** Phase 4, Batch 3 — Adaptive Scheduler & Agent Coordination  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED` (audit only; implementation pending)

---

## 1. Executive Summary

Batch 3 audits PLUTON's task scheduling and agent-coordination layer and identifies where it can be made more adaptive without replacing the working architecture. The scheduler is correct and bounded (DAG validation, `maxConcurrentWorkers` cap, write-scope leases, circuit breaker, recovery), but it is **non-adaptive**: it dispatches purely FIFO by `created_at`, has no priority/fairness policy, no duplicate-work detection, no resource-awareness beyond concurrency + write-scope leases, and does not consume the `TaskAssessment` or `ModelPerformanceMonitor` signals built in Batches 1–2.

Batch 3 will add a deterministic, explainable scheduling policy layered on top of the existing scheduler — readiness, priority/fairness, resource-aware allocation, adaptive parallelism, duplicate-work prevention, and durable scheduling events — while never exceeding `maxConcurrentWorkers`, never bypassing verification, and never replaying uncertain external side effects.

---

## 2. Existing Scheduling Architecture (Verified)

### 2.1 Components

| Component | Location | Role |
| :--- | :--- | :--- |
| Task readiness | `listReadyTasks()` (`src/store/store.ts:886`) | Queued tasks whose every `depends_on` target is `completed`; ORDER BY `created_at ASC, id ASC` (pure FIFO). |
| Task admission | `admitTask()` (`src/orchestrator/task-graph.ts`) | Budget, depth, fan-out, cycle, run-state validation in one `BEGIN IMMEDIATE` transaction. |
| DAG | `src/domain/task-graph.ts` | Cycle detection, edge semantics (`from` depends on `to`). |
| Dispatch loop | `dispatchReadyTasks()` (`src/orchestrator/supervisor.ts:1669`) | Iterates ready tasks; skips in-flight; bounds by `maxConcurrentWorkers`; checks write-scope lease conflicts; declares scope; dispatches executor. |
| Executor | `executeTask()` (`src/orchestrator/supervisor.ts`) | Claims task `queued → admitted`, provisions checkout, starts engine session, runs prompt, settles state. |
| Circuit breaker | `src/orchestrator/circuit-breaker.ts` | Identical-failure tripping (consecutive identical failures threshold); resets on manager-requested revision. |
| KeyedMutex | `src/orchestrator/mutex.ts` | Per-Ship serialization within one process (tasks assigned to the same Ship run one at a time). |
| Wakeup registry | `src/orchestrator/wakeups.ts` | Event-driven child settlement; parent waits on child channel; poll fallback on timeout. |
| Lease manager | `src/orchestrator/lease-manager.ts` | File-scope declaration/conflict detection; `recoverLeases()` releases leases of non-active tasks at restart. |
| RecoveryManager | `src/orchestrator/recovery.ts` (Batch A) | Startup reconciliation; requeues session-backed tasks; terminalizes unknown outcomes. |
| TaskAssessment | `src/orchestrator/task-assessment.ts` (Batch 1) | Deterministic complexity/worker estimate recorded as `run.assessed`; injected into manager prompt only. |
| ModelPerformanceMonitor | `src/engines/model-performance.ts` (Batch 2) | Observed performance observations/summaries; used only in model selection. |

### 2.2 Dispatch contract (current)

`dispatchReadyTasks()` is called each tick and after child settlement:

1. If circuit breaker tripped (and no manager-requested revision), stop.
2. For each ready task (FIFO by `created_at`):
   - Skip if already in flight (`this.inFlight.has(task.id)`).
   - Stop when `inFlight.size >= maxConcurrentWorkers`.
   - Check write-scope lease conflicts; skip task on conflict (emit `task.blocked_by_lease`).
   - Declare write scope; skip if conflicts.
   - Record lease; dispatch `executeTask()`.
3. `executeTask()` CAS-claims `queued → admitted`; provisions checkout; starts engine session; runs prompt; settles to `verifying`/`completed`/`failed`/etc.

### 2.3 Guarantees preserved

- DAG validation: dependencies must complete before dependents become ready (`listReadyTasks` SQL).
- Concurrency bound: `inFlight.size >= maxConcurrentWorkers` stops dispatch.
- Write-scope isolation: conflicting file scopes are not dispatched concurrently.
- Circuit breaker: identical automatic retries are capped; manager-requested revisions override.
- Recovery: dead-session tasks requeued as `unknown_outcome` when outcome cannot be proven.
- Verification: `verifying` tasks are not dispatched; they await the evidence gate.
- No task state is silently discarded; failed/unfinished tasks remain visible.

---

## 3. Audit Findings & Architectural Gaps

### Gap 1 — No priority or fairness policy (HIGH impact)

`listReadyTasks()` orders purely by `created_at ASC, id ASC`. There is:

- No concept of task priority or urgency.
- No starvation prevention: a long-running run that admits many tasks first can starve a later run's tasks within the same supervisor process (though runs are isolated per supervisor instance, within one run the manager's admission order dominates).
- No dependency-criticality awareness: a task blocking many dependents is not prioritized over a leaf task.

### Gap 2 — No duplicate-work detection (MEDIUM impact)

Duplicate work is caught only indirectly:

- `max_tasks_per_run` / `max_child_tasks_per_task` budget caps.
- Write-scope lease conflicts (same file → serialized, not deduplicated).
- `task-graph.ts` cycle and duplicate-dependency validation.

Nothing detects:

- Duplicate task titles/briefs within a run.
- Overlapping write scopes that do not conflict exactly but duplicate effort.
- Repeated research requests on the same topic.
- Cross-run duplicate goals (no global task identity index).

Relying exclusively on lease conflicts means duplicate *intent* can proceed in parallel as long as files differ.

### Gap 3 — No resource-aware scheduling beyond concurrency + write-scope (MEDIUM impact)

Scheduling considers:

- `maxConcurrentWorkers` (global in-flight cap).
- Per-Ship KeyedMutex (one task at a time per Ship in-process).
- Write-scope leases (file-level conflict).

It does NOT consider:

- Model availability / performance (Batch 2 signal ignored at schedule time).
- Task assessment worker-count recommendation (Batch 1 signal ignored at schedule time).
- Workspace ownership / checkout state.
- Whether a Ship's engine session is healthy or in cooldown.
- System/database pressure.

### Gap 4 — TaskAssessment not integrated into scheduling (MEDIUM impact)

Batch 1 computes `estimatedWorkers`, `strategy` (`single` / `small_parallel` / `bounded_parallel` / `sequential_fallback`), and records `run.assessed`, but:

- The assessment is only injected into the manager prompt as a signal.
- The dispatch loop does not consult it; parallelism is still decided by the manager's `task.create`/`task.delegate` calls and bounded only by `maxConcurrentWorkers`.
- No "sequential fallback" is enforced when the assessment says parallelism is unsuitable.

### Gap 5 — ModelPerformanceMonitor not integrated into scheduling (LOW impact)

Batch 2's observed performance is used only in `selectModel` (model routing). It is not consulted when deciding *whether* to dispatch a task to a given Ship/model pair.

### Gap 6 — No explicit worker availability beyond in-flight set (LOW impact)

`inFlight` tracks tasks with active engine sessions. There is no:

- Per-Ship session health / cooldown awareness at dispatch time.
- Tracking of how long a task has been in flight (stalled-worker detection).
- Abandoned-task detection between restarts (handled only at startup by RecoveryManager).

### Gap 7 — Scheduling decisions are not auditable (LOW impact)

When `dispatchReadyTasks()` skips a task (lease conflict, concurrency cap, circuit breaker), it emits `task.blocked_by_lease` for conflicts but no event for "deferred due to concurrency cap" or "deferred due to circuit breaker" or "dispatched because assessment recommends parallelism". Operators cannot reconstruct *why* a task ran when it did.

---

## 4. Proposed Improvements (Batch 3 Scope)

All improvements are **additive and bounded**: they layer policy on top of the existing scheduler without replacing `executeTask`, `listReadyTasks`, `admitTask`, or the circuit breaker.

### 4.1 Deterministic scheduling policy

Add `src/orchestrator/scheduling-policy.ts` with:

- `scheduleReadiness(tasks, edges)` — reuses `listReadyTasks()` semantics (dependencies completed); no change to DAG correctness.
- `schedulePriority(readyTasks, assessment)` — stable ordering tie-break on top of FIFO:
  1. Tasks blocking the most unblocked dependents first (dependency criticality).
  2. Then FIFO `created_at`.
  - Never reorders across `created_at` more than necessary; preserves FIFO as the baseline so starvation is bounded by admission order.
- `scheduleAllocation(assessment, maxConcurrentWorkers, inFlight)` — adapts `allocateWorkers()` from Batch 1:
  - `single` → dispatch at most 1 task for this assessment cluster.
  - `small_parallel` / `bounded_parallel` → dispatch up to `estimatedWorkers` (capped by `maxConcurrentWorkers - inFlight.size`).
  - `sequential_fallback` → dispatch 1; wait for settlement before next.
- Resource-aware check: skip dispatch if the Ship's model is in cooldown (`ModelPerformanceMonitor` summary shows repeated failures) — conservative, never fabricates.
- Emit `task.scheduled` / `task.deferred` durable events with reason so decisions are explainable.

### 4.2 Duplicate-work prevention

Add `src/orchestrator/duplicate-work-prevention.ts`:

- `detectDuplicateIntent(store, runId, candidateTask)` — compares candidate against existing tasks in the run by:
  - Same `writeScope` overlap (file-level) AND high title/brief similarity → candidate duplicate.
  - Same acceptance criteria AND similar brief → candidate duplicate.
- On detected duplicate: do not dispatch; emit `task.duplicate_suppressed` and leave task `queued` (not terminal — operator/manager can re-inspect). Never auto-delete or auto-reject; that would discard work.
- Bounded similarity: simple token overlap on title/brief (deterministic, no model calls, no semantic embedding).
- Does not block legitimately independent tasks with similar descriptions but disjoint scopes.

### 4.3 Worker availability & stalled-task handling

- Track `taskStartedAt` per in-flight task (already have in-flight set; add start timestamp).
- On dispatch tick, if an in-flight task exceeds `defaultTaskTimeoutMs` without settlement, the existing supervisor interrupt path handles it (session.interrupt on timeout). No new retry; preserve fail-closed behavior.
- No automatic task reassignment (rule 12: never auto-replay uncertain side effects; rule 10: no unlimited retries).

### 4.4 Integration with Batch 1 & Batch 2 signals

- At dispatch, read the run's `run.assessed` event (TaskAssessment) and use `strategy`/`estimatedWorkers` as the *advisory* parallelism cap for the run, never exceeding `maxConcurrentWorkers`.
- At model resolution (already Batch 2), `ModelPerformanceMonitor` summary informs routing; scheduling does not independently route models (preserves single fallback authority).
- Unknown assessment/performance → conservative (FIFO, single-worker-per-Ship via KeyedMutex, no parallelism boost).

---

## 5. What Is NOT in Scope (Preserve Working Architecture)

- Replacing `dispatchReadyTasks()` / `executeTask()` — kept intact.
- Replacing `KeyedMutex` with distributed locking — in-process mutex is sufficient; cross-process exclusion is via store CAS + fences.
- Automatic task reassignment on worker failure — unsafe (rule 12); recovery handles restart.
- Semantic duplicate detection via embeddings/model calls — non-deterministic, expensive, and unproven; token-overlap only.
- Persisting performance across processes — `ModelPerformanceMonitor` remains in-process (Batch 2 ruling); scheduling uses it only as a live signal.

---

## 6. Acceptance Criteria (Measurable)

| # | Criterion | How measured |
| :--- | :--- | :--- |
| 1 | DAG dependency correctness preserved | `task-graph.test.ts`, `supervisor.test.ts` readiness cases still pass; no ready task has an uncompleted dependency. |
| 2 | `maxConcurrentWorkers` never exceeded | `inFlight.size` assert in tests; dispatch stops at cap. |
| 3 | Priority ordering deterministic | Same input ready set → same dispatch order; dependents-blocking tasks dispatched before leaf tasks when both ready. |
| 4 | Duplicate intent suppressed, not discarded | Duplicate candidate stays `queued`; `task.duplicate_suppressed` event emitted; no auto-deletion. |
| 5 | Adaptive parallelism respects assessment | `sequential_fallback` → 1 concurrent task for that run's cluster; `bounded_parallel` → up to `estimatedWorkers` (capped). |
| 6 | Scheduling decisions auditable | `task.scheduled` / `task.deferred` / `task.duplicate_suppressed` events contain reason + assessment reference. |
| 7 | No new dependencies; typecheck + build + tests pass | `npm run typecheck`, `npm run build`, focused scheduler suites. |

---

## 7. Residual Risks & Limitations

1. Priority is a tie-break on FIFO, not a strict preemption system; a long-running low-priority task still occupies a worker slot until it settles (bounded by `defaultTaskTimeoutMs` + supervisor interrupt).
2. Duplicate detection is token-overlap based; near-duplicates with disjoint write scopes may still proceed (intended — not blocked).
3. `run.assessed` is read from events at dispatch; if the event is missing (pre-Batch-1 runs), scheduling falls back to conservative FIFO + `maxConcurrentWorkers`.
4. Model performance is not persisted across processes (Batch 2 ruling); scheduling signal is live only.
5. No cross-run fairness (runs are isolated per supervisor instance).

---

## 8. Files To Be Changed (Planned)

| File | Change |
| :--- | :--- |
| `src/orchestrator/scheduling-policy.ts` | **New.** Deterministic readiness, priority, allocation, deferred/scheduled events. |
| `src/orchestrator/duplicate-work-prevention.ts` | **New.** Token-overlap duplicate-intent detection. |
| `src/orchestrator/supervisor.ts` | Integrate policy into `dispatchReadyTasks()`; emit `task.scheduled`/`task.deferred`/`task.duplicate_suppressed`; consult `run.assessed`. |
| `tests/unit/scheduling-policy.test.ts` | **New.** Readiness, priority, allocation, duplicate, bounded-concurrency tests. |
| `tests/integration/supervisor.test.ts` | Add scheduling integration cases (priority, duplicate, adaptive parallelism). |
| `docs/optimization/15-ADAPTIVE-SCHEDULER-AUDIT.md` | This audit. |
| `docs/optimization/PROGRESS.md` | Batch 3 status + rulings 11–13. |

---

## 9. Sign-off

Audit complete. No implementation files modified yet. The scheduler is correct and bounded; Batch 3 will layer adaptive policy on top without replacing it.

**Next:** Step 2 — define scheduling policy and implement `scheduling-policy.ts`.
