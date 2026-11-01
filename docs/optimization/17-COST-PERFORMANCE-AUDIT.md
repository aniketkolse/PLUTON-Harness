# PLUTON 4.0 Phase 4 (P2+) — Cost, Latency & Quality Optimization Audit

**Date:** 2026-11-01  
**Milestone:** Phase 4, Batch 5 — Cost, Latency & Quality Optimization  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED` (audit only; implementation pending)

---

## 1. Executive Summary

Batch 5 audits PLUTON's execution efficiency across model usage, token consumption, latency, parallelism, context management, and task completion quality. The goal is to establish measurable baselines *before* introducing optimizations, and to never present estimated values as observed measurements.

Key finding: PLUTON already has significant instrumentation (usage ledger, model performance monitor, recovery duration, task assessment), but **no end-to-end duration measurement** exists for runs, tasks, or workers. Every timing value is a configuration bound (runDeadlineMs, defaultTaskTimeoutMs), not an observed measurement. Token/cost tracking exists but defaults to zero budgets (no limits enforced). Context compaction exists but its usage is not measured.

No optimization should be implemented without a measured before/after comparison.

---

## 2. Existing Instrumentation Inventory

### 2.1 Model usage — `src/engines/model-performance.ts` (Batch 2) + `src/orchestrator/usage-ledger.ts`

| Metric | Source | Classification |
| :--- | :--- | :--- |
| Model selection frequency | `run.model_selected` events (Batch 2) | Observed (durable) |
| Model selection score/exclusions | `run.model_selected` event payload | Observed (durable) |
| Fallback frequency | `model_performance` observations (category `fallback`) | Observed (in-memory only, not persisted) |
| Failed requests | `model_performance` (category `failure`) | Observed (in-memory only) |
| Request latency | `model_performance` (category `latency`, valueMs) | Observed (in-memory only) |
| Input/output tokens | `UsageLedger.record()` → `run_usage` table | Observed (durable, when store attached) |
| Cached tokens | `UsageLedger` (`cached_tokens`) | Observed (durable, when store attached) |
| Cost (USD) | `UsageLedger` (`costUsd`) | Observed (durable, may be 0 on free/local models) |
| Per-ship token/cost totals | `UsageLedger.getSummary()` / `store.getRunUsage()` | Derived (durable) |
| Per-run token/cost totals | `store.getRunUsage()` | Derived (durable) |
| Pricing metadata | `model_selection_config_schema` (`costPreference`, `maxCostUsdPerMillionTokens`) | Config (not observed) |

**Gap:** Model performance observations (latency, success/failure, fallback) are in-memory only (Batch 2 ruling #13) and not persisted across runs. No cross-run model quality aggregation exists.

### 2.2 Execution efficiency

| Metric | Source | Classification |
| :--- | :--- | :--- |
| Run duration | None — only `runDeadlineMs` bound (config) | Unavailable |
| Task duration | None — only `defaultTaskTimeoutMs` bound (config) | Unavailable |
| Worker startup/shutdown overhead | None | Unavailable |
| Queue wait time | None | Unavailable |
| Worker utilization | None | Unavailable |
| Parallelism efficiency | None | Unavailable |
| Scheduling overhead | None | Unavailable |

**Gap:** Zero observed timing data for run/task/worker execution. All timing is configuration, not measurement.

### 2.3 Context efficiency

| Metric | Source | Classification |
| :--- | :--- | :--- |
| Manager prompt size | `max_prompt_chars` cap (config, 60k default) | Config (not measured) |
| Worker prompt size | `max_prompt_chars` cap (config) | Config (not measured) |
| Recovery context size | `crashRecoveryNoteFor()` output (bounded to 12 tools + children) | Observed (can be measured from events) |
| Tool-result retention | `MAX_RESULT_TEXT_CHARS` (50k) | Config (not measured) |
| Context truncation | `BoundedText.take()` (`textTruncated` flag) | Observed (flag present, not aggregated) |
| `compactContext()` log compaction | `compactContext()` (maxLogLines=10 default) | Utility exists, usage not measured |

**Gap:** No aggregation of actual prompt sizes, truncation frequency, or recovery context overhead across runs.

### 2.4 Task quality

| Metric | Source | Classification |
| :--- | :--- | :--- |
| Verification outcomes | `verification_checks` table + `run.verification_resumed` events | Observed (durable) |
| Retry frequency | Circuit breaker (`recordFailure`) + `task.retry_scheduled` events | Observed (durable) |
| Recovery success | `task.recovered` / `task.recovery_unknown_outcome` events + `RecoveryReport.durationMs` | Observed (durable) |
| Completion rate | Task terminal states (`completed`/`failed`/etc.) | Derived (durable) |
| Failed/incomplete tasks | `task.failed`/`task.unknown_outcome` events | Derived (durable) |
| Correction cycles | `task.revision_scheduled` events (manager revision) | Observed (durable) |

**Gap:** No end-to-end "time to completion" or "time to verification" metric.

---

## 3. Configurable Budget Knobs (Unused by Default)

`src/config/schema.ts` runtime config (all optional, absent = no limit):

| Axis | Key | Default | Enforced? |
| :--- | :--- | :--- | :--- |
| Run input tokens | `max_run_input_tokens` | unset | No |
| Run output tokens | `max_run_output_tokens` | unset | No |
| Run cost (USD) | `max_run_cost_usd` | unset | No |
| Per-ship input tokens | `max_ship_input_tokens` | unset | No |
| Per-ship output tokens | `max_ship_output_tokens` | unset | No |
| Per-ship cost (USD) | `max_ship_cost_usd` | unset | No |

`usageBudgetsFromRuntime()` (run-setup.ts) maps these into `BudgetLimits` for the `UsageLedger`. When unset, `new UsageLedger(run.id, undefined, store)` is created with no limits — usage is recorded but never enforced (PR-1 finding: "budgets were configurable nowhere and never applied").

**Conclusion:** Usage is recorded durably but no limits are enforced by default. Operators must explicitly configure budgets.

---

## 4. Gaps and Risks (Ordered by Impact)

### Gap 1 — No observed execution duration (HIGH impact)

No run, task, or worker start/end timestamps beyond config bounds (`runDeadlineMs`, `defaultTaskTimeoutMs`, `ownershipTtlMs`). Cannot answer:

- How long does a run actually take?
- How long does a task take from `queued` to `completed`?
- How much time is spent in queue vs. execution?
- What is worker utilization?

**Requirement:** Add observed duration instrumentation (start/end timestamps per run and per task) before any parallelism optimization can be evaluated.

### Gap 2 — Model performance not persisted across runs (MEDIUM impact)

Batch 2's `ModelPerformanceMonitor` is in-memory only. A restarted supervisor loses all observed model quality data. Routing decisions in a new run start from capability metadata alone, with no observed performance signal.

**Requirement:** Persist model performance observations to the durable event log (e.g., `run.model_performance` events) so routing can benefit from cross-run observed quality, while preserving rule #13 (unknown = `undefined`, never estimated).

### Gap 3 — Context size not measured (LOW impact)

Prompt truncation flags exist (`BoundedText.textTruncated`, `textTruncated` on `PromptOutcome`) but are not aggregated. Recovery context size can be computed from events but is not recorded as a metric.

**Requirement:** Emit context-size observations (prompt char count, truncation flag, recovery context entry count) as durable events to measure context efficiency trends.

### Gap 4 — No worker utilization metric (LOW impact)

`maxConcurrentWorkers` caps in-flight count, but no measurement of how often workers are idle vs. busy, or how long tasks wait in queue.

**Requirement:** Record queue entry/exit timestamps per task to derive queue wait time and worker utilization.

---

## 5. Proposed Benchmark Scenarios (Batch 5 Step 2)

Deterministic benchmark dataset using the mock engine (no real model, no network):

| Scenario | Description | Expected characteristic |
| :--- | :--- | :--- |
| Simple sequential | Single task, no dependencies | Baseline duration, 1 worker |
| Independent parallel | 3 tasks, no dependencies | Parallelism efficiency vs. sequential |
| Dependency-heavy DAG | Chain of 4 dependent tasks | Sequential, low parallelism |
| Large-context | Task with 40k+ char brief | Context efficiency, truncation |
| Tool-intensive | Task with many tool calls | Tool-call overhead, checkpoint cost |
| Model fallback | First model fails, second succeeds | Fallback frequency, recovery |
| Worker failure | Task fails mid-execution | Recovery success, unknown_outcome boundary |
| Verification-heavy | Task requiring multiple checks | Verification duration, gate overhead |

Each scenario must record: total duration, queue wait, worker count, model selection distribution, token/cost (from ledger), retry/fallback counts, verification outcome. Unavailable measurements recorded explicitly as "unavailable".

---

## 6. Proposed Instrumentation (Batch 5 Step 3)

All instrumentation is **additive and bounded**; no existing behavior changes.

### 6.1 Run/task duration events

Emit at supervisor level:

- `run.started` → already exists (no start timestamp in payload; add `startedAt`)
- `task.started` → already exists (no start timestamp; add `startedAt`)
- `task.completed` / `task.failed` / `task.unknown_outcome` → already exist (add `durationMs` computed from `task.startedAt`)

Derive: task duration = completedAt − startedAt; run duration = completedAt − startedAt (run row already has these fields).

### 6.2 Queue wait time

At dispatch: record `task.dequeued` event with `queuedAt` (from `createdAt`) and `dispatchedAt` (now). Derive queue wait = dispatchedAt − createdAt.

### 6.3 Context size

At manager/worker prompt construction: emit `task.prompt_built` / `run.manager_prompt_built` with `promptChars`, `textTruncated`, `recoveryContextEntries`. Bounded to avoid event volume.

### 6.4 Model performance persistence

Emit `run.model_performance` events at session end with per-model latency/success/failure/fallback/completion observations. In-process `ModelPerformanceMonitor` continues to drive routing; events provide cross-run durability.

---

## 7. Optimization Decisions (Deferred to Measurement)

Per the execution discipline: **no optimization is implemented before measurement.** The following are candidate optimizations that must be proven by benchmark:

| Candidate | Condition for adoption |
| :--- | :--- |
| Adaptive worker allocation (Batch 3) already exists | Benchmark must show parallelism benefit exceeds scheduling overhead |
| Context compaction tuning | Benchmark must show truncation reduction without information loss |
| Model routing by observed performance | Already exists (bounded); no change unless benchmarks show benefit |
| Usage budget defaults | Owner decision: whether to ship with conservative defaults |

No optimization may sacrifice task quality, verification, recovery, or workspace safety.

---

## 8. Acceptance Criteria (Measurable)

| # | Criterion | How measured |
| :--- | :--- | :--- |
| 1 | Run/task duration is observed | `task.completed`/`task.failed` events carry `durationMs`; run `startedAt`/`completedAt` populated |
| 2 | Queue wait is observable | `task.dequeued` events carry `queuedAt`/`dispatchedAt` |
| 3 | Context size is measured | `task.prompt_built` events carry `promptChars` |
| 4 | Model performance is durable | `run.model_performance` events persist per-model observations |
| 5 | No fabrication | All new metrics are observed values; missing values are `undefined`, never estimated |
| 6 | No regression | Full suite passes; release gate passes |
| 7 | Benchmarks are deterministic | Benchmark scenarios use mock engine, no network |

---

## 9. Files To Be Changed (Planned)

| File | Change |
| :--- | :--- |
| `docs/optimization/17-COST-PERFORMANCE-AUDIT.md` | This audit |
| `src/orchestrator/supervisor.ts` | Emit `task.started`/`task.completed` timing, `task.dequeued` wait, `run.model_performance` events |
| `src/engines/model-performance.ts` | Optional durable event emission (parameterized, off by default) |
| `tests/unit/model-performance.test.ts` | Extend with durable-event emission tests |
| `tests/benchmarks/planning-cases.json` | Add execution-efficiency scenarios (duration, queue wait, parallelism) |
| `docs/optimization/PROGRESS.md` | Batch 5 status + rulings |

---

## 10. Residual Risks & Limitations

1. Token/cost observations may be 0 on free/local models — cost optimization is not meaningful for all deployments.
2. Model performance is in-process only unless durable events are added; cross-run quality requires owner decision on event volume.
3. Benchmark scenarios using the mock engine measure orchestration overhead, not real model inference quality.
4. Adding duration fields to existing event payloads is additive; no migration required.

---

## 11. Sign-off

Audit complete. No implementation files modified yet. All existing instrumentation is documented; gaps are explicitly classified as observed/derived/unavailable.

**Next:** Step 2 — implement benchmark scenarios and timing instrumentation in small verifiable steps, starting with run/task duration events.
