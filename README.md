# Pluton-Harness

**Plan → Delegate → Execute → Verify → Deliver.**

Pluton-Harness is a **CLI-first, local-first orchestration control plane** for a team of persistent
AI coding agent identities — *Ships*. Each Ship has its own model, role instructions, permissions,
workspace policy, resource limits and a persistent tmux terminal.
Pluton is not a coding model: OpenCode does inference, Pluton's native process policy confines
execution where the host can prove it, tmux provides terminal persistence, Git tracks changes, and a
durable local runtime (SQLite) records what was requested, accepted, dispatched, completed, failed or
left uncertain.

> Status: **early implementation** — see [`docs/ROADMAP.md`](docs/ROADMAP.md) for delivered vs
> planned features and [`docs/`](docs/) for architecture, security and operational documents.
> Statements in the docs about implementation status are kept accurate; anything not executed in
> this environment is reported as NOT RUN with a reproducible command.

## Why

Running one agent is easy. Running a *team* that survives crashes, keeps auditable state, isolates
its workers, verifies its own claims and never silently merges into your branch is not. Pluton
provides the missing control plane for local multi-agent development:

- **CLI-first** — the terminal is the command center; every suitable command supports `--json`
  for automation. No web UI is required for anything.
- **Per-Ship model and role configuration** — every Ship is configured independently and model
  choices are validated against OpenCode's real capabilities. There is no global model switch.
- **Durable task truth** — SQLite-backed runs, tasks, dependency edges, receipts, events and
  approvals; request idempotency; explicit `unknown_outcome` instead of blind replay.
- **Native-only execution** — host execution is the only substrate (`sandbox.kind: native`, see
  [`docs/NATIVE_EXECUTION.md`](docs/NATIVE_EXECUTION.md)). Linux can enforce filesystem and network
  policy through the verified Landlock helper; macOS and Windows run only in the explicitly
  acknowledged `unconfined` mode. Docker and `local-process` configs are rejected with migration
  guidance, never silently downgraded.
- **Verification, not vibes** — acceptance criteria and configured checks gate run completion.

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 24 | local daemon + CLI; uses the built-in `node:sqlite` |
| Git ≥ 2.40 | checkout isolation and diff capture |
| An engine CLI | OpenCode v2 (`opencode acp` protocol); model auth configured in the Ship's engine home |
| Linux for confined modes | kernel with Landlock ABI ≥ 3 (Linux ≥ 6.2) plus the bundled `native/landlock-run` helper; `restricted`/`none` networks also need unprivileged user and network namespaces |
| Host platform | Linux supports confined `read-only`/`workspace-write`; Windows 11 and macOS support only acknowledged `unconfined`. Windows 11 is validated locally; native Linux confinement and macOS are CI-gated, not live-verified in this checkout. |

> **Engine support:** Supported inference engines are OpenCode (`engine: opencode`) via ACP
> and standard HTTP model providers (`engine: openai-compatible`, see [`docs/PROVIDERS.md`](docs/PROVIDERS.md)).
> The deterministic `mock` adapter exists for tests and development only; it is not a substitute
> for a real run. Qwen Code support was removed in the OpenCode-only migration.

Native execution needs no Docker daemon, container image or WSL2 virtual machine. See
[`docs/NATIVE_EXECUTION.md`](docs/NATIVE_EXECUTION.md) for modes, the capability matrix and exact
config keys, and [`docs/MIGRATION.md`](docs/MIGRATION.md) for moving an old `sandbox.kind: docker`
config to native.

## Quick start (intended flow)

### Installation

```bash
# After publication — not on the registry yet (see docs/RELEASE.md)
npm install -g pluton-harness
# Or from local repository checkout
npm install && npm run build && npm link
```

Releasing this package is a staged, gated process — see
[`docs/RELEASE.md`](docs/RELEASE.md) and run `npm run release:check` plus
`npm run smoke:package` (clean-install smoke). The CI workflow
(`.github/workflows/ci.yml`) runs both on Linux, macOS and Windows once this
repository is hosted with a remote.

### Launching the Graphical Workspace (Primary UX)

Pluton launches as a dedicated graphical application workspace by default:

```bash
pluton                             # opens the graphical workspace for current directory (desktop window)
pluton .                           # explicitly opens current workspace
pluton "C:\path\to\my project"     # opens a workspace with spaces in path
pluton --browser                   # opens graphical workspace in default web browser
pluton --headless --detach         # runs local control plane as a background daemon
pluton --status                    # checks running workspace server status and port
pluton --stop                      # cleanly stops the background server for this workspace
pluton --tui                       # launches interactive terminal chat TUI instead of graphical window
```

### Command-line Operations

```bash
pluton doctor                      # checks OS/runtime, Git, tmux, engines, native policy and config
pluton init                        # write pluton.yaml + .pluton/roles in the current project (native default)
pluton chat [ship]                 # chat with an operator Ship (default: supervisor) or `pluton ship chat <ship>`
pluton run --goal "Implement auth" # supervised run: the manager Ship plans and delegates on the host
pluton verify --run <id>           # run the project's verification checks, apply the verdict
pluton attach <ship>               # live host tmux session (tmux is visibility, not a security boundary)
pluton integrate --run <id>        # merge verified task branches into the integration checkout (never main)
pluton approvals list              # operator inbox: list/approve/deny pending approvals
pluton status                      # shows recent runs and task counts from durable state
```

## Desktop Delivery Architecture & Packaging (ADR-0015)

Pluton uses a two-tier desktop delivery model with **one shared graphical frontend** and **one authoritative SQLite runtime**:

1. **Tier 1 (Verified Production Default): App-Mode Window Launcher**
   - Intended distribution: npm (`npm install -g pluton-harness`, available after the first public release).
   - Automatically detects and launches Microsoft Edge (`msedge.exe --app=URL`) on Windows or Google Chrome/Chromium on Linux and macOS.
   - Provides a distraction-free window without URL bars or browser chrome, with native window frame and taskbar grouping.
   - Falls back gracefully to the default system browser if no Chromium engine is detected.
   - Zero heavyweight runtime downloads (keeps package size under 2MB).

2. **Tier 2 (Future Standalone Installer Distribution): Tauri v2 WebView2 Wrapper**
   - For standalone Windows installers (`.msi`, `.exe`) distributed via GitHub Releases or `winget`.
   - Connects to the local Pluton server without duplicating UI code or runtime logic.
   - Requires the Rust toolchain (`cargo`, `rustc` ≥ 1.75) and MSVC C++ Build Tools to compile.

## Troubleshooting & Lifecycle Management

- **Port in use or existing server:** Pluton automatically reuses an existing healthy server instance running for the same workspace (`checkServerHealth` verifies token, project ID, and workspace path — path comparison is case-insensitive where the filesystem is, e.g. `C:\Work\App` = `c:\work\app`). If an explicitly requested port is taken, the error names the port and suggests `--port`.
- **Stale instance after crash:** If a previous server process terminated abruptly, `pluton` detects dead PIDs and cleans up stale `.pluton/run/server.json` files automatically.
- **Stopping servers:** Run `pluton --stop` in the workspace directory to cleanly terminate background daemons. For safety, `--stop` only signals a process that passes the authenticated health check for this workspace; a stale PID that was recycled by an unrelated process is reported, not killed.
- **Concurrent launches:** Launching twice at once is serialized by an atomic workspace claim (`.pluton/run/server.claim`); the second launch waits for and reuses the first server instead of starting a duplicate.
- **Log inspection:** When run with `--detach`, stdout and stderr are recorded in `.pluton/run/server.log` (owner-only `0600`; it contains the tokenized workspace URL — treat it as a credential).

## Interactive Chat TUI

Pluton includes an interactive chat TUI (zero runtime dependencies, hand-rolled inline renderer).
Running `pluton` bare in a project (or `pluton chat [ship]`) connects the operator to an operator Ship:

- **Keybindings:**
  - `Enter` — send prompt
  - `Escape` — interrupt active turn
  - `Ctrl+C` — clear current input
  - `Ctrl+D` — exit chat
  - `Up` / `Down` — cycle command and prompt history
  - `Left` / `Right`, `Home` / `End`, `Backspace` / `Delete` — text editing
- **Slash Commands:**
  - `/help` — show available slash commands
  - `/status` — show project status, current/latest run and pending approvals
  - `/runs` — list recent runs
  - `/run <goal>` — start a new supervised run in the background
  - `/approvals` — list pending approvals
  - `/approve <ref>` — approve a pending approval
  - `/deny <ref>` — deny a pending approval
  - `/new` — close current session and start a fresh chat session
  - `/exit`, `/quit` — exit chat
- **Resume & Execution Continuity:**
  - Chat transcripts and engine resume tokens persist durably in SQLite.
  - Resume with `pluton chat --continue` or `pluton chat --resume <session-id>`.
  - Exiting the chat TUI while a background run is active keeps the run progressing in the background. Re-entering chat automatically reconnects event polling.

## Command families (target surface)

`doctor` · `init` · `project` · `ship` (list/show/create/edit/chat·engine/model; `muse` is a
deprecated alias) · `chat` · `run` ·
`status` · `runs` · `task` (list/show/graph/diff/retry) · `verify` · `integrate` · `attach` ·
`approvals` (list/approve/deny) · `stop` · `logs` — all with `--json` where meaningful.

## Repository layout

```
src/chat/           operator chat sessions and turn orchestration
src/cli/            CLI entry & command handlers
src/config/         pluton.yaml schema + loaders
src/desktop/        app-mode window launcher
src/domain/         IDs, state machines, contracts (no I/O)
src/engines/        engine contract + OpenCode adapter + deterministic mock
src/execution/      native execution provider, policy matrix, Landlock helper integration
src/orchestrator/   manager bridge, task graph, scheduler, approvals, integration
src/plan/           durable plan records and plan-to-run handoff
src/server/         local REST/SSE application server
src/store/          SQLite schema, migrations, durable stores
src/terminal/       host tmux lifecycle & safe attach
src/tools/          tool bridge catalog, handlers and MCP transports
src/tui/            interactive chat TUI
src/ui/             graphical workspace frontend
src/util/           shared exec, redaction and sanitization helpers
src/verify/         acceptance checks & run verdicts
src/workspace/      checkout isolation, diffs, integration
native/landlock-run/  verified Linux Landlock/namespace helper (Rust)
templates/          team templates & role prompts
scripts/            build, release, demo and documentation gates
tests/              unit · integration · e2e (opt-in)
docs/               product, architecture, security, ADRs, reverse-engineering
```

## Documentation index

[NATIVE EXECUTION](docs/NATIVE_EXECUTION.md) · [MIGRATION GUIDE](docs/MIGRATION.md) ·
[ACCEPTANCE REPORT](docs/ACCEPTANCE_REPORT.md) · [ROADMAP](docs/ROADMAP.md) ·
[SECURITY](docs/SECURITY.md) · [RELEASE](docs/RELEASE.md) ·
[ARCHITECTURE](docs/PLUTON_ARCHITECTURE.md) · [BASELINE](docs/PLUTON_BASELINE_REPORT.md) ·
[DELIVERY REPORT](docs/delivery-report.md) · [ADRs](docs/adr/) ·
[Reverse engineering](docs/reverse-engineering/)

## Independence & licensing

Pluton-Harness is licensed under the Apache License, Version 2.0 (see [`LICENSE`](LICENSE)). It is an independent project, **not affiliated with** Cloudroom, OpenMausBot,
OpenCode or their maintainers; those repositories are studied for architectural patterns only.
See [`docs/reverse-engineering/reuse-and-license-audit.md`](docs/reverse-engineering/reuse-and-license-audit.md)
and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
