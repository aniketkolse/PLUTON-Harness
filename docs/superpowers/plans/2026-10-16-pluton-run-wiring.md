# Pluton `run` Wiring + Live Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pluton run` a real command that drives the tested `RunSupervisor` end-to-end with per-Muse MCP bridge specs, budget from config, and engine env allowlisting — first on host engines, then with engines inside per-Muse Docker containers — proven by a live smoke (manager on OpenCode + worker on Qwen) that `pluton verify` closes.

**Architecture:** The CLI starts one loopback `ToolHttpServer` per run; `mcpServerFor(muse, taskId)` registers a per-session `PlutonToolBridge` and returns an HTTP `McpServerSpec` delivered to engines via ACP `session/new mcpServers` (`McpServerHttp`, gated on `mcpCapabilities.http`). Budgets map from `runtime.*` config into `RunBudget` + supervisor options. Run creation is idempotent via `--request-id` receipts. Docker mode adds: a pinned engine image profile, one long-lived container per Muse, and an `AcpSpawnFn` that runs the engine via `docker exec` (env passed as `-e NAME` pass-through — never `-e NAME=value` in argv).

**Tech Stack:** TypeScript strict / ESM / Node ≥ 24; `node:sqlite`; `node:http`; existing `ToolHttpServer`, `RunSupervisor`, `PlutonToolBridge`, `DockerSandboxManager`, ACP adapters; vitest. **No new runtime dependencies.**

**Spec:**
- `docs/adr/0003-engine-adapter-protocol.md`, `0004-sandbox-container-model.md`, `0005-checkout-terminal-lifecycle.md`, `0006-task-persistence-idempotency.md`, `0007-dynamic-delegation-policy.md`, `0008-model-auth-secret-storage.md`
- `docs/reverse-engineering/engine-mcp-integration.md` (§4 HTTP-transport plan; verified engine facts)
- ACP schema (verified 2026-10-16): `McpServerHttp = {type:"http", name, url, headers:[{name,value}]}`; `McpServerStdio = {name, command, args, env:[{name,value}]}`; agent capability gate `agentCapabilities.mcpCapabilities.http`
- `docs/delivery-report.md` §6 (missing items this plan closes), `docs/SECURITY.md` §8

**Design calls made in this plan (user has not yet decided these; review them):**
1. HTTP-first bridge for the run path; `pluton mcp serve` (stdio) stays for manual/dev use. In-container stdio→HTTP shim is a documented contingency only — built solely if an engine fails to advertise `mcpCapabilities.http` in the smoke.
2. Host-mode wiring and smoke (Phase A) land before Docker mode (Phase B), so live-model failures are isolated from container failures.
3. Per-session bearer tokens stay registered until run end (server stops then); loopback bind, 32-byte random tokens, never logged.
4. `--request-id` is optional; when given, run creation goes through `admitRequest` (`targetKind: 'run.create'`).

## Global Constraints

- TypeScript strict, ESM, Node ≥ 24; no new runtime dependencies; argv arrays only (no shell strings).
- Secrets never in `pluton.yaml`, DB rows, events, logs, artifacts, or **process argv** (ADR-0008). Docker env pass-through uses `-e NAME` only.
- Sandbox fails closed: Docker daemon or image unavailable → typed error + exact fix; never silently run unsandboxed.
- Never write to the user's repository tree; checkouts live under `.pluton/workspaces/`.
- `unknown_outcome` is never auto-replayed; completion only via durable records.
- Tests deterministic; Docker/live E2E opt-in and reported as NOT RUN with exact commands when not run.
- `npm run check` (typecheck + tests) green before every commit; incremental conventional commits.

## Review Focus

Failure modes the tests must pin (each gets a test in the owning task):
1. Docker daemon down at run start → `SandboxUnavailableError` with fix text; zero containers created; run not started.
2. Engine binary missing (host or container) → task records `failed` with typed error; run never claims success.
3. Bridge unreachable from the engine (e.g. `host.docker.internal` absent) → tool calls fail visibly in the engine transcript; manager cannot complete the goal without delegating.
4. Bearer token / API keys never appear in argv, DB, events, logs (assert in tests over recorded argv + persisted rows).
5. Re-running with the same `--request-id` after a crash mid-run → same run id, no duplicate run/tasks; different payload under same id → `ConflictError`.

## File Structure

- Create: `src/orchestrator/run-setup.ts` — pure config→budget/supervisor-options mapping.
- Create: `src/cli/commands/run.ts` — the `run` command flow (`runRun`), HTTP bridge wiring, receipt handling.
- Modify: `src/engines/contract/types.ts` — `McpServerSpec` union (stdio | http).
- Modify: `src/engines/acp/options.ts` — `toAcpMcpServers` emits both variants.
- Modify: `src/cli/main.ts` — real `run` command; update stale "still planned" hint at line 430.
- Modify: `src/sandbox/types.ts` + `src/sandbox/docker.ts` — `extraHosts` support.
- Create: `src/sandbox/muse-containers.ts` — per-Muse long-lived container provisioning.
- Create: `src/engines/docker-exec.ts` — `dockerExecSpawn` AcpSpawnFn with host→container path/env mapping.
- Modify: `src/sandbox/image.ts` + `src/cli/commands/sandbox.ts` — engine image profile build/record.
- Modify: `docker/worker/Dockerfile` — optional engines layer via build arg (pinned versions).
- Tests: `tests/unit/run-setup.test.ts`, `tests/unit/acp-mcp-servers.test.ts`, `tests/unit/docker-exec.test.ts`, `tests/unit/muse-containers.test.ts`, `tests/integration/cli-run.test.ts`; extend `tests/unit/sandbox.test.ts`, `tests/unit/sandbox-image.test.ts`, `tests/e2e/docker-sandbox.e2e.test.ts` (opt-in).
- Docs: `docs/smoke-live-run.md` (procedure + results), README/ROADMAP/delivery-report updates.

---

## Phase A — Host-mode wiring (engines as child processes, real HTTP bridge)

### Task 1: Runtime config → RunBudget + supervisor settings

**Files:**
- Create: `src/orchestrator/run-setup.ts`
- Test: `tests/unit/run-setup.test.ts`

**Interfaces:**
- Consumes: `RunBudget` (`src/domain/models.ts:87-93`), `runtimeConfigSchema` inferred type (`src/config/schema.ts:43-63`).
- Produces:
  - `export function runBudgetFromRuntime(runtime: RuntimeConfig): RunBudget` — `maxConcurrentWorkers: runtime.max_concurrent_workers`, `maxTasks: runtime.max_tasks_per_run`, `maxDelegationDepth: runtime.max_delegation_depth`, `maxRunMinutes: runtime.max_run_minutes`, `defaultTaskMinutes: runtime.default_task_minutes`.
  - `export interface SupervisorSettings { maxConcurrentWorkers: number; defaultTaskTimeoutMs: number; runDeadlineMs: number }`
  - `export function supervisorSettingsFromRuntime(runtime: RuntimeConfig): SupervisorSettings` — workers passthrough; minutes × 60_000.

- [ ] **Step 1: Write the failing test** — `tests/unit/run-setup.test.ts`: defaults from an empty-prefault runtime give `{3, 20, 3, 90, 30}` budget and `{3, 1_800_000, 5_400_000}` settings; custom values map exactly.
- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/unit/run-setup.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement `src/orchestrator/run-setup.ts`** with the two functions above; derive `RuntimeConfig` type via `z.infer` from the exported `runtimeConfigSchema`.
- [ ] **Step 4: Run test to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit** — `feat: map runtime config to run budget and supervisor settings`

### Task 2: `McpServerSpec` HTTP variant + ACP mapping

**Files:**
- Modify: `src/engines/contract/types.ts:46-51`
- Modify: `src/engines/acp/options.ts:92-103`
- Test: `tests/unit/acp-mcp-servers.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export type McpServerSpec =
    | { kind: 'stdio'; name: string; command: string[]; env?: Record<string, string> }
    | { kind: 'http'; name: string; url: string; headers?: Record<string, string> }
  ```
  `toAcpMcpServers(specs: McpServerSpec[] | undefined): unknown[]` — stdio → `{name, command: argv[0], args: argv.slice(1), env: [{name,value}]}` (unchanged wire shape, now with `kind` required); http → `{type:'http', name, url, headers:[{name,value}]}`; empty argv → `ValidationError` (existing behavior).

- [ ] **Step 1: Write the failing test** — `tests/unit/acp-mcp-servers.test.ts`: stdio spec produces the exact existing wire object; http spec produces `{type:'http', name, url, headers:[{name:'Authorization', value:'Bearer t'}]}`; `{kind:'stdio', command: []}` throws `ValidationError`.
- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/unit/acp-mcp-servers.test.ts` → FAIL.
- [ ] **Step 3: Implement** — add `kind` to the union in `types.ts`; update `toAcpMcpServers`; fix every construction site the type error surfaces (search `McpServerSpec` / `mcpServers` — supervisor defaults return `null`, mock tests pass `[]`).
- [ ] **Step 4: Run to verify it passes**, then the full suite (`npm run check`) to catch affected construction sites.
- [ ] **Step 5: Commit** — `feat: add HTTP MCP server spec variant and ACP mapping`

### Task 3: `pluton run` command with HTTP bridge wiring

**Files:**
- Create: `src/cli/commands/run.ts`
- Modify: `src/cli/main.ts` (replace stub at `main.ts:663-679`; update hint at `main.ts:430`)
- Test: `tests/integration/cli-run.test.ts` (new)

**Interfaces:**
- Consumes: `bootstrapStore` (`src/bootstrap.ts:22-41`), `requireProject`/`ProjectContext` (`src/cli/context.ts`), `stateDir`/`workspaceDir`/`engineHomesDir`/`findManager` (`src/config/load.ts:90-107`), `runBudgetFromRuntime`/`supervisorSettingsFromRuntime` (Task 1), `McpServerSpec` (Task 2), `ToolHttpServer` (`src/tools/http-transport.ts:46`, `register` :74-86, `url` :98, `start` :102-117, `stop` :119-126), `toolBridgeLimitsFromRuntime` (`src/tools/bridge.ts:45-60`), `PlutonToolBridge` (`src/tools/bridge.ts:86-118`), `RunSupervisor` (`src/orchestrator/supervisor.ts:154-199`, `managerBridge` :202, `runToCompletion` :494), `GitWorkspaceManager`, `WakeupRegistry`, `admitRequest` (`src/store/store.ts:973-1030`, targetKind `'run.create'`), `createRun` (`src/store/store.ts:327-348`).
- Produces:
  ```ts
  export interface RunCommandOptions { goal: string; acceptance: string[]; managerRef?: string; requestId?: string }
  export interface RunDeps { adapterFor?: (muse: MuseRecord) => EngineAdapter }   // test seam; default = registry
  export interface RunSummary { runId: string; state: RunState; outcome: RunOutcome['outcome']; taskCounts: Record<string, number>; managerSummary: string | null; unfinishedTasks: string[]; verificationPending: boolean }
  export async function runRun(ctx: ProjectContext, opts: RunCommandOptions, deps?: RunDeps): Promise<RunSummary>
  ```
  Flow: `bootstrapStore` → resolve manager (`managerRef` by id then slug via `resolveMuseByRef`; else `findManager`) → budget from `runBudgetFromRuntime` → create run (with receipt when `requestId` given; duplicate → return existing run's summary with a `duplicate: true` flag on the event only) → `new ToolHttpServer()` + `start()` → build supervisor with:
  - `wakeups: new WakeupRegistry()` (shared with every bridge),
  - `mcpServerFor: (muse, taskId)` → bridge = `taskId === null ? supervisor.managerBridge() : new PlutonToolBridge({... callerTaskId: taskId ...})`; `const { token } = http.register(bridge, { museId: muse.id, taskId, runId })`; return `{ kind:'http', name:'pluton', url: `${http.url}/mcp`, headers: { Authorization: `Bearer ${token}` } }`,
  - `engineEnv: () => ({})` (ADR-0008: auth lives in engine homes; Qwen adapter's own allowlist reads host env),
  - `verificationConfigured: ctx.loaded.config.project.verification.length > 0`,
  - `adapterFor: deps?.adapterFor`, `workspaceManager: new GitWorkspaceManager({ workspacesRoot: workspaceDir(ctx.rootDir) })`,
  - `limits: toolBridgeLimitsFromRuntime(ctx.loaded.config.runtime)`, timings from Task 1, `diagnostic: (line) => process.stderr.write(line + '\n')`.
  Then `await supervisor.runToCompletion()` → `await http.stop()` → `store.close()` in `finally` → summary (`verificationPending = state === 'verifying'`).
- CLI registration: `pluton run --goal <text> [--acceptance <c>]... [--manager <muse>] [--request-id <id>] [--json]`; goal required (`ConfigError` if missing); human output: run id, outcome, task counts, and when `verificationPending` the line `next: pluton verify --run <id>`; JSON envelope `{ok:true,data:{run:{id,state,outcome},taskCounts,managerSummary,unfinishedTasks}}` via `emitOk`.

- [ ] **Step 1: Write the failing tests** — `tests/integration/cli-run.test.ts` (in-process, deterministic):
  - Build a temp project (pattern from `tests/integration/supervisor.test.ts` `makeWorld`): real git repo, config with manager `mock` + worker `mock` muses, `verification: []`.
  - Manager mock's `onPrompt` reads `req.mcpServers` captured via `onStartSession`, then performs **real HTTP calls**: `initialize` → `tools/list` → `tools/call task.create` (worker task) → `tools/call task.wait` → returns success; worker mock returns success. Assert: run reaches `completed`; task rows exist; the HTTP calls actually traversed `ToolHttpServer` (assert `http.sessionCount() > 0` during the run via a hook, or assert bridge events `tool.call` in the store).
  - Idempotency: same `--request-id` + same goal twice → same run id, one run row; same id + different goal → `ConflictError`.
  - Spawned CLI error path: `bin/pluton.js run --goal x --json` in a project with no supervisor muse → `{ok:false,error:{code:...}}`, exit 1.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/integration/cli-run.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/cli/commands/run.ts` + `main.ts` registration (use `runCommand`/`emitOk`/`emitErr`; remove `run` from the planned-commands loop; update the `status` hint string).
- [ ] **Step 4: Run to verify they pass**, then `npm run check`.
- [ ] **Step 5: Commit** — `feat: wire pluton run to the supervisor with HTTP tool bridge`

### Task 4: Host-mode live smoke (OpenCode manager + Qwen worker) + docs

**Files:**
- Create: `docs/smoke-live-run.md` (procedure + dated results table)
- Modify: `docs/ROADMAP.md` (Phase 6/7 remaining items), `docs/delivery-report.md` (§6/§7), `README.md` (run usage)

**Procedure (exact):**
1. Scratch project at `.pluton-tmp/smoke-host/` (gitignored): `git init`, seed one file; `pluton.yaml` with `manager` (engine `opencode`, model as configured on this host), `worker` (engine `qwen`, model `cbai/glm-5.2`), `sandbox.kind: local-process` + `local_process_acknowledged: true` (documented dev-only), `verification` with one check (e.g. `git status --porcelain` expected clean) — verification left empty OR set, see step 4.
2. Engine auth (never printed): Qwen via the 9router gateway env keys loaded into the smoke shell from the existing key file; OpenCode via a user-managed copy of the host auth file into `.pluton/engine-homes/manager/` (ADR-0008 permits a user-managed copy; document the exact copy command with placeholder path).
3. Set `PLUTON_QWEN_BIN` (existing prefix `cli-entry.js`) and `PLUTON_OPENCODE_BIN` to the host binaries.
4. Run: `pluton run --goal "add a README line and a test that fails without it" --json` → expect `state: verifying` (checks configured) or `completed` (no checks); then `pluton verify --run <id> --json` → expect run `completed` with the check recorded.
5. Record actual results (including any engine quirks, timing, token cost if visible) in `docs/smoke-live-run.md` and update delivery-report §6/§7 truthfully — failures stay failures in the docs.
- [ ] **Step 1: Write the smoke doc skeleton + docs edits (before running, so results land in a known place).**
- [ ] **Step 2: Execute the smoke on this host; capture outputs.**
- [ ] **Step 3: Fix wiring bugs found (bounded: wiring/config — engine-internal quirks are documented, not patched).**
- [ ] **Step 4: `npm run check` green; commit** — `feat: host-mode live smoke with opencode manager and qwen worker` (docs + fixes).

---

## Phase B — Docker mode (engines inside per-Muse containers)

### Task 5: Worker image with pinned engine CLIs

**Files:**
- Modify: `docker/worker/Dockerfile` (add `ARG PLUTON_ENGINES=0` layer: `RUN npm install -g --omit=dev opencode-ai@<pin> @qwen-code/qwen-code@<pin>` — pins resolved at implementation time from the host versions actually verified: OpenCode version as reported by the host binary, Qwen `0.25.2`)
- Modify: `src/sandbox/image.ts` (+ `src/cli/commands/sandbox.ts` if a flag is needed)
- Test: extend `tests/unit/sandbox-image.test.ts`

**Interfaces:**
- Produces: `buildImageRequest` gains `profile: 'base' | 'engines'`; recorded `.pluton/state/worker-image.json` stores profile + image id; `dispatchReadiness` requires the `engines` profile for container-mode runs and keeps the base profile for probe-only use.
- [ ] **Step 1: Write the failing test** — build argv includes `--build-arg PLUTON_ENGINES=1` for profile `engines`; readiness refuses a base-profile image in container mode with the exact rebuild command.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** (Dockerfile layer + image record/profile plumbing).
- [ ] **Step 4: Run to verify it passes**; opt-in E2E: `docker build` + `docker run --rm <img> sh -c "opencode --version && qwen --version"` → recorded in docs (NOT RUN if daemon unavailable, with the command).
- [ ] **Step 5: Commit** — `feat: worker image engines profile with pinned CLIs`

### Task 6: Per-Muse containers + `extraHosts`

**Files:**
- Modify: `src/sandbox/types.ts` (`SandboxSpec.extraHosts?: string[]`), `src/sandbox/docker.ts` (`--add-host` in `buildCreateArgs`)
- Create: `src/sandbox/muse-containers.ts`
- Test: extend `tests/unit/sandbox.test.ts`; new `tests/unit/muse-containers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MuseContainerSpec { projectId: string; museId: string; image: string; limits: {cpus:number; memoryMb:number; pids:number}; network: 'restricted'|'none'|'open'; mounts: {hostPath:string; containerPath:string; readOnly?:boolean}[] }
  export async function ensureMuseContainer(manager: SandboxManager, store: Store, spec: MuseContainerSpec): Promise<{ containerName: string; created: boolean }>
  ```
  Always adds `extraHosts: ['host.docker.internal:host-gateway']`; creates+starts when absent, reuses when the managed labels match; records/updates a `SandboxRecord` per (project, muse); never removes a container it did not create (label guard).
- [ ] **Step 1: Write the failing tests** — argv: `--add-host host.docker.internal:host-gateway` present; create path calls `manager.create` + `start` and upserts a record; reuse path (existing labeled container) skips `create`; mismatched labels → refuse reuse.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass; `npm run check`.**
- [ ] **Step 5: Commit** — `feat: per-Muse container provisioning with host gateway`

### Task 7: `docker exec` engine spawn seam

**Files:**
- Create: `src/engines/docker-exec.ts`
- Modify: `src/cli/commands/run.ts` (container mode: when `sandbox.kind === 'docker'`, ensure containers, construct adapters with `spawnFn`, bridge URL host `host.docker.internal`, `binaryPath` pinned to container paths)
- Test: new `tests/unit/docker-exec.test.ts`; extend `tests/integration/cli-run.test.ts` with a fake-spawn assertion (in-process, no Docker needed)

**Interfaces:**
- Produces:
  ```ts
  export interface DockerExecContext { containerName: string; mounts: {hostPath:string; containerPath:string}[]; env: Record<string,string> }
  export function mapHostPathToContainer(path: string, mounts: DockerExecContext['mounts']): string  // longest-prefix; throws ValidationError when unmapped
  export function dockerExecSpawn(ctx: DockerExecContext): AcpSpawnFn
  ```
  Spawn argv: `['exec','-i','-w',<mapped cwd>, ...Object.keys(env).map(n => ['-e', n]).flat(), ctx.containerName, command, ...args]` with the **values passed via the spawned docker CLI's own env** (`env: {...process.env-subset, ...ctx.env}`) — `-e NAME` pass-through only; `-e NAME=value` is forbidden by a unit test. Env values that are host mount paths (e.g. `XDG_CONFIG_HOME`) are rewritten through `mapHostPathToContainer`.
- [ ] **Step 1: Write the failing tests** — argv shape (no `=` in any `-e` argument); path mapping (mapped, nested, unmapped→throw); env value rewrite for configDir; fake child spawn receives docker CLI env containing the values.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass; `npm run check`.**
- [ ] **Step 5: Commit** — `feat: docker exec ACP spawn seam with argv-safe env`

### Task 8: Container-mode live smoke + verify close-out + docs

**Files:**
- Modify: `docs/smoke-live-run.md` (container-mode section + results), `docs/ROADMAP.md`, `docs/delivery-report.md`, `docs/SECURITY.md` §8 (only what the smoke actually verifies — e.g. `host.docker.internal` reachability flips from inferred to verified)

**Procedure:**
1. Build the engines image (Task 5); record digest.
2. Scratch project `.pluton-tmp/smoke-docker/` with `sandbox.kind: docker`, same two-muse config as Task 4.
3. `pluton run --goal "<tiny goal>" --json` → containers created per Muse; engines run via `docker exec`; bridge reached via `host.docker.internal`; run stops in `verifying`.
4. `pluton verify --run <id> --json` → `completed`.
5. Verify no secrets in argv: while a session is live, assert `docker exec` argv contains only `-e NAME` (spot-check via `Get-CimInstance Win32_Process` on Windows or `ps` in WSL).
6. Record honest results (including NOT-RUN items) in the docs; `npm run check`; commit — `feat: container-mode live smoke through docker exec`.

---

## Self-Review Notes

- **Spec coverage:** run CLI (Task 3), MCP specs both variants (Task 2), env allowlist (Task 3 — engine homes + adapter allowlists, documented in Task 4), budget from config (Task 1), idempotency (Task 3), Docker locality (Tasks 5–8), live smoke + verify close (Task 4, Task 8). `attach`/`integrate`/approval UX are the next slice — not this plan.
- **Type consistency:** `McpServerSpec.kind` discriminator (Task 2) is consumed only by `toAcpMcpServers` (Task 2) and produced by `run.ts` (Task 3/Task 7); `RunBudget`/`SupervisorSettings` names match `models.ts`/`supervisor.ts` exactly.
- **Known risk:** engine `mcpCapabilities.http` is schema-valid but unverified for OpenCode/Qwen on this host — the Task 4 smoke is the verification; if an engine refuses, the documented fallback is the stdio spec (`pluton mcp serve`, multi-process WAL is safe: `busy_timeout=5000`, `src/store/db.ts:14,18`) or the in-container stdio→HTTP shim (B-phase contingency, built only if needed).
- **Auth gap (pre-existing, documented):** `pluton muse auth` does not exist; the smokes use the user-managed copy / env-key paths and say so in the docs.
