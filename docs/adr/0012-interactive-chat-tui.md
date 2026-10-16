# ADR-0012 — Interactive chat TUI: zero-dependency inline renderer and the operator bridge scope

- Status: Accepted (2026-10-17)

## Context

The operator asked for an interactive TUI chat "like pi and Claude Code": one Muse acting as the
operator's proxy — streaming conversation, tool calls as they happen, approvals, and the ability
to command the harness from the conversation (the README's `muse … chat` target surface).

Stack research (2026-10-17, read-only): Ink 8 — Claude Code's renderer — is ~60 packages / ~15 MB
and needs a JSX compile step (Node 24 type-stripping does not transform JSX), which would break
this repo's no-build-step property; `@earendil-works/pi-tui` is young and pi-specific; a
zero-dependency inline renderer is ~600–1000 LOC against Node 24 builtins (`node:readline` raw
mode, ANSI cursor control, `process.stdout` resize).

The codebase already streams everything a TUI needs: the engine session contract
(`src/engines/contract/types.ts`) normalizes `text`/`tool`/`usage`/`approval_request`/`result`
events out of `sendPrompt()`, and the restricted tool bridge (ADR-0007) is the audited command
surface. Two gaps: the bridge requires an existing run row, and nothing persists chat sessions.

ADR-0001/0011: 3 runtime dependencies (commander/yaml/zod); the ACP client, MCP server and HTTP
transport are all hand-rolled; no verbatim reuse.

## Decision

- **Zero new dependencies; inline renderer.** The chat UI is pure modules
  (`src/tui/width|theme|render|editor|keys|state.ts`) plus one I/O module
  (`src/tui/terminal.ts`, the `ChatIo` seam) that owns raw mode, keypress events, resize, and the
  live-region redraw. Finalized transcript blocks are plain writes to scrollback; only the short
  bottom region (status + streaming text + input) is redrawn via cursor-up + clear-down. No
  alt-screen, no DECSTBM scroll regions, no `ESC[6n` (Windows/ConPTY — ADR-0010).
- **Entry points.** `pluton chat [muse]` and `pluton muse chat <muse>` are the same flow; bare
  `pluton` opens chat only in a project with TTY stdio (otherwise the previous help behavior).
  `--json` resolves the chat plan and never starts the engine, spawns a container, or binds the
  bridge (the `attach` plan-mode precedent).
- **Operator Muse.** Default target = the project's supervisor-role Muse (the same resolution
  `pluton run` uses); any enabled Muse is targetable. The session runs in the Muse's per-Muse
  container (ADR-0004) with the project mount read-only, like the manager in `run`.
- **Operator bridge scope** (extends ADR-0007). `PlutonToolBridgeOptions.runId` becomes optional:
  absent = operator scope, no run row required, exposing **only** the operator catalog
  (`project.status`, `run.list`, `run.get`, `run.start`, `approvals.list`; permissions of the
  same names, `run.inspect` for `run.get`). Identity stays server-side; per-call permission
  checks and `tool.call`/`tool.denied` audit events are unchanged (`run_id: null` for operator
  calls); run scope keeps the existing catalog and never sees operator tools.
- **Chat persistence.** Migration v3 adds `chat_sessions` + `chat_messages`; `--continue` /
  `--resume <id>`; native resume tokens are passed only to engines whose capabilities advertise
  resume (opencode yes; qwen degrades to transcript re-render, documented).
- **`run.start` drives in-process.** The chat process creates the run (same admission/receipt
  path as `pluton run`) and hosts its `RunSupervisor` in the background — one chat-started run at
  a time; progress renders from the durable event cursor (`store.eventsSince`). Exiting chat
  stops the supervisor, the same semantics as Ctrl+C on `pluton run`.
- **Approvals in the TUI.** Pluton approvals are listed and decided from chat (`/approvals`,
  `/approve`, `/deny`) through the existing decide path. Engine-level permission prompts
  (`session/request_permission`) remain fail-closed exactly as today and are surfaced in the
  transcript; an async interactive handler contract is an explicit follow-up.

## Consequences

- The renderer is ours to maintain: display-width tables are a documented subset of UAX#11;
  Windows quirks are avoided by construction (allowed sequences: cursor up/forward, clear-down,
  bracketed paste; no cursor-position queries).
- Ink and pi-tui remain contained alternatives behind `ChatIo` if the inline renderer ever proves
  insufficient.
- Operator scope is a new authorization surface: permission-gated, audited, and scope-isolated
  from run tools (pinned by tests both ways).
- Chat-started runs die with the chat process; warned on exit and documented. One active
  chat-started run at a time (guard returns a typed tool error).

## Evidence

- Research reports (2026-10-17): pi/Claude Code TUI pattern inventory; Node TUI stack matrix
  (context7: ink@8, @clack/prompts, @inquirer/prompts, terminal-kit, blessed forks, zero-dep);
  Pluton codebase seam map (engine contract, tool bridge, store, test fakes).
- Plan: `docs/superpowers/plans/2026-10-17-tui-chat.md`.
