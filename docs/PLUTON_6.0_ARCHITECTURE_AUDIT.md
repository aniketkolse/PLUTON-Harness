# PLUTON 6.0 — Architecture Audit: Universal Provider-Agnostic AI Execution

- **Document**: `docs/PLUTON_6.0_ARCHITECTURE_AUDIT.md`
- **Specification**: PLUTON 6.0 — Universal Provider-Agnostic AI Execution Architecture
- **Repository**: `aniketkolse/PLUTON-Harness`
- **Working Tree**: `Y:\Pluton`
- **Platform**: `win32` (Windows 11 / x64, Node `v24.20.0`)
- **Audit Date**: 2026-11-04
- **Audit Mode**: Read-only codebase inspection. No application code, database records, credentials, or configuration files modified during audit.
- **Test Baseline**: 114 / 114 unit, server, and engine tests passing across `provider-store`, `provider-routes`, `provider-cli`, `execution-router`, and `openai-compatible` suites.

---

## 1. Executive Summary & Core Diagnosis

PLUTON's original design coupled agent execution to OpenCode as the sole process-spawning execution engine. External providers (such as OpenAI-compatible endpoints) were introduced as secondary engines, but fundamental assumptions that OpenCode is the universal execution layer remain embedded across model routing, model selection, supervisor task dispatch, health tracking, UI model presentation, and tool execution.

When a user selects an external provider model (such as `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b`), the following failure modes occur:
1. **Model identity failure**: The execution router assumes that the first path segment before `/` represents a PLUTON provider connection ID. For multi-segment model IDs like `nvidia/nvidia/nemotron...`, `prefix` resolves to `nvidia`. When no provider named `nvidia` is configured in `.pluton/providers.json`, routing silently falls back to `opencode`.
2. **Catalog validation failure**: The OpenCode engine adapter validates the model against its own catalog. Because OpenCode does not offer the external model, it rejects the model switch with:
   `model 'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b' is not offered by engine 'opencode'`.
3. **Supervisor worker model override**: Unless a model is explicitly pinned in `pluton.yaml` under `pin: <model>`, `RunSupervisor.executeTask` runs `selectModel(this.modelRegistry, { engineKind: ship.engineKind })` and overrides `ship.model` with whatever model scores highest in the registry for that engine.
4. **Health & quota blast-radius leakage**: `RunSupervisor` records task failures in `ModelErrorContext` without specifying `provider`. `ModelHealthMonitor` defaults `providerScope` to `engineKind` (`openai-compatible`). A quota or authentication failure on one provider marks all models across all providers using `openai-compatible` as unavailable.
5. **Tool runtime execution vacuum**: `OpenAICompatibleSession` supports native function-calling over MCP, but PLUTON's MCP tool bridge (`src/tools/catalog.ts`) exposes only run management and orchestration tools (`task.create`, `task.inspect`, `diff.inspect`, `project.read`). All file creation, file editing, directory searching, and terminal command execution were historically delegated to OpenCode's built-in binary tools. Without OpenCode, external models cannot edit code or run tests.

---

## 2. Execution Path Trace: Model Selection to Task Completion

Below is the verified end-to-end trace from UI/CLI model selection to worker task execution.

```
[1. User Action: Model Selection]
   ├── UI: Popover item click or Browse Modal -> selectModelForShip(shipId, modelId, providerId, engineId)
   └── CLI: /model <modelId>
            │
            ▼
[2. HTTP Request: POST /api/ships/:id/model]
   Payload: { model: "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b", provider: null, engine: null }
            │
            ▼
[3. Execution Router: src/engines/execution-router.ts -> resolveExecutionRoute]
   ├── modelPrefix("nvidia/nvidia/...") -> "nvidia"
   ├── providerById.has("nvidia") -> FALSE (provider may be named "openrouter" or "my-gateway")
   ├── BUILTIN_MODEL_PREFIXES.has("nvidia") -> FALSE
   ├── importOpenCodeProviders(rootDir) -> does not find provider "nvidia"
   ├── Step 3 Fallback: resolvedEngine = ship.engineKind || "opencode" -> "opencode"
   └── Returned Route: { identity: { engineKind: "opencode", providerId: "opencode", modelId: "..." } }
            │
            ▼
[4. Engine Model Validation: src/server/routes.ts:1530-1549]
   ├── adapter = getEngineAdapter("opencode") -> OpenCodeEngineAdapter
   ├── available = await adapter.listModels() -> OpenCode catalog
   ├── known = available.some(...) -> FALSE
   └── HTTP 400: "model 'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b' is not offered by engine 'opencode'"
            │
            ▼ (If validation was bypassed or model belonged to a configured provider)
[5. Persistence: SQLite & pluton.yaml]
   ├── store.updateShipModel(shipId, requestedModel, targetEngine, targetProvider)
   └── editShip(pluton.yaml) -> updates model, engine, provider
            │
            ▼
[6. Supervisor Run Dispatch: src/orchestrator/service.ts & supervisor.ts]
   ├── RunSupervisor.executeTask(task, ship)
   ├── Check cfg.pin -> IF NOT PINNED:
   │     selectModel(this.modelRegistry, { engineKind: ship.engineKind })
   │     resolvedModel = modelSelectionOutcome.selection.modelId  <-- OVERRIDES ship.model!
   ├── adapter = this.adapterFor(ship, { isolatedCheckout }, resolvedModel)
   └── session = await adapter.startSession({ model: resolvedModel, mcpServers: [mcpSpec] })
            │
            ▼
[7. Tool Execution Loop: src/engines/openai-compatible/session.ts]
   ├── Model requests function call (e.g. write_file, edit_file, bash)
   ├── McpHttpClient.callTool(name, args) -> hits PlutonToolBridge via HTTP
   └── PlutonToolBridge.callTool(name, args) -> NOT FOUND!
         Only task.*, ship.*, diff.inspect, and project.read exist in PlutonToolBridge.
         Model turn fails or hallucinates completion without modifying workspace files.
            │
            ▼
[8. Fallback on Failure: src/orchestrator/supervisor.ts:1608-1678]
   ├── errorContext = { engineKind: adapter.kind, modelId, ... } (provider omitted!)
   ├── healthMonitor.recordFailure -> providerScope defaults to "openai-compatible"
   │     -> ALL models under engine "openai-compatible" marked unavailable!
   └── decideFallback -> decides switch to replacement model
         fallbackSession = await adapter.startSession({ model: currentModelId })
         CRITICAL BUG: Reuses the SAME adapter instance without re-resolving route!
```

---

## 3. Detailed Answers to Core Architectural Audit Questions

### 3.1 Where OpenCode is assumed to be the default engine

1. **Ship Configuration Templates (`templates/teams/*.yaml`)**:
   - `templates/teams/bugfix.yaml` (lines 37, 46): Every ship hardcodes `engine: opencode` and `model: opencode/deepseek-v4.1-flash-free`.
   - `templates/teams/full-stack.yaml`: All worker ships default to `engine: opencode`.
   - `templates/teams/repository-analysis.yaml`: All worker ships default to `engine: opencode`.
2. **Execution Router Fallback (`src/engines/execution-router.ts:227, 252`)**:
   - In `resolveExecutionRoute`, when no external provider prefix matches:
     ```typescript
     resolvedEngine = resolvedEngine ?? 'opencode'
     resolvedProviderId = resolvedEngine
     ```
   - Defaults unresolved models directly to engine `'opencode'`.
3. **API Model Enumeration (`src/server/routes.ts:1339-1340, 1370`)**:
   - `engineKinds.add('opencode')` is hardcoded into `/api/models`.
   - An empty model catalog falls back to `SHIP_WORKER_MODELS` specifically for `'opencode'`.
4. **UI Ship Configuration Dropdowns (`src/server/static-assets.ts:4876`)**:
   - In `renderMuseModels()`, the dropdown options for a ship are computed as:
     `var options = engineModels[m.engine] || [];`
   - If a ship has `engine: 'opencode'`, its dropdown lists only models discovered by OpenCode. External models in `engineModels['openai-compatible']` are hidden from the select menu unless the user clicks the secondary "Browse..." button.
5. **Supervisor Dynamic Selection (`src/orchestrator/supervisor.ts:1421`)**:
   - `selectModel` is invoked with `engineKind: ship.engineKind`. If the ship was created with the default engine, it only searches for models discovered through OpenCode.

### 3.2 Where provider identity is lost

1. **Model Registry Composite Key (`src/engines/model-registry.ts:21-27, 120-121`)**:
   - `ModelRegistryKey` is defined as:
     ```typescript
     export interface ModelRegistryKey {
       engineKind: string
       modelId: string
     }
     ```
   - The registry internal map is:
     `byEngine = new Map<string, Map<string, ModelRegistryEntry>>()`
   - **`providerId` is omitted from the key.**
   - Impact: If two external providers (e.g. `9router` and `groq`) share a model name (e.g. `llama-3.3-70b-instruct`), they overwrite each other in the registry.
2. **Supervisor Failure Context (`src/orchestrator/supervisor.ts:1608-1614`)**:
   - During task failure handling:
     ```typescript
     const errorContext: ModelErrorContext = {
       engineKind: adapter.kind,
       modelId: currentModelId,
       providerMessage: out.errorCode || out.summary || 'unknown error',
       scopeHint: 'task',
       taskId: task.id,
     }
     ```
   - **`provider` is not set on `errorContext`.**
   - Impact: `ModelHealthMonitor` falls back to `providerScope = engineKind` (`openai-compatible`), conflating all providers.
3. **Execution Route Resolution (`src/engines/execution-router.ts:89-92`)**:
   - `modelPrefix(modelId)` splits on the first `/`:
     ```typescript
     function modelPrefix(modelId: string): string {
       const slashIndex = modelId.indexOf('/')
       return slashIndex !== -1 ? modelId.slice(0, slashIndex).toLowerCase() : ''
     }
     ```
   - Impact: For vendor-prefixed models like `nvidia/nemotron...` or `meta-llama/llama-3...` hosted on a gateway like `openrouter`, `prefix` becomes `nvidia` or `meta-llama`. The gateway's provider identity (`openrouter`) is completely lost.
4. **Fallback Recovery Loop (`src/orchestrator/supervisor.ts:1670`)**:
   - When switching to `currentModelId = decision.toModelId`, the supervisor does not call `resolveExecutionRoute` or look up the provider identity for `decision.toModelId`.

### 3.3 Where external models are incorrectly validated against OpenCode

1. **API Model Switch Route (`src/server/routes.ts:1530-1549`)**:
   - When switching a ship's model via `POST /api/ships/:id/model`:
     ```typescript
     const adapter = getEngineAdapter(targetEngine, { rootDir, providerId: targetProvider })
     if (!isCustom && adapter.capabilities().modelList) {
       const available = await adapter.listModels()
       const checkModelId = targetRoute?.providerModelId ?? requested
       const known = available.some(...)
       if (!known && available.length > 0) {
         this.sendJson(res, 400, {
           ok: false,
           error: `model '${requested}' is not offered by engine '${targetEngine}'`,
           available: available.map((m) => m.id),
         })
         return true
       }
     }
     ```
   - If `resolveExecutionRoute` defaulted `targetEngine` to `'opencode'`, OpenCode's adapter validates the model. If absent from OpenCode's catalog, it rejects the valid external model.
2. **CLI Model Switch Command (`src/cli/commands/chat.ts:574-583`)**:
   - In `pluton chat`, the `/model` command checks candidate models against the session's existing adapter before route re-resolution:
     ```typescript
     if (caps.modelList && targetEngine === ship.engineKind) {
       const list = await adapter.listModels()
       ...
       return `Model '${trimmed}' is not supported by engine '${ship.engineKind}'. Available models: ${available}`
     }
     ```
   - If `ship.engineKind` is `'opencode'`, the model is validated against OpenCode.

### 3.4 Whether all sessions are created through the same adapter

1. **Session Creation Points**:
   - **Background Run Supervisor (`src/orchestrator/service.ts:398-430`)**: Sessions are created via `adapterForResolvedRoute({ route, ship, provider, ... })`.
   - **Interactive Chat (`src/server/routes.ts:2350-2375`, `src/chat/session.ts`)**: Sessions are created via `adapterForResolvedRoute`.
2. **Adapter Segregation**:
   - For `opencode`, `adapterForResolvedRoute` wraps `OpenCodeEngineAdapter` in `NativeExecutionAdapter` (process supervision and sandbox containment).
   - For `openai-compatible`, `adapterForResolvedRoute` returns `OpenAICompatibleAdapter` directly (HTTP streaming, no process sandbox).
3. **Session Re-resolution Defect**:
   - While initial session creation respects the route, **supervisor fallback (`src/orchestrator/supervisor.ts:1670`) reuses the existing adapter instance**. If a worker starts on `opencode` and tries to fall back to an `openai-compatible` model, it crashes because `OpenCodeEngineAdapter.startSession` is called with the external model id.

### 3.5 Whether the supervisor overrides worker model assignments

**YES.** In `src/orchestrator/supervisor.ts:1412-1442`:
```typescript
let resolvedModel: string
let modelSelectionOutcome: ModelSelectionOutcome | null = null
const cfg = this.modelConfig?.ships[ship.id]
if (cfg?.pin) {
  resolvedModel = cfg.pin
} else if (this.modelRegistry !== null) {
  modelSelectionOutcome = selectModel(this.modelRegistry, {
    task: { title: task.title, brief: task.brief, acceptanceCriteria: task.acceptanceCriteria },
    shipRole: ship.role as ShipRole,
    engineKind: ship.engineKind,
    ...
  })
  if (modelSelectionOutcome.selection !== null) {
    resolvedModel = modelSelectionOutcome.selection.modelId
  } else {
    resolvedModel = ship.model
  }
} else {
  resolvedModel = ship.model
}
```
Unless the operator has explicitly pinned the model in `pluton.yaml` under `ships.<id>.pin`, `selectModel` evaluates the entire registry and dynamically picks the model with the highest heuristic score. If the user explicitly configured `ship.model = '9router/ag/gemini-3.8-flash-high'`, but another model in the registry has a higher score for that role, `ship.model` is silently overridden.

### 3.6 Whether the UI and backend use different model identifiers

**YES.** There is significant identifier mismatch:
1. **Remote Model Reporting (`src/engines/openai-compatible/adapter.ts:108`)**:
   `OpenAICompatibleAdapter.listModels()` returns the exact remote ID (e.g. `ag/gemini-3.8-flash-high` or `nemotron-3.5...`).
2. **API Model Decoration (`src/server/routes.ts:1410-1413`)**:
   `GET /api/models` prepends the provider ID:
   `compositeId = rawId.startsWith(`${prov.id}/`) ? rawId : `${prov.id}/${rawId}``
   The API exposes `id: "9router/ag/gemini-3.8-flash-high"`.
3. **UI Model Tracking (`src/server/static-assets.ts:4669`)**:
   The UI stores `data-model="9router/ag/gemini-3.8-flash-high"`, `data-provider="9router"`, `data-engine="openai-compatible"`.
4. **Route Resolution Discrepancy (`src/engines/execution-router.ts:284-307`)**:
   `resolveExecutionRoute` strips the provider prefix to produce `providerModelId` (`ag/gemini-3.8-flash-high`) which is sent to the remote API, but saves the composite string `model` to `pluton.yaml` and `store.ships`.
5. **Multi-Segment Model Collision**:
   If an external provider reports model `nvidia/nemotron-3.5`, `routes.ts` turns it into `openrouter/nvidia/nemotron-3.5`. If the UI or CLI passes `nvidia/nemotron-3.5` without `provider: "openrouter"`, the backend treats `nvidia` as the provider ID.

### 3.7 Whether external API integrations support actual tool execution or only text generation

**EXTERNAL API INTEGRATIONS SUPPORT TOOL PROTOCOL MECHANICS, BUT PLUTON PROVIDES ZERO CODING TOOLS TO THEM.**

1. **Protocol Support (`src/engines/openai-compatible/session.ts:19-30, 180-337`)**:
   - `OpenAICompatibleSession` converts MCP tool definitions to OpenAI chat completion function tools (`ChatToolDefinition`).
   - It parses streamed `tool_calls` chunks (`delta.tool_calls`), accumulates arguments, and dispatches calls to `McpHttpClient.callTool(name, args)`.
   - Tool call results (`{ role: 'tool', tool_call_id, content }`) are fed back into conversation history for multi-turn execution.
2. **Tool Surface Deficit (`src/tools/catalog.ts:24-173`, `src/tools/bridge.ts:275-290`)**:
   - The MCP bridge exposes only orchestration and management tools:
     - Task lifecycle: `task.create`, `task.delegate`, `task.inspect`, `task.wait`, `task.get_result`, `task.cancel`, `task.request_revision`
     - Run governance: `review.report`, `approval.request`, `run.stop`
     - Inter-ship messaging: `ship.message`, `ship.inbox`
     - Read-only inspection: `diff.inspect`, `project.read`
   - **There are NO coding tools in the tool bridge**:
     - No file write tool (`file.write` or `project.write`)
     - No file edit tool (`file.edit`)
     - No command execution tool (`command.exec` or `terminal.run`)
     - No test execution tool (`tests.run`)
     - No workspace search or directory listing tool
3. **OpenCode Dependency**:
   - OpenCode possesses internal, native tools (`read`, `write`, `edit`, `bash`, `glob`, `grep`) built directly into the OpenCode binary.
   - For an OpenCode session, OpenCode handles file operations internally and connects to Pluton solely for `pluton-tools` orchestration.
   - For an `openai-compatible` session, there is no OpenCode binary. The session receives only `pluton-tools`.
   - **Consequence: When executing coding tasks on an external provider, the model has no tools to modify code, run tests, or inspect directories.**

---

## 4. Subsystem Audit Register

| Subsystem | File Location | Current Implementation State | Failure Modes & Architectural Deficits |
|---|---|---|---|
| **Engine Contracts** | `src/engines/contract/types.ts` | Defines `EngineAdapter`, `EngineModel`, `ModelAvailability`, `EngineSession`. | `EngineModel.id` is ambiguous (remote ID vs provider-qualified ID). No schema for verified vs declared capabilities. |
| **Engine Registry** | `src/engines/registry.ts` | Built-in engines: `mock`, `opencode`, `openai-compatible`. | Engines are treated as process vs HTTP categories. `providerId` is loosely threaded via `EngineCreateOptions`. |
| **Provider Store** | `src/providers/store.ts` | Stored in `.pluton/providers.json`. Credentials in `.pluton/provider-homes/<id>/credential.json` (0600). | Only supports 1 connection per provider ID. No connection health, validation timestamp, or capability tracking. |
| **Provider Types** | `src/providers/types.ts` | `ProviderConfig` Zod schema (`id`, `engine`, `base_url`, `auth`, `models`). | No SSRF protection on `base_url`. Protocol styles limited to bearer/header. No manual model capability declarations. |
| **Model Registry** | `src/engines/model-registry.ts` | Runtime inventory indexed by `(engineKind, modelId)`. | `providerId` missing from key. Collisions occur across providers sharing `engineKind: 'openai-compatible'`. |
| **Model Discovery** | `src/engines/model-discovery.ts` | Periodically probes adapters via `listModels()`. | External models discovered without capability evaluation. Discovery failure reports are transient. |
| **Model Selection** | `src/engines/model-selection.ts` | Heuristic scoring (capabilities, context, latency, cost). | Constrained to single `engineKind`. Penalizes unknown capabilities. Overrides explicit user model selections. |
| **Execution Router** | `src/engines/execution-router.ts` | `resolveExecutionRoute()` resolves composite route. | Naive `modelPrefix()` splits on `/`. Defaults to `opencode` when provider not found. Fails on multi-segment vendor IDs. |
| **Routed Adapter** | `src/execution/routed-adapter.ts` | Wraps process engines in sandbox; leaves HTTP engines uncontained. | Does not support adapter switching during session lifetime. |
| **Tool Bridge** | `src/tools/bridge.ts` | MCP server over loopback HTTP providing `TOOL_SCHEMAS`. | Contains only management tools (`task.*`). Has NO coding tools (`project.write`, `tests.run` lack handlers). |
| **OpenAI Adapter** | `src/engines/openai-compatible/adapter.ts` | Implements `EngineAdapter` for HTTP endpoints. | Does not verify capabilities. Requires `providerId` option or fails if multiple providers exist. |
| **OpenAI Session** | `src/engines/openai-compatible/session.ts` | Owns conversation turn loop, SSE streaming, MCP tools. | Functional tool execution loop, but starved of actual coding tools by tool bridge. |
| **Supervisor** | `src/orchestrator/supervisor.ts` | Coordinates workers, task dispatch, session allocation. | Forces `selectModel` override. Reuses initial adapter on fallback. Omits `provider` in failure health logging. |
| **Ship Assignments** | `src/store/store.ts`, `pluton.yaml` | `ships` table in SQLite stores `engine_kind`, `provider`, `model`. | Ship templates hardcode OpenCode. UI dropdown hides non-OpenCode models. |
| **Model Health** | `src/engines/model-health.ts` | Records failure categories, cooldowns, availability. | Defaults un-attributed failures to `engineKind`, causing cross-provider blast radius contamination. |
| **Server Routes** | `src/server/routes.ts` | HTTP API for models, ships, sessions, runs, providers. | Pre-validates external models against OpenCode. Synthesizes ad-hoc composite IDs. |
| **Frontend UI** | `src/server/static-assets.ts` | Single-page app with Settings, Model Selector, Chat. | Ship row select dropdown filters models by `ship.engine`. Disconnects provider metadata on direct edits. |

---

## 5. Security & Isolation Audit

1. **Credential Safety**:
   - Provider credentials are stored in `.pluton/provider-homes/<id>/credential.json` with permissions `0600` inside a `0700` directory.
   - On Windows, best-effort `icacls` restricts inheritance and grants access to current user, SYSTEM, and Administrators only.
   - Credentials are read only on-demand and never stored in `pluton.sqlite` or `pluton.yaml`.
   - Redaction filters (`redactSecrets`, `redactProseSecrets`) scrub bearer tokens and API keys from error messages and logs.
   - Gaps:
     - No SSRF validation on custom provider `base_url` (could point to `http://169.254.169.254` or internal loopback).
     - Custom request headers accept arbitrary key-values without restriction.
2. **Workspace & Checkout Confinement**:
   - `NativeExecutionAdapter` enforces workspace isolation for process-spawning engines.
   - `OpenAICompatibleAdapter` does not spawn processes; it interacts with the workspace solely through MCP tool calls.
   - If coding tools (`file.write`, `command.exec`) are exposed to external models, they MUST enforce the existing `FileLeaseManager`, `writeScope`, workspace isolation, and path-traversal safeguards (`assertInside`, `realpathSync`).

---

## 6. Required Architectural Transformations (Phase 1–10 Alignment)

Based on the audit findings, the implementation phases must address the following:

1. **Phase 1 — Universal Provider Abstraction**:
   - Decouple `engine`, `provider`, `connection`, and `model`.
   - Expand `ProviderConfig` to support multiple independent connections per provider.
   - Replace bare string keys in `ModelRegistry` with a true composite identity: `(connectionId, providerId, modelId)`.
2. **Phase 2 — Universal API & Protocol Adapter Layer**:
   - Standardize adapter interface (`EngineAdapter`) for request construction, streaming, tool-calling, cancellation, and health.
   - Implement endpoint validation and SSRF safeguards for custom base URLs.
3. **Phase 3 — Universal Model Discovery & Registration**:
   - Support automatic discovery without OpenCode.
   - Support manual model registration with explicit capability declarations (verified vs user-declared).
   - Distinguish model states: Discovered, Configured, Connection Validated, Ready for Build.
4. **Phase 4 — Universal Coding-Agent Execution Runtime (CRITICAL)**:
   - Provide native PLUTON coding tools in the shared MCP bridge:
     - `file.read` / `file.write` / `file.edit`
     - `directory.list` / `file.search`
     - `command.exec` / `tests.run`
   - Enforce existing `FileLeaseManager`, path traversal boundaries, and approval policies across all tool calls.
5. **Phase 5 — Universal Settings & Connection Management**:
   - Update Settings UI to manage multiple connections, custom endpoints, manual model registration, and connection validation.
6. **Phase 6 — Universal Model Selector**:
   - Fix UI model selector and Ship row dropdowns to display models from all active provider connections.
   - Preserve exact model identity through selection, persistence, and execution.
7. **Phase 7 — Provider-Independent Supervisor & Ships**:
   - Support mixed-provider teams (e.g. Supervisor on Provider A, Coder on Provider B).
   - Prevent supervisor from overriding user-selected models unless explicitly unpinned.
8. **Phase 8 — Provider-Scoped Health, Quotas & Fallback**:
   - Thread `provider` and `connectionId` through `ModelErrorContext`.
   - Isolate quotas and health states per connection so OpenCode exhaustion does not impact external providers.
   - Fix fallback loop to re-resolve routes and instantiate replacement adapters.
9. **Phase 9 — Persistence & Migration**:
   - Ensure backward compatibility with existing `pluton.sqlite`, `pluton.yaml`, and `.pluton/providers.json`.
10. **Phase 10 — Automated Test Verification**:
    - Comprehensive test coverage for multi-connection isolation, tool execution through MCP, cross-provider supervisor teams, and quota fault isolation.

---

## 7. Audit Sign-off

- **Phase 0 Status**: **COMPLETE**
- **Root Causes Identified**: 7/7 primary audit questions definitively answered with code-level citations.
- **Application Code Changes**: 0 lines modified during Phase 0.
- **Proceeding to Phase 1**: Ready for Universal Provider Abstraction schema and types design.
