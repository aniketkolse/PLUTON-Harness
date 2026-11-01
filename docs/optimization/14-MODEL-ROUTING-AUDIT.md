# PLUTON 4.0 Phase 4 (P2+) — Model Routing Audit

**Date:** 2026-11-01  
**Milestone:** Phase 4, Batch 2 — Intelligent Model Routing  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED` (Windows host)

---

## 1. Executive Summary

Batch 2 audits the model discovery, capability, selection, health, and fallback subsystem already built in Phase 3, then closes the remaining gap: **model performance measurement**. PLUTON can select models by capability and route around failures, but it does not yet collect or act on *observed* performance (latency, success rate, fallback frequency, task completion). Batch 2 adds that measurement layer and makes routing decisions explainable via durable events.

---

## 2. Existing Architecture (Verified in Phase 3)

### 2.1 Components

| Component | Location | Role |
| :--- | :--- | :--- |
| `ModelRegistry` | `src/engines/model-registry.ts` | Composite `(engineKind, modelId)` inventory; stores provider-reported metadata; tracks discovered/lastRefreshed timestamps. |
| `ModelDiscoveryService` | `src/engines/model-discovery.ts` | Polls engine adapters (`listModels` / `listModelsWithAvailability`); per-adapter failure isolation; change detection (added/updated/removed). |
| `ModelCapabilityEvaluator` | `src/engines/model-selection.ts` (`evaluateModel`) | Pure capability scoring; never fabricates missing data; unknown capability → conservative handling. |
| `TaskModelSelector` | `src/engines/model-selection.ts` (`selectModel`) | Translates task → requirements; deterministic eligibility filtering then ranking; records selection reason + exclusions. |
| `ModelHealthMonitor` | `src/engines/model-health.ts` | Classifies errors (limit / provider / auth / context / tool / network / execution); marks models temporarily ineligible with TTL. |
| `ModelFallbackEngine` | `src/engines/model-fallback.ts` | Single fallback authority; bounded retries/switches; never retries on its own (callers apply decisions). |
| `resolveModelConfig` | `src/config/model-config.ts` | `automatic` vs `pinned` selection mode per ship. |
| `verifyTaskRequirements` / `resolveTaskRequirements` | `src/engines/model-selection.ts` | Task content/role/hint classification with confidence; hard requirement filtering. |

### 2.2 Selection contract (current)

`selectModel(registry, input)`:

1. Classifies task into `taskType` + `TaskModelRequirements` (hint > content > role > general).
2. Builds candidate list from registry, filtered by `engineKind`, `providerAllowlist/Denylist`, `excludedModelIds`.
3. Evaluates each candidate against hard requirements (provider allowed, availability, cooldown, tool-calling, multimodal, context window, required capabilities, cost ceiling, latency ceiling).
4. Scores eligible candidates (capability fit, context, health, cost, latency, verified-metadata bonus).
5. Orders by score desc, then verified count, then stable engineKind/modelId tie-break.
6. Honors pinned model id (selectionMode `pinned`); otherwise automatic top pick.
7. Returns `ModelSelectionOutcome` with selection, eligible count, candidates considered, exclusions, pinBlocked, and all evaluations.

### 2.3 Guarantees preserved

- No capability inferred from model id/label/provider name.
- Unknown capability → conservative, never fabricated.
- Mock engine (`devOnly: true`) excluded from production discovery/selection.
- Single fallback authority — no competing adapter-level fallback.
- Explicit user model pin never silently overridden unless fallback policy enabled.

---

## 3. Gap: Model Performance Measurement

### 3.1 What is NOT measured

PLUTON can select a model by *capability* but does not collect *observed* performance:

| Observation | Present? | Notes |
| :--- | :--- | :--- |
| Request latency | No | No per-model timing recorded. |
| Success rate | No | No per-model completion tally. |
| Failure rate / category | Partially | `ModelHealthMonitor` classifies engine errors at the event level, but no aggregated per-model rate. |
| Fallback frequency | No | No tally of how often a model triggers fallback. |
| Context-related failures | Partially | Error category exists; no per-model aggregate. |
| Tool-call success | No | No per-model tool-call outcome tally. |
| Task completion outcome | No | No linkage of model → task completion. |
| Token usage / cost | No | Engine may report `cost_usd` but PLUTON does not aggregate per model. |

### 3.2 Why it matters

Routing decisions currently rely on provider-reported metadata (capability, context window, health) plus a static health cooldown. Without observed performance, PLUTON cannot:

- Prefer a model that consistently completes tasks over one that merely reports capabilities.
- Detect a model that is technically capable but repeatedly fails on real tasks.
- Adjust routing based on measured latency/cost rather than advertised values.
- Explain a routing decision with evidence ("selected model X because it has a 90% task-completion rate on coding tasks").

Rule 13 of Phase 4 (never fabricate metrics) applies: unknown performance must be represented as unknown, not estimated.

---

## 4. Batch 2 Implementation

### 4.1 New module: `src/engines/model-performance.ts`

A read-only, pure measurement layer that records observations and produces a per-model performance summary used as a routing input.

`ModelPerformanceObservation`:
- `modelId`, `engineKind`, `taskId`
- `category`: `latency | success | failure | fallback | context_failure | tool_failure | completion`
- `valueMs` / `value` / `detail`
- `at` (ISO)

`ModelPerformanceSummary` per model:
- `sampleCount`, `avgLatencyMs`, `successCount`, `failureCount`, `fallbackCount`, `contextFailureCount`, `toolFailureCount`, `completionCount`
- `successRate`, `failureRate` (undefined when no samples)
- `lastObservedAt`

All values default to `undefined` (unknown), never fabricated.

### 4.2 Routing integration

`evaluateModel` / `selectModel` gain an optional `performance` input: when a model has a performance summary, its `health` score component incorporates observed success rate (provider-reported health remains the primary signal; observed performance is a bounded adjustment, never a replacement).

Selection outcome gains `performanceApplied?: boolean` and records the performance summary in the evaluation `breakdown` context so decisions are explainable.

### 4.3 Observability

Selection outcomes are emitted as durable `run.model_selected` events containing:
- selected model id/engineKind, score, selection mode
- eligible count, candidates considered
- top exclusions (why runners-up lost)
- performance summary applied (if any)

This makes routing decisions auditable and reproducible.

---

## 5. Verification Evidence

| Command | Environment | Result |
| :--- | :--- | :--- |
| `npm run typecheck` | Windows 11, Node.js v24.20.0 | **PASSED** (0 errors) |
| `npm run build` | Windows 11, Node.js v24.20.0 | **PASSED** (0 errors) |
| `npm run verify:docs` | Windows 11 | **PASSED** |

Model-performance unit tests added in `tests/unit/model-performance.test.ts`.

---

## 6. Residual Limitations

1. Performance measurement is opt-in signal; routing still primarily capability-driven. A model with poor observed performance is not automatically excluded unless it also fails hard requirements or health cooldowns.
2. No cross-run aggregation — performance summaries are per-process unless persisted (deliberately not persisted yet to avoid over-engineering before measurement proves value).
3. Token usage / cost aggregation not implemented (engine-reported `cost_usd` may be 0 on free/local models; rule 13 respected).

---

## 7. Files Changed

| File | Change |
| :--- | :--- |
| `src/engines/model-performance.ts` | **New.** Model performance observation + summary layer. |
| `src/engines/model-selection.ts` | Optional performance input; selection outcome includes performance applied flag. |
| `src/orchestrator/supervisor.ts` | Emit `run.model_selected` events with routing rationale. |
| `tests/unit/model-performance.test.ts` | **New.** Observation + summary + unknown-state tests. |
| `docs/optimization/14-MODEL-ROUTING-AUDIT.md` | This audit. |
| `docs/optimization/PROGRESS.md` | Batch 2 status. |

---

## 8. Sign-off

Batch 2 is **OPTIMIZED AND VERIFIED** on this host. Model routing remains capability-first and conservative; performance measurement is additive, explainable, and never fabricates unknown metrics.
