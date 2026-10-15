# ADR-0003 — Engine adapter protocol and the first two engines

- Status: **Accepted** (2026-10-16) — Phase 4 completed: ACP transport implemented, OpenCode adapter
  live-verified, second engine selected and live-verified per the addendum below
- Supersedes: none. Addendum: "Phase 4 addendum — second engine selection: Qwen Code (verified)"

## Context

Pluton must drive heterogeneous coding engines through their **official, currently supported
structured protocols** — never by scraping TUI text. Engine and model are chosen per Muse. The
first engine is OpenCode; a second *real* engine is required for the MVP (the mock adapter does
not count). Capabilities differ per engine and must be reported, not faked.

## Verified protocol surface (this host, 2026-10-16)

- `opencode` v2.0.29 provides: `opencode acp` ("Start an Agent Client Protocol server"),
  `opencode serve` (v2 HTTP API + OpenAPI), `opencode run --format json` (JSONL event stream with
  `sessionID`), `opencode session export/import`, `opencode models` listing provider-qualified
  IDs. Live smoke test succeeded unauthenticated on a free hosted model
  (`opencode/deepseek-v4.1-flash-free`), i.e. real end-to-end engine tests are possible here.
- ACP (Agent Client Protocol) is JSON-RPC over stdio, adopted by 25+ agents by early 2026,
  including Gemini CLI (`--acp`) and GitHub Copilot CLI (public preview). Zed publishes the spec.
- Codex CLI ships `codex app-server` (JSON-RPC 2.0 over stdio hosting "threads"; documented in
  `openai/codex` `codex-rs/app-server/README.md`); Pi ships an RPC mode (JSON Lines over
  stdio, pi.dev/docs/latest/rpc).

## Decision (proposed)

- **Adapter contract** (`src/engines/contract/`): one `EngineAdapter` covering
  `discover/version`, `listModels`, `authStatus` (no secret values), `startSession(resume?)`,
  `sendPrompt`, normalized event stream (content deltas, tool activity, approval requests,
  usage-if-available, errors, completion), `interrupt/cancel`, `close`, plus a **capabilities
  record** (e.g. `resume`, `interrupt`, `approvals`, `usage`, `modelList`, `sessionExport`) where
  unsupported features return explicit capability errors instead of fabricated behavior.
- **First engine:** OpenCode via **ACP over stdio** (`opencode acp`) as the managed protocol;
  `opencode run --format json` remains a verified fallback path if ACP proves unstable on a
  platform (recorded as adapter capability deviation, not silently).
- **Second engine:** selected from Codex app-server / Gemini-CLI-ACP / Pi-RPC by the criteria:
  (1) protocol documentation verifiable from official sources, (2) fixture-testable offline,
  (3) installable here without paid auth, (4) value of protocol diversity vs implementation
  complexity. **Final choice recorded as an addendum to this ADR in Phase 4.** If the second
  engine also speaks ACP, it shares the ACP transport and differs only in descriptor + capability
  probing — legitimate, because the engines are genuinely different products.
- **Framing/bounds:** newline-delimited JSON-RPC 2.0 client implemented in-repo (no client
  dependency); maximum protocol message size, bounded stdout/stderr ring buffers, request
  timeouts, and redaction of failure diagnostics before persistence.
- **Isolation of channels:** the structured protocol channel is separate from any user-facing
  tmux/terminal channel; tmux never carries the managed protocol.

## Consequences

- Adding an engine = implementing/parameterizing one transport + capability probe, not a rewrite.
- Tests: fixture-replay conformance suite for the protocol; live tests opt-in.
- If OpenCode's ACP lacks a needed feature (e.g. approvals), the adapter reports it and the
  runtime falls back to `--auto`-style policy gating chosen by Pluton, never by faking.

## Evidence

- `opencode --help`, `opencode acp --help`, `opencode run --help`, `opencode models` outputs
  (captured in session log 2026-10-16).
- Live smoke: `opencode run --format json -m opencode/deepseek-v4.1-flash-free "…"` → exit 0,
  JSONL `{"type":"text",…,"sessionID":"ses_…"}` containing the exact requested marker.
- Web: geminicli.com ACP mode docs; github.com/openai/codex app-server README; pi.dev RPC docs.

## Phase 4 addendum — second engine selection: Qwen Code (verified)

Status: **Accepted** (2026-10-16). The four selection criteria from the Decision section were
applied against the candidates that could be installed and driven here without paid auth:

| Candidate | Protocol docs | Offline fixture-able | Installable here | Kept? |
|---|---|---|---|---|
| Qwen Code (`@qwen-code/qwen-code` 0.25.2) | ACP, `qwen --acp` (same spec as OpenCode; `--help` + live frames) | yes (recorded frames replay) | yes (npm, Node >= 22) | **yes** |
| Codex CLI `codex app-server` | yes (repo README) | yes | requires ChatGPT/API auth | deferred |
| Gemini CLI `--acp` | yes | yes | requires Google login | deferred |
| Pi RPC | yes | yes | not installed here | deferred |

**Decision:** the second engine is **Qwen Code**, driven via its native `qwen --acp` ACP server.
The ADR already permits a shared transport when the engines are genuinely different products;
Qwen Code is an independent CLI (Apache-2.0, Alibaba) with its own auth, settings and session
model — it is not a wrapper around OpenCode.

**Verified live surface (Qwen Code v0.25.2, 2026-10-16; raw transcripts in
`.pluton-tmp/qwen-acp-probe.log`, `qwen-acp-probe2.log`, `qwen-noauth-probe.log`):**

- `initialize` → `agentInfo {name: qwen-code, version: 0.25.2}`,
  `agentCapabilities.loadSession === true`, `sessionCapabilities` is an object
  (`{list:{}, resume:{}}`) — there is **no** `close` capability.
- `session/new {cwd, mcpServers}` → `{sessionId, models{currentModelId,…}, modes{currentModeId},
  configOptions:[mode, model]}`. The mode select starts at **`auto`** (LLM classifier
  auto-approves safe actions) — Pluton therefore pins the mode explicitly at session start
  (default: `default`, i.e. ask/deny policy per ADR-0004) instead of trusting the engine default.
- Model option values are **composite runtime ids** (`$runtime|openai|cbai/glm-5.2(openai)`); the
  display name is the bare model id. The adapter matches a Muse's configured model by exact value
  or display name and always sends the engine's value verbatim; after every
  `session/set_config_option` it re-reads `configOptions` and refuses to proceed if the engine did
  not actually switch (a mis-pinned model must fail, never run silently).
- `session/prompt` streams `session/update` (4-char `agent_message_chunk` slices,
  `agent_thought_chunk`, `tool_call`/`tool_call_update`, `usage_update` with context used/size —
  deliberately not mapped to prompt token counts, `available_commands_update`) and resolves with
  `{stopReason,…}`. `session/cancel` (notification) resolves the turn with
  `stopReason:'cancelled'`; a timed-out turn whose cancel is not acknowledged poisons the session
  (`unknown` outcome, refuses further prompts).
- `session/load` resumes a session and replays history (recall verified with a codeword); the
  native session ids live on disk under `QWEN_DIR`, so transport close does not lose resumability.
- Approvals: under mode `default`, edits and shell raise `session/request_permission` with
  `[proceed_always|allow_always, proceed_once|allow_once, cancel|reject_once]` (shell adds
  `proceed_always_project`/`proceed_always_user`). Pluton's policy (`deny` default, fail-closed;
  `allow_once`/`allow_always` explicit operator choices) maps onto the engine's own option ids;
  rejecting is safe — the tool is not run and the turn still ends `end_turn`.
- Unauthenticated `session/new` fails with **-32000** `"Authentication required: Use Qwen Code CLI
  to authenticate first."` (`data.authMethods`), mapped to `EngineAuthMissingError` — never
  retried or faked. Auth reaches the engine only via the ADR-0008 allowlist
  (`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`/`OPENAI_API_BASE`/`OPENAI_API_VERSION`/
  `DASHSCOPE_API_KEY`/`DASHSCOPE_BASE_URL`); on this host the verified path is the operator's local
  9router OpenAI-compatible gateway. (OpenCode Zen's free tier is client-locked — a non-OpenCode
  client gets HTTP 403 `FreeTierError` — so it cannot back a second engine; no new external
  credentials were introduced.)
- Engine quirks handled explicitly (never guessed): no `session/close` (-32601) → `close()` ends
  the transport instead; qwen-specific notifications (e.g. `qwen/notify/…`) are ignored and
  counted; custom server requests (e.g. `craft/drainMidTurnQueue`) are refused with **-32601**;
  the engine crashes with ENOENT if its home dir does not exist → the adapter creates the Muse
  engine home before spawning (found by the live suite).

**Verification:** shared refactor kept the OpenCode behavior green (its 42 offline tests pass
against the extracted `src/engines/acp/*` modules); the new offline suite
(`tests/unit/qwen-*.test.ts`, scripted by recorded frames in `tests/fixtures/qwen-acp/`) covers
capabilities, discovery, mode/model pinning (both already-match and switch paths), resume, MCP
mapping, auth mapping, the three approval policies, unknown server requests, stray notifications,
cancel, timeout→poison, overlap refusal, model drift and close; the opt-in live suite
(`tests/live/qwen.live.test.ts`, `PLUTON_LIVE_QWEN=1 … npm run test:live`) passed 4/4 against the
real binary including codeword-recall resume. `npm run check` = typecheck + 169 tests, green.
