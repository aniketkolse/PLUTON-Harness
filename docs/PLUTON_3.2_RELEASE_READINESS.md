# PLUTON 3.2 — Release Readiness Report

**Date:** Sat Oct 31 2026
**Verdict:** PASS WITH WARNINGS

---

## A. Executive verdict

**PASS WITH WARNINGS** — All phases 1–9 are implemented and verified. The full test suite passes (159 files, 1431 tests, 10 skipped). Build and typecheck are clean except for three pre-existing `pinnedModel` errors in `tests/unit/opencode-model-fallback.test.ts` that are documented as the established baseline and were not introduced by this work. Production Supervisor wiring is in place. Two non-blocking limitations remain (see §F).

---

## B. Architecture completion

| Phase | Component | Status |
|-------|-----------|--------|
| 0 | Design document `docs/MODEL_INTELLIGENCE_DESIGN.md` | ✅ Approved |
| 1 | Contract types (`EngineModel`, `ModelAvailability`, `ModelErrorCategory`, `TaskModelRequirements`, `ModelSelection`, `FallbackState`, `FallbackDecision`, `FallbackScope`, `TaskClassificationHint`) | ✅ Complete |
| 2 | `ModelRegistry` + `ModelDiscoveryService` | ✅ Complete |
| 3 | `ModelCapabilityEvaluator` + `TaskModelSelector` | ✅ Complete |
| 4 | `ModelHealthMonitor` + error classification (8 categories) | ✅ Complete |
| 5 | `ModelFallbackEngine` + safe replay detection | ✅ Complete |
| 6 | `ModelConfig` (pluton.yaml layer, automatic vs. pinned) | ✅ Complete |
| 7 | Supervisor integration (`resolveTaskModel` per task) | ✅ Complete |
| 8 | Comprehensive test matrix (96 new tests) | ✅ Complete |
| 9 | Production wiring + final regression + this report | ✅ Complete |

---

## C. Production wiring evidence

**Wiring path:** `src/orchestrator/service.ts` → `createRunSupervisor()`

```typescript
// PLUTON 3.2: construct the model registry and config for this run.
const modelRegistry = new ModelRegistry()
const modelConfig = resolveModelConfig(ctx.loaded.config)
const discoveryEngines = listEngineKinds().map((f) => ({
  engineKind: f.kind,
  adapter: getEngineAdapter(f.kind),
}))
const discovery = new ModelDiscoveryService({
  engines: discoveryEngines,
  registry: modelRegistry,
  refreshIntervalMs: (ctx.loaded.config.models && ctx.loaded.config.models.discovery)
    ? ctx.loaded.config.models.discovery.refreshIntervalMs : 0,
})
void discovery.refresh().catch(() => {})

const supervisor = new RunSupervisor({
  modelRegistry,
  modelConfig,
  ...
})
```

The `RunSupervisor` constructor stores these as `this.modelRegistry` and `this.modelConfig`. `executeTask()` calls `this.resolveTaskModel(ship, task)` which:

1. Returns the pin if `modelConfig.ships[ship.id].pin` is set.
2. Otherwise runs `selectModel(registry, ...)` using task content, ship role, hints, preferences, allowlists.
3. Falls back to `ship.model` with a diagnostic when no eligible candidate exists.

The resolved model is used for:
- Assignment snapshot (`assignment.model`)
- Session startup (`ship.model` passed to `adapter.startSession`)
- Worker events (`model` field in `worker.started`, `worker.progress`)

**Legacy mode:** When `modelRegistry`/`modelConfig` are absent (e.g., direct `RunSupervisor` construction in tests), `resolveTaskModel` returns `ship.model` unchanged — full backward compatibility.

---

## D. Model Intelligence behavior

### Discovery
- `ModelDiscoveryService` probes every registered engine adapter's `listModels()` concurrently.
- Per-adapter failures are isolated; previous inventory is retained on failure.
- Empty successful results remove that adapter's models.
- Duplicate opaque IDs across adapters remain distinct (composite `(engineKind, modelId)` key).
- Invalid entries (missing/empty id) are filtered and counted, not fatal.
- Overlapping refreshes coalesce (`coalesced: true`).

### Registry
- `ModelRegistry` is the single source of truth; entries are frozen (deep copy + `Object.freeze`).
- Stale probe results (older `observedAt`) are ignored.
- Availability is preserved across metadata refreshes.
- `snapshot()` / `list()` return immutable, deterministically sorted arrays.

### Capability evaluation
- `evaluateModel` checks provider restrictions, availability, cooldown, mandatory capabilities (tool calling, multimodal, requiredCapabilities, context window, cost/latency ceilings).
- Unknown mandatory capability never satisfies a requirement (conservative).
- Every exclusion carries a machine-readable `code` and human-readable `reason`.

### Task-aware selection
- Classification precedence: explicit hints → task content → ship role → general-purpose.
- Model identifiers never influence classification.
- Ranking: `capabilityFit(0-40) + context(0-20) + health(0-20) + cost(0-10) + latency(0-10) + verified(0-5)`.
- Ties broken by verified count → lexicographic `(engineKind, modelId)` — never a hardcoded model.
- Unknown cost/latency: neutral in ranking (zero), unverified under hard ceilings (fails).
- Pins: selected with `selectionMode: 'pinned'` if eligible; unavailable/incompatible/absent pins produce `pinBlocked` with no silent substitution.

### Health classification
- Eight categories: `usage-limit`, `provider-unavailable`, `auth-failure`, `context-limit-exceeded`, `unsupported-tool-capability`, `temporary-network-error`, `execution-error`, `unknown`.
- Evidence precedence: structured code → HTTP status → provider code → message patterns → unknown.
- Not every error is a usage limit; execution errors do not trigger fallback.
- Scoped: task-level, provider/account-level, model-level, global.
- Cooldowns are time-aware and expire; successful health evidence restores eligible state.

### Scoped fallback
- `decideFallback` state machine: healthy → degraded → switching → exhausted.
- Bounded: `maxRetriesPerModel` per model, `maxTotalFallbacks` per task.
- Execution errors → `no-action` (no switch).
- Unsafe replay (unresolved tool calls) → `unsafe` (no switch, operator intervention required).
- No eligible candidate → `exhausted` (safe stop).
- Provider-wide vs. task-scoped exclusions respected.

### Prompt-resumption safety
- `isSafeToReplay` returns `false` when a tool `start` has no matching `end`.
- Buffered events are inspected before any replay decision.
- Unsafe resumption produces a safe stop with diagnostic.

### Supervisor integration
- Per-task model resolution via `resolveTaskModel` (exported as `resolveTaskModelFor` for testability).
- Pins never bypassed by dynamic selection or legacy fallback.
- Assignment snapshot, session startup, and worker events all use the resolved model.
- One worker's failure does not restart another.

---

## E. Verification results

### Full test suite

```
Test Files  159 passed (159)
Tests       1431 passed | 10 skipped (1441)
Duration    202.34s
```

### Typecheck

```
tsc -p tsconfig.json
```

Only three errors, all pre-existing in `tests/unit/opencode-model-fallback.test.ts` (lines 62, 65, 120: `Property 'pinnedModel' does not exist on type 'EngineSession'`). These are the documented baseline and were not introduced by PLUTON 3.2 work.

### Build

```
tsc -p tsconfig.build.json
```

Clean — no errors.

### End-to-end / CLI / server

- Existing Supervisor integration tests: 159 files pass including `tests/integration/supervisor.test.ts`.
- No new CLI commands added (per Phase 9 constraint — only existing paths modified).
- Server run creation path now wires model intelligence (verified by typecheck + build + full suite).

### New tests added (Phases 1–9)

| Phase | Test file | Count |
|-------|-----------|-------|
| 2 | `model-registry.test.ts` | 12 |
| 2 | `model-discovery.test.ts` | 11 |
| 3 | `model-selection.test.ts` | 29 |
| 4 | `model-health.test.ts` | 22 |
| 5 | `model-fallback.test.ts` | 12 |
| 6 | `model-config.test.ts` | 5 |
| 7/8 | `supervisor-model-selection.test.ts` | 5 |
| **Total new** | | **96** |

---

## F. Known limitations

1. **Discovery is fire-and-forget in production.** `void discovery.refresh().catch(() => {})` is called during `createRunSupervisor` but is not awaited. The first task may execute before discovery completes, causing `resolveTaskModel` to fall back to `ship.model` (legacy). This is safe but means dynamic selection may not take effect on the very first task of a run. **Impact:** Low — subsequent tasks and runs benefit from the populated registry within the same process; cross-run sharing is not implemented.

2. **No clean shutdown of discovery timers in production.** The `ModelDiscoveryService` instance is created per-run and its `stop()` is never called. Since periodic refresh defaults to `refreshIntervalMs: 0` (disabled), no timer is started, so there is no resource leak in the default configuration. If a user enables periodic refresh via `models.discovery.refreshIntervalMs`, the timer is unref'd and will not keep the process alive, but it will not be explicitly cleared on run completion. **Impact:** Low — unref'd timers do not prevent process exit; cleanup is best-effort.

3. **No cross-run registry sharing.** Each run constructs its own `ModelRegistry` and `ModelDiscoveryService`. Health observations and discovery results are not shared across runs within the same process. **Impact:** Medium — repeated discovery per run; health state resets between runs. A shared runtime registry would be a Phase 10 improvement.

4. **`EngineModel.availability` and registry `availability` are now the same type.** The redundant `ModelAvailabilityInfo` interface was removed in Phase 4. Discovery does not auto-enrich availability; it is populated by the health monitor. **Impact:** None — this is the intended design.

5. **Pre-existing typecheck errors.** Three `pinnedModel` errors in `tests/unit/opencode-model-fallback.test.ts` remain. These are in test code referencing `session.pinnedModel` on the `EngineSession` interface, which does not declare it. **Impact:** None — pre-existing, not introduced by this work, and not blocking.

---

## G. Git safety

### Modified files (tracked)

| File | Lines changed |
|------|--------------|
| `src/bootstrap.ts` | 2 (model fallback for optional) |
| `src/cli/commands/ship.ts` | 2 (model fallback for optional) |
| `src/config/schema.ts` | 71 (optional model, models config section) |
| `src/engines/contract/types.ts` | 173 (Phase 1 contracts) |
| `src/orchestrator/service.ts` | 22 (production wiring) |
| `src/orchestrator/supervisor.ts` | 57 (per-task model resolution) |

### New files (untracked)

| File | Purpose |
|------|---------|
| `docs/MODEL_INTELLIGENCE_DESIGN.md` | Design document |
| `src/config/model-config.ts` | Phase 6 config layer |
| `src/engines/model-discovery.ts` | Phase 2 discovery service |
| `src/engines/model-fallback.ts` | Phase 5 fallback engine |
| `src/engines/model-health.ts` | Phase 4 health monitor |
| `src/engines/model-registry.ts` | Phase 2 registry |
| `src/engines/model-selection.ts` | Phase 3 selection |
| `tests/unit/model-*.test.ts` (7 files) | Phase 8 tests |
| `tests/unit/supervisor-model-selection.test.ts` | Phase 8 tests |

### Safety checks

- `pluton.yaml`: **Not modified** — user's configuration preserved.
- No secrets or credentials in any new file.
- No database migrations added.
- No unrelated user changes overwritten.
- No commits or pushes performed.

---

## H. Release recommendation

**PLUTON 3.2 is ready for a controlled real-provider validation run** with the following caveats:

1. The first task of each run may use the legacy `ship.model` if discovery has not completed — monitor diagnostics for `no eligible model from registry; falling back to ship.model`.
2. Enable periodic refresh only if needed (`models.discovery.refreshIntervalMs` in `pluton.yaml`); default is disabled.
3. The three pre-existing typecheck errors in `tests/unit/opencode-model-fallback.test.ts` should be addressed separately (add `pinnedModel` to the `EngineSession` interface or cast in tests).
4. Consider implementing a shared runtime registry (limitation 3) before high-throughput production use.

---

**End of report.** No new feature phase will begin without explicit approval.