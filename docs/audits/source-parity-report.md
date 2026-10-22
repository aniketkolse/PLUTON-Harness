# PLUTON-Harness ↔ DeepSeek Harness (`dsh`) — Source Parity Report

> **Historical audit snapshot (2026-10-21; engine note 2026-10-22):** Qwen Code support was
> removed after this audit. Adapter lists, fixture paths, test counts and Qwen references below are
> as of the audit date; some of those files no longer exist. They are historical evidence, not
> current support or setup instructions. OpenCode is the only supported real engine.

- **Audit type:** read-only architectural and feature-parity audit. No source files were modified; the only artifact produced by this audit is this report.
- **Repository:** `aniketkolse/PLUTON-Harness` at HEAD `595e8b6588e6deae6962c7efa40a6e09eada3ef5` (`595e8b6`), working tree clean except five pre-existing untracked files (`docs/audit-*.png`).
- **Audit date:** 2026-10-21. Platform: win32. Node `v24.20.0`, npm `10.9.9`, git `2.56.0.windows.2`.
- **Reference corpus:** the four reverse-engineering volumes of DeepSeek Harness (`dsh` v0.2.1-rc.2), read end-to-end for this audit (see §2).

---

## 1. Executive verdict

**PLUTON is an orchestration control plane, not a re-implementation of the `dsh` agent kernel — and that is exactly what this audit's evidence shows.**

1. **Where dsh has an equivalent capability, PLUTON matches structurally** (loopback token-authenticated server + event streaming, durable monotonic event log with a cursor API, fail-closed approvals with expiry, plan records, mid-session model switching, crash recovery at both session and run/ownership level, MCP stdio integration, hardened git checkout lifecycle). 21 of the matrix's 64 comparable rows grade `MATCHES`.
2. **Where PLUTON covers the same intent at reduced scope, it grades `PARTIAL`** (27 rows): the web UI, wire protocol, auth persistence, engine/provider layering, projections, delegation steering, and sandbox filesystem policy are genuinely present but implemented differently or narrower than dsh's versions.
3. **Several dsh runtime capabilities are absent (15 `MISSING` rows)** — plugin kernel/HMR/market, SDKs, FTS session search, attachments, compaction, web search/fetch, LSP, skills catalog, PTC/workflow engine, telemetry, i18n — and, importantly, the repo's own ADRs record most of these absences as *deliberate non-goals* (ADR-0011 independence, `PLUTON_IMPLEMENTATION_ROADMAP.md` non-goals: "dsh capabilities with no demonstrated Pluton need").
4. **PLUTON-only strengths have no dsh analog at all**: the durable task graph with admission budgets, file leases, supervisor ownership leases with stale takeover, the Phase-7 verification gate, `verify`/`integrate` with CS-6 overlap detection and protected-path approvals, QA question cards, and the tmux attach/doctor/tooling surface. These are the fulfillment of PLUTON's stated orchestration purpose and must not be traded away in pursuit of dsh parity.
5. **Verdict:** architectural kinship is high (same family of local-first, loopback, event-driven harness); behavioral parity is neither established nor attempted — `dsh` runs arbitrary agents on a plugin kernel with per-call sandboxing and model-owned tool surfaces, while PLUTON supervises durable multi-muse runs of external engines with a verification and integration pipeline. **Architectural similarity between the two does not prove behavioral parity** (§10).

Status distribution across the 64 capacity-anchored matrix rows in §5: **21 MATCHES · 27 PARTIAL · 15 MISSING · 1 UNVERIFIED**; behavior-level items that could not be verified without gated execution are additionally ledgered in §8.3.

---

## 2. Reference corpus availability

The reference set specified by the task is `Y:\Setup\REA deepseek\`:

| Document | Status | Lines (read in full) |
|---|---|---|
| `01-kernel-and-composition.md` | Read fully | 366 |
| `02-agent-session-persistence.md` | Read fully | 363 |
| `03-model-tools-capabilities.md` | Read fully | 47.2 KB / 553 |
| `04-interfaces-delivery-reference.md` | Read fully | 48.4 KB / 523 |
| **`REA.txt`** | **NOT FOUND anywhere** | — |

`REA.txt` was searched for recursively in the repository (including `references/`, `docs/**`, `graphify-out/raw`), the user profile, Downloads/Documents/Desktop, and the `Y:\` drive root at depth 4, plus `C:\Users\Asus\.config\opencode`. It does not exist. The repo's own earlier parity audit reached the same conclusion independently (`docs/PLUTON_FEATURE_PARITY.md:6`, baseline `main@506fa72`: "**REA.txt: NOT FOUND.** … if REA.txt exists elsewhere it should be supplied and this matrix re-validated."). The four numbered volumes are self-contained for feature-level claims; composition-kernel internals that would have lived in `REA.txt` remain unavailable, and matrix rows that would depend on them are marked accordingly.

Throughout this report: **`dsh §nn`** refers to the numbered chapters of the four volumes (01–06 = kernel/composition in vol. 01; 07–12 = agent core/session/persistence in vol. 02; 13–22 = model/tools/capabilities in vol. 03; 23–32 = interfaces/delivery/reference in vol. 04).

---

## 3. Evidence method and classification

Every finding is anchored to one or more of:

- **S — source fact:** read directly in the reference volumes (`dsh §`).
- **R — repository fact:** read directly in repo source/config/docs at `595e8b6` (exact path cited).
- **T — test evidence:** a test file that exercises the capability in the default suite (`npm test`), with the decisive test title quoted from the file. All default-suite tests referenced below passed in the run recorded in §4.
- **U — unverified:** a plausible-but-unproven behavioral claim, listed in §8.3 rather than asserted as fact.
- Absence claims ("no X exists") are **R-class**: based on the module inventory (two thorough read-only explorations of `src/`, `tests/`, `scripts/`, `docs/`) plus targeted case-insensitive name searches over `src/**/*.ts` executed for this audit (commands and results in §4). They are scoped to "no implementation surface found by inventory + name search", not proof of intent.

Status legend used in the matrix:

- `MATCHES` — comparable capability implemented and covered by tests in the default suite; parity at structure level.
- `PARTIAL` — same intent present, but divergent implementation or reduced scope (not a defect claim — §7 explains the deliberate divergences).
- `MISSING` — dsh capability with no PLUTON implementation surface.
- `UNVERIFIED` — implementation exists, but the behavior claim could not be evidenced without gated/out-of-scope execution (listed with exact gating).

---

## 4. Verification record at HEAD `595e8b6`

All commands run from `Y:\Pluton`, win32:

| # | Command | Exit | Evidence |
|---|---|---|---|
| 1 | `git rev-parse HEAD` | 0 | `595e8b6588e6deae6962c7efa40a6e09eada3ef5` |
| 2 | `git status --porcelain` (before and after full suite) | 0 | Only `?? docs/audit-{1200px,1920px,420px,420px-settings,820px}.png`; no tracked-file modifications |
| 3 | `node --version` / `npm --version` | 0 | `v24.20.0` / `10.9.9` |
| 4 | `npm run typecheck` (`tsc -p tsconfig.json`) | 0 | — |
| 5 | `npm run verify:assets` (`node scripts/verify-assets.mjs`) | 0 | "verify-assets: 60 checks passed" |
| 6 | `npx vitest run --reporter=json --outputFile=<temp>\vitest-parity-results.json` | 0 | `numTotalTests: 1153, numPassedTests: 1153, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0`, success: true; all suites green |
| 7 | `npm run build` (`tsc -p tsconfig.build.json`) | 0 | — |
| 8 | `node src/cli/main.ts doctor --json` | 0 | ok; summary 12 pass / 7 warn / 0 fail (warns = per-Muse engine auth "not configured", benign for the configured free-flow models per the doctor fix hints; Docker 29.8.2 daemon up; worker image `pluton-worker:local` matches recorded build `sha256:2e2c871eeb11…`; tmux 3.3a in image; opencode engine v2.1.2 present) |

Not executed in this audit (gated suites, deliberately out of scope for a read-only audit — their gating is documented in the configs, not inferred):

- `npm run test:e2e` (`vitest.e2e.config.ts`) — requires `PLUTON_E2E_DOCKER=1` + worker image; `tests/e2e/linux-bind-mount.e2e.test.ts:39-40` additionally requires `process.platform === 'linux'` + non-root. The default suite excludes `tests/e2e/*.e2e.test.ts` and `tests/live/**` (`vitest.config.ts`), except `ship-workers-e2e`, whose filename (`ship-workers-e2e.test.ts`) matches the default glob `tests/**/*.test.ts` and therefore runs on all platforms.
- `npm run test:live` (`vitest.live.config.ts`) — requires `PLUTON_LIVE_OPENCODE=1` / `PLUTON_LIVE_QWEN=1` (real binaries, real models, real network).
- `npm run release:check`, `npm run smoke:package` (release-time steps; `release-check.mjs` itself declares the prod dependency audit NOT TESTED offline and the POSIX 0600 check NOT TESTED on Windows).

Platform-gated tests inside the default suite (recorded for skip accounting; the recorded run had **0 runtime skips**, because these gates resolved to "run" on this host):

- `tests/e2e/linux-bind-mount.e2e.test.ts:39-40` — Linux/docker-gated (`describe.skip` otherwise) — did not run here (e2e config).
- `tests/live/opencode.live.test.ts:25`, `tests/live/qwen.live.test.ts:44` — env-gated.
- `tests/unit/workspace.test.ts:379` — `it.runIf(process.platform === 'win32')` (ran on this host).
- `tests/unit/tool-bridge.test.ts:1029-1032` — win32-only junction branch (`ctx.skip()` otherwise).
- False-positive skip strings (`it.skip('processes payment')`) inside `tests/unit/independent-verifier.test.ts:33/41/89` and `tests/integration/multi-agent-reliability.test.ts:122` are fixture payloads for tamper detection, not real skips.

Absence searches run for this audit (R-class evidence), all case-insensitive over `src/**/*.ts`:

| Search | Result |
|---|---|
| `fts|fulltext` | No full-text session query (only incidental `sidebar`/`localeCompare` matches) |
| `compaction|summariz` | Only unrelated `summarize*` helper functions — no history-compaction feature |
| `web_search|web_fetch|webSearch|webFetch|search_web|fetch_url` | No matches |
| `electron|cookie|telemetry|otel|i18n|locale` | Only incidental matches: `localeCompare` sorts; `cookie` appears solely as a sensitive *key name* in `src/util/redact.ts:10`; `src/chat/session.ts:1051` comment "Real telemetry only (G5 / PR-2): no engine reports a context window, so …" |
| `spill|attach_file|attachments?/v1|SKILL\.md` | No matches |
| `plugin|workflow|ptc|run_code` | Only incidental matches (`plans` table comment; a TUI demo fixture string) |
| `sessionStorage|localStorage` (SPA `static-assets.ts`) | `pluton_token` in `sessionStorage` only (lines 1799–1801) |

---

## 5. Feature-by-facility matrix

Columns: **dsh** = source section evidence (S); **repo** = repository evidence (R); **tests** = default-suite evidence (T). Statuses per §3.

### A — Product shell & interfaces

| # | Capability | dsh (source) | PLUTON (repo) | Tests | Status |
|---|---|---|---|---|---|
| A1 | CLI command surface & JSON mode | dsh §26: commander CLI, headless one-shot (`dsh headless`), stdout diagnostics | `src/cli/main.ts`: ~20 commands (`app/doctor/init/muse group/engine list/sandbox/status/task/graph/mcp/verify/run/chat/attach/integrate/workspace/approvals/version`), global `--json` with `{ok,data}|{ok,error}` envelope, `--demo` TUI, root invocations `pluton [targetPath]` | `cli-run(8)`, `cli-status(8)`, `bare-entry(2)`, `config(14)`, `init-templates(2)` | **MATCHES** |
| A2 | Web UI: chat, runs/tasks, approvals, settings, file explorer | dsh §23 (host + ~55 `ui-*` plugins: chat, tool cards, approvals, jobs, schedule, subagent panel, directory picker, open-in-app …) | `src/server/static-assets.ts` (4,656-line zero-dependency SPA): streaming chat + transcript replay, orchestra DAG view, task inspector, approvals + QA card, settings (models/permissions/thinking/MCP), file explorer, diff viewer, usage display | `spa-ui(27)`, `ui-visual-acceptance(4)`, `scripts/verify-assets.mjs` (60 checks) | **PARTIAL** — feature subset; no plugin inventory/market, no terminal sidebar, no document preview, no i18n |
| A3 | Event wire (SSE/streams, generations, replay) | dsh §23: unary `POST /api` + `/api/remote.mux` WS, `$events` baseline with generations, atomic event-window replacement, gap repair via `page()` | `src/server/events.ts` `ServerEventBroadcaster` (SSE, 15s heartbeats, sanitized payloads w/ caps 4000/7000), `routes.ts` REST + SSE `GET /api/events`, `log-watcher.ts` CS-8: cursor = `latestEventSeq` at connect, history not replayed; SPA replays transcript from durable store | `server-log-watcher(11)`, `worker-events-stream(7)` ("redacts secrets and bounds long string buffers in payload"), `server-api(12)` | **PARTIAL** — REST+SSE, no WS mux/generations/reconnect gap-repair; reconnection gap-continuity is U-class (§8.2) |
| A4 | Auth model | dsh §23: launch-token `?token=` on `GET /` → signed `HttpOnly` cookie ~30d; Host/Origin/DNS-rebinding checks; 401/403 semantics | `src/server/security.ts`: 32-byte hex token, `timingSafeEqual`, `X-Pluton-Token` header **or** `?token=`, loopback-only bind, origin/host anti-rebind validation, traversal guards; SPA keeps token in `sessionStorage` (static-assets.ts:1799–1801); no cookie persistence | `server-security(5)`, `server-api` ("serves static frontend assets without token over loopback") | **PARTIAL** — same defense family; no signed-cookie persistence or credentials file (`$DSH_HOME/.credentials.yaml` analog) |
| A5 | Desktop application | dsh §24: Electron main → desktop-host child (`ELECTRON_RUN_AS_NODE`), `dsh-app://` custom protocol, ASAR-bundled runtime, single-instance lock | `src/desktop/launcher.ts`: Chromium app-mode (`--app=<url>`) preferring Edge/Chrome, browser fallback; ADR-0014 dual desktop/browser architecture; ADR-0015 Tier-1 app-mode (authoritative) + Tier-2 future Tauri v2, explicit non-Electron reasons | `desktop-launcher(6)`, `app-lifecycle(12)` | **PARTIAL** — dedicated-window UX delivered by launcher; no packaged/signable installer; deliberate (ADR-0015) |
| A6 | Single-instance / loopback hosting discipline | dsh §24: single-instance lock; reserved profile home | `src/server/instance.ts`: `.pluton/run/server.json` + mutex `server.claim`, PID recycling defense ("refuses to signal a recycled PID from a stale instance file on `--stop`"), health check with token+rootDir validation | `app-lifecycle(12)`, `server-api` | **MATCHES** |
| A7 | SDK surfaces (TS/Python JSON-RPC on stdio; ACP server; runtime wheel) | dsh §25 | None. Distribution surface = CLI (`bin/pluton.js`) JSON mode + REST/SSE server + `pluton mcp serve` (stdio MCP) | `mcp-server(27)`, `bare-entry(2)` | **MISSING** |
| A8 | Config surface | dsh §01/§05/§18: profiles/bundles/patches, Schemastery cards, settings edit via profile patches, stale-write refusal | `src/config/schema.ts` zod v4 strict schema (runtime limits, sandbox, git, muses roles w/ workspace_policy/permissions/approval_mode; superRefine team rules), `src/config/load.ts` (version guard, path containment `assertInside`), `templates/teams/*.yaml` + `templates/roles/*.md` for `pluton init`; settings via `GET/POST /api/settings` | `config(14)`, `init-templates(2)`, `server-api` ("manages runtime settings…") | **PARTIAL** — typed config + validation present; no profile/patch composition system, no live plugin config cards |
| A9 | i18n / locale machinery | dsh §23: typed `ctx.locale` dictionaries, verify gates | None (name-search §4) | — | **MISSING** |
| A10 | Launch-time environment validation (doctor) | dsh §01 `auditStartupEntries` demands core plugins present | `pluton doctor`: node/WSL2/docker/git/config/storage/engine/sandbox/image/tmux/disk checks | `doctor` run recorded §4 (12 pass / 7 warn / 0 fail) | **MATCHES** |

### B — Agent core, session, persistence

| # | Capability | dsh (source) | PLUTON (repo) | Tests | Status |
|---|---|---|---|---|---|
| B1 | Agent loop: turns, streaming, settlement | dsh §08 turn/step machine, inbox, waterfalls, parallel tool calls | PLUTON delegates the loop to the engine (ACP `session-base.ts` streams engine turns); supervisor-side turn lifecycle = `turn_start/turn_end` SSE, `POST /api/sessions/:id/prompt` (202 fire-and-forget), engine result normalization (`acp/normalize.ts` `summarizePromptResult`) | `acp-session-turn(2)`, `acp-normalize-tool(2)`, `supervisor` streaming tests ("leaves finalSummary honest-null for a successful turn that streamed no answer") | **PARTIAL** — the turn/step machinery lives inside engine ACP agents, not the harness |
| B2 | Session persistence & resume | dsh §09/§10: append-only JSONL, zstd frames, flock, sealed generations, `resume_session` | `store.ts` + migrations: `chat_sessions` (native_session_id, resume_token, engine_session_id) + `chat_messages` (unique session+seq) v3; `pluton run --resume <id>`; chat `--resume/--continue` | `chat-store(12)` ("migrates a fresh database to v3", "appendChatMessage assigns monotonic per-session seqs"), `chat-session(7)` ("resumes previous session: passes resumeToken…") | **PARTIAL** — durable + resumable, different storage model (SQLite rows vs JSONL generations); no byte-stable export |
| B3 | Durable event log w/ monotonic sequence & idempotency | dsh §09: model-visible ⟺ logged; durable tool/call↔result pairing | `events` table (autoincrement seq) + `receipts` idempotency (migration v1); `appendEvent` on the SSE persist path; redaction applied **before** persistence (`events.ts` via `redactDeep`+`stripControlDeep`+caps) | `store(44)`, `store-ownership(22)`, redaction tests (`redact-prose(7)`, `sanitize(3)`) | **MATCHES** |
| B4 | Projection/snapshot seam | dsh §11: named projections (`tokenUsage`, `contextPressure`, todos, …) + client snapshot crop | Derived views implemented directly: log-watcher collapses `task.*` event bursts into single `task_state` frames; `listRuns/listTasks`; store cursor reads (`eventsSince`, `latestEventSeq`); no named-projection registry or versioned viewSchema crop | `server-log-watcher(11)` ("maps task.* events to a single task_state frame", "collapses a burst for one entity into one frame") | **PARTIAL** |
| B5 | Session search / full-text query | dsh §11: FTS5 `session-query` SQLite with predictions/budgets | Nothing (grep §4) | — | **MISSING** |
| B6 | Planning surfaces | dsh §22 plan-mode (durable `plan/mode` event, `exit_plan_mode`, acceptance at pre-step) | `plans` table (v4) + `/plan` chat command + manager planning in `src/orchestrator/plan/manager.ts`; plan rows carry goal/tasks/run linkage | `plan-manager(5)`, `plan-domain(9)`, `plan-store(2)`, `cli-chat` `/plan` coverage, `cli-chat-slash-expanded(2)` | **MATCHES** |
| B7 | Slash-command surface in chat | dsh §23 commands/input-trigger (`/compact`, `/permission`, `/schedule`, …) | `src/chat/commands.ts`: `/help /status /runs /run /cancel /plan /sessions /doctor /permissions /approve /deny /models /model /approvals` (+ more) | `chat-commands(9)`, `chat-commands-expanded(6)`, `chat-commands-model(5)` | **PARTIAL** — operational subset; no compaction/schedule/goal commands |
| B8 | Mid-session model switching | dsh §13/§14 configurable providers + model discovery; settings UI | `ChatSession.switchModel` (restarts engine session w/ pinned model), `POST /api/muses/:id/model` → `store.updateMuseModel` + cascade to coder/worker muses; `/api/models` per-engine availability; `applyModel` refuses silent substitution | `chat-session-switch-model(1)`, `cli-chat-model-slash(2)`, `opencode-model-validation(8)` | **MATCHES** |
| B9 | Crash / unclean-kill recovery | dsh §10 repair consumer (bounded interrupted-turn closure); §24 profile locks | Run-level: supervisor ownership leases (`supervisor_token`/`supervisor_heartbeat_at`, v7) + stale takeover + background-driver crash settlement (idempotent, never rewrites terminal state) | `supervisor-ownership(14)` ("a stale owner stops with a read-only superseded outcome…", "restart reconciliation takes over a stale ownership record"), `background-run-settle(4)` ("is idempotent and never rewrites an already-terminal run") | **MATCHES** |
| B10 | Live-stream vs durable-log relationship | dsh §09: full attempt stream embedded in durable `assistant/message` | Live SSE tokens are ephemeral; durable answer/result persisted once (incl. credential-prose redaction); no full partial-stream embedding or replayable envelope | `supervisor` ("persists a worker answer/result…", "redacts credential-looking prose out of persisted answers"), `chat-store` truncation test | **PARTIAL** |

### C — Model & engine layer

| # | Capability | dsh (source) | PLUTON (repo) | Tests | Status |
|---|---|---|---|---|---|
| C1 | Provider/model adapters | dsh §13/§14 adapter registry, DeepSeek Anthropic-compatible adapter, pi-ai multivendor routes, model-info normalization, attribution headers | Engine adapter contract (ADR-0003): `EngineCapabilities/Discovery/Model/AuthStatus/McpServerSpec/Session` in `src/engines/contract/types.ts`; ACP client stack (stdio JSON-RPC, retry options, spawn injection); adapters: `mock` (dev), `opencode` (verified vs v2.0.29; host doctor sees v2.1.2), `qwen` (verified vs v0.25.2); no claude/gemini | `engines(6)`, `opencode-adapter(33)`, `qwen-adapter(39)`, `acp-client(15)` | **PARTIAL** — providers owned by engine CLIs; harness has no own LLM stack (deliberate layering; no attribution headers/api-extension seams) |
| C2 | Retry / transport resilience | dsh §13 `llm-retry` (provider policies, jittered backoff, durable budget) | `src/engines/acp/retry.ts` transport retry options; spawn retry; per-call `AcpSpawnFn` injection; no durable cross-restart retry budget | `acp-retry(4)`, `transport-retry(3)` | **MATCHES** |
| C3 | Usage accounting & context pressure | dsh §13 token-meter (replay-aware, usage/breakdown/pressure projections), disjoint usage buckets | `usage` SSE event; usage budgets that **interrupt** at thresholds (`src/orchestrator/usage-ledger.ts`, run/muse token+cost caps in schema); honest no-estimates stance (G5/PR-2: `src/chat/session.ts:1051`); engines do not report context windows → no context-pressure projection | `usage-ledger(4)`, `supervisor-usage-budget(5)`, `tui-*` honest usage | **PARTIAL** |
| C4 | Approval gating for engine actions | dsh §18 one-shot `request(spec)`, answerer waterfall, fail-closed `unavailable⇒deny`, persisted ask/decide events | `src/engines/interactive-approval.ts` (`EnginePermissionChannel`: forwards ask-* modes to operator, fail-closed TTL expiry + cap; strips control escapes); `src/cli/commands/approvals.ts` list/decide + fail-closed expiry sweep; `POST /api/approvals/:id/decide`; auto-continue integration | `engine-interactive-approval(17)` ("expires the record and fails closed when the TTL runs out"), `engine-approval(12)`, `cli-approvals(17)` ("sweeps overdue pendings to expired (fail-closed)"), `approval-lifecycle(6)` | **MATCHES** |
| C5 | Structured ask-user questions | dsh §18 `ask_user_question` (confirm/choice/info, timed mode), `DELEGATED_CALLER` rejection | `qa.question` approval type with options/answer (SPA card + decide API + task unblocking), one-canonical-card rule | `qa-question-unblock(6)` ("POST /api/approvals/:id/decide accepts question options and unblocks tasks"), `qa-question-card(5)` | **MATCHES** |
| C6 | Credentials handling | dsh §18 credentials refs/records, precedence, versioned YAML vault, authorization OAuth flows | Per-Muse engine homes `.pluton/engine-homes/<slug>` (ADR-0008) isolating engine CLI auth; presence-only auth reporting (`authStatus.configured` never returns values); custom API keys server-memory only; `redact.ts` secret-key+prose filters | `engine-approval`, `server-api` ("custom AI models securely"), doctor auth checks | **PARTIAL** — isolation-first design; no harness-owned credential vault or OAuth flow registry |
| C7 | Model catalog & availability | dsh §13 configurable-provider directory + `discoverModels` | `engine.listModels` + `listModelsWithAvailability`; `SHIP_WORKER_MODELS` fallback; `/api/models`; no silent model substitution | `opencode-model-validation(8)` ("refuses silent substitution in applyModel when model is unavailable"), `server-api` | **MATCHES** |

### D — Tools, MCP & delegation

| # | Capability | dsh (source) | PLUTON (repo) | Tests | Status |
|---|---|---|---|---|---|
| D1 | Tool surface exposed to agents | dsh §15 tool registry w/ schema, permissions, presentation | `src/tools/catalog.ts` `TOOL_SCHEMAS` (14 orchestration tools: `task.create/delegate/inspect/wait/get_result/cancel/request_revision`, `scope.declare/release`, `muse.propose_create`, `approval.request`, `diff.inspect`, `project.read`, `run.stop`) + `TOOL_DEFS` permission+mutating metadata; handlers separated (`src/tools/handlers.ts`); operator catalog variant | `tool-bridge(50)`, `operator-bridge(7)`, `operator-bridge-settlement(5)` | **MATCHES** |
| D2 | Guarded execution pipeline per call | dsh §15: pre-execute waterfall (allow/deny/ask, fail-closed), deny-only monotonic guards, execute w/ deadline `TOOL_TIMEOUT`, post-execute accept/block, frozen result event, `UNKNOWN_TOOL` pre-policy | Per-call permission check + mutating flag + bounded result/payload caps + redaction before persist; fixed handler table; no waterfall hooks, no per-call timeout policy layer | `tool-bridge(50)`, `tool-http(7)` ("rejects requests without or with a wrong token") | **PARTIAL** |
| D3 | MCP integration | dsh §19: harness as MCP **client** (per-server plugins, `mcp__<server>__<tool>` naming, generational swap), MCP resources tools | PLUTON as MCP **server**: `pluton mcp serve --run --muse` exposes orchestration tools over stdio to a delegated engine session (`McpStdioServer`, bearer-token HTTP transport variant); engine contract passes `McpServerSpec`s to sessions (`acp-mcp-servers`); `GET /api/mcp` status | `mcp-server(27)` (handshake/gate/tools/errors/byte bounds), `cli-mcp-serve(3)` ("keeps stdout pure protocol"), `acp-mcp-servers(5)`, `spa-ui` ("MCP connection registry… reports a real (empty) registry") | **MATCHES** — MCP integrated at equivalent surface, with the client/server direction inverted (see §11) |
| D4 | Ingesting external MCP servers' tools into the harness | dsh §19 (client tools on `ctx.tools`, instructions into system prompt) | None in-repo (engines may attach their own MCP); no external server config surface beyond engine-provided specs | grep + inventory (§4) | **MISSING** |
| D5 | Subagent/delegation runtime | dsh §21: provider registry (spawn/fork/ACP/codex/claude-code/dsh-sdk), `send_message` steer/cold-resume, `interrupt`, defaults maxDepth 1 / maxActive 8 | Task-graph delegation: depth limit (`maxDelegationDepth=3`), child fan-out cap, admissibility checks; `task.request_revision` for in-flight course correction; selective pausing; no live-child steering channel or cold-resume of child agent state | `task-graph(9)` ("rejects depth beyond max_delegation_depth"…), `selective-pausing(5)` | **PARTIAL** |
| D6 | Background jobs & wakeups | dsh §22 `ctx.jobs` (session-fenced, first-wins settlement, output ring w/ cursors, completion delivery wakeup) | Run/task artifacts + `wakeups.ts` exactly-once wakeup registry driving the supervisor loop; bounded payloads (no per-job output ring w/ model read cursors) | `wakeups(10)` ("delivers each wakeup exactly once"), `supervisor` late-result tests | **PARTIAL** |
| D7 | Durable schedule (cron/at/every reminders) | dsh §22 `ctx.schedule` | None (grep §4) | — | **MISSING** |

### E — Execution & sandbox

| # | Capability | dsh (source) | PLUTON (repo) | Tests | Status |
|---|---|---|---|---|---|
| E1 | Sandbox model | dsh §17: per-call argv confinement, modes read-only/workspace-write/danger-full-access, fail-closed `SANDBOX_UNAVAILABLE`, bwrap→Landlock/Seatbelt/Windows-ACL backends | Whole-container durable sandbox per Muse (`src/sandbox/factory.ts` docker default; `local-process` refuses without explicit `sandbox.local_process_acknowledged: true`); container recreate-on-drift, managed-label guards, uid mapping, network_policy enforcement via docker networks | `sandbox(18)` ("refuses local-process without the explicit acknowledgement", "refuses to stop or remove a container without the Pluton managed label"), `muse-containers(10)`, `muse-network-policy(5)` | **PARTIAL** — inverted granularity: durable container instead of per-call confinement; no escalation ladder |
| E2 | Filesystem policy for workers | dsh §17 `fs-sandbox` workspaceRoot modes | Branch-per-task isolation: `GitWorkspaceManager` clones into `.pluton/workspaces`, `pluton/<run>/<slug>` branches, checkout markers, file **leases** with conflict detection | `workspace(25)`, `lease-manager(7)` ("detects and rejects overlapping file leases"), `protected-paths(9)` | **PARTIAL** — different mechanism (VCS isolation vs FS policy) |
| E3 | Shell/terminal execution for workers | dsh §16 shell/subprocess/terminals (PTY sessions) | Containerized tmux sessions pinned per Muse; `docker exec` spawn layer (ACP in-container mode); operator `pluton attach <muse> --window` to one tmux pane | `terminal(32)`, `attach(10)` ("builds the exact docker exec -it argv"), `docker-exec(9)`, `container-user-mapping(8)` | **MATCHES** |
| E4 | Windows boundary | dsh §17 Windows restricted-token runner (`enforcement: partial`) | ADR-0010: workers run in Linux containers via Docker Desktop/WSL2; local-process (Windows host) is dev-only, requires acknowledgement; win32-specific unit gates run here | `sandbox(18)` local-process ack tests, doctor WSL2 check, `LINUX_BIND_MOUNT_VALIDATION.md`; native-linux bind-mount E2E is **not run** here (§4) | **PARTIAL** — documented boundary + fail-safe configs; full runtime proof gated out |
| E5 | Protected paths / main-branch safety | dsh §17 writableRoots allow-list analog | `src/workspace/protected-paths.ts` anchored globs; integration writes to protected paths become **approvals**, never silent; `require_approval_for_main_branch_integration=true`; integration never touches main | `cli-integrate(22)` ("blocks a protected-path task behind a pending approval, then merges it once approved"), `protected-paths(9)` | **MATCHES** |

### F — Delegation robustness & orchestration (where dsh has an analog)

| # | Capability | dsh (source) | PLUTON (repo) | Tests | Status |
|---|---|---|---|---|---|
| F1 | Planning records / goal state | dsh §22 goals (event-sourced compare-and-set, rounds) | `plans` + run planning by supervisor Muse; plan→run handoff validated live | `plan-*`, `smoke-docker-plan-live(1)` ("validates plan creation, dependency constraints, approval invalidation, and execution handoff") | **MATCHES** |
| F2 | Delegation depth/fan-out limits | dsh §21 maxDepth 1 / maxActiveSubagents 8 | Durable admission-time budgets: depth 3, `max_child_tasks_per_task`, `max_tasks`, cycles/duplicate/cross-run-deps rejection — checked in one transaction before write | `task-graph(9)` ("detects dependency cycles in both directions", "gates readiness on dependency completion") | **MATCHES** |
| F3 | Concurrency discipline | dsh §08 `maxParallelToolCalls`; §21 active-children cap | `maxConcurrentWorkers` in-flight cap, per-Muse `KeyedMutex` ("serializes work on the same key"), file-lease `blocked_by_lease`, wakeup exactly-once | `supervisor(50)` ("serializes tasks assigned to the same Muse", "a repeated dispatch in the same tick cannot start a queued task twice"), `mutex(4)` | **MATCHES** |
| F4 | Failure handling & retries | dsh §13 `llm-retry` + request-error waterfall | Task-level `maxRetriesPerTask` + `CircuitBreaker` trip + manager-revision exception (`CS-5`), attempt caps terminalizing unknown outcomes (`T4`) | `supervisor(50)`, `circuit-breaker(3)` | **MATCHES** |
| F5 | Cancellation & steering | dsh §21 `interrupt` / `send_message` (steer running child injectively); §08 cancellation causes | Single cancel control plane (CS-9) for any source with intentional-drain racing; late results discarded; operator steering = `task.request_revision` + cancel + approvals; **no injecting messages into a running worker session's stream** | `supervisor(50)` ("interrupts the live session of a cancelled task on the next tick, discarding its late result") | **PARTIAL** |
| F6 | Crash-safety guarantees on durable artifacts | dsh §10 JSONL repair, §22 two-write `pendingMutation` markers, §24 locks | Ownership fences (`store-ownership`), `CAS` semantics on task/run mutations, first-wins settlement, idempotent crash settle, exactly-once wakeups | `store-ownership(22)` ("fence-gated mutations throw OwnershipLostError", "takes over only when the heartbeat has reached the cutoff"), `background-run-settle(4)` | **MATCHES** |
| F7 | Token/cost awareness & enforcement | dsh §13 token-meter measurement (no enforcement) | Usage budgets that **enforce** (interrupt at threshold) vs dsh measurement-only; no bucket-precise breakdowns/cache attribution | `usage-ledger(4)`, `supervisor-usage-budget(5)` | **PARTIAL** |

**Reverse direction (PLUTON-only; not graded vs dsh because dsh has no comparable analog):** Phase-7 verification gate (`verifying`→`completed` only via evidence-backed checks; `src/verify/runner.ts`; `verify(5)`, `independent-verifier(12)`, `verify-redispatch(4)`), `pluton integrate` with CS-6 cross-task overlap detection + dirty-commit landing + idempotent reruns (`cli-integrate(22)`, `workspace(25)`), durable file leases across competing tasks (`lease-manager(7)`), supervisor ownership takeover & read-only superseded outcomes (`supervisor-ownership(14)`), QA question-card task unblocking (`qa-question-unblock(6)`), operator tooling (`doctor/init/status/task list/graph/workspace clean` with marker-guarded deletion, `cli-workspace(10)`), engine-honesty registry ("dev-only engines are labeled", `engine list`), and a TUI (dsh ships **none** — verified, dsh §26).

### G — dsh-only runtime features

| # | Capability (dsh source) | PLUTON | Status |
|---|---|---|---|
| G1 | Attachments: image normalization + byte-exact files, verify-on-read, dedupe (§22) | None | **MISSING** |
| G2 | Compaction: pressure/overflow-triggered history replacement w/ durable shadow (§22); proof of no `compact` code (§4 grep) | Bounded caps + truncation markers only (`MAX_EVENT_TEXT_CHARS` 8k, task result caps, route body caps) | **MISSING** |
| G3 | Spill: oversized result preview+locator w/ private store (§22) | Caps only, no spill store/locator | **PARTIAL** |
| G4 | Web search/fetch w/ hardened outbound fetch (§16) | None; sandbox `network_policy='restricted'` is the only web posture | **MISSING** |
| G5 | LSP read-only language ops (§16) | None | **MISSING** |
| G6 | Skills: SKILL.md ranked catalogs, digest-driven injection, `/name` invocation (§16) | Static role instruction files (`.pluton/roles` + `templates/roles`); no catalog/digest mechanism | **PARTIAL** |
| G7 | PTC `run_code` + workflow engine scripts (§20) | None — documented non-goal (`PLUTON_IMPLEMENTATION_ROADMAP.md` §non-goals) | **MISSING** |
| G8 | Extension family: cordis introspection, dynamic plugin define/run w/ sandboxed host-half (§22) | None | **MISSING** |
| G9 | Plugin kernel: composition, profiles/bundles/patches, market, HMR, effect-undo (§01) | None — ADR-0011 (independence/licensing) restricts reuse; static adapter registry + commander instead | **MISSING** |
| G10 | todo/goal/schedule products (§22) | Plan records cover goal-shaped needs (F1); todo/schedule absent | **PARTIAL** (goal) — schedule counted `MISSING` at D7 |
| G11 | Identity (`anonymous-user-id` + request header) (§22) | None | **MISSING** |
| G12 | Telemetry: opt-in OTel channels, no defaults (§22) | None (privacy-consistent posture; no telemetry claims made) | **MISSING** |
| G13 | Document/office → PDF (§22) | None | **MISSING** |
| G14 | Runtime behavior of HMR/plugin swap in a *live* composed tree | N/A — no such runtime | **UNVERIFIED** (moot here; listed because the source fact has no PLUTON counterpart to exercise) |

### H — Quality & delivery

| # | Capability | dsh (source) | PLUTON (repo) | Tests | Status |
|---|---|---|---|---|---|
| H1 | Test infrastructure | dsh §28: thread/process pools, 100% per-file coverage gate w/ exemption manifest, offline snapshot replay corpora through real CLI, mock LLM server, run-gates aggregation | Default vitest suite (1,153 tests, recorded §4) + gated e2e/live configs + recorded ACP frame fixtures (`tests/fixtures/{opencode,qwen}-acp/recorded-frames.json`) + shared helpers (real store + broadcaster + workspace manager harness); asset verifier | `tests/helpers/*` harnesses; `release-gate(26)` | **PARTIAL** — strong unit/integration posture; no coverage gate, no CLI-replay snapshot corpora |
| H2 | Release/publish pipeline | dsh §29: publish flow w/ hard fail on changed-content-same-version, verify-packed-install, multi-surface packaging (single exe, Electron, wheels) | `scripts/lib/release-gate.mjs` + `release-check.mjs` (11 checks: porcelain gate, version identity, engines.node, docs links, `npm run check`, build, `npm pack` manifest + host-path/credential leak scan; never publishes), `smoke:package` (npm pack → install into space-containing path → run CLI), CI matrix node24 ×3 OS | `release-gate(26)`, `ci-workflow(5)` ("runs the gate on Linux, macOS and Windows with Node 24", "never publishes"), `verify-assets(2)` | **PARTIAL** — npm-only delivery path |
| H3 | Docs / ADR discipline | dsh §30: enforced rulebook w/ doc links/budgets/translation-pairing gates | 15 ADRs (0001–0015) + architecture/feature audits + roadmap + security model; release gate checks doc links | `release-gate` link checks | **PARTIAL** |
| H4 | Cross-platform CI posture | dsh §28 gate names incl. windows-blocking lanes | ci-workflow tests pin 3-OS × node 24; opt-in Docker E2E lane behind explicit flag | `ci-workflow(5)` | **MATCHES** |

---

## 6. Source↔repo anchor cross-map (load-bearing claims)

| dsh concept | Source § | PLUTON path | Test evidence |
|---|---|---|---|
| Durable event log, model-visible ⟺ logged | 02 §09 | `src/store/migrations.ts` (`events`, `receipts`) · `src/server/events.ts` append path | `store(44)`, `store-ownership(22)` |
| Cursor/projection reads | 02 §11 | `src/store/store.ts` `eventsSince/latestEventSeq` · `src/server/log-watcher.ts` | `server-log-watcher(11)` |
| Fail-closed approvals w/ expiry | 03 §18 | `src/engines/interactive-approval.ts` · `src/cli/commands/approvals.ts` | `engine-interactive-approval(17)`, `cli-approvals(17)` |
| Ask-user structured question | 03 §18 | `qa.question` type in routes/API + SPA card | `qa-question-unblock(6)`, `qa-question-card(5)` |
| Guarded per-call tool surface | 03 §15 | `src/tools/catalog.ts` + `handlers.ts` + `bridge.ts` | `tool-bridge(50)` |
| MCP stdio integration | 03 §19 | `src/tools/mcp-server.ts` + `src/cli/commands/mcp.ts` | `mcp-server(27)`, `cli-mcp-serve(3)` |
| Engine adapter contract (external agent proc) | 01 §01 plugin seams · 03 §21 providers | `src/engines/contract/types.ts` + `src/engines/acp/*` | `engines(6)`, `acp-client(15)` |
| Loopback token auth + anti-rebind | 04 §23 | `src/server/security.ts` + `server.ts` bind | `server-security(5)` |
| Streaming web transcript | 04 §23 conversation nodes | `src/server/static-assets.ts` chat + `routes.ts` SSE | `spa-ui(27)` |
| Session resume tokens | 02 §10 · 04 §25 SDK resume | `chat_sessions.native_session_id/resume_token` + `ChatSession` resume | `chat-session(7)` |
| Crash repair / fenced recovery | 02 §10 · 04 §22 | ownership leases + `background-run-settle` | `supervisor-ownership(14)`, `store-ownership(22)` |
| Single-instance discipline | 04 §24 | `src/server/instance.ts` claim mutex | `app-lifecycle(12)` |
| Typed config validation | 01 §05 Schemastery | `src/config/schema.ts` zod strict | `config(14)` |
| Container sandbox | 03 §17 | `src/sandbox/{factory,docker,local-process,muse-containers}.ts` | `sandbox(18)`, `muse-containers(10)` |
| Git-isolated work products | 03 §17 writable-roots analog · 04 §22 workspace-changes | `src/workspace/manager.ts` + `protected-paths.ts` | `workspace(25)`, `protected-paths(9)`, `cli-integrate(22)` |
| Offline-replayable engine transcripts | 04 §27/§28 snapshot replay | `tests/fixtures/*/recorded-frames.json` replayed in unit suites | `opencode-pure(10)`, `qwen-pure(12)` |

---

## 7. Architectural differences (deliberate divergences, each with its record)

1. **Plugin kernel vs static seams.** dsh composes everything through a vendored Codis-style kernel with profiles, patches, market and HMR (`dsh §01`). PLUTON composes through static registries (engine factory registry, tool catalog, commander CLI) and six runtime dependencies total (`package.json`: commander, yaml, zod). Recorded in ADR-0001 (language/runtime/packaging) and ADR-0011 (independence/licensing/reuse).
2. **Where the LLM runtime lives.** dsh owns the provider stack (`ctx.llm`, adapters, retry policies, token meter — `dsh §13/14`). PLUTON owns *delegation* and treats the LLM stack as engine-internal (opencode/qwen ACP agents), keeping only contracts, availability, and budgets at the harness level (ADR-0003).
3. **Storage engine and repair story.** dsh: append-only JSONL files, zstd frames, flock, sealed generations, FTS5 queries (`dsh §10/11`). PLUTON: one `node:sqlite` WAL database, 7 forward-only migrations, monotonic `events` seq + idempotency receipts + cursor reads (ADR-0002). Both satisfy append-only durability and crash recovery; neither needs the other's medium.
4. **Sandbox granularity.** dsh confines **each process spawn argv** with per-call modes and reports enforcement quality (`dsh §17`). PLUTON sandboxes the **whole durable worker environment** (container per Muse, network policy, uid mapping) and treats local-process mode as an acknowledged developer-only escape (ADR-0004/0010). Escalation ladders do not exist on either side for the same object.
5. **Delegation model.** dsh subagents are in-*process* agent children with inbox steering and cold resume (`dsh §21`). PLUTON delegation is a persisted **task graph** between engine sessions with leases, revisions, and state transitions in one SQLite transaction (`task-graph.ts` admission).
6. **Client wire.** dsh: unary RPC + WebSocket Mux + typed Remotes + generation-based event windows (`dsh §23/27`). PLUTON: plain REST + SSE + derived-state frames (SPA consumes server state). Both are single-host loopback designs.
7. **Desktop packaging.** dsh ships Electron + code-signing/notarization + ASAR runtime (`dsh §24/29`). PLUTON ships a launcher that opens the app URL in an existing Chromium (ADR-0014/0015), explicitly refusing the 200 MB+ installer tradeoff; Tauri v2 recorded as Tier-2 future path.
8. **TUI.** dsh ships **no TUI** (verified: `dsh §26`); PLUTON ships a full custom TUI 2.0 (ADR-0012/0013; `src/tui/*`). Pure reverse divergence.
9. **Config.** dsh config is live plugin Config with profile patches and stale-write refusal (`dsh §01/18`). PLUTON config is a strict zod-checked YAML with team templates and role prompts, guarded by version migrate hints and path containment (ADR-0001/0012).
10. **Model-visible ⟺ logged discipline.** dsh enforces full request-history reconstructability (system-prompt surface nodes, embedded streams). PLUTON persists transcripts, final answers, tool events, and reasons, but does **not** claim full request-reconstruction; G5/PR-2 explicitly forbids fabricating what engines don't report (`src/chat/session.ts:1051`).

---

## 8. Gap ledger

### 8.1 Confirmed gaps (implementation present in dsh §-refs; R-class absence in PLUTON at `595e8b6`)

| ID | Gap | dsh ref | Impact on PLUTON's purpose |
|---|---|---|---|
| CG-1 | No file/image attachment ingestion for chat/run inputs | §22 | Briefs from the operator must reference files by path; large inputs cannot be attached/deduped |
| CG-2 | No history compaction/summarization for long sessions/runs | §22 | Long supervision sweeps rely on caps + fresh resumes; transcripts don't shrink |
| CG-3 | No SDK / programmatic product surface (TS/Python JSON-RPC, ACP server) | §25 | Automation is CLI+REST/SSE only; no editor/remote integration seat |
| CG-4 | No external-MCP ingestion into the harness's own tool surface | §19 | Engines carry their own MCP; the supervisor's tool vocabulary is fixed by `TOOL_SCHEMAS` |
| CG-5 | No web search/fetch tools for researcher-role muses | §16 | Research capabilities depend on engine-internal tools only |
| CG-6 | No LSP integration, skills catalog, schedule, telemetry, identity, i18n, office conversion | §16/§22/§23 | Feature-departmental absences; individually low impact on orchestration core |
| CG-7 | No signed-cookie session persistence (token re-supplied per request; SPA sessionStorage) | §23 | Restart/relaunch requires re-entering/appending token (UX continuity gap, not a security hole — validation is timing-safe and loopback-bound) |
| CG-8 | No FTS/keyword search over the durable event log | §11 | Cross-run forensic queries must use CLI `status/task list/graph` projections instead |

### 8.2 Possible gaps (inference or unproven edges — flagged, not asserted)

- **SSE reconnect continuity:** the SPA reconnects and reads the durable transcript, but whether a disconnect, mid-stream, can *miss* events without repair (dsh solves via generation windows + atomic replacement — `dsh §23`) is not evidenced here (U; verifying it requires a live streaming/disconnect scenario, §8.3).
- **Token lifecycle across restart:** `generateServerToken` runs per server start; a pinned `sessionStorage` token against a restarted server will fail validation. Server exit UX (`--stop/--status`, `isPidAlive`) exists; the reconnect UX with regenerated tokens is plausible-but-unverified (U).
- **Approval/verification TTL vs clock skew** (`approvals.expires_at` sweeps): implemented with fail-closed semantics and tests; skew behavior beyond the sweep interval is an untested edge here (T for the tested window, U beyond).
- **`network_policy='restricted'` enforcement** is docker-network-based (`muse-network-policy(5)`); local-process mode has no equivalent network fence — documented dev-only, but the enforcement asymmetry deserves an operator note (R for config, U for escape analysis).
- **Outbound network posture parity:** dsh performs hardened outbound fetch hardening rules (§16); PLUTON's workers reach the network through policy-restricted containers; the residual egress surface of engine CLIs inside the network policy was not probed here (U).
- **Truncation semantics of `chat_messages`/task results vs model-visible lossiness:** caps are tested for persistence; what an engine *receives* after cap clipping in prompts is an unverified edge (U).

### 8.3 Unverified runtime behavior (not exercised in this audit; gate recorded)

| # | Behavior | Why not | Gate |
|---|---|---|---|
| UV-1 | Docker sandbox round-trips (`docker-sandbox.e2e`: create/start container from worker image; typed marker through real tmux pane) | e2e config, opt-in flag | `PLUTON_E2E_DOCKER=1` + worker image (present per doctor) |
| UV-2 | Linux bind-mount uid ownership across lifecycles | Requires native Linux host + non-root; this audit ran on Windows/WSL2 host | `tests/e2e/linux-bind-mount.e2e.test.ts:39-40` |
| UV-3 | Live engines (opencode/qwen) incl. resume and real-model behavior | Opt-in; real network/binary; free-model auth bwarnings recorded by doctor | `PLUTON_LIVE_OPENCODE=1` / `PLUTON_LIVE_QWEN=1` |
| UV-4 | Multi-server concurrent contention beyond unit-level flock/claim tests | Not reproducible in a single read-only audit pass | e2e/manual scenario |

The e2e file headers themselves state the doctrine this report adopts: "A skip is documented as NOT TESTED, never a pass."

---

## 9. Reconciliation with the repo's own prior audits (documentation drift)

`docs/PLUTON_FEATURE_PARITY.md` (2026-10-18, baseline `main@506fa72`, 762 tests) records five verified gaps G1–G5. At the audited HEAD `595e8b6` (1153 tests / 125 files**, recorded in §4), the gap disposition is materially different:

| Parity-doc gap | State at `595e8b6` | Evidence |
|---|---|---|
| G1 "Usage budgets dormant in real runs" | **Closed** — budgets interrupt runs at threshold | `src/orchestrator/usage-ledger.ts`; `supervisor-usage-budget(5)`; ROADMAP PR-1 |
| G2 "No interactive operator channel for engine permission requests" | **Closed** — fail-closed interactive channel + SPA decide API | `src/engines/interactive-approval.ts`; `engine-interactive-approval(17)`; `routes.ts` `POST /api/approvals/:id/decide` |
| G3 "No transport-level retry/backoff" | **Closed** | `src/engines/acp/retry.ts`; `acp-retry(4)`; `transport-retry(3)` |
| G4 "No session-log projection/query surface" | **Subset closed** — cursor projections + collapsed task/run frames exist; FTS search still `MISSING` (CG-8) | `server/log-watcher.ts` CS-8; `store.eventsSince`; grep §4 |
| G5 "TUI context %/cost are fabricated estimates" | **Closed** — honest no-estimates rule | `src/chat/session.ts:1051` comment ("Real telemetry only (G5 / PR-2)"); `research-comparison.md` "Explicit non-claims" |

Consequently, `docs/PLUTON_FEATURE_PARITY.md` and `docs/feature-completion-audit.md` are **stale relative to the current tree** (762 → 1,153 tests; gaps G1/G2/G3/G5 resolved; ROADMAP's "Named follow-ups" partially landed). This report supersedes those documents for the `595e8b6` baseline and recommends regenerating the parity doc from it (R9 in §10).

Careful: this does **not** overclaim "everything closed." G4, CG-1..CG-8 and §8.2/§8.3 remain open, and the legacy audits' *methodological* claims (e.g., "100.0% features verified") are weaker than this audit's evidence classes.

---

## 10. Prioritized recommendations (preserving PLUTON's orchestration purpose)

Ordered by impact-to-pipeline value vs cost; every item notes the dsh pattern it borrows without converting PLUTON into dsh.

| # | Recommendation | Rationale (keeping orchestration purpose) | dsh pattern to borrow |
|---|---|---|---|
| **R1** | **Add attachment ingestion** (bounded: file digests + read-only stored paths + ingress redaction; extend chat/run briefs) | CG-1 is the most operator-visible interaction gap for run creation; read-only file references also protect the git working-tree model | §22 attachment-local (verify-on-read, no base64 exposure) |
| **R2** | **Search tooling for the event log**: a `pluton log <run> --grep/--since/--kind` cursor-based query built on `eventsSince` | Completes G4 without importing FTS5; investigators/debuggers of long multi-muse runs become self-serve | §11 session-query seeds (cursor+budget reading, without FTS) |
| **R3** | **Long-run transcript budget UX**: bounded summarization of *task* transcripts (not the log) using the already-configured free-flow engine models on `verifying`/`finishing`; preserve raw rows in store | Long supervision runs hit caps today (G/CG-2); summarizing task narratives keeps managers' context within trains while preserving durable truths | §22 compaction-basic "replace a range with a summary" — scoped to task view, never the log |
| **R4** | **Token-continuity UX** for app-mode windows (optional signed short-tolerance cookie or one-click token re-entry / deep-link refresh; prefer keeping `HttpOnly SameSite=Strict` cookie family parity) | Closes CG-7 without weakening the anti-rebind model; matches dsh's 30d-cookie model | §23 auth (cookie w/ strict source checks) |
| **R5** | **Research tool seam for `researcher`-role muses** behind strict network_policy (only if/when engine-internal capabilities fall short): port dsh's hardened outbound-fetch rules (nocredentials, redirect re-validation, byte/time caps) | Keeps the sandbox posture while adding CG-5's most-requested department | §16 web-fetch-http hardening rules |
| **R6** | **Session/bundle export** (`pluton export --run` → JSON/JSONL per run of events+transcripts+verifications) | Hands externally reproducible forensic bundles to auditors; low-cost given durable log | §10 `SessionPersistence.export` byte-stable model |
| **R7** | **E2E/live harness activation on schedule**: run `npm run test:e2e` with `PLUTON_E2E_DOCKER=1` on a Linux runner in CI, keeping Windows runs unit-level; record UV-1/UV-2 as closed only after a green native-Linux run | The evidence gap between unit-tests and runtime truth is the audit's largest unknown block | §28 "CI owns exhaustive coverage and matrices" |
| **R8** | **Ship the Tauri v2 Tier-2 desktop wrapper only at installer-distribution time** (ADR-0015); skip Electron entirely | Preserves otra-toned npm-first delivery; no re-architecting | §24 Electron serves as comparison baseline, not target |
| **R9** | **Regenerate `docs/PLUTON_FEATURE_PARITY.md`** from this report at the `595e8b6` baseline; fold G1–G5 sidelines, mark CG/UV items as tracked ledgers; update test-count provenance | Removes documentation drift the audit found (§9) and gives future audits a single current authority | §30 doc discipline ("publish derived state only at commit points") |
| **R10** | **Do NOT add**: plugin kernel/HMR/market, PTC/workflow engine, schedule/cron, telemetry, identity, i18n | These are recorded non-goals with "no demonstrated PLUTON orchestration need" (ADR-0011; `PLUTON_IMPLEMENTATION_ROADMAP.md` non-goals); each would enlarge independent code surface against the audit's principle that orchestration is the product | — |

---

## 11. Statement on similarity ≠ parity

**Architectural similarity between PLUTON and DeepSeek Harness does not prove behavioral parity.** Concrete, evidence-backed instances where the same *words* denote different systems:

- "session" — dsh: append-only JSONL event stream with projections and repair consumers. PLUTON: SQLite chat transcript + engine resume token + run/task rows.
- "sandbox" — dsh: per-spawn argv confinement with modes and enforcement reporting. PLUTON: container-per-Muse durable workspace.
- "approval" — dsh: in-turn one-shot service with answerer waterfalls. PLUTON: durable approval records with expiry sweeps, QA cards, and auto-continue.
- "attach" — PLUTON's `attach` command attaches a terminal to a tmux pane; dsh's "attachment" is a file/image ingestion feature. The words collide; the features do not intermap.
- "MCP" — dsh consumes external servers' toolsets; PLUTON exposes its orchestration tools as an MCP server to engine sessions. Integration exists on both, at mirrored directions.
- "event log" — both have one; the replays, gap-repair, and projection semantics differ (§5-A3/B4), so streaming behavior cannot be inferred equivalent.

Therefore every `MATCHES` in this report is a claim about *structure and tested semantics of the PLUTON implementation*, not about behavioral identity with `dsh` under identical inputs. Behavioral claims require the gated suites (§8.3), which were not run in this audit.

---

## 12. Audit limitations

- Read-only: no source changes; the only file written by this audit is this report (`docs/audits/source-parity-report.md`). The five pre-existing untracked PNGs were left as found (untracked).
- The audit's repository evidence is content-verified at `595e8b6`; the earlier parity docs were baseline-stamped at `506fa72` and are treated as historical claims, reconciled in §9.
- `REA.txt` was not found (§2); any claims that would have been refined by it are constrained to what the four volumes demonstrably state.
- Two read-only exploration passes (module/feature inventory; tests→capability map) plus targeted greps (§4) were used for absence evidence; no dynamic instrumentation or live-traffic capture was performed.
- Test evidence classes (T) refer to the vitest run recorded in §4 on win32; tests marked as gated out were not treated as passing-or-failing here, per the "NOT TESTED, never a pass" doctrine.
