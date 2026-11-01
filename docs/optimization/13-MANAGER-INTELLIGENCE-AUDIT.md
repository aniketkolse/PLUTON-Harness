# PLUTON 4.0 Phase 4 (P2+) — Manager Intelligence Audit

**Date:** 2026-11-01  
**Milestone:** Phase 4, Batch 1 — Manager Intelligence & Adaptive Task Decomposition  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED` (Windows host)

---

## 1. Executive Summary

Batch 1 audits the manager's planning architecture and introduces a structured,
deterministic task-assessment layer plus adaptive worker allocation. The manager
remains the single planning authority (no architecture replacement), but it now
receives a bounded, evidence-backed assessment of the request and an explicit
worker-allocation recommendation in its prompt, and the run records that
assessment as a durable event.

---

## 2. Existing Planning Architecture

### 2.1 Components

| Component | Location | Role |
| :--- | :--- | :--- |
| Manager Ship prompt | `buildManagerPrompt()` in `src/orchestrator/supervisor.ts` | Static role contract, delegation rules, response format. |
| Manager instructions | `.pluton/roles/manager.md` (loaded via `instructionsFor`) | Role duties, hard rules. |
| Task admission | `admitTask()` in `src/orchestrator/task-graph.ts` | Budget, depth, fan-out, cycle, run-state validation. |
| DAG validation | `src/domain/task-graph.ts` | Cycle detection, edge semantics. |
| Wakeup registry | `src/orchestrator/wakeups.ts` | Event-driven child settlement. |
| Circuit breaker | `src/orchestrator/circuit-breaker.ts` | Identical-failure tripping, retry caps. |
| Revision tool | `task.request_revision` handler | Bounded manager-requested requeue. |
| Plan manager | `src/plan/manager.ts` | Durable plan drafts, review/approve/execute. |

### 2.2 Decision points

1. **Goal → acceptance criteria** (manager prose, not state).
2. **Plan shape**: how many tasks, which owners, which dependencies.
3. **Delegation vs. direct action**: manager may act as any specialist.
4. **Worker count**: implicitly chosen by how many `task.create`/`task.delegate`
   calls the manager makes; bounded by `max_concurrent_workers`, `max_team_size`,
   `max_tasks_per_run`, `max_delegation_depth`, `max_child_tasks_per_task`.
5. **Readiness**: `listReadyTasks()` returns tasks whose dependencies are
   `completed`; dispatch is bounded by `maxConcurrentWorkers` and write-scope
   leases.
6. **Completion**: `finalize()` derives run state from durable task counts.

### 2.3 Decomposition strategy (current)

The manager is an LLM operating under the role contract. It is instructed to:

- Plan first, then delegate or act directly.
- Use `dependsOn` for real ordering.
- Split only where parallelism is real.
- Give each task a distinct scope and acceptance criteria.
- Wait event-driven via `task.wait`.

There is **no deterministic decomposition in code**; the manager decides. The
runtime only validates and bounds what it produces. This is by design (the
manager's prose is not state), but it means planning quality is not measurable
from code alone.

### 2.4 Known weaknesses (evidence-based)

1. **No task assessment representation.** Nothing records why a run needed N
   workers or what complexity was estimated. There is no durable artifact to
   compare estimates against outcomes.
2. **No adaptive worker allocation signal.** The manager is told the team size and
   concurrency cap, but receives no evidence-backed recommendation. It must guess
   from prose.
3. **No duplicate-work detection.** Duplicate task descriptions, overlapping
   write scopes, and repeated research are caught only by budget caps and lease
   conflicts, not by identity.
4. **No planning benchmark.** There is no reproducible dataset or before/after
   measurement of planning quality.
5. **Context inefficiency.** The manager prompt is static; it does not reflect the
   request's assessed complexity, so simple and complex requests get identical
   planning guidance.

### 2.5 Duplicate-work risks

- A manager that crashes and restarts receives the durable task list (Batch A),
  which prevents blind re-planning, but the initial plan can still create
  redundant tasks.
- Two independent runs with similar goals share no task identity; nothing
  deduplicates across runs.
- `max_tasks_per_run` and `max_child_tasks_per_task` are the only hard guards.

### 2.6 Missing dependency detection

- Dependencies are declared by the manager via `dependsOn`; the runtime validates
  acyclicity and run membership but cannot infer missing dependencies from
  task content.
- `isTaskBlockedOnWaiting()` detects tasks blocked behind waiting prerequisites,
  but only after the fact.

### 2.7 Context inefficiencies

- Manager prompt size is bounded by `max_prompt_chars` (default 60 000).
- Worker prompts include brief, acceptance criteria, revision feedback, and
  recovery context; no redundant tool results are injected.
- No structured assessment is passed to the manager or workers.

### 2.8 Planning quality test coverage

- `task-graph.test.ts`, `supervisor.test.ts` cover admission, cycles, dispatch,
  wakeups, recovery.
- No test measures plan coverage, missing requirements, unnecessary subtasks, or
  worker utilization.
- `tests/integration/multi-agent-reliability.test.ts` covers failure isolation.

---

## 3. Task Assessment Model (new)

`src/orchestrator/task-assessment.ts` introduces a deterministic, code-level
assessment of a request. It is **not** a model estimate; it is a heuristic over
textual signals, recorded as durable evidence and compared against outcomes.

### 3.1 `TaskAssessment` fields

- `complexity`: `simple | moderate | complex`
- `estimatedWorkers`: integer, bounded `[1, maxConcurrentWorkers]`
- `requiredCapabilities`: subset of `research | coding | testing | planning | review`
- `requiredTools`: inferred tool categories (`file_read`, `file_write`, `shell`,
  `git`, `search`, `verification`)
- `dependencyDepth`: estimated dependency depth (0 = none)
- `parallelizableUnits`: count of independent work units detected
- `verificationRequired`: boolean
- `resourceConstraints`: `{ maxWorkers, maxTasks, maxDepth }`
- `confidence`: `high | medium | low`
- `signals`: the raw keyword/structural signals used (for auditability)

### 3.2 Heuristic rules (deterministic, no model calls)

- Complexity escalates with brief length, acceptance-criteria count, keyword hits
  (research/coding/testing/planning), and explicit multi-stage language.
- `parallelizableUnits` counts independent clauses and distinct deliverable
  nouns; capped by `maxConcurrentWorkers`.
- `estimatedWorkers = min(maxConcurrentWorkers, max(1, parallelizableUnits))`,
  further reduced when dependency depth > 2 (sequential work dominates).
- Required capabilities/tools are keyword-driven and conservative (a capability
  is added only on a clear signal).
- Confidence is `high` when multiple signals agree, `low` when only one weak
  signal exists.

### 3.3 Adaptive worker allocation

`allocateWorkers(assessment, maxConcurrentWorkers)` returns:

- `workerCount`: final bounded count.
- `strategy`: `single | small_parallel | bounded_parallel | sequential_fallback`
- `reason`: human-readable justification (recorded in the durable event).

Rules:

- `simple` → 1 worker, `single`.
- `moderate` with `parallelizableUnits <= 1` → 1, `single`.
- `moderate` with `parallelizableUnits > 1` → min(units, cap), `small_parallel`.
- `complex` → min(units, cap), `bounded_parallel`, unless dependency depth > 2
  then `sequential_fallback` with 1–2 workers.
- Never exceeds `maxConcurrentWorkers`; never below 1.

### 3.4 Durability

At run start the supervisor computes an assessment of the run goal and emits
`run.assessed` with the full assessment + allocation. The assessment is also
injected into the manager prompt as a bounded "Task assessment" section.

---

## 4. Planning Benchmark Dataset

`tests/benchmarks/planning-cases.json` contains 9 representative cases:

1. Simple factual task.
2. Multi-source research.
3. Multi-stage coding task.
4. Independent parallel research.
5. Dependency-heavy workflow.
6. Large file-analysis task.
7. Tool-intensive task.
8. Task requiring verification and correction.
9. Ambiguous small task.

Each case records the expected complexity band, worker-count band, and required
capabilities. A unit test asserts the assessor stays within those bands. This is
a regression guard for the heuristic, not a claim about LLM planning quality.

---

## 5. Implementation (Batch 1)

| File | Change |
| :--- | :--- |
| `src/orchestrator/task-assessment.ts` | **New.** `TaskAssessment`, `assessTask`, `allocateWorkers`. |
| `src/orchestrator/supervisor.ts` | Run assessment at startup; emit `run.assessed`; inject assessment into manager prompt via `buildManagerPrompt`. |
| `tests/unit/task-assessment.test.ts` | **New.** Heuristic + allocation + bound tests. |
| `tests/benchmarks/planning-cases.json` | **New.** Planning benchmark dataset. |
| `docs/optimization/13-MANAGER-INTELLIGENCE-AUDIT.md` | This audit. |
| `docs/optimization/PROGRESS.md` | Batch 1 status. |

---

## 6. Verification Evidence

| Command | Environment | Result |
| :--- | :--- | :--- |
| `npm run typecheck` | Windows 11, Node.js v24.20.0 | **PASSED** (0 errors) |
| `npm run build` | Windows 11, Node.js v24.20.0 | **PASSED** (0 errors) |
| `npx vitest run tests/unit/task-assessment.test.ts` | Windows 11 | **PASSED** |
| `npm run verify:docs` | Windows 11 | **PASSED** |

---

## 7. Residual Limitations

1. Decomposition itself remains LLM-driven; the assessment is a signal, not a
   controller. The manager may ignore the recommendation.
2. No automatic duplicate-task detection across runs.
3. No inference of missing dependencies from task content.
4. Benchmark measures the heuristic, not end-to-end planning quality (which
   requires a live model and is covered by the opt-in live suite).

---

## 8. Sign-off

Batch 1 is **OPTIMIZED AND VERIFIED** on this host. The manager now receives a
bounded, durable assessment and worker-allocation recommendation; the runtime
records it as `run.assessed`. No existing guarantee was weakened.
