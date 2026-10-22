# PLUTON Architecture — as-built reference (Phase 1 audit)

**Date:** 2026-10-18
**Repository state:** `main` at `506fa72` ("feat(tui): align chat layout to single-column card design and remediate visual defects"). Untracked additions present: `.pluton/`, `pluton.yaml`, `PLUTON_TUI_REFINEMENT_PROMPT.md`.
**Method:** read-only inspection of the repository plus executed commands recorded in `docs/PLUTON_BASELINE_REPORT.md`. Every architectural statement below cites a repository path; statements that could not be verified are marked **not verified**.

> Reference frame: the mission's specification volumes (`01`–`04` in `Y:\Setup\REA deepseek\`) describe **DeepSeek Harness (`dsh`)** — an agent *harness* built on the Cordis plugin kernel. Pluton is an **orchestration control plane** whose engines are external harnesses. Capability-by-capability parity mapping is in `docs/PLUTON_FEATURE_PARITY.md`; this document describes only what Pluton is today.

## 1. What Pluton is (documented)

From `README.md`: Pluton-Harness is a **CLI-first, local-first orchestration control plane** for a team of persistent AI coding agents ("Muses"). Pluton is not a coding model: engines do inference, containers provide isolation, tmux provides terminal persistence, Git tracks changes, and a durable local runtime (SQLite) records what was requested, accepted, dispatched, completed, failed, or left uncertain.

The preserved product rules (from the mission's conversation history and `PLUTON_TUI_REFINEMENT_PROMPT.md` line 15) are:

- the existing runtime, agent execution, engine adapters, session persistence, approvals, tools and task lifecycle are the source of truth;
- the TUI work is presentation-layer only ("Do not rewrite the harness or replace the backend to make the interface easier to build");
- the approved TUI design is `PLUTON_TUI_REFINEMENT_PROMPT.md` + ADR-0013.

## 2. Process and composition model (as built)

There is no daemon, no service container, and no plugin lifecycle today (verified: grep for `plugin|hot.?reload|service registry|lifecycle hook` over `src/` returns no matches).

| Path | What runs there |
|---|---|
| `src/cli/main.ts` (46.8 KB) | Commander-based CLI; ~14 command groups; every command that needs state goes through `bootstrapStore` |
| `src/bootstrap.ts:23` | `bootstrapStore`: ensure `.pluton/state` → open SQLite → migrate → ensure project row → mirror config muses into `muses` (disabled, not deleted, when removed from config) |
| `src/cli/commands/run.ts:240` | `createRunSupervisor`: builds the long-lived `RunSupervisor` for `pluton run` (in-process manager bridge + HTTP bridge registered per Muse/task with bearer tokens) |
| `src/orchestrator/supervisor.ts:170` | `RunSupervisor`: the manager session, dispatch loop, per-Muse locking, engine sessions, outcome mapping, retries, verification hand-off |
| `src/chat/session.ts` (35.4 KB) | `ChatSession`: interactive operator TUI loop, streaming turns, background run polling (`runPollTick`), approvals inbox, slash commands |
| `src/engines/registry.ts:52` | Engine registry: a simple `Map` of factories (`mock` devOnly, `opencode`, `qwen`) — the closest thing to a service registry that exists |

Composition is static and config-driven: one `pluton.yaml` per project, validated by Zod (`src/config/schema.ts`), plus role templates in `templates/`. There is no profile/bundle/patch layering and no hot reload.

## 3. Module map

| Directory | Files | Role |
|---|---|---|
| `src/cli/` | 3 + 12 commands | CLI entry, output envelopes (`output.ts`), per-command implementations |
| `src/config/` | 2 | Zod schema + loader (strict; argv-only commands; `CONFIG_VERSION = 1`) |
| `src/domain/` | 6 | IDs, typed models, errors, permission catalog, task/run/sandbox state machines, plan types |
| `src/store/` | 3 | SQLite open/pragmas (`db.ts`), forward-only migrations (`migrations.ts`), the single `Store` class (62.8 KB, 80 public methods) |
| `src/orchestrator/` | 8 | Supervisor, task-graph admission, wakeups, circuit breaker, keyed mutex, file-lease manager, usage ledger, run-setup mapping |
| `src/engines/` | 3 + acp(5) + contract(2) + opencode(3) + qwen(3) + mock | Engine contract, ACP stdio client, adapters, docker-exec spawn, approval-mode mapping, discovery |
| `src/tools/` | 6 | Restricted tool catalog + handlers, authorization bridge, MCP stdio server, HTTP transport, operator tool catalog |
| `src/sandbox/` | 6 | Docker lifecycle, worker image build/probe, Muse containers, factory, ack-gated local-process path |
| `src/server/` | 8 | Local workspace app server (loopback + workspace-token gate): SPA assets, HTTP routes, SSE log-watcher, instance discovery/lifecycle |
| `src/workspace/` | 2 | Per-task/integration git checkouts; protected paths |
| `src/terminal/` | 4 | Per-Muse tmux session management inside containers; `attach` resolution |
| `src/verify/` | 2 | Configured verification checks, verdict logic, independent-review helpers |
| `src/chat/` | 3 | Slash-command registry, prompt text, the chat session loop |
| `src/plan/` | 1 | `PlanManager` (plan-mode workflow) |
| `src/tui/` | 14 | TUI 2.0 primitives: terminal, layout, render, state, theme, markdown, sanitize, width, editor, keys, activity, approval cards, orchestra inspector, plan graph |
| `src/ui/` | 10 | TUI 2.0 design-system components: brand banner, header, messages, cards, tools, status bar, input, approval, theme, demo |

Tests: 70 unit files, 19 integration files, 1 gated E2E file, 2 opt-in live files, fixtures for OpenCode/Qwen ACP frames (`tests/fixtures/`).

## 4. Durable model (SQLite)

One database per project at `<project>/.pluton/state/pluton.sqlite` (WAL; `db.ts` sets `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`; transactions are explicit `BEGIN IMMEDIATE`). Migrations are forward-only; a newer schema is refused, never downgraded (`migrations.ts` header; ADR-0002).

Tables (declared in `src/store/migrations.ts`): `projects`, `muses`, `runs`, `tasks`, `task_edges`, `events`, `receipts`, `workspaces`, `sandboxes`, `terminals`, `approvals`, `verification_checks`, `meta`, `chat_sessions`, `chat_messages`, `plans`, `file_leases`, `run_usage`, `verifications`.

Schema v7 (`run-supervisor-ownership`, `migrations.ts:327–336`) adds the run-ownership pair to `runs`: `supervisor_token` (opaque fencing token; NULL = unowned) and `supervisor_heartbeat_at` (epoch-ms of the last renew; NULL = unowned — legacy rows read as claimable, and a token with a NULL heartbeat counts as stale). `supervisor_pid` (v1) stays as observability. The claim is one atomic statement: `claimRunSupervisor(runId, { pid, ttlMs, nowMs? })` mutates only while the row is unowned or its heartbeat is at or before `now − ttl`, and fails closed (`null`) on a live owner; `renewRunSupervisor` (heartbeat CAS) and `releaseRunSupervisor` (clear CAS) both match on the token, so an old owner can never renew or release the new owner's claim (`store.ts:456–493`). Run-owned mutating store methods take an optional trailing `SupervisorFence { runId, token }` that the same statement re-checks — a stale process's write is rejected (`OwnershipLostError`) or skipped by contract (the throw/silent-skip matrix is in §5).

Key records (`src/domain/models.ts`):

- **Events** are append-only with a monotonic global sequence (`events.seq` = SQLite AUTOINCREMENT); payloads are bounded and redacted; read via `eventsSince(projectId, afterSeq)` / `listEvents(runId)` (`store.ts:984–1051`).
- **Receipts** (`request_receipts` semantics) make every request idempotent: same id + same payload returns the stored receipt; same id + different payload is a `request_conflict` (`Store.admitRequest`, `store.ts:1292`).
- **Approvals** are durable records with `pending|approved|denied|expired`, TTL sweep, and fail-closed expiry (`store.ts:782–984`).
- **Usage** rows per (run, muse, task) with `input_tokens`, `output_tokens`, `cached_tokens`, `cost_usd` (`store.ts:1423–1492`).
- **File leases** for scope declarations across concurrent Muses (`file_leases` + `FileLeaseManager`).
- **Chat** sessions/messages with per-session monotonic sequence; **plans** for plan-mode; **verifications** evidence rows.

## 5. Execution model

Task state machine (`src/domain/state.ts`): `created → queued → admitted → running → (waiting_for_children | needs_input | needs_approval | verifying) → completed | failed | cancelled | interrupted | unknown_outcome`; transitions outside the table are rejected. Run and sandbox machines live in the same module.

`RunSupervisor` flow (verified in `src/orchestrator/supervisor.ts:279–560`):

1. Manager session prompts the manager Muse with the restricted tool bridge (via HTTP MCP spec).
2. Dispatch loop takes `listReadyTasks` up to `maxConcurrentWorkers`, per-Muse serialization via `KeyedMutex`, and stops dispatch while the circuit breaker is tripped.
3. A task with `isolated-task-checkout` gets a per-task `git clone --local` checkout (`src/workspace/manager.ts`), recorded in `workspaces`.
4. Engine session via `adapterFor(muse)`; prompt has a hard wall-clock timeout (`runPrompt`); timeout maps to outcome `unknown` with `prompt_timeout` — never a fabricated success.
5. Outcomes: `success` → `verifying` when verification checks exist, else `completed`; `failure` → circuit-breaker decision → retry (new attempt, `task.retry_scheduled`) or fail; `cancelled` → `cancelled`; `unknown` → `unknown_outcome`. Every transition appends an event and notifies waiters exactly once (`wakeups.ts`).
6. `scope.declare`/`scope.release` map to file leases; leases are released in a `finally` block on task exit.
7. Usage events (`inputTokens`/`outputTokens`/`costUsd`) are absorbed by `UsageLedger.record`; overrun triggers `session.interrupt()` (`supervisor.ts:473–486`). Budgets are **opt-in**: `runtime.max_run_input_tokens` / `max_run_output_tokens` / `max_run_cost_usd` and the per-Muse caps (`src/config/schema.ts:73–82`) map through `usageBudgetsFromRuntime` (`src/orchestrator/run-setup.ts:42–52`) into the ledger when configured (`run.ts:330,350`) — absent limits mean no limit (`supervisor.ts:347`). See the parity doc gap table.
8. `pluton verify` runs configured checks (argv-only, allow-listed, bounded) and closes tasks/runs only from durable verdicts (`src/verify/runner.ts`).

**Supervisor ownership.** `runToCompletion()` claims the run before its first state write (`supervisor.ts:1121–1149`): the claim is atomic, so a live owner makes a second supervisor throw `ConflictError` naming the holder pid (`details.supervisorPid`; the CLI refuses cleanly, HTTP maps the code to 409 — `routes.ts:574–577`). The claim is renewed on an `ownershipTtlMs / 3` throttle (default `DEFAULT_OWNERSHIP_TTL_MS = 90_000`), and every loop tick (≤ `loopPollMs`) also fast-checks the durable token, so detection is tick-bounded while correctness is write-time: the supervisor's duty-path mutations carry `SupervisorFence { runId, token }` and their single SQL statement re-checks the token (reads stay unfenced; the one deliberately unfenced write is `run.started`, appended immediately after the claim-scoped `created → active` transition (one synchronous span with the fenced write, so no takeover can interleave before the heartbeat ages past the TTL)). Fence miss → **throw** `OwnershipLostError` (`ownership_lost`) for `setTaskState`, `setTaskStateIf`, `setRunState`, `appendEvent`, `createApproval`, `createWorkspace`, `updateWorkspace`; **silent skip** (best-effort by contract — must not throw from `finally`/engine pumps) for `recordLease`, `releaseLeasesForTask`, `reapOrphanedLeases`, `recordUsage`. State transitions are additionally CAS-protected on the pre-read state: `setTaskState`/`setRunState` repeat the expected `state` in the UPDATE's `WHERE`, so a control-plane write that commits between the read and the write (e.g. a cancel) is never resurrected — the loser gets a `StateTransitionError` naming the concurrent change, while a stale owner is classified fence-first as `OwnershipLostError`. Channel teardown writes (approval `abort`/expiry in `src/engines/interactive-approval.ts`) are deliberately best-effort **unfenced**: they are scoped to approvals the losing process itself created and they fail closed (expiry/abort resolve `deny`). On loss (fast-check mismatch, failed renew, or any fence miss) the supervisor marks itself stale, interrupts its manager + task engine sessions, and returns the read-only `superseded` outcome — **no finalize, no events, no drain, no release**; ownership changes are durable events (`run.supervisor_claimed { pid, tookOver, previousPid? }`), and every normal finish appends `run.supervisor_released` then releases in `finally`. Explicit boundary: control-plane writers (tool handlers, HTTP routes, CLI commands, chat) stay **unfenced by design** — they are state-driven and the supervisor reacts to them; on ownership loss the stale owner's already-armed engines are interrupted. Limitations: a hard-wedged owner cannot stop itself (its writes are fenced, but its engine children may linger until the process is killed), and the guarantee is atomic per statement through one local SQLite file, not a distributed protocol.

Restart behavior: state is durable, but there is no automatic re-dispatch; the recorded policy is "an interrupted or externally-uncertain action is never auto-replayed" (ADR-0006; `implementation-decisions.md` A2/A4 status: decided, acceptance suite not yet implemented).

## 6. Engine layer

- Contract (`src/engines/contract/types.ts`): `EngineAdapter` (capabilities, discover, listModels, authStatus, startSession) and `EngineSession` (sendPrompt → normalized `EngineEvent` stream, interrupt, close). Events: `status`, `text`, `tool`, `approval_request`, `usage`, `result {success|failure|cancelled|unknown}`, `error`. Capabilities: `resumeSession`, `interrupt`, `approvals`, `usage`, `modelList`, `mcpServers`, `sessionExport`; conservative defaults; unsupported features must raise capability errors, never fabricate.
- ACP transport (`src/engines/acp/client.ts`): in-repo newline-delimited JSON-RPC 2.0 over stdio; 60 s default control-request timeout; 4 MB max frame; max 64 pending; bounded stderr tail; malformed frames are fatal to the connection; request timeouts reject that request only. No retry/backoff policy exists anywhere in `src/engines/` (verified grep).
- Adapters: `opencode` (live-verified v2.0.29; model pinning, `session/load` resume, approvals, usage), `qwen` (v0.25.2; session modes, composite model values, unknown server requests refused `-32601`, auth mapping `-32000`), `mock` (tests/dev only). Fixture-replay conformance suites in `tests/unit` and `tests/fixtures/`.
- Native mode (default): `src/execution/native.ts` spawns host engine processes with realpath-checked cwd boundaries, explicit env allowlisting, byte-bounded output, process-tree termination and durable `execution.*` events; `src/execution/adapter.ts` wraps engine adapters so discovery/auth stay on the host while process creation is policy-gated.
- Container mode (legacy opt-in): `docker-exec.ts` spawns the engine through `docker exec -i`, passes env by `-e NAME` only (values never enter argv), rewrites host paths to container paths; the worker image pins engine versions (`sandbox/image.ts`, `PLUTON_ENGINES=1` build profile gates container dispatch).
- Approval mapping (`src/engines/approval.ts`): Muse `approval_mode` maps to engine session modes; anything the engine still asks is answered fail-closed (`deny`) except `autonomous-bounded` (`allow_once`). Known limitation recorded in that file: a denied action does not stall the turn, so a task can still record a syntactically "successful" no-op; denials are only visible as `approval.engine_decision` events and an empty diff. Engine permission requests in the ask-* modes now have an interactive operator channel: `src/engines/interactive-approval.ts` mints a durable approval per request (surfaced in the TUI inbox and the SPA approval banner) and resolves fail-closed `deny` when no decision can be recorded.

## 7. Tool bridge and security boundaries

- Restricted catalog (`src/tools/catalog.ts`): 13 tools — `task.create`, `task.delegate`, `task.inspect`, `task.wait`, `task.get_result`, `task.cancel`, `scope.declare`, `scope.release`, `muse.propose_create`, `approval.request`, `diff.inspect`, `project.read`, `run.stop`. Each has a strict Zod schema, one authorizing permission, and a mutating flag; JSON Schemas are exported for MCP `tools/list`.
- Per-call authorization (`src/tools/bridge.ts`): caller identity, permission, run graph state, budgets, pending-approval caps, path containment (realpath-checked), dependency/lockfile rules, terminal-delegation rejection.
- Transports: MCP stdio server (`mcp-server.ts`, protocol 2024-11-05; `pluton mcp serve`) and an HTTP transport with per-session bearer tokens (`http-transport.ts`); containerized engines reach it via the host gateway, while native engines use a loopback-only binding.
- Operator (chat) tools (`src/tools/operator-catalog.ts`): `project.status`, `run.list`, `run.get`, `run.start`, `approvals.list` (per ROADMAP §chat slice).
- Sandbox (`src/sandbox/`): non-root, `--cap-drop ALL`, `no-new-privileges`, CPU/memory/PID limits, bounded noexec tmpfs, mount allowlist, env allowlist, Pluton-owned labels, label-guarded stop; Docker unavailable fails closed with the exact fix. `network_policy: restricted` is a bridge with DNS, **not an egress filter** (documented in `docs/SECURITY.md` / ADR-0004).
- Workspaces: per-task clones under `.pluton/workspaces/`; the user's tree is never merged into; integration goes to `pluton/integration/<run>` (never main) with a protected-path approval gate (`src/workspace/`, ADR-0009).
- Terminals: Docker mode uses one tmux session per Muse inside its container and resolves the exact `docker exec -it` argv; native mode uses host tmux (`src/terminal/native.ts`) and returns `tmux attach-session` argv, failing closed with an actionable error when host tmux is absent.

## 8. Presentation layer (TUI 2.0)

Per ADR-0013 (Accepted 2026-10-18) and `docs/tui-refinement-report.md`:

- `src/tui/` primitives: alternate-screen lifecycle, responsive layout engine (two-column ≥120×30, inspector toggle, small-terminal warning), theme tokens (muted violet `\x1b[38;5;141m` + cool cyan), zero-dependency markdown/code formatting, ANSI sanitization of untrusted output, tool-activity lines with durations, boxed approval cards (`[A]`/`[D]`/`[V]`), orchestra inspector (Muses, task graph, approvals, recent events).
- `src/ui/` components: brand banner, header, transcript messages, result cards with diff coloring, tool cards, status bar, input box, approval card, theme, demo mode.
- 19 slash commands (`/help /status /runs /run /cancel /plan /sessions /doctor /permissions /models /model /approvals /approve /deny /new /inspector /clear /exit /quit`) with autocomplete and Levenshtein suggestions (`src/chat/commands.ts`).
- **Known deviation (verified):** the status bar computes context utilization and cost from hardcoded constants — `DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000` and `DEFAULT_COST_PER_MILLION_TOKENS = 2.0` (`src/chat/session.ts:71–72, 1045–1050`) — i.e. a displayed cost that no engine reported. This conflicts with the project's own "never fabricate" / honest-status conventions.

## 9. Interfaces today

CLI (all with `--json` envelopes): `init`, `doctor`, `muse` (list/show/create/edit, `model list`, `chat`), `engine list`, `sandbox` (probe/build-image), `status`, `task` (list/show), `graph`, `mcp serve`, `run`, `verify`, `chat`, `attach`, `integrate`, `approvals` (list/approve/deny).

Machine interfaces: the MCP tool bridge (engine-facing), the CLI JSON envelopes, and the local workspace app server (`src/server/`; launched by `pluton`/`pluton --browser`, managed with `--headless --detach`, `--status`, `--stop`). The server is loopback- and workspace-token-gated and serves the SPA plus best-effort live deltas derived from the durable log (`log-watcher.ts`); the durable event log stays the source of truth — see L11. There is **no SDK and no API gateway** (consistent with README positioning).

## 10. Verification and test infrastructure

- `npm run check` = `tsc -p tsconfig.json` + `vitest run`; baseline 2026-10-18: typecheck exit 0, 89 files / 762 tests passed (`docs/PLUTON_BASELINE_REPORT.md`).
- Gated Docker E2E (`PLUTON_E2E_DOCKER=1 npm run test:e2e`): 5/5 passed on this host (2026-10-18), skips cleanly without a daemon/image.
- Opt-in live engine suites (`PLUTON_LIVE_OPENCODE=1`, `PLUTON_LIVE_QWEN=1` with `npm run test:live`) — NOT RUN in this audit (per-Muse engine auth not configured; `pluton doctor` reports 6 auth warnings).
- Honesty conventions: README status banner, ADRs with statuses, `docs/ROADMAP.md` as the live status surface, "NOT RUN with a reproducible command" reporting.

## 11. Known limitations (verified, current)

Former limitation, now resolved (2026-10-19, change set `supervisor-ownership-race`): `runs.supervisor_pid` was written once and never read — every `RunSupervisor` entry point (`pluton run`, `--resume`, `approvals decide` auto-continue, `verify --dispatch`, HTTP resume, chat background runs) could construct a second supervisor for the same live run. Schema v7 + the atomic claim, renewed heartbeat and `SupervisorFence` gating (see §4 claim API and §5 supervisor-ownership paragraph) now refuse a second live owner and turn a stale owner read-only (`superseded`) with its duty writes atomically rejected; a second live owner is a clean `ConflictError`/HTTP 409. Two honest residuals remain: **(R1)** a hard-wedged stale owner cannot be forced to stop from its own side — its state writes are fenced, but its engine children may linger until the operator kills the process; **(R2)** the guarantee is per-statement atomic through one local SQLite database file, not a distributed-system protocol. (By-design boundary, not a residual: control-plane writers stay unfenced — see §5.)

| # | Limitation | Evidence |
|---|---|---|
| L1 | Usage budgets are opt-in and off unless configured (`runtime.max_*`); absent = no limit | `config/schema.ts:73–82`; `orchestrator/run-setup.ts:42–52`; `run.ts:330,350` |
| L2 | TUI context %/cost are estimates from hardcoded constants | `chat/session.ts:71–72, 1045–1050` |
| L3 | `runtime.max_retries_per_task` (config default 1) is not passed to the supervisor (effective default 2) | `config/schema.ts:54`; `supervisor.ts:227`; `run.ts:261–306` |
| L4 | No transport-level retry/backoff for engine spawn/handshake | grep: no `retry`/`backoff`/`jitter` in `src/engines/` |
| L5 | No session-log projection/query surface (no FTS, no read models) | grep: no `FTS5`/`projection` in `src/`; `store.ts` only offers `eventsSince`/`listEvents` |
| L6 | Engine permission requests are only interactively approvable in the ask-* modes; auto-answered modes can still surface a denial as a no-op success | `engines/approval.ts`; `engines/interactive-approval.ts` |
| L7 | `restricted` network policy is not an egress filter | `docs/SECURITY.md`; ADR-0004 |
| L8 | No automatic restart reconciliation/replay (by policy; acceptance suite not implemented) | ADR-0006; `implementation-decisions.md` A2/A4 |
| L9 | No SDK and no API gateway; the machine surfaces are the MCP bridge, the CLI JSON envelopes, and the loopback/token-gated workspace app server (`src/server/`) | `src/server/`; directory inventory |
| L10 | Attach `-it` interactive leg NOT RUN (no real TTY in harness); live engine suites opt-in | `docs/ROADMAP.md`; this audit |
| L11 | SPA orchestration frames are best-effort live deltas derived from the durable log (which stays authoritative); an approval decided out-of-process leaves the banner/badge stale until the next refresh | `src/server/log-watcher.ts`; `src/server/static-assets.ts` |

## 12. ADR index

| ADR | Topic |
|---|---|
| 0001 | Language, runtime, packaging |
| 0002 | SQLite driver and migrations |
| 0003 | Engine adapter protocol |
| 0004 | Sandbox/container model |
| 0005 | Checkout and terminal lifecycle |
| 0006 | Task persistence and idempotency |
| 0007 | Dynamic delegation policy |
| 0008 | Model auth and secret storage |
| 0009 | Git integration and merge strategy |
| 0010 | Windows/WSL2 boundary |
| 0011 | Independence, licensing, reuse |
| 0012 | Interactive chat TUI |
| 0013 | TUI 2.0 agentic terminal architecture (Accepted) |
