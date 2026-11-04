# PLUTON 4.2 — Execution Architecture Audit and Provider Independence Baseline

- **Repository**: `aniketkolse/PLUTON-Harness`
- **Working Tree**: `Y:\Pluton`
- **Platform**: `win32` (Windows 11 / x64, Node `v24.20.0`)
- **Branch**: `main` (tracking `origin/main`)
- **HEAD Commit**: `cd70630` (`docs: document Phase 5 file explorer scalability and update audit matrix`)
- **Working Tree State**: `pluton.yaml` modified (preserved verbatim without unstaged revert or modification)
- **Audit Date**: 2026-11-03
- **Audit Mode**: Read-only inspection. No product code, database records, credentials, or configuration files were modified.

---

## 1. Executive Summary

When an OpenCode account reaches its usage limit, PLUTON halts coding execution globally. Even when a secondary external AI provider (such as an OpenAI-compatible endpoint like `9router`, Ollama, vLLM, DeepSeek, or Groq) is configured with valid credentials in `.pluton/providers.json` and its models appear in the model registry, assigning one of those models to a Ship still results in an OpenCode quota error.

This audit establishes the concrete root causes of this failure:
1. **Model identity is not composite**: Models are tracked and assigned as bare strings (e.g. `9router/ag/gemini-3.8-flash-high`) rather than a composite tuple `(engineKind, providerId, modelId)`.
2. **OpenCode is assumed to be the default execution engine**: In `src/engines/opencode/adapter.ts`, `SHIP_WORKER_MODELS` hardcodes external provider models (`9router/*`) into OpenCode's static catalog.
3. **Frontend drops provider and engine identity**: In `src/server/static-assets.ts`, model switching via popover and quick select transmits `{ model: modelId }` without `provider` or `engine`, forcing the backend to retain `ship.engineKind` (`opencode`).
4. **Durable Ship state omits provider tracking**: SQLite's `ships` table lacks a `provider` column, and `ShipRecord` has no `provider` property.
5. **Supervisor and fallback are trapped in the Ship's initial engine**: In `src/orchestrator/supervisor.ts`, model selection and fallback are constrained to `entry.engineKind === ship.engineKind`, and fallback reuses the exact same initial engine adapter instance.
6. **Health and quota scope defaults to engineKind**: In `src/engines/model-health.ts`, errors lacking a provider scope default to `engineKind` (`opencode`), marking all models under that engine as ineligible for 5 minutes.

External providers already support real execution (streaming SSE, thought tokens, MCP tool execution via HTTP, cancellation, and error normalization in `OpenAICompatibleSession`), not just model discovery. The failure is an **architectural routing and identity failure**, not a lack of execution capability in the external adapter.

---

## 2. Baseline Verification Results

Verification commands run against current repository HEAD (`cd70630`):

| Check | Command | Status | Details |
|---|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** | `tsc -p tsconfig.json`, exit code 0 |
| Build | `npm run build` | **PASS** | `tsc -p tsconfig.build.json`, exit code 0 |
| Asset Verification | `npm run verify:assets` | **PASS** | 77 checks passed |
| Doc Links | `npm run verify:docs` | **PASS** | 123 files scanned, 52 links checked, 0 broken |
| Unit / Integration Tests | `npm test` | **FAIL (partial)** | Schema version 15 bump left hardcoded arrays in store tests; OpenCode mock test missing project config mock |

---

## 3. Complete Execution Path Trace

Below is the verified end-to-end trace from UI model selection to execution completion, tracking how an external provider model request gets diverted to OpenCode.

```
[UI: Model Selection]
  ├── Popover Item Click: switchModel(modelId) -> drops providerId, engineId
  └── Quick Select Change: switchMuseModel(shipId, sel.value) -> drops providerId, engineId
          │
          ▼
[HTTP Request: POST /api/ships/:id/model]
  Payload: { model: "9router/ag/gemini-3.8-flash-high" }
  (provider: undefined, engine: undefined)
          │
          ▼
[API Route: src/server/routes.ts]
  ├── targetEngine = payload.engine || ship.engineKind -> evaluates to "opencode"
  ├── targetProvider = undefined
  ├── getEngineAdapter("opencode", { providerId: undefined }) -> OpenCodeEngineAdapter
  ├── adapter.listModelsWithAvailability() -> matches because 9router/* is in SHIP_WORKER_MODELS!
  ├── store.updateShipModel(ship.id, model, "opencode") -> persists engine_kind='opencode'
  └── editShip(...) -> updates pluton.yaml with engine: opencode
          │
          ▼
[Supervisor Dispatch: src/orchestrator/service.ts & supervisor.ts]
  ├── RunSupervisor.executeTask(task)
  ├── selectModel(registry, { engineKind: ship.engineKind ("opencode") })
  │     └── Filters candidates to engineKind === 'opencode'
  ├── Resolved Model = "9router/ag/gemini-3.8-flash-high"
  ├── supervisorAdapterFor(ship, session)
  │     └── nativeAdapterFor(ship, ...)
  │           └── engineAdapterForShip(ship, ...)
  │                 └── ship.engineKind === 'opencode' -> new OpenCodeEngineAdapter()
  └── adapter.startSession({ ship: { model: "9router/ag/gemini-3.8-flash-high" }, ... })
          │
          ▼
[Engine Process Spawn: src/engines/opencode/adapter.ts]
  ├── Spawns `opencode` binary over stdio JSON-RPC (ACP protocol)
  ├── ACP: `session/new`
  ├── ACP: `session/set_config_option` { configId: 'model', value: '9router/ag/gemini-3.8-flash-high' }
  └── ACP: `session/prompt`
          │
          ▼
[Execution Failure & Quota Trap]
  ├── OpenCode CLI returns: "OpenCode account reaches its usage limit"
  ├── supervisor.ts classifies error as `usage-limit`
  ├── ModelHealthMonitor.recordFailure():
  │     ├── context.provider is undefined -> providerScope = "opencode"
  │     ├── Sets cooldown on all models under "opencode"
  │     └── 9router/ag/gemini-3.8-flash-high marked ineligible
  └── decideFallback({ engineKind: "opencode" }):
        ├── Only considers "opencode" engine models
        ├── All "opencode" models in cooldown
        └── Fallback fails with action: 'exhausted'
```

---

## 4. Exact Failure Locations

| Component | File Path | Line(s) | Failure Mechanism |
|---|---|---|---|
| **Frontend Quick Select** | `src/server/static-assets.ts` | 4846 | `switchMuseModel(sel.getAttribute('data-muse'), sel.value)` passes only 2 arguments, omitting `providerId` and `engineId`. |
| **Frontend Popover** | `src/server/static-assets.ts` | 4588–4589, 4730–4733 | `switchModel(modelId)` accepts only `modelId` and posts `{ model: modelId }` without `provider` or `engine`. |
| **Catalog Contamination** | `src/engines/opencode/adapter.ts` | 36–39, 464 | `SHIP_WORKER_MODELS` hardcodes `9router/ag/claude-opus-4-6-thinking`, `9router/ag/gemini-3.8-flash`, `9router/ag/gemini-3.8-flash-high` into OpenCode's static candidate catalog. |
| **Backend Route Fallback** | `src/server/routes.ts` | 1402, 1420–1424 | `targetEngine = payload.engine?.trim() \|\| ship.engineKind` falls back to `opencode` when payload omits `engine`. |
| **Durable Store Gap** | `src/store/migrations.ts` & `src/store/store.ts` | `migrations.ts:31–47`, `store.ts:546–555` | `ships` table schema does not include a `provider` column; `updateShipModel` only records `model` and `engine_kind`. |
| **Supervisor Model Filter** | `src/orchestrator/supervisor.ts` | 1392 | `selectModel(..., { engineKind: ship.engineKind })` strictly excludes models from any other engine. |
| **Supervisor Fallback Scope** | `src/orchestrator/supervisor.ts` | 1593, 1641 | `decideFallback` passes `engineKind: adapter.kind`, and fallback execution calls `await adapter.startSession(...)` reusing the initial engine adapter. |
| **Health Monitor Quota Scope** | `src/engines/model-health.ts` | 373, 412–424 | `providerScope = context.quotaScope ?? context.provider ?? engineKind` defaults to `'opencode'`, placing all OpenCode models into global cooldown. |

---

## 5. Root Cause Analysis

The root cause is a compound architectural flaw:

1. **Model-Centric Identity vs Engine/Provider Triplet**:
   The system was designed under the assumption that a model string (e.g. `opencode/deepseek-v4.1-flash-free`) uniquely identifies the execution pipeline. When external providers were added in PLUTON 4.1 Phase 1, `provider` was added to `pluton.yaml` as an optional configuration attribute, but model identity was never unified into `(engineKind, providerId, modelId)`.

2. **OpenCode Gateway Assumption**:
   Because `9router/*` was hardcoded in `SHIP_WORKER_MODELS`, PLUTON treated `9router` models as OpenCode models. When a user selected `9router/ag/gemini-3.8-flash-high`, PLUTON did not route the request to `OpenAICompatibleAdapter`; it spawned `opencode` and asked OpenCode to run it. When the OpenCode account ran out of quota, OpenCode rejected the request.

3. **Lossy State Persistence and Frontend Transport**:
   The frontend UI discarded provider and engine parameters on quick select and popover model switches. Even if a user intended to switch to an external provider, the API payload received only `model`. The API defaulted `targetEngine` to `ship.engineKind` (`opencode`). The SQLite database had nowhere to persist `provider`.

4. **Inflexible Supervisor Execution and Fallback**:
   The supervisor bound each task to a single `EngineAdapter` constructed at session initialization. Fallback logic in `decideFallback()` and `supervisor.ts` had no mechanism to query candidate models from another engine, resolve a new engine adapter, or construct a replacement session under a different provider.

---

## 6. OpenCode-Specific Dependencies Inventory

The following locations in the codebase assume OpenCode is universal or treat its availability as global:

1. `src/engines/opencode/adapter.ts`:
   - `SHIP_WORKER_MODELS`: Hardcodes external provider models alongside OpenCode free models.
   - `listModelsWithAvailability()`: Blends `SHIP_WORKER_MODELS` with live discovery.
2. `src/server/routes.ts`:
   - Line 1285: `engineKinds.add('opencode')` guarantees OpenCode is always queried even if no Ship uses it.
   - Line 1315–1322: Special-cases `opencode` catalog fallback when discovery returns an empty list.
   - Line 1402: Defaults `targetEngine` to `ship.engineKind`.
3. `src/engines/approval.ts`:
   - `engineAdapterForShip`: Special-cases `ship.engineKind === 'opencode'` with custom permission mapping, delegating other engines to `getEngineAdapter`.
4. `src/orchestrator/service.ts`:
   - `discoveryEngines`: Registers `getEngineAdapter(f.kind, { rootDir: ctx.rootDir })` without `providerId`. This works for OpenCode because it needs no provider configuration, but fails or drops `openai-compatible` when multiple providers exist.
5. `src/server/static-assets.ts`:
   - Line 4829: `renderMuseModels()` extracts options from `state.models[m.engine]`. If a Ship's engine is `opencode`, the select dropdown only presents OpenCode models.

---

## 7. Existing Reusable Components & Capabilities

PLUTON already possesses a full, production-grade external provider execution stack. It is **not** limited to discovery:

| Component | Location | Verified Capabilities |
|---|---|---|
| `OpenAICompatibleAdapter` | `src/engines/openai-compatible/adapter.ts` | Resolves provider credentials from store, validates HTTP endpoints, discovers models via GET `/models`, creates sessions with MCP specs. |
| `OpenAICompatibleClient` | `src/engines/openai-compatible/client.ts` | Direct REST and SSE streaming over native `fetch`. Parses SSE deltas for text, thought/reasoning, usage, and tool calls. |
| `OpenAICompatibleSession` | `src/engines/openai-compatible/session.ts` | Full multi-turn conversation loop. Translates Pluton MCP tools into OpenAI tool definitions. Executes tool calls via `McpHttpClient`, feeds tool outputs back to model, handles cancellation and token limits. |
| `McpHttpClient` | `src/engines/openai-compatible/mcp-client.ts` | Speaks JSON-RPC 2.0 over HTTP POST to Pluton's tool bridge. Calls `tools/list` and `tools/call`. |
| `PlutonToolBridge` | `src/tools/bridge.ts` | Unified tool execution runtime: read files, edit files, execute commands, inspect diffs, manage approvals, and enforce workspace isolation. |
| `ProviderStore` | `src/providers/store.ts` | Isolated credential storage in `.pluton/provider-homes/<id>/credential.json` (0600 POSIX, Windows SID ACLs) and provider config in `.pluton/providers.json`. |
| `ModelRegistry` | `src/engines/model-registry.ts` | In-memory catalog keyed by composite `(engineKind, modelId)` with capability tracking. |
| `ModelHealthMonitor` | `src/engines/model-health.ts` | Error classification into 8 categories (`usage-limit`, `auth-failure`, etc.) with scope support (`task`, `provider`, `global`). |

---

## 8. Missing Adapter Capabilities & Architectural Gaps

To achieve true provider independence, the following architectural elements must be repaired:

1. **Explicit Execution Router (`src/engines/router.ts`)**:
   - Given a model ID and optional provider/engine hints, resolve: `modelId` → `{ engineKind, providerId, exactModelId }`.
   - Never infer an external provider model as an OpenCode model.
2. **Provider Identity in Durable Ship State**:
   - Add `provider` column to SQLite `ships` table via migration v16.
   - Add `provider?: string` to `ShipRecord`.
   - Ensure `store.updateShipModel` and `syncShips` preserve `provider`.
3. **Frontend Model Selector Integrity**:
   - `switchModel` and `switchMuseModel` must send `{ model: modelId, provider: providerId, engine: engineId }`.
   - The model dropdown must group by provider and allow switching a Ship across engines and providers.
4. **Dynamic Adapter Resolution in Supervisor**:
   - `supervisor.ts` must resolve the appropriate `EngineAdapter` dynamically based on the resolved model's engine and provider, rather than locking to the Ship's initial adapter.
5. **Cross-Engine Fallback**:
   - When an engine encounters `usage-limit` or failure, `decideFallback` must be able to consider eligible candidate models from other healthy engines/providers.
   - When fallback switches to a different engine, the supervisor must close the old session, construct an adapter for the replacement engine/provider, and launch a new session.
6. **Isolated Quota and Health Scoping**:
   - `ModelErrorContext` must capture `providerId`.
   - When OpenCode hits usage limits, only `(opencode, opencode)` is cooled down. Configured external providers (e.g. `(openai-compatible, 9router)`) remain 100% healthy and available.

---

## 9. Credential and Quota Flow

### Current vs Target Credential Flow:
- **OpenCode**: Reads credentials from the CLI environment (`OPENCODE_API_KEY` or `~/.config/opencode`). Completely independent from Pluton's internal provider store.
- **External Providers**: Stored securely in `.pluton/provider-homes/<providerId>/credential.json`. Read exclusively by `OpenAICompatibleAdapter.credentialFor()`. Passed as `Authorization: Bearer <key>` directly to the provider's HTTP endpoint.
- **Isolation Guarantee**: OpenCode never receives external provider keys; external HTTP requests never use OpenCode credentials.

### Current vs Target Quota Flow:
- **Current**: OpenCode quota error → `ModelHealthMonitor.recordFailure` with `context.provider = undefined` → defaults `providerScope = 'opencode'` → cools down all models registered under `opencode` (which included `9router/*`).
- **Target**: OpenCode quota error → scoped strictly to `engineKind: 'opencode'`, `providerId: 'opencode'`. External models registered under `engineKind: 'openai-compatible'`, `providerId: '<provider>'` are unaffected. When Build or Ship executes with an external model, requests go directly to the external HTTP API without touching OpenCode.

---

## 10. Required Migrations

1. **SQLite Database Migration (v16)**:
   - Migration file: `src/store/migrations.ts`.
   - Step: Add column `provider TEXT` to `ships` table.
   - Schema version bumped to `16`.
2. **Domain Models**:
   - Update `ShipRecord` in `src/domain/models.ts` to include `provider: string | null`.
3. **Store Updates**:
   - Update `src/store/store.ts`:
     - `updateShipModel(id: string, model: string, engineKind?: string, provider?: string | null)`
     - Update `syncShips` to insert/update `provider`.
     - Update row mapper `rowToShip` to read `row.provider`.

---

## 11. Regression Risks & Mitigation

| Risk | Mitigation |
|---|---|
| Modifying `pluton.yaml` without approval | Strictly prohibited. Model/provider assignment will be persisted in SQLite store and runtime memory without touching `pluton.yaml` unless explicitly commanded. |
| Discarding unstaged `pluton.yaml` changes | Current working tree diff preserved intact. |
| Breaking OpenCode CLI compatibility | OpenCode adapter preserved unchanged for actual OpenCode models; only hardcoded foreign models removed from its static list. |
| API key leakage | API keys remain strictly in `credential.json` and are redacted by `redactProseSecrets`. |
| MCP sandbox boundary degradation | Tool execution continues through `PlutonToolBridge` with token verification, file leases, workspace confinement, and approval enforcement. |
| Test suite version expectations | Store migration tests will be updated to accommodate v16 schema expectations cleanly. |

---

## 12. Conclusion and Next Steps

Phase 0 confirms that the failure is entirely due to architectural routing, misattribution in catalogs, loss of provider context in UI/API/store, and rigid single-adapter supervisor sessions.

The path forward for Phase 1 is clear:
1. Purge foreign model IDs from `SHIP_WORKER_MODELS` in `src/engines/opencode/adapter.ts`.
2. Establish an explicit execution router resolving `(modelId, provider?, engine?)` to `{ engineKind, providerId, modelId }`.
3. Add `provider` persistence to `ShipRecord` and SQLite `ships` table.
4. Update frontend and API routes to preserve provider and engine metadata.
5. Enable cross-engine adapter resolution and session switching in `supervisor.ts`.
6. Scope model health and quota strictly to `(engineKind, providerId)`.