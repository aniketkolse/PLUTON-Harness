# PLUTON Feature Parity — reference capability matrix (Phase 1 audit)

> **Historical audit (2026-10-18; engine note 2026-10-22):** Qwen Code support was removed after
> this audit. Qwen capability claims below are historical evidence, not current support. OpenCode
> is the only supported real engine; `mock` is tests/dev only.

**Date:** 2026-10-18 · **Baseline:** `main` @ `506fa72` (typecheck/build/unit/E2E green — see `docs/PLUTON_BASELINE_REPORT.md`)
**Reference set:** `Y:\Setup\REA deepseek\01-kernel-and-composition.md`, `02-agent-session-persistence.md`, `03-model-tools-capabilities.md`, `04-interfaces-delivery-reference.md` — a reverse-engineering specification of **DeepSeek Harness (`dsh`)**.

> **REA.txt: NOT FOUND.** The mission names `REA.txt` as the first primary reference. It does not exist in `Y:\Setup\REA deepseek\` (only the four numbered `.md` files) nor anywhere searched on `Y:\` or the user profile. This matrix is built from the four `.md` volumes; if `REA.txt` exists elsewhere it should be supplied and this matrix re-validated.

## Method and vocabulary

Each row maps one reference capability to Pluton's actual implementation. Status is evidence-based; nothing is marked implemented without a file reference, and nothing is marked required merely because `dsh` has it.

- **Status:** `Implemented` · `Partial` (exists with verified gaps) · `Missing` · `N-A` (not applicable by design, reason given).
- **Applicability to Pluton 2.0:** `Required` (serves Pluton's own stated goals or the mission's explicit rules) · `Candidate` (valuable, needs an owner decision) · `Future` (deferred until a dependency exists) · `N-A` (documented reason).
- **Priority:** `P1` next · `P2` after P1 · `P3` later/decision-gated · `—` none.

Boundary rule used throughout: the four volumes describe a **harness** (model ↔ tools ↔ sessions); Pluton is a **control plane** whose engines are harnesses. Capabilities about model interaction (provider adapters, execution families, prompt internals) are engine-owned by design; capabilities about durability, coordination, observability, interfaces and delivery map directly.

## A. Documented requirements (separated from behavior)

| # | Requirement | Source |
|---|---|---|
| R1 | Preserve the existing backend and agent execution logic; do not replace them with a generic harness | Mission; `PLUTON_TUI_REFINEMENT_PROMPT.md` line 15 ("TUI presentation-layer upgrade only … Do not rewrite the harness or replace the backend") |
| R2 | Match the approved PLUTON TUI design | `PLUTON_TUI_REFINEMENT_PROMPT.md`; ADR-0013; `docs/tui-refinement-report.md` |
| R3 | Treat the reference volumes as the primary parity specification | Mission; volumes 01–04 (REA.txt missing — see note) |
| R4 | Audit rules: no rewrite before understanding; no assumed features; separate documented/proposed/unresolved; preserve backward compatibility; no unverified claims | Mission |
| R5 | Backward compatibility unless a change is explicitly required (config schema is `.strict()`; DB migrations forward-only) | Mission; `config/schema.ts`; `migrations.ts` |

## B. Existing behavior summary (verified strengths)

- Durable, idempotent core: single SQLite/WAL store, `BEGIN IMMEDIATE` transactions, receipts, append-only sequenced events, forward-only migrations (`src/store/*`; 762 tests green).
- Explicit state machines and typed refusals; no prose-as-state (`src/domain/state.ts`; ADR-0006/0007).
- Real engine adapter over ACP with capability honesty, live-verified OpenCode, deterministic mock (`src/engines/*`). Qwen support was removed on 2026-10-22 and is historical only.
- Restricted tool bridge with per-call authorization, MCP stdio + HTTP transports, adversarial-review hardened (`src/tools/*`).
- Container isolation with hardening + per-Muse tmux + per-task checkouts; gated E2E 5/5 green (`src/sandbox/*`, `src/workspace/*`, `src/terminal/*`).
- Verification gate: completion only via durable evidence (`src/verify/*`, `pluton verify`, `pluton integrate`).
- TUI 2.0 with design system, sanitization, approvals, inspector (ADR-0013).
- Strong test culture: 89 files / 762 tests + gated E2E + opt-in live suites + ACP frame fixtures.

## C. Capability matrix

### C1. Kernel and composition (volume 01)

| Ref capability (section) | dsh mechanism (title-level) | Pluton status | Pluton evidence | Applicability | Dependencies | Acceptance test | Prio |
|---|---|---|---|---|---|---|---|
| §02 Cordis kernel | Service graph on a shared context; scoped contexts; lifecycle | Missing | No service registry/lifecycle anywhere in `src/` (grep); closest artifact is the engine factory `Map` (`src/engines/registry.ts:52`) | Candidate — decision-gated (see Q2); a large architecture change, not justified by an assumed need | Design ADR first; no code deps | ADR accepted + typed service registry with lifecycle events + dependency-direction tests | P3 |
| §03 Boot pipeline | `dsh web` → initialized plugin tree | Partial analog | `bootstrapStore` per CLI invocation (`src/bootstrap.ts:23`); no persistent host | N-A today (CLI-per-command + in-process supervisor) | — | n/a | — |
| §04 Profiles/bundles/patches | Layered composition of config/plugins with patch application | Missing | Single strict `pluton.yaml` + templates (`src/config/schema.ts`; `templates/`) | Candidate — only if multi-team/multi-project overlays become a product need | Config versioning story | Config overlay + precedence tests; unknown keys still fail closed | P3 |
| §05 Plugin management | Install/market/resolvers for plugins | Missing | N/A | N-A — no plugin ecosystem exists or is planned in Pluton; engines are external processes | — | — | — |
| §06 HMR hot reload | Live plugin reload | Missing | N/A | N-A for the CLI model; revisit only with a long-lived host | — | — | — |

### C2. Agent core, session, persistence (volume 02)

| Ref capability (section) | dsh mechanism (title-level) | Pluton status | Pluton evidence | Applicability | Dependencies | Acceptance test | Prio |
|---|---|---|---|---|---|---|---|
| §07 Agent contract | `ctx.agents`, scope, presets | Partial (adapted) | `EngineAdapter` contract (`src/engines/contract/types.ts:138`); Muse presets via `pluton.yaml` + role templates + default permissions (`src/domain/permissions.ts:42`) | N-A as named; equivalent exists | — | Adapter conformance suite (exists) | — |
| §08 Agent loop | Turn/step state machine inside the harness | Partial (adapted) | Pluton's loop is per-attempt in `RunSupervisor.executeTask` + the task state machine; inner step loop is engine-owned | N-A by design (engines own turns) | — | Existing supervisor tests | — |
| §09 Session log | Append-only, typed session event log | Implemented | `events` table, monotonic `seq`, bounded redacted payloads; `appendEvent`/`eventsSince` (`src/store/store.ts:984–1051`; `src/domain/models.ts:197`) | Required — already core | — | Replay by seq cursor: no gaps/dupes (partially covered by store tests) | P2 |
| §10 Persistence backends + migration chain | JSONL backends; format v0→v4 migrations; storage service | Partial | Single backend (SQLite) with forward-only numbered migrations (`src/store/migrations.ts`); no JSONL export/import; engine `sessionExport` capability exists but unused | Candidate: session export/import | §09 replay surface | Export a run/session to JSONL and re-import as a read model; fixtures for old schema | P2 |
| §11 Projections & session query | Read models + session search over the log | Missing | No projections/FTS anywhere (grep `FTS5|projection` → none); only `eventsSince`/`listEvents` | Candidate → strong for operator/audit UX | §09 | Query API with tests: e.g. "tasks by state in run", "approvals pending", "usage per muse"; no fabricated rows | P2 |
| §12 System prompt & request context | Composable prompt nodes; request context assembly | Partial | `buildManagerPrompt`/`buildTaskPrompt` (`src/orchestrator/supervisor.ts:112–169`), role instruction files, `compactContext` helper (`usage-ledger.ts:184`) | Candidate (minor) | — | Prompt assembly golden tests per role | P3 |

### C3. Model layer, tools, capabilities (volume 03)

| Ref capability (section) | dsh mechanism (title-level) | Pluton status | Pluton evidence | Applicability | Dependencies | Acceptance test | Prio |
|---|---|---|---|---|---|---|---|
| §13 LLM runtime: retry | Retry policy on model calls | Missing | No `retry/backoff/jitter` in `src/engines/` (grep); ACP client has timeouts only (`client.ts:83`); a failed turn becomes a task failure/retry (coarse) or `unknown` | Required (conservative scope only: side-effect-free phases; never blind resend — ADR-0006 A2) | None | Unit tests with injected spawn: spawn/initialize retried with capped exponential backoff + jitter; a started prompt is never resent | P1 |
| §13 LLM runtime: token-meter | Token/cost accounting and budgeting | Partial | `usage` EngineEvents → `UsageLedger` → `run_usage` rows (`supervisor.ts:323–338`, `store.ts:1423`); budget logic implemented and unit-tested with explicit limits (`tests/unit/usage-ledger.test.ts`, `tests/integration/multi-agent-reliability.test.ts:244`) — **but dormant in real runs** (no limits constructed; no config fields) | Required | — | Configured budgets stop a run: mock engine emits usage over limit → interrupt + durable evidence; config round-trip tests | P1 |
| §15 Tools: registry + guarded pipeline | Schema validation, guards, pre/post-execute hooks, concurrency metadata | Partial | Catalog + strict Zod + per-call authz + leases (`src/tools/catalog.ts`, `bridge.ts`); no hook seams, no per-tool concurrency-safety metadata, no output-rendering seam | Candidate (needed if extension/plugin goals are confirmed) | Q2 decision | Extension-seam tests: pre/post hooks observed in order; concurrent-unsafe tools serialized | P2 |
| §16 Execution capabilities (shell/fs/subprocess/terminal/lsp/skill/web) | Engine-provided tool families | N-A by design | Engines own file/shell tools inside containers; Pluton deliberately exposes only 13 coordination tools | N-A — Pluton is the control plane; keeping this surface narrow is a security property | — | n/a | — |
| §17 Sandboxing | Sandbox service for tool execution | Implemented (one gap) | Docker hardening + image gating + per-Muse containers (`src/sandbox/*`); E2E 5/5 green; `network_policy=restricted` is not an egress filter (documented) | Required for the documented policy; egress enforcement = Candidate | — | Egress probe test once implemented; today: doc states the limitation | P2 (egress) |
| §18 Approvals/permissions/ask-user/credentials | Approval waterfall; ask-user; credential stores | Partial | Durable approval records + TTL sweep + fail-closed expiry (`store.ts:782–984`); engine approval mapping (`src/engines/approval.ts`); TUI cards + keyboard decisions; credentials = per-Muse engine home (ADR-0008) | Required (interactive engine-approval channel); O2 decision still open | TUI/chat event channel | Engine `approval_request` surfaced, operator decides, decision recorded and applied; denial cannot record as silent success | P1 |
| §19 MCP | MCP client/server integration | Partial (server side) | Pluton exposes the restricted bridge over MCP stdio + HTTP to engines (`mcp-server.ts`, `http-transport.ts`); MCP config for engines live-verified (`docs/reverse-engineering/engine-mcp-integration.md`) | Adapted — the useful direction for a control plane | — | Existing bridge tests + engine integration doc | — |
| §20 PTC & workflow engine | Programmatic tool calling; workflow scripts | Missing | No workflow engine in `src/` | Candidate — only with a concrete use case (e.g. unattended pipelines) | Q2 decision | Workflow spec + engine-mock execution tests | P3 |
| §21 Subagents & agent teams | `ctx.subagents`; team orchestration | Adapted (implemented differently) | Durable task graph + delegation limits + exactly-once wakeups + supervisor (`task-graph.ts`, `wakeups.ts`, `supervisor.ts`); 12 mock-engine integration tests | Required — Pluton's core value; parity by mechanism, not shape | — | Existing integration tests | — |
| §22 Agent features & support packages | Todos, planning, misc. packages | Partial | Plan mode (`src/plan/manager.ts`, `/plan`), sessions, model switching, permissions/doctor slash commands; no todo tool | Candidate (minor) | — | Feature tests per addition | P3 |

### C4. Interfaces, delivery, reference (volume 04)

| Ref capability (section) | dsh mechanism (title-level) | Pluton status | Pluton evidence | Applicability | Dependencies | Acceptance test | Prio |
|---|---|---|---|---|---|---|---|
| §23 Web UI (host/client "Wire") | Browser UI bound to a local wire protocol | Missing | No web UI in `src/` | Candidate (P3) — Pluton is TUI-first by design; needs an owner decision | Session query API (§11) | — | P3 |
| §24 Desktop (Electron) | Desktop shell over the same wire | Missing | — | N-A unless requested | §23 | — | — |
| §25 SDKs (TS/ACP/Python) | Public SDKs for embedders | Missing | CLI JSON envelopes only; `bin/pluton.js` shim (`src/cli/output.ts`) | Candidate — start read-only (status/task/graph/events) | §11 | SDK contract tests against the JSON envelopes | P2/P3 |
| §26 TUI reality check | dsh has no TUI framework | Inverse | Pluton's TUI 2.0 is its own (ADR-0013); see §E discrepancy check | Required (approved design fidelity) | — | Visual/behavior tests + named follow-ups closed | P1 (follow-ups) |
| §27 API gateway (BFF) | Typed gateway over services | Missing | — | Candidate after §25 | §11, §25 | — | P3 |
| §28 Testing & quality infra | Snapshot corpus, contract suites | Partial (strong base) | 762 tests + gated E2E + opt-in live + fixtures; missing: coverage gate, capability conformance test (A7), state-coverage test (R3) | Required (cheap, anti-drift) | — | Conformance test fails on adapter/capability drift; coverage threshold in CI | P2 |
| §29 Build/packaging/delivery | Publish pipeline for all artifacts | Partial | `npm run build` (tsc), `bin` shim; no packaging/publishing; license undecided (O8) | Future | O8 license | Reproducible artifact build from a clean checkout | P3 |
| §30 Conventions & invariants | Reverse-engineered rulebook | Implemented as convention | ADRs 0001–0013, honesty conventions, module boundaries (enforcement partial: `implementation-decisions.md` R2/R4/R10 tests not written) | Required | — | Doc-drift + boundary tests (O5) | P2 |
| §31 Unknowns ledger | Explicit unknowns economics | Process exists | `docs/reverse-engineering/implementation-decisions.md` "Still open" O1–O8; this doc §F | Required | — | Each open item gains an owner decision or an ADR | — |
| §32 End-to-end flow map | Traced flows | Covered | `docs/PLUTON_ARCHITECTURE.md` §5/§6; `docs/smoke-live-run.md` | — | — | — | — |

## D. Five highest-priority verified gaps (ranked)

| # | Gap | Evidence | Consequence | Parity ref |
|---|---|---|---|---|
| G1 | Usage budgets dormant in real runs | `supervisor.ts:226` (no limits), `run.ts:261–306` (not passed), `config/schema.ts` (no fields); budget logic itself implemented + unit-tested | Cost/token runaway guardrails advertised by the usage-tracking slice do not actually bound a production run | §13 token-meter |
| G2 | Engine permission requests have no interactive operator channel; fail-closed denials can record as "successful" no-op tasks | `engines/approval.ts:24–37`; ROADMAP named follow-up "async engine-approval interactive prompts" | Operator cannot grant a sensitive action mid-run; honesty gap (task success with zero changes) | §18 approvals/ask-user |
| G3 | No transport-level retry/backoff for engine spawn/handshake | No `retry/backoff/jitter` in `src/engines/` (grep); `acp/client.ts:16–18` failure policy is fail-fast | A transient spawn/handshake blip burns a task attempt or ends `unknown_outcome` | §13 retry |
| G4 | No session-log projection/query surface | No `FTS5`/`projection` in `src/`; only `eventsSince`/`listEvents` (`store.ts:1025–1051`) | Operator/audit/SDK surfaces must re-scan raw rows; blocks streaming replay (O1) and SDK work | §9–§11 session log/query |
| G5 | TUI context %/cost are fabricated estimates | `chat/session.ts:71–72, 1045–1050` | Displays a dollar cost no engine reported — violates the project's honesty conventions | §13 token-meter; §26 |

Additional verified gaps (not top-5): `max_retries_per_task` config not wired (L3); kernel/composition absence (decision-gated); no web UI/SDK/gateway; egress filtering; coverage/conformance gates.

## E. TUI discrepancy check (against the approved design)

Approved design = `PLUTON_TUI_REFINEMENT_PROMPT.md` (474 lines) + ADR-0013 requirements. Verified implemented per `docs/tui-refinement-report.md` and `src/tui`/`src/ui` inventory: alternate screen, responsive layout, violet/cyan identity, markdown + code framing, sanitized tool activity, approval cards, slash commands + autocomplete, orchestra inspector, plan graph.

Open items (from ROADMAP named follow-ups; status per files, not re-tested interactively in this audit):

| Item | Status |
|---|---|
| Fullscreen/alt-screen mode | Implemented (`src/tui/terminal.ts:alternateScreen`, report §1.1) |
| Async engine-approval interactive prompts | **Open** (see G2) |
| Tool-output detail / thinking-chunk streaming | Partial/open (activity lines exist; no detail streaming) |
| `@`-file completion in the editor | Open |
| Dynamic steering prompts during active runs | Open |
| Arrow-select approval decision panel | Open (keyboard `A`/`D`/`V` exists) |
| Honest usage display | **Deviation** (see G5) |

## F. Proposed design directions (proposals only — nothing here is implemented or approved)

1. **Usage budgets end-to-end (G1):** add optional run/per-Muse token+cost limits to `runtime` config (safe bounds, defaults absent = current behavior), map via `run-setup.ts`, construct `UsageLedger` with limits and pass `max_retries_per_task` in `run.ts`. See `docs/PLUTON_IMPLEMENTATION_ROADMAP.md` PR-1.
2. **Engine-approval channel (G2):** surface `approval_request` events into the chat/TUI inbox and `pluton approvals`; record decisions as the durable authority; interim: flag denials in task result evidence so a no-op cannot pass verification silently.
3. **Transport retry (G3):** bounded exponential backoff + jitter for side-effect-free phases only (spawn, transport handshake). Never resend a prompt; classification test required.
4. **Session query/projection (G4):** read-model module over `events`/`chat_messages`/`run_usage` with a seq-cursor API (Last-Event-ID semantics); powers TUI inspector, future SDK, and replay.
5. **Composition kernel (Q2):** ADR-only first. Minimal scope if approved: typed service registry + lifecycle events. Explicitly reject market/HMR/Electron/Python-wheel parity unless the owner requests it.

## G. Unresolved questions

| # | Question | Needed from |
|---|---|---|
| Q1 | Where is `REA.txt`? Is the four-volume set the complete reference? | Owner |
| Q2 | Is a Cordis-style composition kernel a PLUTON 2.0 requirement, or is the control-plane + engine-adapters architecture final? This decides P2/P3 scope broadly | Owner |
| Q3 | Are SDK/API-gateway/web-UI surfaces in scope (the volumes spend ~5 chapters on them)? | Owner |
| Q4 | Engine-approval channel: scope (chat only vs `pluton approvals` vs both) and policy | Owner + ADR (O2) |
| Q5 | Machine streaming/replay protocol (O1): SSE-style replay vs `logs --json` only | Owner + ADR |
| Q6 | Budget semantics: which axes (run/per-Muse; tokens/cost), defaults, and behavior at breach (interrupt vs fail) | Owner (PR-1 assumes: optional, tokens primary, interrupt) |
| Q7 | PTC/workflow engine: any concrete Pluton use case? | Owner |
| Q8 | Delivery scope: packaging/publish/license (O8) | Owner |
