# PLUTON 4.0 Phase 3 (P2) — Persistence & Crash-Recovery Audit

**Date:** 2026-11-01  
**Milestone:** Phase 3 (P2), Batch A — Persistent Orchestration & Crash Recovery  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED` (Windows host); POSIX-only sandbox checks remain `BLOCKED BY ENVIRONMENT`

---

## 1. Executive Summary

Phase 3 Batch A audited every durable boundary a run depends on, then replaced the
supervisor's inline, state-only restart reconciliation with a dedicated
`RecoveryManager` that classifies the full durable record before writing anything.

The resulting recovery contract is deliberately conservative:

1. **No engine session is ever resumed.** A restarted process cannot own a dead
   process's engine session, so a session-backed task is either safely requeued or
   terminalized as `unknown_outcome`.
2. **No unknown external outcome is replayed.** Durable per-tool checkpoints pair
   tool starts with persisted completions. An unmatched start means the process
   died mid-operation, so the task is never re-run automatically.
3. **No completion is fabricated.** A `verifying` task is completed by recovery only
   when its current-attempt evidence rows are complete, consistent, and pass the
   same verdict gate used by `pluton verify`. Missing or pending evidence stays
   visibly `verifying`.
4. **No persisted work is silently discarded.** Completed tool summaries, existing
   child tasks, and the durable task list are injected into the next worker/manager
   prompt so a restarted process adopts persisted work instead of minting copies.
5. **Every recovery decision is durably auditable** as an event; no new table or
   migration was introduced.

Verification on this host: `npm run typecheck` passed, `npm run build` passed, and
`tests/integration/supervisor.test.ts` passed **63/63** tests (31.41 s), including
the full T1–T16 restart-reconciliation suite.

---

## 2. Persistence Architecture

### 2.1 Storage engine and durability settings

SQLite is opened through the single `openDatabase()` entry point
(`src/store/db.ts`), which applies:

| Pragma | Value | Meaning |
| :--- | :--- | :--- |
| `journal_mode` | `WAL` | Readers do not block the writer; committed transactions are fsync'd by SQLite. |
| `foreign_keys` | `ON` | Referential integrity is enforced on every connection. |
| `busy_timeout` | `5000` | Writer contention fails after 5 s instead of immediately. |
| `synchronous` | `NORMAL` | Recommended durability/throughput point for WAL. |

`withTx()` wraps multi-statement units in `BEGIN IMMEDIATE … COMMIT`, rolling back
on any error. A crash cannot leave a half-applied receipt/state/event batch inside
one transaction; either the whole unit is on disk or none of it is.

### 2.2 Schema history

The database is at **migration v14** (`verification-evidence-identity`). The audit
covered migrations v1–v14; Batch A added **no schema change**. Relevant tables:

- `runs` — goal, acceptance criteria, state, ownership token/heartbeat, summary.
- `tasks` — state, attempt, assignment snapshot, workspace/session ids, result,
  failure.
- `task_edges` — dependency DAG.
- `events` — append-only, monotonically sequenced audit log (the source for SSE
  deltas and recovery decisions).
- `approvals` — operator gate; only `pending` may be decided.
- `verification_checks` / `verifications` — per-attempt command evidence and
  independent verdicts.
- `workspaces` / leases / receipts / chat and plan tables — supporting durable
  state.

### 2.3 Durable vs transient state

| State | Location | Survives process death? | Recovery authority |
| :--- | :--- | :--- | :--- |
| Run goal, acceptance, budget, state | `runs` | Yes | Authoritative |
| Run ownership (PID/token/heartbeat) | `runs` | Yes (stale) | Reclaim only after heartbeat TTL |
| Task state, attempt, result, failure | `tasks` | Yes | Authoritative |
| Task dependencies | `task_edges` | Yes | Authoritative |
| Event log, including recovery decisions | `events` | Yes | Audit + live UI deltas |
| Approvals and decisions | `approvals` | Yes | Authoritative |
| Verification checks/evidence | `verification_checks` | Yes | Verdict input |
| Workspace checkout records | `workspaces` + on-disk markers | Yes | Reattach/archive/create |
| File leases | lease files + `leases` table | Yes (stale) | Recovered/reaped |
| Live engine session | Engine process | **No** | Never resumed |
| In-process approval waiters | Memory | **No** | Expired, not re-bound |
| Manager conversation | Engine process | **No** | New prompt with durable context |
| Tool start/end stream | Memory → `task.tool_started` / `task.tool_completed` events | Yes at boundaries | Duplicate-execution classifier |

### 2.4 Transaction and fencing boundaries

The store enforces the following invariants at the mutation boundary:

- **Single-owner run claim:** `claimRunSupervisor()` is one `UPDATE … WHERE
  supervisor_token IS NULL OR heartbeat expired`, so two supervisors can never own
  a run concurrently. Heartbeat renewal and release are token-CAS statements.
- **Fenced supervisor writes:** every supervisor duty write passes
  `SupervisorFence { runId, token }`. A stale owner's write is a 0-row no-op and is
  classified as `OwnershipLostError`, never silently applied.
- **State CAS:** `setRunState` and `setTaskState` include the pre-read state in the
  `WHERE` clause (`AND state = ?`), so a concurrent control-plane decision can
  never be resurrected by a stale writer.
- **Approval finality:** only `pending` may move to `approved|denied|expired`; a
  decided row is immutable (re-setting the same status is an idempotent no-op).
- **Verification finality:** only `pending` check rows may receive a result; a
  decided check's evidence cannot be rewritten.
- **Idempotent admission:** `admitRequest()` runs receipt lookup, target creation,
  and receipt completion inside one `BEGIN IMMEDIATE` transaction; the same request
  id with a different payload is a hard conflict.
- **Bounded event payloads:** `appendEvent()` redacts secrets, strips control
  characters, and rejects payloads above the configured cap.

**Known atomicity gap:** a task/run state write and its accompanying event append
are separate statements (not one transaction). The state tables are the source of
truth; a crash between the two can lose the audit event but never the task result
or a later recovery decision. This is recorded as a residual risk in §9.

---

## 3. Crash-Point Matrix

| Crash point | Durable evidence at restart | Recovery action | External duplicate risk |
| :--- | :--- | :--- | :--- |
| Before run claim | Run `created`, no tasks | Nothing to recover; normal startup | None |
| After claim, before `created → active` | Stale token/heartbeat | Next owner waits for TTL, then takes over; run still `created` | None |
| After `active`, before manager planner | No tasks or partially persisted tasks | Manager starts with durable task list; persisted tasks are resumed, not duplicated | Planner may add new work; existing rows are never copied |
| During task session startup | Task `admitted`, no tool checkpoint | Requeue (attempt + 1), abandon stale session id | None |
| During a tool call | `task.tool_started` with no matching completion | Terminalize `unknown_outcome` (`recovery_unknown_tool_outcome`); never replay | **Prevented** |
| After a tool completed, before task result write | Paired start/completion events | Requeue with completed-tool summaries injected into the next prompt | Reduced; model is instructed to inspect, not repeat |
| During task result/state write | Either old session-backed state or `verifying` with result | Requeue if old state; verdict from evidence if `verifying` | No result is dropped |
| During verification command | `verification_checks` rows in `pending` | Stay `verifying` (`recovery.verification_interrupted`) | Check is not marked green |
| After verification rows complete, before verdict | Complete current-attempt evidence | Apply the normal verdict gate (`recovery.verification_resumed`) | None |
| During approval wait | Pending approval + `needs_approval` task | Expire with `decidedBy: 'pluton:recovery'`, requeue | Engine was blocked before execution |
| After approval granted, before tool result | Approval `approved`, no persisted tool completion | `unknown_outcome` (`recovery_approval_unconfirmed`); never replay | **Prevented** |
| Run parked in `awaiting_approval` | Pending approvals | Expire pending rows, resume run to `active` | None |
| Run parked in `awaiting_input` | No durable waiter | Stay parked; manager suppressed | None |
| After all tasks terminal, before run finalize | Terminal task rows | Finalize from durable counts; manager receives the durable task list | Planner sees existing rows instead of blind re-planning |
| During checkout provisioning | Workspace row and/or on-disk marker | Reattach valid checkout; archive invalid one; create fresh if gone | No silent deletion of dirty work |

---

## 4. Recovery Policy (Normative)

The policy is implemented in `src/orchestrator/recovery.ts` and applies only after
the new supervisor has claimed the run.

### 4.1 Run ownership

- Claim is state-blind; a terminal control-plane write during startup wins.
- A stale owner is reclaimed only after its heartbeat is at or before
  `now − TTL`; a NULL heartbeat counts as expired.
- Every recovery write carries the new claim's fence.

### 4.2 Parked runs

- `awaiting_approval`: every pending approval is expired with an audit event
  (`approval.expired`, reason `supervisor_restart`) and then the run is resumed to
  `active` (`recovery.run_resumed`). If a control-plane write already terminalized
  the run, recovery stops and adopts that winner.
- `awaiting_input` / `verifying`: the run stays parked and the manager is
  suppressed, because there is no durable waiter or only the evidence gate remains.
- Terminal: no task writes, no manager startup.

### 4.3 Session-backed tasks

`SESSION_BACKED_TASK_STATES` = `admitted`, `running`, `waiting_for_children`,
`needs_input`, `needs_approval` (the state machine intentionally excludes
`verifying`).

1. If the task's approval was already **granted**, the engine may have executed the
   approved operation; the result was never persisted → `unknown_outcome`
   (`recovery_approval_unconfirmed`).
2. Fold all `task.tool_started` / `task.tool_completed` events for the **current
   attempt**:
   - Any unmatched start → `unknown_outcome` (`recovery_unknown_tool_outcome`).
   - Any completed tool with `isError: true` → `unknown_outcome` (a failed tool may
     still have produced partial external effects).
3. Otherwise, if `attempt >= max_retries_per_task` → `unknown_outcome`
   (`recovery_exhausted`, prior state preserved in the message).
4. Otherwise requeue: CAS to `queued`, `attempt + 1`, clear `engineSessionId`;
   append `task.recovered` (with up to 12 completed-tool summaries) and
   `task.session_abandoned` when a session id existed.

### 4.4 Verification tasks

- No current-attempt check rows → stay `verifying`, emit
  `recovery.verification_missing`. The operator must re-run verification.
- Any `pending` check → stay `verifying`, emit
  `recovery.verification_interrupted` with the pending check names.
- All checks final → call the same `applyTaskVerificationVerdict()` used by the CLI
  and HTTP API. Incomplete/inconsistent evidence raises, and recovery emits
  `recovery.verification_blocked` instead of guessing.
- If the run itself is `verifying`, `finalizeRunVerdict()` is re-run after task
  decisions so the run can close or re-dispatch unblocked dependents.

### 4.5 Approvals

- A pending approval whose in-process waiter died is expired, never re-bound.
- A granted approval without a persisted result is an unknown outcome, never a
  retry.
- Expiry is auditable and visible to every operator surface.

### 4.6 Continuation context

- A requeued task's prompt gets the `task.recovered` completed-tool summaries and
  a list of all existing child tasks with state and title, so it inspects durable
  work instead of re-delegating duplicates.
- A restarted manager's prompt lists every durable task (id, state, title, parent)
  and explicitly instructs it to resume/inspect rather than create duplicates.

### 4.7 Recovery budget

Recovery uses the same `max_retries_per_task` budget as normal retries. An exhausted
task is terminalized as `unknown_outcome`; it is never silently dropped or rerun.

---

## 5. Implementation

### 5.1 New module: `src/orchestrator/recovery.ts`

- `RecoveryManager.recover()` returns a `RecoveryReport`:
  `runId`, `decisions`, `requeued`, `unknownOutcome`, `verificationResumed`,
  `verificationPending`, `approvalsExpired`, `runResumedFrom`, `suppressManager`,
  `durationMs`.
- `RecoveryDecision` records `taskId`, `priorState`, `action`, `attempt`, `reason`.
- `analyzeToolCheckpoints()` folds checkpoint events with the same pairing rules as
  `isSafeToReplay()` (call id first, anonymous events close the most recent open
  call). It is pure and unit-testable.
- Every decision writes a durable event; the pass ends with
  `run.recovery_completed` carrying counts and duration.
- Concurrent state changes are handled with from-state CAS writes; a lost CAS
  returns `no_action` and is never reported as a completed recovery action.

### 5.2 Supervisor wiring (`src/orchestrator/supervisor.ts`)

Startup order is now:

1. Claim run (`claimRunSupervisor`) and write `run.supervisor_claimed`.
2. `created → active` (or adopt a terminal control-plane winner).
3. `recoverLeases` + `reapOrphanedLeases`.
4. `RecoveryManager.recover()`.
5. Bounded model discovery (10 s).
6. Manager session, unless recovery suppresses it.

Additional changes:

- `runPrompt` writes `task.tool_started` / `task.tool_completed` checkpoints for
  task-scoped turns (including the model-fallback turn), bounded to 120 chars for
  names/call ids and 300 for summaries, with control characters stripped.
- `buildTaskPrompt` accepts an optional recovery note; `crashRecoveryNoteFor()`
  reads the latest `task.recovered` row for the current attempt and injects
  completed-tool and child-task context.
- `buildManagerPrompt` accepts the durable task list and instructs the manager to
  resume existing work.
- Finalize treats a recovery-suppressed manager as a legitimate startup: it does
  not persist the synthetic `"resumed worker dispatch"` label over the run summary.

### 5.3 Store support (`src/store/store.ts`)

- `listTaskEvents(taskId, { types, limit })` returns the newest N matching events
  in chronological order — a bounded read for hot recovery paths.

---

## 6. Duplicate-Execution Risk Register

| Risk | Mitigation | Residual exposure |
| :--- | :--- | :--- |
| Replaying a tool whose result was never persisted | Unmatched start → `unknown_outcome`; no engine turn is opened | None within the recorded checkpoint model |
| Replaying a failed tool | Tool error → `unknown_outcome` | None |
| Re-running an externally visible operation after a clean completion | Completed-tool summaries injected; model told to inspect | The model can still choose to repeat a completed call; Pluton does not claim exactly-once effects |
| Duplicate child tasks after a parent crash | Existing child ids/states injected into the parent prompt | A model may ignore context; `maxChildrenPerTask`/`maxTasks` remain the hard bound |
| Duplicate planning after a manager crash | Durable task list injected into the restarted manager prompt | Dynamic planning is preserved; no conversation replay |
| Double verification | `verification_checks` are per attempt; a fresh run supersedes old rows; only final rows count | None |
| Double approval side effects | Granted approval without persisted result → `unknown_outcome` | None |
| Two supervisors on one run | Token/heartbeat CAS + fenced writes | None while the clock is sane; a manually forged token would require DB access |

**Non-claim:** the system does not provide exactly-once semantics for arbitrary
external side effects. It provides durable at-most-once *recovery* behavior for
operations whose outcome Pluton cannot prove, and evidence-based completion for
work it can prove.

---

## 7. Architectural Ruling: No Recovery Table

**Decision:** recovery decisions are persisted as events (`recovery.*`,
`task.recovery_*`), not as a new relational table.

**Rationale:**

- The event log already carries project/run/task identity, monotonic ordering,
  retention, redaction, and live SSE delivery.
- Recovery reads the authoritative `runs`, `tasks`, `approvals`, and
  `verification_checks` rows; it does not need a second derived state store.
- The required queries (latest decision per task, decision counts, audit trail) are
  satisfiable with indexed event reads; `listTaskEvents` provides a bounded,
  chronological read.
- Avoiding a migration keeps v14 database compatibility and removes a second write
  path that could diverge from the event log.

**Revisit condition:** if operators need transactional idempotency keys for
recovery decisions (for example, replaying the same recovery pass across multiple
control-plane processes) or indexed per-decision queries that the event table
cannot serve within latency bounds, introduce a dedicated table in a later
migration. That would be a separate architectural ruling, not an implicit change.

---

## 8. Test Coverage and Verification Evidence

### 8.1 Restart-reconciliation suite (`tests/integration/supervisor.test.ts`)

| Test | Scenario | Result |
| :--- | :--- | :--- |
| T1 | Running task requeued; dead session abandoned and id cleared | PASS |
| T2 | Admitted task (claimed, no session) requeued | PASS |
| T3 | `needs_approval` task recovered defensively | PASS |
| T4 | Exhausted recovery budget → `unknown_outcome`, no rerun | PASS |
| T5 | Same checkout reattached with dirty state preserved | PASS |
| T6 | Invalid checkout marker archived, fresh checkout created | PASS |
| T7 | Missing checkout row marked removed, fresh checkout created | PASS |
| T8 | Interrupted verification stays `verifying` | PASS |
| T9 | Complete durable evidence applies verdict and completes | PASS |
| T10 | Unmatched tool start refuses replay (`unknown_outcome`) | PASS |
| T11 | Paired tool completion requeues with injected context | PASS |
| T12 | Pending approval expired; parked run resumed; task requeued | PASS |
| T13 | Granted approval without result → `unknown_outcome` | PASS |
| T14 | Already-terminal task untouched | PASS |
| T15 | Multiple stranded workers recovered independently | PASS |
| T16 | Requeued parent receives durable child context | PASS |

Additional assertions cover the manager prompt's durable-task section.

### 8.2 Commands run

| Command | Environment | Result | Counts / runtime |
| :--- | :--- | :--- | :--- |
| `npm run typecheck` | Windows 11, Node.js v24.20.0 | **PASSED** | 0 errors |
| `npm run build` | Windows 11, Node.js v24.20.0 | **PASSED** | 0 errors |
| `npx vitest run tests/integration/supervisor.test.ts` | Windows 11, NTFS | **PASSED** | 63/63 tests, 1 file, 31.41 s (tests 97%) |

No skips were reported in the focused suite.

### 8.3 Environment limitation

POSIX-only checks (Linux Landlock, POSIX file permissions) cannot execute on this
Windows host: `BLOCKED BY ENVIRONMENT`. They are not claimed as verified here and
must run on a Linux CI runner.

---

## 9. Residual Risks and Recommended Follow-ups

1. **State/event write gap.** A crash between a state CAS and its event append can
   lose one audit event (state remains correct). Recommendation: add a
   `setTaskStateWithEvent` store primitive using `withTx` for the highest-value
   transitions (task completion/failure, run finalization) in a later batch.
2. **`verifying` with no evidence.** If a process dies after a successful task
   entered `verifying` but before any verification check row exists, recovery
   leaves it `verifying` and requires operator verification. This is intentional
   (no evidence, no green). Phase B's evidence-based gate should define the
   `NOT_REQUIRED` path for task types that genuinely need no checks.
3. **Completed-tool replay is advisory.** The model is told to inspect completed
   calls, but Pluton does not mechanically prevent a repeated call that already
   completed cleanly. Hard prevention would require tool-level idempotency keys,
   which the engine contract does not currently expose.
4. **Manager planning is resumed, not replayed.** The manager receives durable task
   rows but not its previous conversation. Dynamic plans that were never persisted
   remain unpersisted; this is preferable to duplicating existing work.
5. **Checkpoint completeness depends on engine events.** ACP normalizes tool-call
   creation to `start` and completion to `end`; an adapter that hides a tool until
   after it ran could under-report an in-flight operation. Any new engine adapter
   must preserve the start/end contract.
6. **Clock skew.** Ownership takeover trusts the host clock for heartbeat TTL.
   Multi-host deployments would need a monotonic or database-time source.

---

## 10. Files Changed in Batch A

| File | Change |
| :--- | :--- |
| `src/orchestrator/recovery.ts` | **New.** Recovery manager, policy classification, tool-checkpoint folding, durable decisions. |
| `src/orchestrator/supervisor.ts` | Recovery wiring, tool checkpoints, crash/child context, durable manager context, suppression handling. |
| `src/store/store.ts` | `listTaskEvents()` bounded chronological task-event read. |
| `tests/integration/supervisor.test.ts` | T8–T16 recovery tests plus manager-prompt context assertions. |
| `docs/optimization/07-PERSISTENCE-RECOVERY-AUDIT.md` | This audit. |
| `docs/optimization/PROGRESS.md` | Phase 3 Batch A status and ruling ledger update. |

---

## 11. Sign-off

Batch A is **OPTIMIZED AND VERIFIED** on this host for TypeScript compilation,
production build, and the complete restart-reconciliation integration suite.
Recovery never resumes a dead session, never auto-replays an unknown external
outcome, and never fabricates a completion from missing evidence. POSIX-only
sandbox verification remains `BLOCKED BY ENVIRONMENT`.
