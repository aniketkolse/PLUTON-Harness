# PLUTON 3.2 — Dynamic Model Intelligence Engine Design

**Version:** 1.0  
**Status:** Proposed (pending implementation approval)  
**Scope:** `src/engines/`, `pluton.yaml`, `tests/unit/`, `docs/`

---

## 1. Existing Architecture and Identified Limitations

### 1.1 Current model handling

Model handling today lives almost entirely in `src/engines/opencode/adapter.ts`:

| File | Component | What it does | Limitation |
|------|-----------|--------------|------------|
| `src/engines/opencode/adapter.ts` | `SHIP_WORKER_MODELS` (lines 36–50) | Hardcoded list of provider-qualified model ids used as the candidate pool for `listModelsWithAvailability`. | Violates the no-hardcoding rule. New models require a code change and rebuild. |
| `src/engines/opencode/adapter.ts` | `selectFallbackModel()` (lines 202–222) | Static preferred-order array used when the current model hits a usage limit. | Static fallback chain — not dynamic, not capability-aware, not refreshed from the live model list. |
| `src/engines/contract/types.ts` | `EngineModel` (lines 34–39) | `{ id, label?, source }` | No capability, context window, tool-calling, quota, or health metadata. |
| `src/engines/contract/types.ts` | `ModelAvailability` (lines 41–48) | `{ id, available, reason?, source?, label? }` | No distinction between usage-limit, provider-down, auth failure, context limit, etc. |
| `src/engines/opencode/adapter.ts` | `listModels()` (lines 517–548) | Parses `opencode models --standalone` output line-by-line. | Only discovers `id` — no metadata. |
| `src/engines/opencode/adapter.ts` | `isModelLimitError()` (lines 154–157) | Regex matching for usage-limit strings. | Only classifies limit errors; no health state machine, no retry bounds, no error-category taxonomy. |
| `pluton.yaml` | `ships.<id>.model` | Per-ship pinned model id. | Backward-compatible must be preserved (Decision 1), but automatic selection is the default (Decision 2). |
| `src/orchestrator/supervisor.ts` | `executeTask()` (lines 1028–…) | Starts a session with `ship.model` directly. | No dynamic selection, no capability matching, no fallback beyond per-session retry. |

### 1.2 Identified limitations (gap vs. spec)

1. **No dynamic model discovery.** Models are known only via the static `SHIP_WORKER_MODELS` array plus whatever `opencode models` returns at runtime. There is no model registry, no refresh, no change detection.
2. **No capability-based selection.** `EngineModel` carries no capabilities (context window, tool calling, coding/reasoning strength, multimodal, quota). Selection cannot be task-aware.
3. **Static fallback chain.** `selectFallbackModel()` uses a hardcoded preferred-order list. Spec §5 explicitly forbids this.
4. **No health management.** No distinction between usage-limit, provider-down, auth failure, context-limit-exceeded, unsupported tool, temporary network error, and execution error. Spec §4 requires this taxonomy.
5. **No per-worker independent model allocation.** The supervisor starts each worker with `ship.model` from pluton.yaml; there is no per-task model re-selection.
6. **No bounded fallback/retry policy.** No prevention of endless retry loops. Spec §5 requires bounded retry.
7. **No observability of selection decisions.** No events recording why a model was selected, when it was switched, or what fallback happened.

---

## 2. Proposed Architecture and Component Responsibilities

The design introduces a **Model Intelligence Layer** between pluton.yaml configuration and the engine adapters. Existing adapters are not replaced — they are extended with discovery, availability, and health data consumed by the new layer.

### 2.1 Component diagram (logical)

```
┌─────────────────────────────────────────────────────────────┐
│                      pluton.yaml                            │
│  (ships[*].model, models.discovery, models.selection,       │
│   models.fallback, providers.allowlist/denylist)            │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│              ModelRegistry (in-memory + store-backed)       │
│  • Catalog of discovered models with metadata               │
│  • Health state per model (healthy/degraded/unavailable)    │
│  • Change detection (added/removed/changed)                 │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│          ModelDiscoveryService (per engine adapter)         │
│  • Calls adapter.listModels() / listModelsWithAvailability()│
│  • Periodic refresh + on-change refresh                     │
│  • Graceful handling of unavailable providers               │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│          ModelCapabilityEvaluator                            │
│  • Scores models against capability requirements            │
│  • Conservative: unknown metadata → not presumed capable    │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│          TaskModelSelector                                   │
│  • Translates task → capability requirements                │
│  • Ranks eligible models; selects highest-ranked            │
│  • Records selection reason (observability)                 │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│          ModelHealthMonitor                                  │
│  • Classifies errors (limit / provider / auth / context /   │
│    tool / network / execution)                              │
│  • Marks models temporarily ineligible                      │
│  • Triggers re-selection + fallback                         │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│          ModelFallbackEngine (bounded state machine)        │
│  • Re-evaluates candidates after a failure                  │
│  • Switches via existing adapter.applyModel()               │
│  • Prevents endless loops; safe stop when no eligible model │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Component responsibilities

| Component | Responsibility | Seam |
|-----------|---------------|------|
| `ModelRegistry` | Single source of truth for discovered models, metadata, health state, selection history | `src/engines/model-registry.ts` |
| `ModelDiscoveryService` | Polls each registered engine adapter for its model list; merges results; detects adds/removes/changes | `src/engines/model-discovery.ts` |
| `ModelCapabilityEvaluator` | Scores a model against a `TaskRequirements` capability set; never fabricates missing data | `src/engines/model-selection.ts` |
| `TaskModelSelector` | Maps task type (research/coding/test/simple) → requirements; ranks; selects; records reason | `src/engines/model-selection.ts` |
| `ModelHealthMonitor` | Listens to engine events/errors; classifies failure category; marks models ineligible with TTL | `src/engines/model-health.ts` |
| `ModelFallbackEngine` | State machine: healthy → degraded → switching → exhausted; bounded retries | `src/engines/model-fallback.ts` |
| `ModelConfig` (pluton.yaml layer) | Parses `models.*` and `ships[*].model`; resolves automatic vs. pinned per ship | `src/config/model-config.ts` |

### 2.3 What is NOT changed

- Engine adapters (`OpenCodeEngineAdapter`, `MockEngineAdapter`) remain the protocol boundary. They gain no new hardcoded model names.
- The ACP session turn loop (`AcpEngineSessionBase`) is untouched.
- The approval/permission channel (`interactive-approval.ts`) is reused unchanged.
- `pluton.yaml` ship entries remain valid without modification (backward compatible).

---

## 3. Model Metadata and Capability Schema

Extend `EngineModel` and `ModelAvailability` with capability metadata. Missing metadata is `null`/`unknown` — never fabricated.

### 3.1 Extended `EngineModel` (contract/types.ts)

```typescript
export interface EngineModel {
  id: string                    // provider-qualified, exact as engine reports
  label?: string                // human display name
  source: 'engine' | 'static'
  // Capability metadata (all optional — unknown when not reported)
  capabilities?: ModelCapabilities
  contextWindow?: number        // tokens, null = unknown
  toolCalling?: boolean         // null = unknown
  multimodal?: boolean          // null = unknown
  codingCapable?: boolean       // null = unknown
  reasoningCapable?: boolean    // null = unknown
  provider?: string             // opaque provider identity, when known (never inferred from the id)
  discoveredAt?: string         // ISO timestamp
  lastRefreshedAt?: string      // ISO timestamp
}
```

### 3.2 Capability metadata

```typescript
export interface ModelCapabilities {
  // Which task classes the model is reported/suited for
  taskFit?: ('research' | 'coding' | 'testing' | 'simple')[]
  // Quota / usage information when exposed by provider
  quota?: {
    limitReached?: boolean      // true if currently at/over limit
    resetAt?: string            // ISO timestamp when limit may reset
    remaining?: number
  }
  // Provider health
  providerHealth?: {
    healthy: boolean
    lastError?: string
    lastErrorAt?: string
  }
}
```

### 3.3 Extended `ModelAvailability`

```typescript
export type AvailabilityErrorCategory =
  | 'usage-limit'
  | 'provider-unavailable'
  | 'auth-failure'
  | 'context-limit-exceeded'
  | 'unsupported-tool-capability'
  | 'temporary-network-error'
  | 'execution-error'
  | 'unknown'

export interface ModelAvailability {
  id: string
  available: boolean
  reason?: string
  category?: AvailabilityErrorCategory   // classified error category
  source?: 'engine' | 'catalog' | 'static' | 'discovered'
  label?: string
  healthCheckedAt?: string               // ISO timestamp
  temporarilyIneligibleUntil?: string    // ISO timestamp (fallback cooldown)
}
```

### 3.4 Conservative default

When metadata is missing: `capabilities` = `[]`, `toolCalling` = `null`, `codingCapable` = `null`, etc. The selector treats `null` as "unknown — do not assume capability, but do not automatically exclude unless a requirement explicitly demands it."

---

## 4. Discovery and Refresh Strategy

### 4.1 Discovery sources

1. **Engine adapter `listModels()`** — every registered engine adapter reports its offered models. This is the authoritative source.
2. **Engine adapter `listModelsWithAvailability()`** — when available, includes per-model availability.
3. **pluton.yaml `models.discovery`** — optional provider allowlists/denylists that filter what is considered.

### 4.2 Refresh triggers

| Trigger | When | Action |
|---------|------|--------|
| Startup | Process start | Initial discovery across all registered engines |
| Periodic | Every `models.refreshIntervalMs` (default 5 min) | Re-poll all engines; detect changes |
| On failure | Usage limit / provider error detected | Immediate refresh of affected engine's model list |
| On demand | Operator requests via `pluton models refresh` | Full re-discovery |
| On config change | pluton.yaml edited | Re-read config, re-apply allowlists/denylists |

### 4.3 Change detection

The `ModelRegistry` compares each discovery result to the previous snapshot and emits:
- `model.discovered` — new model id seen
- `model.removed` — previously seen model no longer offered
- `model.changed` — metadata (availability, capabilities) changed

These events are persisted to the durable event log (see §10).

### 4.4 Unavailable providers

If an engine adapter's `listModels()` throws (binary missing, timeout, non-zero exit), the provider is marked `provider-unavailable` and its models are excluded. Discovery continues with other engines. No crash, no hard failure.

### 4.5 No hardcoded model IDs

The discovery service iterates `listEngineKinds()` from the registry and calls each adapter's `listModels()`. No model id is ever hardcoded in discovery or selection logic.

---

## 5. Task-Aware Selection Algorithm

### 5.1 Task requirements classification

Each task is classified into a `TaskModelRequirements` set:

```typescript
export interface TaskModelRequirements {
  taskType: 'research' | 'coding' | 'testing' | 'simple' | 'planning'
  requiresToolCalling: boolean
  requiresMultimodal: boolean
  minContextWindow?: number
  preferredCapabilities: ('research'|'coding'|'testing'|'simple')[]
  costPreference?: 'low' | 'balanced' | 'indifferent'
  latencyPreference?: 'low' | 'balanced' | 'indifferent'
}
```

Classification rules (conservative, overridable by pluton.yaml `models.selection.taskFit`):

| Task type | Default requirements |
|-----------|---------------------|
| `research` | `requiresToolCalling: true`, `preferredCapabilities: ['research', 'reasoning']`, large context preferred |
| `coding` | `requiresToolCalling: true`, `preferredCapabilities: ['coding']`, adequate context |
| `testing` | `requiresToolCalling: true`, `preferredCapabilities: ['testing']`, adequate context |
| `simple` | No required capabilities; prefers efficient/low-cost model |
| `planning` (supervisor) | `requiresToolCalling: false`, `preferredCapabilities: ['reasoning']` |

### 5.2 Scoring and ranking

For each eligible model (available, not temporarily ineligible, passes allowlist/denylist, passes capability requirements):

```
score = capabilityMatchScore  (0–100, how well capabilities match requirements)
      + contextWindowScore    (0–20, larger context = higher, capped)
      + healthScore           (0–20, healthy = 20, degraded = 10)
      + costScore             (0–10, lower cost preferred when costPreference='low')
      + latencyScore          (0–10, lower latency preferred when latencyPreference='low')
```

Ties broken by: (a) recently used successfully, (b) discovery order, (c) lexicographic id (deterministic but not meaningful).

**Conservative policy:** A model with `toolCalling: null` but `requiresToolCalling: true` is **excluded** (unknown ≠ capable). A model with `codingCapable: null` for a coding task is **excluded**. Missing metadata reduces confidence but does not disqualify unless a hard requirement is involved.

### 5.3 Selection output

```typescript
export interface ModelSelection {
  modelId: string
  reason: string                    // human-readable, persisted
  score: number
  candidatesConsidered: number
  eligibleCandidates: string[]
  selectedAt: string                // ISO timestamp
  selectionMode: 'automatic' | 'pinned' | 'fallback'
}
```

---

## 6. Configuration and pluton.yaml Migration

### 6.1 pluton.yaml additions (backward compatible)

New optional top-level `models:` section:

```yaml
models:
  discovery:
    refreshIntervalMs: 300000       # 5 minutes; 0 = disable periodic
    providers:
      allowlist: []                 # empty = all providers
      denylist: []                  # empty = none denied
  selection:
    taskFit:
      research: [research, reasoning]
      coding: [coding]
      testing: [testing]
      simple: []
      planning: [reasoning]
    costPreference: balanced        # low | balanced | indifferent
    latencyPreference: balanced     # low | balanced | indifferent
  fallback:
    maxRetriesPerModel: 2
    cooldownMs: 300000              # 5 minutes before a failed model is reconsidered
    maxTotalFallbacks: 5            # per task, bounded to prevent loops
```

Existing `ships.<id>.model` continues to work:
- If `model` is set → **pinned** selection (Decision 4). The selector still verifies the pinned model is available and eligible; if not, it reports the conflict to the operator rather than silently substituting.
- If `model` is omitted → **automatic** selection (Decision 2).

### 6.2 Migration path

- No existing pluton.yaml requires changes.
- `ships.<id>.model` values remain valid and are treated as pins.
- New `models.*` keys are optional; defaults produce behavior equivalent to current (but dynamic where possible).
- The CLI gains `pluton models list`, `pluton models refresh`, `pluton models select --task <id>` for inspection.

---

## 7. Model Availability and Health Management

### 7.1 Health states

| State | Meaning | Trigger |
|-------|---------|---------|
| `healthy` | Model offered by engine, no known issues | Discovery success |
| `degraded` | Model offered but recently hit a usage limit or error | Failure event, cooldown active |
| `unavailable` | Model not offered by any engine, or provider down | Discovery removal, provider error |
| `temporarily-ineligible` | Model failed within cooldown window; excluded from selection | Fallback engine marks it |

### 7.2 Error classification taxonomy (Spec §4)

The `ModelHealthMonitor` classifies every engine error into exactly one category:

| Category | Detection | Action |
|----------|-----------|--------|
| `usage-limit` | `isModelLimitError()` matches | Mark ineligible for cooldown, trigger fallback |
| `provider-unavailable` | `listModels()` throws / engine binary missing | Exclude provider's models, trigger fallback |
| `auth-failure` | 401 / credential errors from engine | Mark ineligible, require operator re-auth |
| `context-limit-exceeded` | Context window error from engine | Exclude model for this task, try smaller-context alternative |
| `unsupported-tool-capability` | Engine reports tool not supported | Exclude model for tool-requiring tasks |
| `temporary-network-error` | Transient ECONNREFUSED, timeout | Short cooldown, retry same model once |
| `execution-error` | Actual model output error (not infra) | Log, do not auto-switch (model may be fine) |
| `unknown` | Unclassified error | Conservative: short cooldown, fallback allowed |

**Not every error is a usage limit.** Execution errors do not trigger fallback.

### 7.3 Cooldown and re-eligibility

A model marked ineligible gets `temporarilyIneligibleUntil = now + cooldownMs`. After cooldown, it re-enters the eligible pool. Discovery refresh re-evaluates all health states.

---

## 8. Fallback and Recovery State Machine (Spec §5)

### 8.1 States

```
┌─────────┐    selection    ┌─────────┐    failure    ┌──────────┐
│ Healthy │────────────────►│ Degraded│──────────────►│ Switching│
└─────────┘                 └─────────┘               └─────┬────┘
                                                            │
                                               switch ok    │
                                                            ▼
                                               ┌────────────────┐
                                               │  Healthy       │
                                               │ (new model)    │
                                               └────────────────┘
                                                            │
                                               switch fail   │
                                                            ▼
                                               ┌────────────────┐
                                               │   Exhausted    │◄─────┐
                                               │   (no models)  │      │
                                               └────────────────┘      │
                                                                       │
                                          max retries / no eligible   │
                                                                       ▼
                                                              ┌────────────────┐
                                                              │ Operator alert │
                                                              │ (safe stop)    │
                                                              └────────────────┘
```

### 8.2 Transitions

| From → To | Condition | Action |
|-----------|-----------|--------|
| Healthy → Degraded | Usage limit / provider failure detected | Classify error, mark model ineligible, log `model.failure_detected` |
| Degraded → Switching | Next eligible model exists | Select next-best, log `model.switch_initiated` |
| Switching → Healthy | New model session starts successfully | Log `model.switch_completed`, resume prompt |
| Switching → Exhausted | No eligible model remains OR max total fallbacks reached | Log `model.exhausted`, alert operator, fail task safely |
| Any → Exhausted | `maxTotalFallbacks` exceeded | Prevent endless loops |

### 8.3 Bounded retry policy

- `maxRetriesPerModel` per model (default 2): how many times to retry the same model after a temporary error before moving on.
- `maxTotalFallbacks` per task (default 5): absolute cap on fallback transitions per task.
- After exhaustion: task preserved, conversation history preserved, operator notified, task left in recoverable state (`failed` with `model.exhausted` failure payload).

### 8.4 Safe prompt resumption (Spec §6)

Before replaying a prompt after a switch:
- Inspect the buffered events from the failed turn. If any tool calls (`tool` phase `start`) were emitted without a matching `end`, the operation has uncertain side effects — **do not auto-replay**. Report to operator.
- If the turn produced only `text`/`status`/`usage` events with no tool starts, replay is safe with the new model.
- The original prompt text is preserved in `result_json` / task brief; replay uses the same text.
- Idempotency: task id + attempt number is the dedupe key; completed operations are not repeated.

---

## 9. Multi-Agent Model Allocation (Spec §8)

### 9.1 Independent selection per worker

The supervisor calls `TaskModelSelector.select(task, ship)` for each task independently:
- Researcher task → requirements favor `research`/`reasoning` capabilities
- Coder task → requirements favor `coding` capability + tool calling
- Tester task → requirements favor `testing` + tool calling
- Supervisor/planning → reasoning, large context

Each worker gets its own `ModelSelection` recorded in its task's `assignment` (the existing `assignment` JSON field already carries `model`).

### 9.2 Isolation of failures

A model failure for worker A:
- Marks that model temporarily ineligible **for worker A's task only** (or globally if usage-limit is provider-level — this is a configuration choice in `models.fallback.scope`).
- Does **not** interrupt or restart other workers' sessions.
- Other workers continue with their independently selected models.

### 9.3 Role examples, not fixed assignments

`SHIP_ROLES` / `PERSISTENT_SHIP_ROLES` remain vocabulary only. No role → model mapping is hardcoded. pluton.yaml `ships.<id>.model` pins are the only fixed assignments, and only when explicitly set by the user.

---

## 10. Persistence and Observability (Spec §9)

### 10.1 Reused persistence

No new tables or databases. Model intelligence data rides on existing durable records:

| Record | New field(s) | Purpose |
|--------|-------------|---------|
| `TaskRecord.assignment` | `modelId`, `selectionMode`, `selectionReason` | What model was chosen and why |
| `TaskRecord.result_json` | `modelSwitches: [{from, to, reason, at}]` | Fallback history per task |
| `EventStore` | `model.discovered`, `model.removed`, `model.changed`, `model.failure_detected`, `model.switch_initiated`, `model.switch_completed`, `model.exhausted` | Observability stream |
| `ShipRecord.model` | Unchanged (pinned or null) | Source of truth for explicit vs. automatic |

### 10.2 Observability events

All model events are appended via the existing `store.appendEvent()` with the run/task/ship fence:

- `model.discovered { modelId, provider, capabilities }`
- `model.removed { modelId }`
- `model.failure_detected { modelId, category, errorCode }`
- `model.switch_initiated { from, to, reason }`
- `model.switch_completed { from, to }`
- `model.exhausted { modelId, reason, fallbacksUsed }`

### 10.3 UI exposure (Spec §7)

The inspector/SPA can query:
- Current model per worker (from `TaskRecord.assignment.modelId`)
- Provider (from model id prefix)
- Selection reason (from `selectionReason`)
- Previous model switches (from `result_json.modelSwitches`)
- Fallback history (from event stream)
- Current availability state (from `ModelRegistry` health)

No sensitive provider info (API keys, credentials) is logged — `redactDeep` already applied to scope payloads.

---

## 11. Security and Permission Boundaries (Spec §7)

- **No silent substitution of pinned models.** If `ships.<id>.model` is set but the pinned model is unavailable/ineligible, the operator is notified; the model is not silently changed.
- **Approval boundaries preserved.** Model fallback is an operational decision, not a tool execution. It uses the existing `EnginePermissionChannel` only when `approval_mode` requires it for sensitive provider/config changes. Ordinary automatic fallback within the allowlist does **not** require per-switch operator approval (Decision 7).
- **No secrets in logs.** Model ids and provider names are not secrets; credentials never enter the model registry.
- **Allowlist/denylist enforced.** The selector never considers a model on the denylist; only allowlisted models (if allowlist is non-empty) are eligible.

---

## 12. Testing Strategy and Acceptance Criteria (Spec §10)

### 12.1 Test principles

- **No hardcoded real model IDs.** All tests use dynamically generated mock model lists (`mock/model-a`, `mock/model-b`, etc.).
- **Mock engine adapters** implement `listModels()` returning configurable model arrays with configurable metadata.
- **Focused unit tests per component**, then integration tests through the supervisor.

### 12.2 Test matrix

| Category | Test | Mock setup |
|----------|------|------------|
| A. Discovery | New model appears | `listModels()` returns model-a on first call, model-a+model-b on second |
| A. Discovery | Model disappears | `listModels()` returns model-a then model-b only |
| A. Discovery | Provider unavailable | `listModels()` throws |
| A. Discovery | Metadata changes | `listModels()` returns same ids, different capabilities |
| B. Selection | Research task picks research-capable model | Models with/without `research` in `taskFit` |
| B. Selection | Coding task picks coding-capable model | Models with/without `coding` |
| B. Selection | Simple task picks efficient model | Models scored by cost/latency |
| B. Selection | Unsupported capability excludes candidate | Model lacks `toolCalling` but task requires it |
| C. Fallback | Usage limit reached | `isModelLimitError()` true → next eligible selected |
| C. Fallback | Provider failure | `listModels()` throws → other provider's model selected |
| C. Fallback | Temporary network error | Short cooldown, retry same model once |
| C. Fallback | Multiple fallback transitions | Chain of 3 models each failing in turn |
| C. Fallback | No eligible models remain | All models ineligible → `model.exhausted`, safe stop |
| D. Recovery | Context preserved | Same prompt text replayed with new model |
| D. Recovery | No duplicate tool execution | Buffered events inspected; no tool-start without tool-end replayed |
| D. Recovery | Completed results preserved | Prior task result not overwritten by fallback |
| E. Multi-agent | Different workers get different models | Researcher → research model, Coder → coding model |
| E. Multi-agent | One worker's fallback doesn't restart others | Worker B session continues while A falls back |
| E. Multi-agent | Availability change mid-execution | Model becomes unavailable during a running task |
| F. Regression | Existing operator approvals | `interactive` policy still gates permission requests |
| F. Regression | Existing model switching | `switchModel()` still works via `applyModel()` |
| F. Regression | Existing task execution | Supervisor `executeTask()` unchanged outcome |
| F. Regression | OpenCode / ACP adapters | Existing `opencode-model-fallback.test.ts` still passes |

### 12.3 Acceptance criteria

1. Model discovery works with zero hardcoded model ids.
2. Selection ranks by capability match, not model name or version number.
3. Fallback is dynamic (re-evaluates from live model list), bounded, and never infinite.
4. Pinned models in pluton.yaml are respected; unpinned ships use automatic selection.
5. One worker's model failure does not restart other workers.
6. All existing regression tests pass (`opencode-model-fallback.test.ts`, full `tests/unit/`).
7. `npm run build` passes with no type errors.

### 12.4 Final verdict definition

- **PASS**: All acceptance criteria met, all tests green, build clean.
- **PASS WITH WARNINGS**: Criteria met but non-blocking gaps documented.
- **FAIL**: Any acceptance criterion unmet or build broken.
- **BLOCKED**: Live execution cannot proceed (provider capacity/credentials unavailable).

---

## Implementation Plan

Phase 0 — Design document (this file) → **approved**
Phase 1 — Contract types: extend `EngineModel`, `ModelAvailability`, add `ModelCapabilities`, `TaskModelRequirements`, `ModelSelection`, `AvailabilityErrorCategory` → **complete**
Phase 2 — `ModelRegistry` + `ModelDiscoveryService`: discovery, refresh, change detection, health states → **complete**
Phase 3 — `ModelCapabilityEvaluator` + `TaskModelSelector`: capability evaluation, task classification, ranking, selection → **complete**
Phase 4 — `ModelHealthMonitor` + error classification: eight categories, scoped health, cooldowns, registry integration → **complete**
Phase 5 — `ModelFallbackEngine`: bounded fallback, safe replay detection, switch/exhausted/unsafe decisions → **complete**
Phase 6 — `ModelConfig`: pluton.yaml layer, automatic vs. pinned, allowlist/denylist, backward compat → **complete**
Phase 7 — Supervisor integration: per-task dynamic model selection via registry, pins, preferences → **complete**
Phase 8 — Comprehensive test matrix: contracts, discovery, capability, health, fallback, config, supervisor → **complete**
Phase 2 — `ModelRegistry` + `ModelDiscoveryService`: discovery, refresh, change detection, health states
Phase 3 — `ModelCapabilityEvaluator` + `TaskModelSelector`: task-aware ranking, conservative selection
Phase 4 — `ModelHealthMonitor`: error classification, cooldown, re-eligibility
Phase 5 — `ModelFallbackEngine`: bounded state machine, safe resumption
Phase 6 — `ModelConfig` (pluton.yaml layer): automatic vs. pinned, allowlist/denylist, backward compat
Phase 7 — Supervisor integration: per-task model selection, `pluton models` CLI commands
Phase 8 — Tests: full matrix from §12.2
Phase 9 — Regression + build + final report

## Approved architectural decisions (PLUTON 3.2)

### Decision 1 — Fallback scope (provider-aware)

- Task-specific quota errors exclude the affected model for that task only.
- Provider/account-wide quota errors affect all workers sharing that quota scope.
- Unrelated provider accounts remain eligible.
- Cooldown and availability rechecks supported.
- A model is never globally disabled based on an isolated task-level failure.

### Decision 2 — Task classification precedence

1. Explicit task-type/capability hints (optional, backward compatible).
2. Task description and acceptance criteria.
3. Ship role as a fallback hint.
4. General-purpose requirements when classification is uncertain.

### Decision 3 — Cost and latency

- Unknown cost/latency does not automatically exclude a model.
- Unknown values contribute zero to ranking.
- Known values influence ranking only when configured.
- Explicit cost/latency ceilings are hard constraints; unknown values cannot establish compliance and must be treated as unverified.
- Capability and availability constraints take priority over cost/latency.

---

After you approve the design, I'll proceed Phase 1 onward, verifying after each phase.