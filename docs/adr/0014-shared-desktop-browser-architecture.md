# ADR-0014 — Dual Desktop and Browser Graphical Application Architecture

- Status: Accepted (2026-10-18)

## Context

Pluton's existing interface architecture (ADR-0012, ADR-0013) provided an interactive terminal UI (TUI 2.0). To scale Pluton into a production-grade developer platform combining the project-opening and coding-agent workflow of OpenCode and Claude Code with the polished graphical workspace experience of Codex and DeepSeek, Pluton requires:

1. A dedicated graphical desktop application running in its own window.
2. A browser-accessible graphical application at a local URL.
3. An npm-installable CLI launcher (`pluton`, `pluton .`, `pluton <path>`) working smoothly in Windows PowerShell.
4. Identical application experience, data contracts, and session models across desktop and browser.
5. Strict preservation of the existing agent runtime, multi-agent orchestration, file lease management, SQLite persistence, tool sandbox, and security model.
6. A proper graphical application interface (not a terminal UI, TUI, or terminal emulator).

## Decision

We adopt **Architecture Option C: Shared Web Application + Local Application Server + Standalone Desktop Window Shell**.

### 1. Unified Layered Architecture

```
┌────────────────────────────────────────────────────────┐
│               Desktop App (Edge/Chrome App Window)     │
│             OR Browser App (http://127.0.0.1:<port>)   │
└───────────────────────────▲────────────────────────────┘
                            │ HTTP / SSE / Token Auth
┌───────────────────────────┴────────────────────────────┐
│         PLUTON Application Server (src/server/)        │
│  - Static Asset Delivery                               │
│  - REST / JSON API (Sessions, Runs, Approvals, Muses)  │
│  - Server-Sent Events (SSE) Real-Time Stream           │
│  - Origin & Token Validation (CSRF / Cross-Origin Gate)│
└───────────────────────────▲────────────────────────────┘
                            │ In-Process Service Boundary
┌───────────────────────────┴────────────────────────────┐
│             Authoritative PLUTON Runtime               │
│  - Store & SQLite DB (.pluton/state/pluton.sqlite)     │
│  - RunSupervisor, PlanManager, FileLeaseManager        │
│  - UsageLedger, CircuitBreaker, WakeupRegistry         │
│  - Engine Adapters (OpenCode, Mock)                     │
│  - Restricted Tool Bridge & Sandbox Containers         │
└────────────────────────────────────────────────────────┘
```

### 2. Boundaries and Components

- **Local Application Server (`src/server/`):**
  - Built with Node 24 standard library (`node:http`, `node:fs`, `node:path`). Zero heavy web framework dependencies.
  - Binds strictly to `127.0.0.1` (loopback only) on an ephemeral or configured port.
  - Generates a cryptographically random session token (`X-Pluton-Token`) stored in `<project>/.pluton/run/server.json`.
  - Protects against cross-origin attacks: validates `Origin` and `Host` headers, rejects unauthorized cross-origin requests.
  - Endpoints:
    - `GET /api/health` — Service readiness and version check.
    - `GET /api/workspace` — Active workspace metadata, files, and git status.
    - `GET /api/sessions` & `POST /api/sessions` — Chat session listing and creation.
    - `GET /api/sessions/:id` — Session details, transcript blocks, and history.
    - `POST /api/sessions/:id/prompt` — Dispatch prompt turn to the engine adapter.
    - `POST /api/sessions/:id/cancel` — Abort in-flight prompt stream.
    - `GET /api/runs` & `GET /api/runs/:id` — Multi-agent orchestration runs and task graph.
    - `POST /api/runs` — Trigger new multi-agent run.
    - `GET /api/approvals` & `POST /api/approvals/:id` — List pending approvals, decide (`approved` | `denied`).
    - `GET /api/muses` — List configured Muses and engine status.
    - `GET /api/events` — Server-Sent Events (SSE) stream broadcasting live agent tokens, tool lifecycle, run status, and approval notices to all connected clients.
    - `GET /*` — Serves the bundled shared graphical frontend.

- **Shared Graphical Frontend (`src/web/` bundled to `dist/web/`):**
  - Built with clean, modern HTML5, CSS3, and ESM TypeScript conforming to the PLUTON design system:
    - Palette: `#0B0C10` (background), `#9D7CD8` (purple accent), `#10B981` (success), `#EF4444` (error), `#60A5FA` (info), `#F3F4F6` (text), `#6B7280` (muted), `#272B3A` (surfaces/borders).
  - Modules:
    - **AppShell**: Navigation, workspace selector, runtime connectivity indicator, theme variables.
    - **ConversationWorkspace**: Real-time streaming assistant messages, markdown, code blocks, diff views, prompt composer, abort button.
    - **AgentOrchestra**: Graphical inspector showing Muses, task graph DAG, states, write leases, and usage ledger telemetry.
    - **ApprovalInterface**: Actionable approval card/banner with fail-closed approve/deny controls and diff/context inspection.
    - **SessionHistory**: Sidebar with past sessions, task timelines, and search.
    - **ModelsSettings**: Engine provider status, model selection, doctor checks.

- **Desktop Shell Delivery:**
  - On Windows, launches via dedicated application window mode using system Chromium/Edge:
    `msedge.exe --app=http://127.0.0.1:<port>/?token=<token> --window-size=1280,840` (or `chrome.exe --app=...`).
  - Launches as a standalone native window: no browser URL address bar, no navigation tabs, custom title, standalone taskbar grouping, native window resize/snap.
  - Zero heavy binary dependencies (no 200MB Electron download, no Rust compilation).

- **Browser Delivery:**
  - Navigating to `http://127.0.0.1:<port>/?token=<token>` in any modern browser opens the identical application.
  - Session state, history, and active streams synchronize in real time across desktop and browser through the single authoritative SQLite store and SSE feed.

- **CLI Launcher (`src/cli/commands/app.ts` & `src/cli/main.ts`):**
  - Invoking `pluton`, `pluton .`, or `pluton <path>`:
    1. Resolves workspace path, handles Windows paths with spaces and drive letters (`Y:\...`).
    2. Checks `<workspace>/.pluton/run/server.json` to discover if a server is already running.
    3. Reuses existing server instance if healthy.
    4. Otherwise, starts the local application server in background or managed mode.
    5. Waits for readiness with a bounded timeout (10s).
    6. Launches the desktop window (default) or prints browser URL (with `--browser` or headless).

## Alternatives Considered

### Alternative 1: Electron Desktop Wrapper with Embedded Node.js
- **Pros:** Full access to Electron IPC and native menus.
- **Cons:** Adds 200+ MB npm download, complex packaging, potential duplicate node_modules, and fails to serve browser access without separate server plumbing.
- **Why rejected:** Violates minimal footprint and creates two different execution environments.

### Alternative 2: Tauri Desktop Wrapper
- **Pros:** Very small binary size, native webview.
- **Cons:** Requires Rust compiler (`cargo`), which is absent in this Windows environment and adds high CI/install friction for an npm package.
- **Why rejected:** Missing prerequisite build toolchain in target environment.

### Alternative 3: Terminal Emulator inside Web Window (xterm.js)
- **Pros:** Easiest migration from TUI.
- **Cons:** Explicitly rejected by user specification ("The primary user experience must be a proper application interface, not a terminal UI, TUI, or terminal emulator").
- **Why rejected:** Fails the primary product requirement.

## Consequences

### Positive
- Exactly one authoritative agent runtime, one store, and zero duplicated business logic.
- Desktop and browser provide identical user experiences, shortcuts, and visual layouts.
- Fast, zero-compile startup on Node 24 with native Windows Edge/Chrome integration.
- Secure by default: bound to loopback with origin and token authorization.
- Backward compatibility: existing `pluton run`, `pluton chat`, `pluton doctor`, and MCP tools remain 100% operational.

### Negative
- Requires maintaining the HTTP/SSE server and frontend presentation code within the repository.
- Native OS desktop shortcuts and system tray require platform-specific shell integration.
