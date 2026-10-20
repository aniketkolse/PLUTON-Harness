# PLUTON SPA — Reference UI Replacement and Functional Integration

Date: 2026-10-20
Target surface: the graphical SPA served by `src/server/static-assets.ts` (ADR-0014),
launched by `pluton app` into a Chromium app-mode window.

## 1. Why this surface

The reference screenshot is a dark, desktop-first AI coding workspace with a left
navigation sidebar, a left-aligned conversation stream, a bottom composer and a
bottom status strip. The repository already ships exactly one surface that matches
that shape: the embedded SPA (`/index.html`, `/app.css`, `/app.js`) served over
loopback with SSE. The terminal UI in `src/tui/` is a different product surface
(ADR-0012/0013) and is out of scope.

The current SPA is what the reference replaces. It already contains the exact
elements the brief tells us to remove:

| Current SPA element | Brief | Action |
| --- | --- | --- |
| `sidebar-header h3` "Conversations" | "Remove the old standalone CONVERSATIONS heading" | removed |
| `.header-nav` (Chat/Orchestra/Approvals/Files/Settings) | "Do not display the old top navigation" | removed; Files/Settings move into the sidebar, Orchestra/Approvals into the Settings pane |
| `.message-bubble.user { align-self: flex-end }` | "Remove right-aligned user-message layouts" | both roles left-aligned in one column |
| `sbMode` ("Mode: chat"), `sbCostItem` ("Cost:"), `sbMusesCount` ("N Muses") | "Remove the obsolete Mode, Cost and Muse-count indicators" | removed from the status strip |
| Hardcoded `sessionsData` / `mcpServers` / `availableModels` arrays in the mock | "Do not hardcode sessions, models, paths, MCP counts" | replaced with live API data |

## 2. Runtime capability audit (what may honestly be wired)

Derived from the source, not from the reference mockup:

| Reference control | Real Pluton capability | Verdict |
| --- | --- | --- |
| Sessions tab / New Session / session row | `GET/POST /api/sessions`, `GET /api/sessions/:id`, `store.createChatSession` | **wire** |
| Files tab | `GET /api/files`, `GET /api/files/content` | **wire** |
| Settings | `GET /api/workspace`, `/api/muses`, `/api/models`, `/api/approvals` | **wire** |
| Sidebar toggle / resize | client-side only | **wire** |
| Build button | `startRunInBackground` → manager-driven supervisor (`skipManager` defaults false) | **wire** as Chat/Build mode switch |
| Attach | no attachment model exists (`ChatMessageRecord` has no attachments; `PromptRequest` has none) | **wire as a workspace file picker** whose content is inlined into the prompt through the existing read-only file API — the only real mechanism available |
| Microphone | **not implemented anywhere** in the repo | **disabled control with an explicit unsupported explanation** |
| Thinking effort | **not implemented** (no config field, no engine field; ACP even discards `agent_thought_chunk`) | **no effort control**; the strip shows the real execution status only |
| Model selector | `GET /api/models` (real engine registry) exists; switching is CLI-only (`/model` → `store.updateMuseModel`) | **new** `POST /api/muses/:id/model` |
| MCP badge | Pluton is the MCP **server**; it hands `McpServerSpec`s to engines. There is no MCP client and no engine-side connect ack | **wire a real registry**: the SPA now builds the same `PlutonToolBridge` + `ToolHttpServer` the CLI builds, hands the spec to the engine, and reports live registrations. The engine-side handshake is explicitly reported as *not observable* |

## 3. Backend changes (`src/server/routes.ts`, `src/server/types.ts`)

1. **Tool bridge in the SPA prompt path.** `executePromptTurn` currently calls
   `adapter.startSession(...)` with no `mcpServers`, so an SPA engine session has
   **no Pluton tools at all** — unlike `pluton chat`
   (`src/cli/commands/chat.ts:265-295`). The router now builds the same
   `PlutonToolBridge` (operator scope) and `ToolHttpServer` and passes the spec
   to the engine. This is reuse of the existing pipeline, not a second one.
2. **`GET /api/mcp`** — the live MCP registration registry: one entry per chat
   session that owns a bridge, with its real state. `connected` counts
   registrations whose transport is up and whose engine session is still open.
3. **`POST /api/muses/:id/model`** — real model switch: validate against the
   engine's own `listModels()`, then `store.updateMuseModel` (persisted) and
   restart the live engine session for that Muse, mirroring
   `ChatSession.switchModel`.
4. **`POST /api/runs/:id/start`** and **`POST /api/runs/:id/cancel`** — the
   Build mode's supervised-run entry point and its durable cancel
   (`requestRunCancel`), reusing `startRunInBackground` / the supervisor.

Progress for a Build-mode run arrives over the existing SSE `run_state` /
`task_state` frames (derived from the durable event log by
`src/server/log-watcher.ts`) — no new event channel.

## 4. Frontend changes (`src/server/static-assets.ts`)

- **Shell**: sidebar (280px, resizable, collapsible) + main column
  (header / scrollable stream / composer + status strip).
- **Header**: logo, `PLUTON`, `Agentic Harness` badge, connection status. No
  second header; the workspace badge moves to the status strip.
- **Sidebar panes**: Sessions (new + list), Files (tree + preview), Settings
  (runtime card, model registry, per-Muse model assignment, permissions &
  approvals, pending approvals, MCP servers, workspace root, active run).
- **Stream**: one left-aligned column; user bubbles are purple-tinted, AI
  bubbles are neutral with a cyan `PLUTON` label; markdown (headings, lists,
  code fences, inline code, links, quotes), tool cards, system notices.
- **Composer**: multiline textarea (Enter submits, Shift+Enter newline),
  Chat/Build switch, Attach, Microphone (disabled), Send/Stop.
- **Status strip**: thinking status, workspace chip (static — there is no
  workspace picker to open), model selector popover, context indicator,
  MCP button + live count at the far right.
- **Scrollbars**: themed for both the sidebar and the stream; the stream
  auto-scrolls only while the reader is already near the bottom.

## 5. Verification

- `npm run typecheck`, `npm test`, `npm run build`.
- New integration test `tests/integration/spa-ui.test.ts` (own file, so the
  in-flight edits to `tests/integration/server-api.test.ts` stay untouched).
- Launch `pluton app` against this workspace and screenshot the real render.
