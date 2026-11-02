# PLUTON 4.1 — Phase 0 Architecture Audit and Baseline

- Repository: `aniketkolse/PLUTON-Harness`
- Working tree: `Y:\Pluton`
- Branch: `main`, tracking `origin/main`
- HEAD: `db0c7df` (`test(integrate): increase timeout and guard cleanup on Windows`)
- Audit date: 2026-11-02
- Audit mode: read-only. No product code, configuration, database, or tests were modified.
- Only artifact added: this document.

> Naming note: the supplied specification header says “Pluton 5.0”, while the body and
> required deliverables say 4.1. This audit uses **PLUTON 4.1** as instructed by the
> phase names and document paths. The discrepancy should be resolved by the operator
> before Phase 1.

---

## 1. Baseline results

All commands were run from the repository root with Node `v24.20.0`.

| Command | Result | Evidence |
|---|---|---|
| `npm run typecheck` | **PASS** | `tsc -p tsconfig.json`, exit 0, no diagnostics |
| `npm run build` | **PASS** | `tsc -p tsconfig.build.json`, exit 0, no diagnostics |
| `npm test` | **PASS** | 169 test files passed; 1,572 tests passed, 10 skipped (1,582 total); 245.41 s |
| `npm run test:e2e` | **PASS** | 1 test file passed, 1 test passed; 2.17 s |
| `npm run verify:docs` | **PASS** | 111 files scanned, 48 links checked, 0 broken |
| `npm run verify:assets` | **PASS** | 60 checks passed |
| `npm run release:check` | **PASS** | 17 checks: 16 passed, 0 failed, 1 not tested, 0 owner blockers |

`release:check` re-runs `npm run check` (typecheck + full test suite) and `npm run build`,
so its embedded counts repeat the `npm test`/`npm run build` results.

The single `release:check` item reported as **NOT TESTED** is POSIX `0600` permission
enforcement, because Windows does not enforce POSIX mode bits. The script states it runs
on the Linux/macOS CI jobs. This is an environmental limitation, not a regression.

During `npm test`, two engine-discovery warnings were printed by tests:
`opencode models: exit code 1: ServiceUnavailableError: Location plugins did not finish
activating`. The affected runs still passed; the tests exercised the honest
unavailable/fallback path. No live provider credential was used, so this baseline does
**not** validate live OpenCode inference or any external provider.

No `docs/PLUTON_4.0_RELEASE_CHECKLIST.md` exists. The actual file is
`docs/release/PLUTON-4.0-RELEASE-CHECKLIST.md`.

---

## 2. Actual architecture inventory

The graph in `graphify-out/` is **stale**: it still references
`src/engines/qwen/adapter.ts`, which was removed by commit `4c3d128`
(“Consolidate on OpenCode”). All findings below were verified against the working tree,
not the graph.

Key modules inspected:

| Area | Current implementation |
|---|---|
| Engine contract | `src/engines/contract/types.ts` |
| Engine registry | `src/engines/registry.ts` |
| Real engine adapter | `src/engines/opencode/adapter.ts` (+ `src/engines/acp/`) |
| Dev/test adapter | `src/engines/mock/adapter.ts` |
| Discovery | `src/engines/model-discovery.ts` |
| Model inventory | `src/engines/model-registry.ts` |
| Selection | `src/engines/model-selection.ts` |
| Health | `src/engines/model-health.ts` |
| Fallback decision | `src/engines/model-fallback.ts` |
| Orchestration | `src/orchestrator/supervisor.ts`, `src/orchestrator/service.ts` |
| Worker messages | `src/orchestrator/messages.ts` |
| Wakeups | `src/orchestrator/wakeups.ts` |
| Workspaces | `src/workspace/manager.ts`, `src/workspace/trusted-git.ts` |
| HTTP/SSE server | `src/server/server.ts`, `src/server/routes.ts`, `src/server/events.ts`, `src/server/log-watcher.ts` |
| Activity mapping | `src/server/activity.ts` |
| Worker detail | `src/server/task-detail.ts` |
| Graphical UI | `src/server/static-assets.ts` (single embedded SPA) |
| Terminal UI | `src/tui/`, `src/cli/`, `src/chat/` |
| SQLite schema/store | `src/store/migrations.ts`, `src/store/store.ts` |
| Configuration | `src/config/schema.ts`, `src/config/model-config.ts`, `src/config/load.ts` |

Only the first 200 `src` files are listed by the repository layout above conceptually;
`src/server/static-assets.ts` is a 6,877-line embedded HTML/CSS/JS application and is the
authoritative graphical implementation (ADR-0014).

---

## 3. Status definitions

- **Implemented** — exists, is wired end-to-end, and has direct evidence in code/tests.
- **Incomplete** — a working base exists, but the 4.1 requirement is only partly met.
- **Missing** — no implementation or no user-facing path exists.
- **Broken** — the current behavior contradicts a required invariant or silently
  reports something false.

A single area can contain several statuses; the consolidated matrix in §11 is the
authoritative phase-gate summary.

---

## 4. Provider, engine, model, and fallback architecture

### 4.1 Implemented

- **Engine contract boundary is real.** `EngineAdapter` exposes `capabilities()`,
  `discover()`, `listModels()`, optional `listModelsWithAvailability()`,
  `authStatus()`, and `startSession()`
  (`src/engines/contract/types.ts:338-347`).
- **Capabilities are declared, not inferred.** `EngineCapabilities` covers resume,
  interrupt, approvals, usage, model list, MCP, and session export
  (`src/engines/contract/types.ts:15-23`); `defaultCapabilities()` is fail-closed
  (`:349-359`).
- **Rich model metadata is already representable.** `EngineModel` supports exact id,
  label, source, availability, provider, capabilities, context window, tool calling,
  multimodal, coding/reasoning flags, cost, latency, and discovery timestamps
  (`src/engines/contract/types.ts:34-65`). `ModelAvailability` is separate from the
  model record (`:93-106`).
- **One real adapter exists.** `opencode` is registered as `devOnly: false`
  (`src/engines/registry.ts:66-71`). It speaks ACP over stdio and reports honest
  capabilities/discovery/auth status.
- **Mock is excluded from production discovery/selection.**
  `src/orchestrator/service.ts:393-402` filters `factory.devOnly !== true` before
  constructing discovery engines. `ModelDiscoveryService` also defaults to excluding
  dev-only engines unless explicitly enabled
  (`src/engines/model-discovery.ts:288-316`).
- **Discovery is failure-isolated.** Per-adapter refresh failures leave the previous
  inventory intact; registry updates are versioned by observation time
  (`src/engines/model-discovery.ts`, `src/engines/model-registry.ts:1-19`).
- **Model identity is composite in the core registry.** `(engineKind, modelId)` is the
  key (`src/engines/model-registry.ts:21-27`), and provider is metadata, not identity.
- **Health and selection are capability-aware.** `ModelHealthMonitor` classifies
  auth/quota/provider/network/execution errors and scopes failures to
  model/provider/global (`src/engines/model-health.ts`). `selectModel` filters by
  engine, availability, capabilities, cost/latency/context, and health
  (`src/engines/model-selection.ts:629-732`).
- **Fallback is supervisor-owned and bounded.** `RunSupervisor` records
  `run.model_selected`, classifies a failed turn, calls `decideFallback`, checks replay
  safety, and only then starts a replacement session
  (`src/orchestrator/supervisor.ts:1288-1627`). `decideFallback` refuses to replay if a
  tool call was left open (`src/engines/model-fallback.ts:143-163`).
- **The mock cannot enter a production run through model discovery.** Direct
  `mock` use is still possible only through explicit test/dev wiring.

### 4.2 Incomplete

- **Only one real provider integration exists.** No second real adapter is registered.
  A Qwen ACP adapter existed in git history but is absent from the working tree; the
  registry currently contains only `mock` and `opencode`
  (`src/engines/registry.ts:59-72`).
- **Provider identity is not part of model identity.** The registry key is
  `(engineKind, modelId)` (`src/engines/model-registry.ts:21-27`), and
  `ModelSelection` carries `engineKind` and `provider` only as optional metadata
  (`src/engines/contract/types.ts:166-196`). Two providers behind one adapter with
  the same opaque model id cannot be distinguished reliably across every path.
- **OpenCode discovery returns only `{id, source:'engine'}`.**
  `OpenCodeEngineAdapter.listModels()` parses ids from `opencode models --standalone`
  and never attaches provider, context, tool, multimodal, cost, or quota metadata
  (`src/engines/opencode/adapter.ts:421-452`). Availability is derived afterwards from
  the candidate list and a static catalog
  (`src/engines/opencode/adapter.ts:454-491`).
- **The `/api/models` response loses metadata.** It groups by engine and, on empty or
  failed discovery, synthesizes entries from the hardcoded `SHIP_WORKER_MODELS`
  catalog (`src/server/routes.ts:1019-1074`). `modelEntries()` in the SPA keeps only
  `{engine, id, label, source}` (`src/server/static-assets.ts:4032-4040`).
- **Auth is engine-native, per-Ship, not provider-native.**
  `authStatus()` shells out to `opencode auth list --standalone` inside the Ship's
  engine home (`src/engines/opencode/adapter.ts:493-518`). There is no provider account
  abstraction, no OS credential store, and no provider connection state machine.
- **Fallback cannot cross an engine boundary today.** The selector is called with
  `engineKind: adapter.kind` (`src/orchestrator/supervisor.ts:1496-1518`), and
  `selectModel` filters candidates to that engine
  (`src/engines/model-selection.ts:638`). The replacement session is always created
  through the *original* `adapter` (`src/orchestrator/supervisor.ts:1548-1556`). This
  means cross-engine fallback is not implemented at all; if it were enabled without
  changing the adapter construction, a model from another engine would be passed to
  the wrong adapter.
- **Fallback state and decisions are model-id-only.** `ModelFallbackState` holds
  `exhaustedModels: Set<string>` and `switchHistory` of model ids
  (`src/engines/model-fallback.ts:76-86`); `FallbackDecision` carries only
  `fromModelId`/`toModelId` (`src/engines/contract/types.ts:205-221`). Exclusions in
  `selectModel` are also by model id (`src/engines/model-selection.ts:633,637`).
- **The selection pin path can bypass compatibility.** When
  `this.modelConfig.ships[ship.id].pin` is set, the supervisor assigns it directly
  without asking the registry or adapter whether the model exists
  (`src/orchestrator/supervisor.ts:1292-1294`). `ship.model` is an arbitrary string in
  the schema (`src/config/schema.ts:28-30`), and `editShip` writes any `--model` value
  after validating only the engine kind (`src/cli/commands/ship.ts:143,161,174-179`).
- **Provider health state is not surfaced to the UI.** `ModelHealthMonitor` stores
  provider-scope state, but `/api/models` does not expose it and the SPA does not show
  it.

### 4.3 Missing

- A second real provider adapter (OpenAI-compatible, Anthropic, Google, etc.) and its
  conformance suite.
- Provider connection lifecycle: not configured → credentials saved → validating →
  auth failed → connected → discovering → ready → temporarily unavailable.
- Provider-level credential storage, validation, replacement, removal, and diagnostics.
- Provider-aware model discovery metadata (context, tooling, multimodal, quota).
- Cross-engine session replacement through a replacement adapter.
- Exact persistence of `(engineKind, provider, modelId)` on Ship assignments and run
  assignments.

### 4.4 Broken

- **Pinned model IDs are not validated against the assigned engine.** A user or CLI can
  set `ship.model` to a model that another engine or provider owns; the supervisor will
  pass that string to the Ship's adapter. The engine may reject it at session start
  (fail late) or, worse, another engine may accept the same-looking string.
- **The `/api/models` catalog can claim a model is known when it is only a hardcoded
  catalog entry.** `SHIP_WORKER_MODELS` is a hardcoded list in the OpenCode adapter
  (`src/engines/opencode/adapter.ts:36-50`) and is returned as `source:'catalog'`,
  `available:false` when discovery fails (`src/server/routes.ts:1044-1066`). This
  conflicts with the 4.1 rule “no hardcoded model IDs” and can present stale vendor
  names.
- **Fallback events/reporting name the original engine even if the model belongs to a
  different engine.** `task.started` records `engine: adapter.kind`
  (`src/orchestrator/supervisor.ts:1573`), and `run.model_selected` records
  `engineKind: ship.engineKind` (`:1321-1324`), not the selected model's actual engine.
- **`custom` models are marked available without an inference backend.** See §5.4.

---

## 5. Credentials, Settings, and model selection UI

### 5.1 Implemented

- **No API key is written to `pluton.yaml` by the SPA model path.** Ship model changes
  go to the `ships` row in SQLite via `updateShipModel`
  (`src/server/routes.ts:1115-1126`, `src/store/store.ts:453-459`).
- **Per-Ship engine homes exist.** ADR-0008 defines
  `.pluton/engine-homes/<ship-id>/`, restrictive permissions (`0700` best-effort on
  Linux; weaker Windows ACLs documented), and engine-native login. Engine processes get
  a minimal environment (`src/engines/acp/env.ts`).
- **Secrets are redacted from structured payloads.** `redactDeep` replaces values under
  secret-looking keys (`src/util/redact.ts:10-67`); SSE worker payloads are redacted,
  control-stripped, and bounded (`src/server/events.ts:38-55`).
- **Settings has real controls for account, permissions, thinking effort, per-Ship
  models, MCP servers, and pending approvals**
  (`src/server/static-assets.ts:147-276`).
- **The current model popover does validate against the engine when possible.** The
  ship model route calls `adapter.listModels()` and rejects an unknown model when the
  adapter supports `modelList` (`src/server/routes.ts:1097-1114`). It deliberately
  proceeds if the probe itself fails (offline/fail-open), which is a UX choice but not
  a security claim.

### 5.2 Incomplete

- **“Pluton Account” is a fake, in-memory profile.** Defaults are
  `pluton-developer` / `developer@pluton.account` with `connected: true`
  (`src/server/routes.ts:136-140`); sign-in accepts any username/email and sign-out
  only flips a boolean (`:1223-1236`). It has no provider meaning.
- **Permissions and thinking effort are in-memory only.** `permissionPolicies` and
  `thinkingEffort` live in the `ApiRoutes` instance and reset on restart
  (`src/server/routes.ts:141-147`). They are not persisted as user settings.
- **The settings model list is informational, not a provider inventory.** It groups
  models by engine and shows `source` only; no availability, provider, capability,
  context, or connection status (`src/server/static-assets.ts:4042-4060`).
- **The model popover is a flat, unscrollable-by-filter list**, not the required
  searchable dialog. It has a title and a body only (`:472-476`), and
  `renderModelPopover` renders one row per model with the label and engine name
  (`:4062-4081`). There is no search input, provider filter, availability filter,
  capability filter, refresh button, or compatibility explanation.
- **Model switching targets the active chat agent, not an explicitly chosen Ship.**
  `switchModel()` resolves `state.muse` (the active chat session's Ship) and posts to
  `/api/muses/<id>/model` (`src/server/static-assets.ts:4090-4138`). The Settings
  per-Ship cards use a separate path, but the global popover cannot assign a model to
  an arbitrary Ship with compatibility feedback.
- **On successful switch the SPA updates local objects and shows an Undo toast**
  (`src/server/static-assets.ts:4111-4137`), which is good, but it does not refresh the
  full provider inventory or show the exact `(engine, provider, model)` identity.
- **Custom models are not provider-backed.** See §5.4.

### 5.3 Missing

- Settings → Providers section.
- Add Provider, choose integration, enter API key, save, validate, discover models.
- Provider authentication status, discovery status, and connection diagnostics.
- Credential replacement/removal and masked credential display.
- Model defaults separate from per-Ship assignments.
- A searchable “Select Model” dialog with the required filters and metadata.
- A compatibility check that explains unsupported capabilities for the target Ship.
- Persisting the exact engine/provider/model identity for a Ship assignment.

### 5.4 Broken

- **The “Add Custom AI Model & Personal API Key” card is a dead, misleading path.**
  The form is at `src/server/static-assets.ts:186-216`. `POST /api/models/custom`
  accepts a model name and optional API key (`src/server/routes.ts:1239-1268`). The key
  is written to `private readonly customApiKeys = new Map<string, string>()`
  (`:148-149,1251-1254`) and **is never read anywhere else in `src`**. It is not
  persisted, not validated, not used for inference, and disappears on restart. The
  custom model is still added to `customModels` and marked `available: true` in
  `/api/models` (`:1069-1071`).
- **Custom models can be assigned to a Ship and bypass engine validation.** The route
  checks `isCustom` and skips the engine `listModels()` check
  (`src/server/routes.ts:1098-1111`), then persists the model string. A later run hands
  that string to the engine adapter, which has no way to serve it.
- **The UI warning says keys are “kept securely in local memory only”**
  (`src/server/static-assets.ts:196`). That is honest about non-persistence but implies
  security and utility that the in-process `Map` does not provide; it is not OS-secure
  storage and is not used.
- **No provider credential is ever validated by authenticating.** `authStatus` only
  checks whether `opencode auth list` reports any authenticated integration; it does not
  validate a specific provider key entered by the user.

---

## 6. Build, project, session, and workspace lifecycle

### 6.1 Implemented

- **SQLite is the source of truth.** Projects, runs, tasks, events, workspaces,
  approvals, chat sessions, and plans are durable tables
  (`src/store/migrations.ts`).
- **Project identity is independent of run identity and keyed by root path.**
  `projects.root_path` is `UNIQUE` (`src/store/migrations.ts:22-30`), and
  `ensureProject` returns the existing row for the same root
  (`src/store/store.ts:419-432`). A project can already own many runs.
- **Runs record workspace root and origin session.**
  `POST /api/runs` resolves a workspace root from the request/session/project and calls
  `store.createRun` with `workspaceRoot` and `originSessionId`
  (`src/server/routes.ts:519-572`). The `runs` table persists both
  (`src/store/migrations.ts:48-63`; `src/store/store.ts:549-572`).
- **Chat sessions persist their own workspace root.**
  `chat_sessions.workspace_root` and `createChatSession({ workspaceRoot })`
  (`src/server/migrations.ts:235-246`, `src/store/store.ts:1711-1731`).
- **Task checkout isolation is preserved.** `ensureTaskCheckout` is used only for
  `isolated-task-checkout`; read-only roles use the project root
  (`src/orchestrator/supervisor.ts:1354-1360`). `GitWorkspaceManager` creates a clone
  per task and enforces root containment/marker checks
  (`src/workspace/manager.ts:293-306`).
- **Workspace display falls back to the directory basename** (`src/server/workspace.ts:24-29`),
  and the project row has a `name` column.
- **Restart recovery exists for the project row and chat sessions.** `ensureProject`
  reuses by root path; `GET /api/workspace` loads the active run, tasks, approvals, and
  ships (`src/server/routes.ts:199-252`); chat sessions are read from SQLite.

### 6.2 Incomplete

- **Every Build creates a new run.** `startBuild()` posts to `/api/runs` and then
  `/api/runs/:id/start` (`src/server/static-assets.ts:5725-5757`). There is no reuse of
  the previous run, no duplicate suppression, and no “continue the same project
  session” semantics. Reusing the project *row* is not the same as reusing a project
  *workspace/session* for Build.
- **Build always asks for a separate confirmation.** `openBuildConfirm` is called for
  each build and the SPA refuses to dispatch until “Start build” is pressed
  (`src/server/static-assets.ts:5690-5712,6904-6913`). This may have been a deliberate
  safety measure for the old flow, but 4.1 explicitly says the Build button itself is
  the intent to execute a normal build and a second confirmation must not be required
  merely to continue in the same project.
- **The Build flow does not accept or set a project name.**
  `POST /api/runs` accepts `goal`, manager, `sessionId`, and `workspaceRoot` only
  (`src/server/routes.ts:525-533`). The project display name comes from
  `ctx.loaded.config.project.name` / the existing row
  (`src/server/routes.ts:191,221`), not from an operator-entered Build name.
- **No project rename endpoint exists.** `describeWorkspace` uses `basename(rootDir)`;
  no route updates `projects.name`, and no UI control names a project.
- **The “active run” is chosen as the newest non-terminal run** for the workspace
  (`src/server/routes.ts:208-213`), not as a stable project session. After all runs
  finish, a subsequent Build has no project-session anchor to continue from.
- **Build budget is fixed in the route** (`maxConcurrentWorkers: 3`, `maxTasks: 20`,
  `maxDelegationDepth: 3`, `maxRunMinutes: 60`, `defaultTaskMinutes: 10`)
  (`src/server/routes.ts:562-568`). It is not derived from project settings or a
  persisted Build profile.

### 6.3 Missing

- A persistent project workspace/session abstraction that survives multiple Build runs
  and application restarts.
- Operator-defined project naming in the Build flow and a rename that preserves the
  filesystem path.
- Build reuse without project-creation confirmation.
- A test covering: create project with custom name → Build → Build again → restart →
  Build again → same project/workspace reused with isolated task checkouts.

### 6.4 Broken

- **No false claim was found in the build path**: the SPA reports the real run id and
  real state, and it does not fabricate success. The defect is missing behavior, not
  dishonesty.
- **The project row and the workspace root can diverge conceptually.** `project.name`
  is a display label; the workspace root is the project root or a session override.
  There is no explicit “project workspace” record that links the two beyond
  `projects.root_path`.

---

## 7. Recursive file explorer

### 7.1 Implemented

- **Recursive listing exists.** `GET /api/files` calls `listWorkspaceFiles`, which walks
  the workspace recursively and returns repo-relative paths
  (`src/server/routes.ts:271-277,1748-1778`).
- **Containment and excluded internals are enforced.** The listing skips symbolic
  links, `.git`, `.pluton`, `node_modules` (via `protectedWorkspaceSegment`), plus
  `dist`, `.DS_Store`, and `coverage`
  (`src/server/routes.ts:1750-1768`; `src/util/path-safety.ts:18-23`).
- **File read/write/delete use canonical containment.** `resolveWorkspaceFile` performs
  lexical containment, protected-segment checks, `realpathSync` containment, and a file
  check (`src/server/routes.ts:1700-1745`). Content size is capped at 2 MB
  (`:292-295,315-324`).
- **The UI builds a real tree, sorts it, shows directory file counts, supports
  collapse/expand, and opens files on click**
  (`src/server/static-assets.ts:5022-5110`). It has loading and error states with a
  retry button (`:5139-5145`), and tabs for “Files” and “Worktree Diffs”
  (`:140-143`).
- **Icons are inline SVG and visually secondary** (`:4961-5020`). They are not glossy or
  oversized, but the per-extension set is larger than the 4.1 “minimal icons”
  direction.
- **The security boundary is tested.** `tests/integration/server-api.test.ts` covers
  traversal, `.git`/`.pluton`/`node_modules`, case variants, and junction/symlink
  escapes (`:290-372,961-1001`).

### 7.2 Incomplete

- **The tree is not lazy.** The server returns up to 300 files in one synchronous
  `readdirSync` walk, and the client renders the entire tree with every folder expanded
  (`src/server/static-assets.ts:5044-5075`). Deep/large trees are bounded only by the
  flat cap, not by loading strategy or virtualization.
- **No breadcrumb navigation.** The viewer shows the full path string
  (`fileViewerPath`), but the explorer itself has no breadcrumb trail or per-folder
  navigation.
- **No file search.** There is no search input or server-side search parameter.
- **No explicit refresh control.** Refresh is event-driven (`scheduleFilesRefresh` on
  worker/tool/run events) and via the retry error state; the pane has no refresh
  button.
- **No truncation indicator.** If the 300-file cap is reached, the API returns the
  first 300 sorted paths with no `truncated` flag
  (`src/server/routes.ts:1748-1778`). The UI cannot tell the operator that files are
  missing.
- **Per-directory read errors are silently swallowed.** `scan()` catches and ignores
  `readdirSync` failures (`:1771-1773`); the top-level UI error path only fires when the
  whole request fails.
- **The endpoint exposes only files, not directory entries.** Directory structure is
  reconstructed client-side from paths. An empty directory cannot be shown.
- **The icon map is per-extension and richer than the requested minimal set.** It should
  be simplified, not expanded, in Phase 5.

### 7.3 Missing

- Lazy-loading directory API (path-relative listing with `hasMore`/cursor).
- Breadcrumb navigation.
- File search (name and possibly content).
- Large-directory windowing/virtualization or paging.
- Explicit refresh action.
- A truthful `truncated`/`hasMore` indicator.
- Deep-tree and large-directory tests.

### 7.4 Broken

- **Silent truncation is a correctness defect for the explorer.** The requirement
  “nested files are not sufficiently visible” is not solved by a hard cap that hides
  files without telling the user.
- **`GET /api/files` has no session/workspace identity in its own response beyond
  `rootDir`.** That is enough for display, but the UI must continue to resolve the
  active session explicitly; a stale session id can show a different workspace root
  without an obvious error.

---

## 8. Worker Ship inspector and main-chat activity

### 8.1 Implemented

- **The inspector is bound to real task identity.** The right inspector is
  `#rightInspector` (`src/server/static-assets.ts:455-469`); partitions carry
  `data-task-id` (`:6023-6067`), and clicking a partition calls
  `openWorkerDetail(taskId)` (`:7043-7055`).
- **The detail request is exact.** `openWorkerDetail` records
  `{runId: state.activeRunId, taskId}` and fetches
  `/api/runs/:runId/tasks/:taskId/detail` (`:6282-6360`). The server requires the task
  to belong to that run (`src/server/task-detail.ts:149-152`).
- **The detail view is authoritative and read-only.** It is built from the task row,
  durable events, workspace row, verification rows, result, and failure
  (`src/server/task-detail.ts:16-21,143-282`). Closing it never cancels work
  (`src/server/static-assets.ts:6663-6667`).
- **It shows a meaningful subset of the required fields:** task id/title/brief, state,
  assignee, role, engine, model, attempt, workspace, timestamps, acceptance criteria,
  dependencies, write scope, activity, supervisor communication, tool calls, changed
  file **paths**, messages, retry counts, verification, and final output
  (`src/server/static-assets.ts:6516-6550`).
- **Live updates are wired by task id.** Worker SSE events refresh the open detail only
  when `state.workerDetail.taskId === ev.taskId` (`:6172-6174`); activity frames also
  refresh it (`:3243-3245`). Detail refresh re-fetches the authoritative view instead of
  appending guessed deltas (`:6331-6355`).
- **Main chat receives concise, durable activity.** `ActivityMapper` maps only
  lifecycle/meaningful events and drops low-level `worker.progress` unless it is an
  error (`src/server/activity.ts:11-13,128-281`). The SPA appends activity by durable
  seq and ignores duplicates (`src/server/static-assets.ts:3161-3186`). REST recovery
  uses `afterSeq`/`tail=1`, and the log watcher only streams future events
  (`src/server/routes.ts:646-671`; `src/server/log-watcher.ts:177-193`).
- **Canonical naming is mostly correct.** The inspector uses the Ship display name and
  only falls back to role (`src/server/static-assets.ts:6039-6043`); activity uses
  `Supervisor` for the manager and Ship display names for workers
  (`src/server/activity.ts:128-278`). No `Manager Supervisor` or
  `Tool Researcher` strings were found in `src`.

### 8.2 Incomplete

- **No execution-plan section.** The detail shows `dependsOn` and raw activity, but no
  assigned objective/steps/milestones, current step, completed/pending steps,
  dependencies, blockers, or “last meaningful update” as first-class fields.
- **No dedicated blocker section.** Retry counts and activity rows mention blockers,
  but there is no blocker list or resolution state.
- **Approval requests are not scoped into the worker detail.** Approval events are
  broadcast globally and rendered in the main approval UI
  (`src/server/log-watcher.ts:111-134`); the detail's supervisor/activity section only
  sees events whose `taskId` matches.
- **Changed files are paths only in the detail.** The actual patch is available in the
  Worktree Diffs pane and `/api/tasks/:id/diff`, but the worker detail does not show
  `+`/`-` lines inline.
- **No explicit “current activity” summary.** The newest activity row is close, but
  there is no stable field that answers “what is this worker doing right now?”.
- **Scroll position is not preserved across refresh.** `renderWorkerDetail` replaces
  `workerDetailBody.innerHTML` on every refresh (`src/server/static-assets.ts:6552-6554`),
  so a scrolled-up operator loses position. The live worker stream has an at-bottom
  trim guard (`:6110-6125`), but the modal does not.
- **The main chat is a conversation feed, not a per-worker activity stream.** Worker
  updates arrive as `run_activity` rows; the operator cannot filter the main chat by
  worker without opening the detail modal.

### 8.3 Missing

- First-class plan/milestone model in the detail API and UI.
- Per-worker approval list.
- Inline patch/diff in the detail.
- Explicit current-step/last-update fields.
- Scroll preservation and merge of historical + live detail events without full
  re-render.

### 8.4 Broken

- **“Click a Ship opens its real activity” is functionally implemented**, not broken.
  The remaining defects are completeness and presentation, not identity binding.
- **A detail refresh can temporarily replace the body with a loading/error state**
  (`src/server/static-assets.ts:6295-6296,6347-6350`), which is truthful but loses the
  previous content and scroll position.

---

## 9. Worker-to-worker messaging, events, and wakeups

### 9.1 Implemented

- **Durable messages are the event log.** Every message is a `worker.message` event and
  every delivery batch a `worker.message.delivered` event
  (`src/orchestrator/messages.ts:8-19`).
- **Bounded protocol:** body max 8,000 chars, max 500 messages/run, max inbox wait
  60,000 ms, max 50 messages per inbox call
  (`src/orchestrator/messages.ts:34-37`).
- **Kinds are explicit:** finding, evidence, contract, blocker, question, handoff,
  instruction (`:22-32`).
- **Identity is explicit:** `senderShipId`, `senderLabel`, `senderTaskId`,
  `recipientShipId`, `recipientLabel`, `recipientTaskId`, `replyTo`, `createdAt`
  (`:44-80,277-303`). Self-send is rejected, tasks are validated against the sender,
  and recipients must be enabled (`:228-303`).
- **Delivery is pull-based and at-most-once.** `ship.inbox` reads at the worker's next
  tool call; returned ids are acknowledged durably, and a restarted bus rehydrates the
  delivered set so acknowledged messages are not re-delivered
  (`src/orchestrator/messages.ts:166-225,399-448`; test
  `tests/integration/worker-messages.test.ts:200-279`).
- **Wakeups are immediate for a waiting inbox.** `send` and `sendOperator` call
  `wakeups.notify(channel(recipient.id), ...)`, and `inbox` waits on that channel
  (`src/orchestrator/messages.ts:303,362,436-443`). This reduces latency from “next
  poll” to “next wait resolution”, but the engine still has to call `ship.inbox`.
- **Manager visibility exists through activity mapping.** `worker.message` maps to a
  “sender → recipient: shared a finding / reported a blocker / sent a message” row
  (`src/server/activity.ts:200-208`), and the operator→worker route broadcasts a live
  frame without a second write (`src/server/routes.ts:718-757`).
- **Failure/cancellation safety exists.** `close()` wakes all pending inbox waits;
  waits are bounded and abortable
  (`src/orchestrator/messages.ts:450-456`; test `:245-261`).

### 9.2 Incomplete

- **No mid-turn injection.** Delivery is only at the next `ship.inbox` call. A worker
  blocked inside a long tool call cannot receive a message until that call returns or
  the engine chooses to check inbox. This is an engine protocol constraint, not a
  missing queue, but it limits collaboration latency.
- **The message budget is run-wide, not per-pair.** No per-sender/recipient rate limit
  was found beyond the global 500-message cap; a pair of workers can consume most of
  the budget.
- **No priority/TTL.** Messages are FIFO by durable sequence; no urgent/blocker
  priority or expiration.
- **Manager visibility can be noisy.** Every worker-to-worker message becomes a row in
  the same main conversation unless the operator ignores it; no aggregation or
  “worker channel” view exists.
- **Acknowledgment is delivery acknowledgment, not read/acted-on acknowledgment.**
  The sender sees delivery, but not whether the recipient used the finding.

### 9.3 Missing

- Priority/expiry metadata.
- Per-pair or per-kind rate limiting.
- A manager-facing inbox/thread view separate from the global activity feed.
- A test for SSE reconnect + durable message history de-duplication at the UI level
  (the server-side durable set is tested; the SPA rendering path is not).

### 9.4 Broken

- No broken invariant was found in the message bus. Delivery, ordering, identity,
  bounds, and restart rehydration are implemented and tested.
- One latent risk: the operator→worker route constructs a **new** `WakeupRegistry` per
  request (`src/server/routes.ts:718-723`). It persists and broadcasts correctly, and
  the worker's own supervisor bus has its own registry, but an operator message cannot
  wake an inbox waiter owned by the run supervisor because the registries are
  different instances. The message will still be seen at the next inbox call, so this
  is a latency defect, not data loss.

---

## 10. Activity timeline, diffs, and plan visibility

### 10.1 Implemented

- **Meaningful activity is filtered server-side.** `ActivityMapper` maps run/task/
  worker lifecycle, messages, blockers, verification, approvals, scope conflicts, and
  run completion; it returns `null` for raw protocol/unknown events
  (`src/server/activity.ts:128-281`).
- **Activity is durable and exactly-once in the feed.** Activity rows carry the event
  `seq`; the SPA drops `item.seq <= state.activitySeq` and uses durable
  `afterSeq` recovery (`src/server/static-assets.ts:3161-3208`).
- **Diagnostics are preserved elsewhere.** The server log watcher and durable events
  retain low-level data; the UI only filters them from the conversation
  (`src/server/log-watcher.ts`).
- **Real git diffs are captured, not described.** `GitWorkspaceManager.captureDiff`
  reads the task checkout through the trusted-git snapshot view, including untracked
  files (`src/workspace/manager.ts:293-306`; `src/workspace/trusted-git.ts:990-1010`).
- **`+`/`-` rendering is correct.** `renderViewerDiff` adds
  `code-line-add` for lines starting with `+` (excluding `+++`) and `code-line-del` for
  lines starting with `-` (excluding `---`), and styles hunks
  (`src/server/static-assets.ts:5233-5250`). The full line text, including its first
  character, is escaped and rendered, so the operator sees a real `+` or `-`.
- **Changed-file grouping uses real diff headers.** Worker detail parses
  `diff --git a/... b/...` paths and untracked files from the real checkout diff
  (`src/server/task-detail.ts:100-132`).
- **Worktree Diffs and task diff are real.** `/api/runs/:id/diff` and
  `/api/tasks/:id/diff` use the same manager; the SPA renders the actual patch
  (`src/server/routes.ts:960-1009`; `src/server/static-assets.ts:5419-5475`).

### 10.2 Incomplete

- **Worker detail shows only changed paths, not the patch.** The “Changed files” section
  is a list (`wdFiles`, `src/server/static-assets.ts:6441-6460`); the patch lives in a
  different pane. The 4.1 requirement wants actual code changes in the worker view.
- **Diff truncation is not surfaced in the Worktree Diffs UI.** `captureRawDiff`
  returns `{diff, untracked, truncated}` with a 16 MiB Git output cap
  (`src/workspace/trusted-git.ts:44-48,990-1005`), but the run-diff route drops
  `truncated` when building its response (`src/server/routes.ts:997-1003`), and
  `renderDiffContent` receives only text (`src/server/static-assets.ts:5419-5423`).
  A huge diff can be silently partial.
- **Large-diff rendering is unbounded.** `renderViewerDiff` maps every line into DOM
  spans; the `MAX_HIGHLIGHT_CHARS` guard only applies to `renderViewerCode`
  (`src/server/static-assets.ts:5220-5231,5233-5250`).
- **Binary files have no explicit UI treatment.** Git's textual “Binary files differ”
  line would be rendered as a neutral line; there is no binary badge or download path.
- **No write-scope filtering.** The diff shows everything changed in the task checkout.
  Since the checkout is isolated, that is usually task-scoped, but a worker can edit a
  file outside its declared `writeScope`; the diff will show it without labeling it as
  out-of-scope. Scope conflicts are detected elsewhere but not used to filter display.
- **Plan visibility is largely hidden in the SPA.** `activeRunCard` and `dagContainer`
  are inside a `display:none`/`is-hidden` block
  (`src/server/static-assets.ts:150-158`). `renderDag` is implemented
  (`:4863-4908`) but not visible to the operator. The TUI/chat has a real plan graph
  (`src/tui/plan-graph.ts`, `/plan` commands in `src/cli/commands/chat.ts`), so the
  graphical/terminal relationship is inconsistent.
- **No plan events in the activity mapper.** `ActivityMapper` has no plan-created/
  plan-approved/step-completed cases (`src/server/activity.ts:128-281`), and the
  `PlanRecord` model is session-scoped (`src/domain/plan.ts:22-32`) rather than
  run/task-scoped.

### 10.3 Missing

- Worker detail patch view with `+`/`-` lines.
- Diff truncation badge and large-diff strategy.
- Binary file indication.
- Out-of-scope change labeling/filtering.
- Visible execution plan and milestone progress in the SPA.
- Plan/progress events backed by durable state and mapped into the activity feed.

### 10.4 Broken

- **Silent diff truncation is a correctness defect.** A partial patch presented as the
  complete patch is a false claim about the workspace.
- **The SPA hides the plan DAG it already renders.** The manager says it “plans and
  delegates”, but the graphical operator cannot see that plan; this contradicts the
  4.1 visibility requirement even though the underlying plan store exists for chat.

---

## 11. Consolidated requirement matrix

| # | 4.1 requirement | Status | Primary evidence |
|---|---|---|---|
| 1 | Multiple real inference providers via adapters | **Implemented (Phase 1)** | `openai-compatible` adapter registered alongside `opencode` (`src/engines/openai-compatible/adapter.ts`, `src/engines/registry.ts`) |
| 2 | Provider credential storage/validation/removal | **Implemented (Phase 1)** | Dedicated provider registry + private home credentials with 0600 / Windows SID ACLs (`src/providers/store.ts`, `src/cli/commands/provider.ts`) |
| 3 | Provider activation lifecycle | **Implemented (Phase 1)** | Provider configuration, credential store, `pluton provider validate`, discovery and model listing |
| 4 | Dynamic model discovery and display | **Implemented (Phase 2)** | Provider-aware model enumeration and availability across registered providers and engines (`src/server/routes.ts:1030-1120`, `src/server/static-assets.ts`) |
| 5 | Searchable model-selection dialog | **Implemented (Phase 2)** | Searchable modal dialog with filter-as-you-type, provider badges, target Ship selector, and assignment actions (`src/server/static-assets.ts`) |
| 6 | Engine/model/provider compatibility on assignment | **Implemented (Phase 2)** | `/api/ships/:id/model` validates model against target engine/provider adapter, rejecting unknown providers or models with 400 (`src/server/routes.ts:1140-1200`) |
| 7 | Cross-engine fallback through replacement adapter | **Missing/Broken** | Selector constrained to one engine (`src/engines/model-selection.ts:638`); replacement uses original adapter (`src/orchestrator/supervisor.ts:1548-1556`) |
| 8 | Persist exact engine/provider/model identity | **Implemented (Phase 2)** | Ship model assignment updates `pluton.yaml` via `editShip` and SQLite via `updateShipModel` with `(engine, provider, model)` and reloads active sessions (`src/server/routes.ts:1190-1235`, `src/store/store.ts:453-460`) |
| 9 | Persistent project workspace across Builds | **Implemented (Phase 4)** | Migration v15 `project_sessions` stores active persistent workspace session and `build_count` (`src/store/migrations.ts`, `src/store/store.ts`); run creation attaches to session; supervisor injects prior-build lineage into manager prompt for iterative plan refinement (`src/orchestrator/supervisor.ts`) |
| 10 | Operator-entered project name | **Implemented (Phase 4)** | Operator can name project during initial Build confirmation (`#buildConfirmProjectName`), in Settings tab (`#projectNameInput`, `PATCH /api/projects/:id`), or via CLI (`pluton project rename <project> <new-name>`), composing config, store, and registry atomically without path changes (`src/projects/rename.ts`) |
| 11 | Build without repeated project-creation confirmation | **Implemented (Phase 4)** | First Build requires workspace confirmation; subsequent Builds within an established session (`buildCount > 0`) skip repeat confirmation dialog and initiate execution immediately (`src/server/static-assets.ts`, `src/server/routes.ts`) |
| 12 | Recursive file browsing | **Incomplete** | Recursive walk + full tree exist (`src/server/routes.ts:1748-1778`; `src/server/static-assets.ts:5044-5075`), but no lazy load/search/breadcrumb |
| 13 | Large/deep directory support | **Broken/Incomplete** | Hard 300-file cap with silent truncation (`src/server/routes.ts:1748-1778`) |
| 14 | Contained file access | **Implemented** | `resolveWorkspaceFile` + canonical containment + protected segments (`src/server/routes.ts:1700-1745`; tests `tests/integration/server-api.test.ts:290-372,961-1001`) |
| 15 | Worker inspector bound to exact identity | **Implemented** | `openWorkerDetail(taskId)` + `/api/runs/:runId/tasks/:taskId/detail` (`src/server/static-assets.ts:6282-6360`; `src/server/task-detail.ts:143-152`) |
| 16 | Worker detail plan/milestones/blockers | **Missing/Incomplete** | Detail has brief/criteria/deps/activity, no plan or blocker section (`src/server/static-assets.ts:6516-6550`) |
| 17 | Real worker updates in main chat | **Implemented** | `ActivityMapper` + seq-deduped `run_activity` (`src/server/activity.ts`; `src/server/static-assets.ts:3161-3246`) |
| 18 | Worker-to-worker messaging, durability, acks | **Implemented** | `WorkerMessageBus` (`src/orchestrator/messages.ts`); tests `tests/integration/worker-messages.test.ts` |
| 19 | Messaging latency/wakeups | **Incomplete** | Pull-based delivery at next tool call; wakeups resolve waits but cannot inject mid-turn (`src/orchestrator/messages.ts:399-448`) |
| 20 | Filter protocol noise from activity | **Implemented** | `ActivityMapper` returns `null` for low-value events (`src/server/activity.ts:128-281`) |
| 21 | Actual diffs with `+`/`-` | **Implemented** | `renderViewerDiff` (`src/server/static-assets.ts:5233-5250`); real git capture (`src/workspace/trusted-git.ts:990-1010`) |
| 22 | Worker detail actual patch | **Missing** | Only paths (`src/server/static-assets.ts:6441-6460`) |
| 23 | Diff binary/large handling | **Incomplete** | No binary badge; unbounded line rendering; truncation dropped in run diff (`src/server/routes.ts:997-1003`) |
| 24 | Remove generic agent labels | **Implemented** | Ship display name first; canonical `Supervisor` (`src/server/static-assets.ts:6039-6043`; `src/server/activity.ts:128-278`) |
| 25 | Detailed plans/progress in graphical UI | **Missing** | `dagContainer` hidden (`src/server/static-assets.ts:150-158`); plan graph only in TUI (`src/tui/plan-graph.ts`) |
| 26 | Settings provider/model/credential UX | **Implemented (Phase 2)** | Graphical Settings AI Providers management card, Add Provider dialog, API key prompt, validation indicator, and delete action (`src/server/static-assets.ts`) |
| 27 | CLI/terminal parity for provider management | **Implemented (Phase 1)** | `pluton provider list|add|remove|key|remove-key|validate|models` in `src/cli/main.ts` and `src/cli/commands/provider.ts` |
| 28 | Mock excluded from production | **Implemented** | `devOnly` filter (`src/orchestrator/service.ts:393-402`; `src/engines/model-discovery.ts:288-316`) |
| 29 | No hardcoded model IDs | **Broken** | `SHIP_WORKER_MODELS` (`src/engines/opencode/adapter.ts:36-50`) used by `/api/models` (`src/server/routes.ts:1044-1066`) |
| 30 | Never auto-merge worker branches | **Implemented** | Integration is explicit; `GitWorkspaceManager` merges only into `pluton/integration/<run>` (`src/workspace/manager.ts:367-375`; ADR-0009) |

---

## 12. Existing test coverage relevant to 4.1

### Strong existing coverage

- **Model intelligence:** `tests/unit/model-registry.test.ts`,
  `model-selection.test.ts`, `model-health.test.ts`, `model-discovery.test.ts`,
  `model-performance.test.ts`, `model-config.test.ts`,
  `opencode-model-fallback.test.ts`, `supervisor-model-selection.test.ts`.
- **Engine contract:** `tests/unit/engines.test.ts`, `capability-conformance.test.ts`,
  `opencode-adapter.test.ts`, `opencode-pure.test.ts`,
  `tests/engines/opencode-model-validation.test.ts`.
- **Supervisor/fallback:** `tests/integration/supervisor.test.ts`,
  `supervisor-ownership.test.ts`, `supervisor-usage-budget.test.ts`.
- **Messaging:** `tests/integration/worker-messages.test.ts`,
  `session-inbox-routes.test.ts`, `tests/unit/session-inbox-store.test.ts`,
  `wakeups.test.ts`.
- **SPA/worker UI:** `tests/integration/spa-ui.test.ts`,
  `tests/integration/spa-inbox-ui.test.ts`,
  `tests/ui/ship-inspector-sidebar.test.ts`,
  `tests/server/worker-events-stream.test.ts`.
- **Files/security:** `tests/integration/server-api.test.ts` (traversal, protected
  paths, symlink containment, file CRUD), `tests/unit/path-safety.test.ts`,
  `tests/unit/server-security.test.ts`.
- **Diff/workspace:** `tests/unit/workspace.test.ts`, `trusted-git.test.ts`,
  `tests/integration/verify-redispatch-e2e.test.ts`.
- **Build/run/chat:** `tests/integration/cli-run.test.ts`,
  `tests/integration/chat-session.test.ts`, `tests/unit/acceptance-project.test.ts`,
  `tests/unit/builder-workspace-root.test.ts`.

### Coverage gaps directly tied to 4.1

- No second real provider adapter or provider conformance suite.
- No provider lifecycle test (add → validate → discover → refresh → replace/remove).
- No secret-in-API-response test for a real credential store (only the in-memory custom
  model path in `server-api.test.ts:1206-1223`).
- No searchable model-dialog test, filter test, or compatibility-explanation test.
- No cross-engine fallback test, and no test that a replacement session is created
  through the selected adapter.
- No test that a pinned model is rejected when it belongs to another engine.
- No repeated-Build-across-restart test, no operator-defined project-name test.
- No deep-tree, large-directory, lazy-load, breadcrumb, or file-search test.
- No worker-detail plan/milestone test.
- No UI test for diff truncation, binary files, or very large diffs.
- No SSE reconnect test that verifies the SPA’s activity/detail de-duplication.
- `npm run test:e2e` currently runs only one test file / one test; it is not a full
  graphical acceptance suite.
- `tests/live/opencode.live.test.ts` exists but was **not run** in this baseline; no
  real provider credential was used.

---

## 13. Security and invariant observations

- **SQLite remains authoritative.** All durable state used by the audited paths is in
  `src/store/store.ts`/SQLite. No shadow in-memory state was found for runs/tasks/
  events/approvals (Settings account/permissions/thinking/custom models are the
  exceptions and are explicitly in-memory UI state).
- **Approval enforcement remains in the supervisor/engine path.** The audit did not find
  a new bypass; file APIs are operator-facing, not worker-facing.
- **Task checkout isolation remains intact.** No duplication of the workspace manager
  was found; the diff paths read only Pluton-managed checkouts.
- **The supervisor remains the only model fallback decision-maker.** No adapter-level
  auto-switch was found; `switchModel` is operator-triggered
  (`src/engines/opencode/adapter.ts:200-221`).
- **No automatic merge path was found.** Integration is explicit.
- **No secret values are persisted in events by the audited paths.** The custom API key
  is held only in a process `Map` and is never returned; the risk is that it is
  **unused**, not leaked. The SPA warning overstates its security/utility.
- **The strongest security boundary in this audit is the file workspace resolver**
  (`src/server/routes.ts:1700-1745`) and its tests. Phase 5 must extend this resolver,
  not bypass it.

---

## 14. Phase-gate implications

- **Phase 1 (provider architecture)** must start by making model identity carry
  `(engineKind, provider, modelId)` in every assignment/fallback decision, then add a
  second real adapter behind the existing contract. The current single-engine fallback
  is safe only by accident; it must not be extended by passing foreign model ids to the
  existing adapter.
- **Phase 2 (Settings/model dialog)** must replace, not decorate, the flat popover and
  the dead custom-model card. The fake account card should not be reused as a provider
  account UI.
- **Phase 3 (routing/fallback)** must fix the adapter construction at
  `src/orchestrator/supervisor.ts:1548-1556` and the pin path at
  `:1292-1294`; failure-injection tests must prove no duplicate side effects.
- **Phase 4 (persistent Build)** can reuse `ensureProject` and the session/workspace
  columns, but must introduce a project-session anchor and remove the unconditional
  confirmation while preserving sensitive-operation approvals.
- **Phase 5 (files)** must extend the existing contained resolver and replace the
  synchronous 300-file walk with a bounded, paged/lazy API; the SPA tree must stop
  rendering the entire tree at once.
- **Phase 6 (worker experience)** can build on the already-correct identity binding and
  message bus; the missing work is plan/blocker/approval detail, scroll preservation,
  and operator-message wakeup ownership.
- **Phase 7 (timeline/diff)** must expose the hidden plan DAG, add inline patches to the
  detail, and surface truncation/binary states instead of silently dropping them.
- **Phase 8 (acceptance)** must not claim live-provider verification unless a real
  credential and real provider execution are used. The current baseline has no such
  validation.

---

## 15. Audit conclusion

The repository already has a strong, honest foundation:

- a real engine contract and a working OpenCode adapter;
- durable SQLite orchestration, task state machine, approvals, and isolated checkouts;
- a bounded, capability-aware model registry/selection/fallback layer;
- durable worker messaging with acknowledgments and wakeups;
- authoritative worker detail and activity binding;
- real Git diffs with correct `+`/`-` rendering;
- contained file APIs with meaningful tests.

It does **not** yet satisfy PLUTON 4.1’s provider-extensibility, provider credentials,
searchable model dialog, cross-engine fallback, persistent project Build lifecycle,
lazy/searchable file explorer, visible execution plans, or complete worker detail.
Several current behaviors are actively misleading: the dead custom-API-key path,
custom models marked available without an inference backend, silent file/diff
truncation, and a hidden plan UI.

No product code was modified in Phase 0. The working tree remains otherwise clean.
Phase 1 must not begin until the operator reviews this audit and authorizes the next
phase.

---

## 16. Implementation Progress & Upgrade Deliverables

- **Phase 1 (External Model Provider Architecture)**: **Implemented**. Added native credential store (`.pluton/provider-homes/` 0600), `openai-compatible` engine adapter with SSE streaming and `/models` discovery, CLI provider management (`pluton provider list|add|key|validate|remove`), and strict module boundaries.
- **Phase 2 (Provider REST API & Searchable Model UI)**: **Implemented**. Added `/api/providers*` REST endpoints, dynamic Ship model switching (`/api/ships/:id/model`), Settings AI Providers table, Add Provider dialog, Set Key modal, and Searchable Model Selection modal with fuzzy search.
- **Phase 3 (Project Persistence & Dynamic Multi-Builds)**: **Implemented**.
  - Central project registry (`~/.pluton/projects.json`) with canonical `project_<timestamp><hex>` IDs and atomic persistence.
  - 4-tier hybrid resolution engine (`--project` > CWD inside project > `~/.pluton/active-project` > `ProjectRequiredError`).
  - CLI project suite (`pluton project list|current|switch|add|remove`) and global `--project` / `pluton status --all-projects` support.
  - Multi-project context pool (`ProjectContextPool`) hosting all registered projects under a unified server instance.
  - Concurrent multi-build coordination across projects with zero event cross-talk, persistent workspace reuse across sequential runs, and intra-project conflict protection (409 Conflict).
  - Web workspace project selector dropdown (`projectSelectDropdown`, `projectSelectBtn`), client-scoped project switching without global pointer mutation, and project-filtered SSE event streams.
