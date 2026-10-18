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
7. Usage events (`inputTokens`/`outputTokens`/`costUsd`) are absorbed by `UsageLedger.record`; overrun triggers `session.interrupt()`. **The ledger is currently constructed with no limits and config cannot express them** (`supervisor.ts:226`, `run.ts:261–306`, `schema.ts` has no token/cost fields) — see the parity doc gap table.
8. `pluton verify` runs configured checks (argv-only, allow-listed, bounded) and closes tasks/runs only from durable verdicts (`src/verify/runner.ts`).

Restart behavior: state is durable, but there is no automatic re-dispatch; the recorded policy is "an interrupted or externally-uncertain action is never auto-replayed" (ADR-0006; `implementation-decisions.md` A2/A4 status: decided, acceptance suite not yet implemented).

## 6. Engine layer

- Contract (`src/engines/contract/types.ts`): `EngineAdapter` (capabilities, discover, listModels, authStatus, startSession) and `EngineSession` (sendPrompt → normalized `EngineEvent` stream, interrupt, close). Events: `status`, `text`, `tool`, `approval_request`, `usage`, `result {success|failure|cancelled|unknown}`, `error`. Capabilities: `resumeSession`, `interrupt`, `approvals`, `usage`, `modelList`, `mcpServers`, `sessionExport`; conservative defaults; unsupported features must raise capability errors, never fabricate.
- ACP transport (`src/engines/acp/client.ts`): in-repo newline-delimited JSON-RPC 2.0 over stdio; 60 s default control-request timeout; 4 MB max frame; max 64 pending; bounded stderr tail; malformed frames are fatal to the connection; request timeouts reject that request only. No retry/backoff policy exists anywhere in `src/engines/` (verified grep).
- Adapters: `opencode` (live-verified v2.0.29; model pinning, `session/load` resume, approvals, usage), `qwen` (v0.25.2; session modes, composite model values, unknown server requests refused `-32601`, auth mapping `-32000`), `mock` (tests/dev only). Fixture-replay conformance suites in `tests/unit` and `tests/fixtures/`.
- Container mode: `docker-exec.ts` spawns the engine through `docker exec -i`, passes env by `-e NAME` only (values never enter argv), rewrites host paths to container paths; the worker image pins engine versions (`sandbox/image.ts`, `PLUTON_ENGINES=1` build profile gates container dispatch).
- Approval mapping (`src/engines/approval.ts`): Muse `approval_mode` maps to engine session modes; anything the engine still asks is answered fail-closed (`deny`) except `autonomous-bounded` (`allow_once`). Known limitation recorded in that file: a denied action does not stall the turn, so a task can still record a syntactically "successful" no-op; denials are only visible as `approval.engine_decision` events and an empty diff. No interactive operator channel for engine permission requests exists yet (ROADMAP named follow-up).

## 7. Tool bridge and security boundaries

- Restricted catalog (`src/tools/catalog.ts`): 13 tools — `task.create`, `task.delegate`, `task.inspect`, `task.wait`, `task.get_result`, `task.cancel`, `scope.declare`, `scope.release`, `muse.propose_create`, `approval.request`, `diff.inspect`, `project.read`, `run.stop`. Each has a strict Zod schema, one authorizing permission, and a mutating flag; JSON Schemas are exported for MCP `tools/list`.
- Per-call authorization (`src/tools/bridge.ts`): caller identity, permission, run graph state, budgets, pending-approval caps, path containment (realpath-checked), dependency/lockfile rules, terminal-delegation rejection.
- Transports: MCP stdio server (`mcp-server.ts`, protocol 2024-11-05; `pluton mcp serve`) and an HTTP transport with per-session bearer tokens (`http-transport.ts`) used by containerized engines via the host gateway.
- Operator (chat) tools (`src/tools/operator-catalog.ts`): `project.status`, `run.list`, `run.get`, `run.start`, `approvals.list` (per ROADMAP §chat slice).
- Sandbox (`src/sandbox/`): non-root, `--cap-drop ALL`, `no-new-privileges`, CPU/memory/PID limits, bounded noexec tmpfs, mount allowlist, env allowlist, Pluton-owned labels, label-guarded stop; Docker unavailable fails closed with the exact fix. `network_policy: restricted` is a bridge with DNS, **not an egress filter** (documented in `docs/SECURITY.md` / ADR-0004).
- Workspaces: per-task clones under `.pluton/workspaces/`; the user's tree is never merged into; integration goes to `pluton/integration/<run>` (never main) with a protected-path approval gate (`src/workspace/`, ADR-0009).
- Terminals: one tmux session per Muse inside its container; `pluton attach` resolves and returns the exact `docker exec -it` argv; native-Windows tmux deliberately unsupported (ADR-0010).

## 8. Presentation layer (TUI 2.0)

Per ADR-0013 (Accepted 2026-10-18) and `docs/tui-refinement-report.md`:

- `src/tui/` primitives: alternate-screen lifecycle, responsive layout engine (two-column ≥120×30, inspector toggle, small-terminal warning), theme tokens (muted violet `\x1b[38;5;141m` + cool cyan), zero-dependency markdown/code formatting, ANSI sanitization of untrusted output, tool-activity lines with durations, boxed approval cards (`[A]`/`[D]`/`[V]`), orchestra inspector (Muses, task graph, approvals, recent events).
- `src/ui/` components: brand banner, header, transcript messages, result cards with diff coloring, tool cards, status bar, input box, approval card, theme, demo mode.
- 19 slash commands (`/help /status /runs /run /cancel /plan /sessions /doctor /permissions /models /model /approvals /approve /deny /new /inspector /clear /exit /quit`) with autocomplete and Levenshtein suggestions (`src/chat/commands.ts`).
- **Known deviation (verified):** the status bar computes context utilization and cost from hardcoded constants — `DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000` and `DEFAULT_COST_PER_MILLION_TOKENS = 2.0` (`src/chat/session.ts:71–72, 1045–1050`) — i.e. a displayed cost that no engine reported. This conflicts with the project's own "never fabricate" / honest-status conventions.

## 9. Interfaces today

CLI (all with `--json` envelopes): `init`, `doctor`, `muse` (list/show/create/edit, `model list`, `chat`), `engine list`, `sandbox` (probe/build-image), `status`, `task` (list/show), `graph`, `mcp serve`, `run`, `verify`, `chat`, `attach`, `integrate`, `approvals` (list/approve/deny).

Machine interfaces: the MCP tool bridge (engine-facing) and the CLI JSON envelopes. There is **no web UI, no HTTP API beyond the tool bridge, and no SDK** (verified by directory inventory; consistent with README positioning).

## 10. Verification and test infrastructure

- `npm run check` = `tsc -p tsconfig.json` + `vitest run`; baseline 2026-10-18: typecheck exit 0, 89 files / 762 tests passed (`docs/PLUTON_BASELINE_REPORT.md`).
- Gated Docker E2E (`PLUTON_E2E_DOCKER=1 npm run test:e2e`): 5/5 passed on this host (2026-10-18), skips cleanly without a daemon/image.
- Opt-in live engine suites (`PLUTON_LIVE_OPENCODE=1`, `PLUTON_LIVE_QWEN=1` with `npm run test:live`) — NOT RUN in this audit (per-Muse engine auth not configured; `pluton doctor` reports 6 auth warnings).
- Honesty conventions: README status banner, ADRs with statuses, `docs/ROADMAP.md` as the live status surface, "NOT RUN with a reproducible command" reporting.

## 11. Known limitations (verified, current)

| # | Limitation | Evidence |
|---|---|---|
| L1 | Usage budgets are dormant in real runs (ledger built with `undefined` limits; config has no token/cost fields) | `supervisor.ts:226`; `run.ts:261–306`; `config/schema.ts` |
| L2 | TUI context %/cost are estimates from hardcoded constants | `chat/session.ts:71–72, 1045–1050` |
| L3 | `runtime.max_retries_per_task` (config default 1) is not passed to the supervisor (effective default 2) | `config/schema.ts:54`; `supervisor.ts:227`; `run.ts:261–306` |
| L4 | No transport-level retry/backoff for engine spawn/handshake | grep: no `retry`/`backoff`/`jitter` in `src/engines/` |
| L5 | No session-log projection/query surface (no FTS, no read models) | grep: no `FTS5`/`projection` in `src/`; `store.ts` only offers `eventsSince`/`listEvents` |
| L6 | Engine permission requests have no interactive operator channel; denials can surface as no-op successes | `engines/approval.ts:24–37`; ROADMAP named follow-up |
| L7 | `restricted` network policy is not an egress filter | `docs/SECURITY.md`; ADR-0004 |
| L8 | No automatic restart reconciliation/replay (by policy; acceptance suite not implemented) | ADR-0006; `implementation-decisions.md` A2/A4 |
| L9 | No web UI/SDK/API gateway; MCP bridge is the only machine integration | directory inventory |
| L10 | Attach `-it` interactive leg NOT RUN (no real TTY in harness); live engine suites opt-in | `docs/ROADMAP.md`; this audit |

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
