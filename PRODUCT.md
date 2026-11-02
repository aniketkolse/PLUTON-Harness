# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The graphical workspace is a browser application served from the local Pluton server and launched
as an Edge/Chrome app window or opened at a local URL. The product also ships an interactive
terminal interface; the terminal surface is a sibling rendering target of the same system, not a
separate platform.

## Users

One solo operator running PLUTON locally for weeks against a long-lived real repository. They live
in the graphical workspace during the day and drop to the CLI for scripted and batch work.

Today the audience is the project's author plus a small number of early adopters on a
not-yet-published package. There is no team-plan, seat-based, or multi-tenant usage.

## Product Purpose

PLUTON is a CLI-first, local-first orchestration control plane for a team of persistent AI agent
identities called **Ships**. Each Ship has its own model, role instructions, permissions,
workspace policy, resource limits, and terminal. Pluton is not a coding model: OpenCode does
inference, the native provider enforces filesystem/network policy where the host supports it, tmux
provides terminal persistence, Git tracks changes, and a durable local runtime (SQLite) records what
was requested, accepted, dispatched, completed, failed, or left uncertain.

Success means a supervised run delegates real work, the delegated tasks complete, the configured
verification checks pass, and the verified branches integrate into a branch the operator chose —
with an auditable record of every step, including the steps that failed or stayed uncertain.

## Positioning

PLUTON is the control plane around the models, not a model. The mechanism a neighbouring product
could not truthfully copy is **durable task truth**: request idempotency, explicit
`unknown_outcome` instead of blind replay, fail-closed operator approvals, write leases per Ship,
and integration that never silently merges into the operator's branch. On top of that, the model
and role are chosen per Ship and validated against OpenCode's real capabilities — there is no
global model switch.

## Operating Context

- **First supported setup**: Windows 11 (native, explicitly `unconfined`) and Linux (confined
  `read-only`/`workspace-write` with the verified Landlock helper). macOS is policy-supported in
  `unconfined` mode through the same provider but is not live-verified here. `pluton attach` needs
  host `tmux`; runs and chat work without it.
- **Runtime**: Node.js >= 24 (built-in `node:sqlite`), Git >= 2.40 for checkout isolation and diff
  capture, OpenCode v2 over the ACP stdio protocol, or OpenAI-compatible HTTP model providers
  (DeepSeek, Groq, OpenAI, Ollama, etc.) with credentials isolated per provider (see `docs/PROVIDERS.md`).
  The deterministic `mock` adapter is for tests/dev only.
- **State**: one authoritative SQLite database per workspace at `.pluton/state/pluton.sqlite`
  holding runs, tasks, dependency edges, receipts, events, approvals, sessions, and resume tokens.
  Workspace-local runs, logs, and server claims live under `.pluton/run/`.
- **Launch**: `pluton` opens the graphical workspace for the current directory; `--browser` opens
  it in the default browser; `--headless --detach` runs the control plane as a background daemon;
  `--tui` launches the interactive terminal chat instead. The local server is tokenized and
  validates origin on every request.
- **Daily ritual**: `pluton run --goal "..."` starts a supervised run that plans and delegates;
  pending approvals arrive in the operator inbox (graphical Approvals view or
  `pluton approvals list`); `pluton verify --run <id>` applies the verdict;
  `pluton integrate --run <id>` merges verified task branches into the integration checkout —
  never into main. `pluton status` and `pluton doctor` are the first commands anyone runs.
- **Two surfaces, one runtime**: the graphical workspace and the terminal interface share the same
  data contracts, session models, and application experience (ADR-0014). Every suitable CLI command
  also supports `--json` for automation.

## Capabilities and Constraints

- **Zero runtime dependencies for the interface.** The graphical workspace is a single embedded
  HTML/CSS/JS asset set shipped inside the npm package; the terminal interface is a hand-rolled
  inline renderer. No UI framework, no build step, no CDN, no network calls from the UI to
  external services. The package stays under 2 MB.
- **Two rendering environments, one system.** The visual system must hold in a browser (truecolor
  CSS) and in a terminal (truecolor, 256-color, 16-color, and `NO_COLOR` fallbacks). Terminal
  fallbacks are a functional requirement, not a courtesy: the terminal is the CLI-first surface.
- **The canonical palette lives in `src/ui/theme.ts`** (`PALETTE`), and both surfaces resolve
  through it: the browser workspace reads the same values in its CSS `:root`, and the terminal
  interface maps its own role vocabulary onto the same roles and degrades through one shared
  256- and 16-colour table. There is no second, drifting token set.
- **Local-first and offline.** The control plane talks to the local OpenCode engine, the native
  execution helper, and a local database. Nothing about the interface depends on a hosted service.
- **The terminal is always sufficient.** Every capability reachable in the graphical workspace is
  reachable from the CLI, and every suitable command emits JSON for automation.
- **Same experience, two shells.** Desktop app window and browser must show the same screens,
  state, and session model, because they are the same application (ADR-0014).
- **Undecided / not yet true**: the package is not published to the npm registry; OpenCode is the
  only supported real engine (the `mock` adapter is dev/test only); macOS is untested; the
  standalone Tauri v2 installer (ADR-0015 Tier 2) is planned, not built.

## Brand Commitments

All five of the following are binding on future design work.

- **Name and vocabulary**: the product is **PLUTON**; the agent identities are **Ships** (the
  legacy name *Muses* survives only as deprecated aliases for configs, APIs and the `pluton muse`
  command). The motto is **Plan → Delegate → Execute → Verify → Deliver**.
- **The maritime motif is the visual signature**: the ship mark in the brand, the anchor in the
  empty state and status bar, the sailboat glyph in the terminal theme. Design work extends this
  motif; it does not replace it.
- **Muted violet is the identity accent** (`#8B5CF6`, 256-colour 141), with cool cyan as the
  focus colour.
- **CLI-first, no web UI required**: the graphical workspace is a convenience over the same
  runtime, never a gate. No feature may exist only in the graphical app.
- **Independence and licensing posture**: PLUTON is not affiliated with Cloudroom, OpenMausBot, or
  OpenCode. Those projects are studied for architectural patterns only; no borrowed assets, names,
  or trademarks.

## Evidence on Hand

- Product and architecture documentation under `docs/`: `PLUTON_ARCHITECTURE.md`, `SECURITY.md`,
  `RELEASE.md`, `ROADMAP.md`, `PLUTON_BASELINE_REPORT.md`, `delivery-report.md`, `architecture-audit.md`.
- 15 accepted architecture decision records under `docs/adr/`, including ADR-0012, ADR-0013, ADR-0014
  (dual desktop and browser application architecture) and ADR-0015 (desktop delivery and packaging).
- Reverse-engineering and licence-audit reports under `docs/reverse-engineering/`, including the
  reuse register (empty).
- A working CLI (`doctor`, `init`, `ship`, `chat`, `run`, `verify`, `attach`, `integrate`,
  `approvals`, `status`) and the graphical workspace server with its embedded single-page app.
- A vitest unit, integration, and opt-in e2e suite, including a terminal visual-acceptance test.
- **Absent, and therefore never to be fabricated**: no published package, no pricing, no public
  customers, no testimonials, no case studies, no press, no performance or benchmark claims, and
  no logo assets beyond the inline ship mark.

## Product Principles

1. **The control plane never guesses.** If the runtime does not know the outcome, it records
   `unknown_outcome` and asks. Blind replay and optimistic "probably fine" are failures.
2. **Nothing lands silently.** Verified work reaches a branch the operator chose. Integration never
   merges into main on its own, and no approval is granted by default.
3. **Verification decides, not vibes.** Acceptance criteria and configured checks gate whether a
   run is complete. A Ship's claim that it succeeded is a claim, not a verdict.
4. **The terminal is sufficient.** The graphical workspace makes the work visible and pleasant; it
   never makes it possible. A feature that only exists in the graphical app is a bug.
5. **Isolation is real or it is nothing.** Containers, per-Ship permissions, least privilege, and
   fail-closed defaults. The honest limitation — tmux is persistence, not a security boundary —
   is stated rather than papered over.

## Accessibility & Inclusion

WCAG 2.2 AA is the floor for the graphical workspace: 4.5:1 for body text, 3:1 for large text and
non-text UI boundaries, visible focus indication, and full keyboard operation of every control.
State is never communicated by colour alone — an approval, a failed check, and a blocked task each
carry a text or shape signal as well.

The terminal surfaces must stay legible and stateful under the 256-colour, 16-colour, and
`NO_COLOR` fallbacks, and their ASCII icon substitutes must carry the same meaning as the
Unicode ones.
