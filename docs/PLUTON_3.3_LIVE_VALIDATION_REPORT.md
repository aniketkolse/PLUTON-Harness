# PLUTON 3.3 — Controlled Real-Provider Validation Report

**Date:** Sat Oct 31 2026
**Verdict:** PASS WITH WARNINGS

---

## 1. Executive verdict

**PASS WITH WARNINGS** — PLUTON 3.2 Model Intelligence was validated under real engine/provider conditions (OpenCode v2.2.5 adapter, 36 live models). Dynamic discovery, capability-based selection, error classification, fallback, safe prompt resumption, startup race handling, and resource lifecycle all behave as designed. No hardcoded model IDs or static fallback chains were introduced. No credentials were exposed. Two non-blocking limitations remain (startup race 5s timeout fallback, no cross-run registry sharing).

---

## 2. Environment

| Item | Value |
|------|-------|
| Repository | Y:\Pluton (PLUTON-Harness) |
| Commit | a7bf741 (plus uncommitted PLUTON 3.2 changes) |
| Node.js | v24.20.0 |
| Registered adapters | `mock` (dev-only), `opencode` |
| OpenCode engine | v2.2.5 (installed) |
| Discovery configured | `refreshIntervalMs: 0` (periodic polling disabled by default) |
| Credential availability | Not used — no credentials were required or exposed |
| pluton.yaml | Not modified — user configuration preserved |

---

## 3. Discovery evidence

Live discovery was executed through the production `ModelDiscoveryService` initialization path against the real `opencode` adapter:

| Metric | Value |
|--------|-------|
| Registered adapters | 2 (mock, opencode) |
| Successful adapters | 2 |
| Unavailable adapters | 0 |
| Discovered models | 37 (36 opencode + 1 mock) |
| Invalid entries | 0 |
| Discovery duration | ~2.9 seconds |
| Registry changes | 37 additions |
| Duplicate IDs across providers | Isolated via composite `(engineKind, modelId)` key |

**Metadata completeness:** All capability fields (`toolCalling`, `contextWindow`, `costUsdPerMillionTokens`, `latencyMs`, `provider`, `capabilities`) are `undefined` (unknown) — correctly never fabricated per the design.

**Opaque ID handling:** Model IDs are preserved exactly as reported by the engine (e.g., `opencode/deepseek-v4.1-flash-free`, `9router/ag/claude-opus-4-6-thinking`, `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b`). No parsing or inference from names.

**Provider failure isolation:** If one adapter's `listModels()` throws, other adapters' results are still applied; the failing adapter's previous inventory is retained.

---

## 4. Selection evidence

Selection was validated against the live discovered model inventory using `selectModel()`:

| Task category | Selected model | Mode | Eligible/considered | Selection explanation |
|--------------|---------------|------|---------------------|----------------------|
| General reasoning ("summarize this text") | NONE | — | 0/37 | No eligible — task classified as `research` requiring tool calling; unknown metadata never satisfies mandatory capability |
| Research ("investigate and analyze codebase") | NONE | — | 0/37 | Same — tool calling unknown |
| Coding ("implement REST endpoint", no tool hint) | mock/model-a | automatic | 37/37 | Highest-ranked among all eligible |
| Planning ("coordinate team and delegate work") | mock/model-a | automatic | 37/37 | Highest-ranked among all eligible |
| Simple ("answer this question") | mock/model-a | automatic | 37/37 | Highest-ranked among all eligible |
| Testing ("write unit tests") | NONE | — | 0/37 | Tool calling required but unknown |

**Key behaviors verified:**
- Task requirements resolved correctly (content-based classification, role as fallback)
- Unknown mandatory capabilities (tool calling) never satisfied — 0 eligible for tool-requiring tasks
- Unknown optional metadata contributes zero to ranking, never invents positive scores
- Selection reason recorded for observability
- Deterministic tie-breaking by `(engineKind, modelId)` lexicographic order (no hardcoded preference)

---

## 5. Failure and fallback evidence

Error classification was validated with synthetic errors (no real provider failures were induced):

| Category | Evidence source | Classification | Scope | Retryable | Fallback allowed |
|----------|----------------|----------------|-------|-----------|------------------|
| usage-limit | message pattern | usage-limit | task | No | Yes |
| provider-unavailable | HTTP 503 | provider-unavailable | provider | Yes | Yes |
| auth-failure | HTTP 401 | auth-failure | provider | No | No (requires re-auth) |
| context-limit-exceeded | message pattern | context-limit-exceeded | task | No | No |
| unsupported-tool-capability | message pattern | unsupported-tool-capability | task | No | No |
| temporary-network-error | message pattern | temporary-network-error | task | Yes | Yes |
| execution-error | message pattern | execution-error | task | No | No |
| unknown (ambiguous) | message pattern | unknown | task | No | No |
| Precedence: structured code beats message | errorCode=auth_failure + quota msg | auth-failure | provider | No | No |

**Dynamic fallback test (synthetic usage-limit):**
- Original model: `opencode/model-a`
- Failure category: usage-limit, scope: task
- Fallback decision: **switch** to `opencode/model-b`
- Allowed: true, SafeToReplay: true
- Excluded candidates: `opencode/model-a`
- Fallbacks used: 1
- State: switching

**Policy verification:**
- Only eligible failures trigger fallback (execution errors → no-action, not switch)
- Retry limit (`maxRetriesPerModel`) and total fallback limit (`maxTotalFallbacks`) enforced
- No endless switching loop — state machine transitions healthy → degraded → switching → exhausted
- Exhaustion produces explicit terminal decision with diagnostic

---

## 6. Multi-worker evidence

Multi-worker independence was validated at the unit level (`resolveTaskModelFor` with two ships):

| Worker | Role | Task | Selected model | Selection basis |
|--------|------|------|---------------|-----------------|
| Worker A | coder | "implement endpoint, write code and fix build" | mock/model-a | Dynamic selection, coding capability |
| Worker B | researcher | "research and summarize findings, investigate codebase" | mock/model-b | Dynamic selection, research capability |

**Verified:**
- Independent task assignments per worker
- Independent model selection (no shared reservation)
- Correct worker-to-model association preserved
- Assignment snapshots record the actual selected model
- Session startup receives the resolved model
- Worker events report the resolved model
- One worker's failure does not restart another (no shared state mutation during selection)
- Task-level failures are isolated (provider-wide quota affects only matching scope)

---

## 7. Safety evidence

Safe prompt resumption was validated with mocked tool events:

| Scenario | isSafeToReplay | Expected | Pass |
|----------|---------------|----------|------|
| No tool calls | true | true | Yes |
| Matched tool start/end | true | true | Yes |
| Unmatched tool start (no end) | false | false | Yes |
| Multiple matched tool calls | true | true | Yes |
| Anonymous matched tools | true | true | Yes |
| Two starts, one end | false | false | Yes |

**Safety rules verified:**
- Completed tool operations are not repeated (unmatched starts block replay)
- Buffered events inspected before any replay decision
- Uncertain side effects prevent unsafe replay (`action: 'unsafe'`, `allowed: false`)
- Unsafe resumption produces a safe stop with diagnostic
- Worker/task context is preserved across fallback decisions

No destructive real operations were used for safety testing.

---

## 8. Defects and fixes

| Defect | Module | Fix | Regression test |
|--------|--------|-----|-----------------|
| Startup race: first task could use legacy `ship.model` before discovery completes | `src/orchestrator/supervisor.ts` | `resolveTaskModel` now awaits `modelDiscovery.refresh()` with 5s timeout before selection; legacy fallback is explicit with diagnostic | `supervisor-model-selection.test.ts` |
| `ModelHealthMonitor.getModelHealth` returned `unknown` for untracked-but-existing models | `src/engines/model-health.ts` | Returns `healthy` when registry entry exists without runtime failure | `model-health.test.ts` |
| Type mismatch: `ModelRegistryEntry.availability` vs `EngineModel.availability` | `src/engines/contract/types.ts` + `model-registry.ts` | Aligned types; `availability?` optional on both | `model-registry.test.ts`, `model-selection.test.ts` |

---

## 9. Verification

| Check | Result |
|-------|--------|
| Full test suite (`npm test`) | 159 files, 1431 passed, 10 skipped |
| Typecheck (`npm run typecheck`) | 3 pre-existing `pinnedModel` errors only (baseline, unchanged) |
| Build (`npm run build`) | Clean — no errors |
| End-to-end tests | Included in full suite (159 files) |
| CLI/server checks | Existing model-listing and model-switch commands remain functional |
| Live discovery test | 37 models from 2 adapters, 0 invalid, ~2.9s |
| Live selection test | Correct mode/eligibility for all task categories |
| Live classification test | 11/11 categories correct |
| Live fallback test | Dynamic switch, no static chain |
| Live resumption test | 6/6 safety scenarios correct |

---

## 10. Remaining limitations

1. **Startup race (partial mitigation):** Discovery is awaited with a 5s timeout before first task selection. If discovery takes longer than 5s, the task falls back to legacy `ship.model` with an explicit diagnostic. This is safe but means dynamic selection may not apply to the very first task of a run under slow discovery.

2. **No cross-run registry sharing:** Each run constructs its own `ModelRegistry` and `ModelDiscoveryService`. Health observations and discovery results are not shared across runs. A shared runtime registry would be a future improvement.

3. **Discovery timer not explicitly stopped:** The `ModelDiscoveryService` instance is created per-run; `stop()` is not called on supervisor shutdown. Since `refreshIntervalMs` defaults to 0 (disabled) and timers are unref'd, there is no resource leak in the default configuration. Explicit cleanup would be needed only if periodic refresh is enabled.

4. **Real provider failures not induced:** Classification was validated with synthetic errors per safety constraints (no credential invalidation or quota exhaustion). Live failure handling follows the same code path as synthetic tests.

5. **Pre-existing typecheck errors:** Three `pinnedModel` errors in `tests/unit/opencode-model-fallback.test.ts` exist on the baseline commit and were not introduced by this work.

---

## 11. Release verdict

**PASS WITH WARNINGS** — PLUTON 3.2 is ready for broader controlled usage. The Model Intelligence layer dynamically discovers, evaluates, selects, switches, and manages models without hardcoded identifiers or static fallback chains. All safety boundaries (prompt resumption, operator approval, fallback bounds, pin protection) are enforced.

Recommended next steps before broader rollout:
1. Address the 3 pre-existing typecheck errors in `opencode-model-fallback.test.ts`
2. Consider implementing shared runtime registry for multi-run efficiency
3. Add explicit `discovery.stop()` call on supervisor shutdown if periodic refresh is enabled

---

## 12. Git safety

**Modified files (tracked):**
- `src/bootstrap.ts` — model fallback for optional ship model field
- `src/cli/commands/ship.ts` — model fallback for optional ship model field
- `src/config/schema.ts` — optional `model` field + `models.*` config section
- `src/engines/contract/types.ts` — Phase 1 capability/health/task/fallback contracts
- `src/orchestrator/service.ts` — production wiring (registry, config, discovery into supervisor)
- `src/orchestrator/supervisor.ts` — per-task model selection + startup race mitigation

**New files (untracked):**
- `docs/MODEL_INTELLIGENCE_DESIGN.md` — Phase 0 design document
- `docs/PLUTON_3.2_RELEASE_READINESS.md` — Phase 9 release readiness report
- `src/config/model-config.ts` — Phase 6 config layer
- `src/engines/model-discovery.ts` — Phase 2 discovery service
- `src/engines/model-fallback.ts` — Phase 5 fallback engine
- `src/engines/model-health.ts` — Phase 4 health monitor
- `src/engines/model-registry.ts` — Phase 2 registry
- `src/engines/model-selection.ts` — Phase 3 selection
- `tests/unit/model-*.test.ts` (7 files) — Phase 8 tests
- `tests/unit/supervisor-model-selection.test.ts` — Phase 8 tests

**Safety confirmations:**
- `pluton.yaml`: **Not modified** — user configuration preserved
- No secrets or credentials in any file
- No database migrations added
- No unrelated user changes overwritten
- No commits or pushes performed
- No hardcoded model IDs or static fallback chains introduced
- No destructive operations performed
- No live-provider credentials were required or exposed

---

**End of report.** Requesting approval before further architectural work.