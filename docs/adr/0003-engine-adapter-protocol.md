# ADR-0003 — Engine adapter protocol and the first two engines

- Status: **Proposed** (2026-10-16) — finalized in Phase 4 after protocol-doc verification and a
  local install/handshake probe of the second-engine candidate

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
