# Pluton-Harness

**Plan → Delegate → Execute → Verify → Deliver.**

Pluton-Harness is a **CLI-first, local-first orchestration control plane** for a team of persistent
AI coding agent identities — *Muses*. Each Muse has its own engine (OpenCode, …), model, role
instructions, permissions, workspace policy, resource limits and a persistent tmux terminal.
Pluton is not a coding model: engines do inference, containers provide process isolation, tmux
provides terminal persistence, Git tracks changes, and a durable local runtime (SQLite) records
what was requested, accepted, dispatched, completed, failed or left uncertain.

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
- **Multiple engines, per Muse** — engine and model are chosen per Muse and validated against the
  engine's real capabilities. No global "one engine for everyone" switch.
- **Durable task truth** — SQLite-backed runs, tasks, dependency edges, receipts, events and
  approvals; request idempotency; explicit `unknown_outcome` instead of blind replay.
- **Real isolation** — workers run in Linux containers (Docker Desktop/WSL2 on Windows); tmux is
  terminal persistence, *not* a security boundary.
- **Verification, not vibes** — acceptance criteria and configured checks gate run completion.

## Prerequisites (first supported setup: Windows 11 + WSL2 + Docker Desktop)

| Requirement | Notes |
|---|---|
| Windows 11 with WSL2 | `wsl --version` must report WSL 2 |
| Docker Desktop (Linux containers) | the daemon must be running; Pluton talks to it via the `docker` CLI |
| Node.js ≥ 24 | local daemon + CLI; uses the built-in `node:sqlite` |
| Git ≥ 2.40 | checkout isolation and diff capture |
| An engine CLI | e.g. OpenCode v2 (`opencode acp` protocol); model auth configured per engine |

Linux is fully supported as the daemon host; macOS is untested. Native PowerShell has no tmux —
worker terminals live inside Linux containers. See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)
and the WSL2 notes in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Quick start (intended flow)

```bash
npm install
npm link                           # installs `pluton` globally into PATH (or run `node src/cli/main.ts`)
pluton                             # opens the interactive chat TUI with the operator Muse (in a Pluton project)
pluton doctor                      # checks OS/runtime, Docker, Git, tmux, engines, config
pluton init                        # write pluton.yaml + .pluton/roles in the current project
pluton chat [muse]                 # chat with an operator Muse (default: supervisor) or `pluton muse chat <muse>`
pluton run --goal "Implement auth" # supervised run: the manager Muse plans and delegates
pluton verify --run <id>           # run the project's verification checks, apply the verdict
pluton attach <muse>               # live tmux session inside the Muse's container
pluton integrate --run <id>        # merge verified task branches into the integration checkout (never main)
pluton approvals list              # operator inbox: list/approve/deny pending approvals
pluton status
```

## Interactive Chat TUI

Pluton includes an interactive chat TUI (zero runtime dependencies, hand-rolled inline renderer).
Running `pluton` bare in a project (or `pluton chat [muse]`) connects the operator to an operator Muse:

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

`doctor` · `init` · `project` · `muse` (list/show/create/edit/chat·engine/model) · `chat` · `run` ·
`status` · `runs` · `task` (list/show/graph/diff/retry) · `verify` · `integrate` · `attach` ·
`approvals` (list/approve/deny) · `stop` · `logs` — all with `--json` where meaningful.

## Repository layout

```
src/cli/            CLI entry & command handlers
src/domain/         IDs, state machines, contracts (no I/O)
src/runtime/        durable scheduler & lifecycle supervision
src/persistence/    SQLite schema + migrations (node:sqlite)
src/engines/        engine contract + adapters (opencode, second engine, deterministic mock)
src/orchestration/  Manager tool bridge, task graph, budgets, approvals
src/sandbox/        Docker container lifecycle policy
src/terminal/       tmux session lifecycle & safe attach
src/workspace/      checkout isolation, diffs, integration
src/verification/   acceptance checks & run verdicts
src/config/         pluton.yaml schema + loaders
templates/          team templates & role prompts
tests/              unit · integration · e2e (opt-in)
docs/               product, architecture, security, ADRs, reverse-engineering
```

## Documentation index

[PRODUCT](docs/PRODUCT.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [SECURITY](docs/SECURITY.md)
· [ENGINE_ADAPTERS](docs/ENGINE_ADAPTERS.md) · [TASK_LIFECYCLE](docs/TASK_LIFECYCLE.md) ·
[MUSE_CONFIGURATION](docs/MUSE_CONFIGURATION.md) · [WORKSPACES_AND_GIT](docs/WORKSPACES_AND_GIT.md)
· [TMUX](docs/TMUX.md) · [DEVELOPMENT](docs/DEVELOPMENT.md) · [ROADMAP](docs/ROADMAP.md) ·
[ADRs](docs/adr/) · [Reverse engineering](docs/reverse-engineering/)

## Independence & licensing

Pluton-Harness is an independent project. It is **not affiliated with** Cloudroom, OpenMausBot,
OpenCode or their maintainers; those repositories are studied for architectural patterns only.
See [`docs/reverse-engineering/reuse-and-license-audit.md`](docs/reverse-engineering/reuse-and-license-audit.md)
and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
