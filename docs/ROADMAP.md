# Pluton-Harness — Roadmap & Phase Checklist

**Motto:** Plan → Delegate → Execute → Verify → Deliver.
Status legend: `[x]` done · `[~]` in progress · `[ ]` not started · `[!]` blocked by environment

> **Historical roadmap, not current setup guidance.** Docker/container execution was removed
> after this checklist was written; native execution is now the only substrate. Current
> configuration and security behavior live in [`NATIVE_EXECUTION.md`](NATIVE_EXECUTION.md)
> and [`SECURITY.md`](SECURITY.md). Historical checkboxes are retained as a delivery record.

> **Legacy history (2026-10-22):** Qwen Code support was removed in the OpenCode-only migration.
> Qwen entries below record what was delivered at the time and are **not** current support or setup
> instructions. Current engine support is OpenCode only; `mock` is tests/dev only. See
> [`MIGRATION.md`](MIGRATION.md) §8.

Product: Pluton-Harness — CLI-first, local-first orchestration control plane that coordinates a
user-defined team of persistent specialist agent identities ("Muses"), each with its own model,
instructions, permissions, workspace and terminal, backed by a durable runtime.

Pluton is the control plane, **not** a coding model. OpenCode does inference; Docker/containers do
process isolation; tmux provides terminal persistence; Git tracks changes; SQLite records truth.

---

## Phase 0 — Environment reconnaissance `[x]`

Environment (verified 2026-10-16, Windows 11 build 26300, `Y:` fixed drive, 160 GB free):

| Component | Finding |
|---|---|
| Node.js | v24.20.0 (LTS-era) with built-in `node:sqlite` (`DatabaseSync`) available unflagged |
| npm | 10.9.9 (no pnpm/yarn → npm workspaces) |
| Git | 2.56.0.windows.2 |
| Docker | CLI 29.7.2; Docker Desktop installed per-user (`%LOCALAPPDATA%\Programs\DockerDesktop`); **daemon not running**; WSL2 present (`docker-desktop` distro stopped) |
| WSL | 2.7.13.0; only the `docker-desktop` utility distro; no general Linux distro with a shell |
| tmux | 3.6a-win32 native binary present (worker-side tmux is the target; native Windows tmux is a convenience only) |
| OpenCode | v2.0.29; `acp` (Agent Client Protocol stdio server), `serve` (v2 HTTP API), `run --format json`, `session export/import`; **free hosted models exist** → live engine tests feasible |
| Other engines | OpenCode is the only supported real engine; Qwen Code support was removed 2026-10-22. No codex/claude/gemini/pi adapters exist |
| Python | 3.13.12 (species for scripts only) |
| Workspace | `Y:\Pluton` — empty at start; references cloned under `references/` (read-only) |

- [x] Inspect workspace & git status before changes (empty, not a repo — created fresh)
- [x] Check runtimes, package managers, WSL2/Docker, Git, tmux, engine binaries
- [x] Write docs/ROADMAP.md and checklist
- [x] Record environment facts above

## Phase 1 — Reference reverse engineering `[x]`

References (read-only, recorded commits):

| Repo | Branch | HEAD SHA | Date | License |
|---|---|---|---|---|
| [cloudroom-core](https://github.com/davidondrej/cloudroom-core) | main | `3949daaea3c7613458e9ad14afddbd267a0a56bc` | 2026-10-14 | Apache-2.0 |
| [OpenMausBot](https://github.com/milind-soni/OpenMausBot) | main | `7d008053cbdb255c2078fbf772630e634000dce5` | 2026-10-15 | Apache-2.0 except `enterprise/` (source-available carve-out); trademark restrictions |

- [x] Clone references into `references/` (read-only usage), record SHA/branch/date/license
- [x] Three bounded read-only research subagents (SCRATCH: report files only; OpenCode child
      sessions provide context isolation; tmux not applicable to subagent execution on this
      host — documented limitation, no false sandbox claims):
  - [x] `cloudroom-core` full analysis → `docs/reverse-engineering/cloudroom-core.md`
  - [x] OpenMausBot runtime/engines → `docs/reverse-engineering/openmausbot-runtime.md`
  - [x] OpenMausBot MCP/tools/licensing → `docs/reverse-engineering/openmausbot-mcp-workspaces-tests-licensing.md`
- [x] `docs/reverse-engineering/comparison-matrix.md`
- [x] `docs/reverse-engineering/architecture-map.md`
- [x] `docs/reverse-engineering/reuse-and-license-audit.md` (reuse register: empty; grep-verified)
- [x] `docs/reverse-engineering/implementation-decisions.md` (status lines reconciled after Phase 3)

## Phase 2 — Design and skeleton `[x]`

- [x] ADRs 0001–0010 + 0011 (license/reuse policy). Numbers chosen: language/runtime, SQLite driver,
      engine protocol (accepted; Phase-4 addendum in ADR-0003), sandbox, checkout/terminal
      lifecycle (Proposed), task persistence/idempotency, delegation, secrets, Git strategy,
      Windows/WSL2, independence/licensing. Single private package (no npm workspaces) — ADR-0001.
- [x] Monorepo scaffold (strict TS, ESM, vitest), typecheck/test/check scripts
- [x] Typed domain IDs/models + explicit tested state machine (`src/domain/`, 60+ cases incl. run transitions)
- [x] Validated versioned `pluton.yaml` config (Zod; argv-only commands; path-escape rejection)
- [~] Port interfaces: engine contract done (`src/engines/contract/types.ts`); sandbox/terminal/
      workspace interfaces land with their Phase 5 managers (persistence port = `src/store/`)
- [x] Working `pluton --help`, `pluton version`, `pluton doctor`, `pluton init`, `pluton muse …`,
      `pluton engine list` (smoke-tested; JSON envelopes clean)
- [x] Clean typecheck/test proof (`npm run check`; failures honestly reported — exit code 1 on doctor FAIL)

## Phase 3 — Persistence and runtime `[x]`

- [x] SQLite migrations (node:sqlite) + transactional run/task/receipt/event store (`src/store/`)
- [x] Task graph validation, dependency admission, budgets, scheduler readiness (`src/orchestrator/`)
- [x] Idempotency (request receipts), crash reload, lifecycle transitions — 24 store/graph tests incl.
      duplicate→same receipt, changed payload→conflict, rollback, reopen; per-Muse KeyedMutex tested
      (executor-level runs arrive with engine adapters in Phase 4)
- [x] `pluton status`, `task list/show`, `graph` with `--json` (integration tests spawn the real CLI)

## Phase 4 — Engine adapters `[x]`

- [x] Engine contract + capability schema + conformance suite (`src/engines/contract/`; capability
      records cross-checked per adapter; unsupported features raise `capability_unsupported`)
- [x] ACP client over stdio (in-repo, no dependency): framing, message-size cap, bounded
      stdout/stderr diagnostics, request timeouts, server→client request handling, kill/reap
- [x] OpenCode adapter over `opencode acp` (live-verified v2.0.29): model pinning via
      `session/set_config_option`, resume via `session/load` (codeword recall), cancel, approvals,
      usage; offline conformance suite replays recorded frames
- [x] ~~Second real engine: **Qwen Code** (`qwen --acp`, v0.25.2)~~ — **removed 2026-10-22** (legacy
      history: explicit mode pinning, composite model values, absence of `session/close`, qwen-specific
      notifications ignored, unknown server requests refused with -32601, auth mapping (-32000); Qwen
      support is no longer shipped and is not a current capability)
- [x] Deterministic mock engine (tests only)
- [x] Per-Muse engine/model validation, model discovery, auth-readiness checks, event
      normalization, interrupt/cancel, resume handling
- ~~Note: the live Qwen path on this host was backed by the operator's local 9router
  OpenAI-compatible gateway; `PLUTON_QWEN_BIN` / `npm i -g @qwen-code/qwen-code` were documented in
  the adapter and live-test header.~~ **Legacy history only; Qwen support removed 2026-10-22.**

## Phase 5 — Sandboxes, workspace, tmux `[x]`

- [x] Worker image (`docker/worker/Dockerfile`: tmux, git, node, non-root uid 10001) + `src/sandbox/image.ts`
      build/probe module recording the built image ID for drift detection (`pluton sandbox build-image`)
- [x] Engine profile in the worker image: `PLUTON_ENGINES=1` installs pinned `@opencode/cli@2.0.31`
      and proves it with an in-image `--version` at build time (fail-closed); Qwen Code was removed
      from the image in the 2026-10-22 OpenCode-only migration. The recorded profile gates
      container-mode dispatch (`pluton sandbox build-image --engines`; legacy records read as `base`);
      the live build executed 2026-10-17 with the in-image `--version` proof
      (`docs/smoke-live-run.md`)
- [x] Container lifecycle: non-root, `--cap-drop ALL`, `no-new-privileges`, CPU/mem/PID limits, bounded
      noexec tmpfs, mount policy, env allowlist, network policy, Pluton-owned labels, label-guarded
      stop/remove — `src/sandbox/docker.ts` + conformance tests; `local-process` is acknowledgement-gated
- [x] Per-Muse tmux sessions executed inside the container via argv-only sandbox exec, `=`-exact target
      matching, typed failure reasons (`src/terminal/`) + tests; native-Windows tmux deliberately unsupported
- [x] `pluton attach` — interactive operator terminal into a Muse's container tmux session: resolves
      Muse → container → session, ensures the session once, returns the exact `docker exec -it` argv
      (live argv + session-ensure proven; the interactive `-it` leg is NOT RUN — no real TTY in this
      harness; `docs/smoke-live-run.md`)
- [x] Isolated checkouts: per-task `git clone --local`, branch `pluton/<run>/<slug>`, hardlink fallback,
      Pluton-owned removal guards (`src/workspace/manager.ts`) + tests; workspace/sandbox/terminal registry
      rows in the store
- [x] Cross-Muse isolation tests: gated E2E suite (`tests/e2e/docker-sandbox.e2e.test.ts`) is 5/5
      green on this host with `PLUTON_E2E_DOCKER=1` after `pluton sandbox build-image`; skips cleanly
      (0 run, exit 0) where no daemon/image is available — never silently passes

## Phase 6 — Manager and team execution `[~]`

- [x] Default team template (manager/researcher/worker-a/worker-b/qa/reviewer) —
      `templates/teams/full-stack.yaml`; all Muses now use OpenCode, validated by
      `tests/unit/init-templates.test.ts` (legacy history: worker-b once used Qwen)
- [x] Restricted Pluton tool bridge (MCP stdio + HTTP transport) with per-call authorization —
      `src/tools/` (MCP protocol layer, catalog, authorization bridge, handlers, `http-transport.ts`) +
      `src/orchestrator/wakeups.ts`; `pluton mcp serve` runs the bridge as a real stdio child for one
      engine session; unit/integration tests across `mcp-server`, `tool-bridge`, `tool-http`, `wakeups`,
      `cli-mcp-serve` — hardened after an adversarial review (realpath containment against
      junctions/case/8.3 aliases, bounded audit names, dependency-scope and terminal-delegation
      rejection, pending-approval caps)
- [x] Dynamic specialist proposals with hard limits + audit records — `muse.propose_create` validates
      team-size/role/engine/model and records a pending operator approval (nothing instantiated
      silently); the operator side landed as `pluton approvals` (list/approve/deny): approving a
      `muse.create` applies it through the real team sync + container provisioning when the run is
      live in docker mode, denying never instantiates, and pending approvals expire fail-closed
      (operator-configurable TTL; sweep on list/decide)
- [x] Manager plan → validate → dispatch → collect → report flow (plan-first policy) —
      `src/orchestrator/supervisor.ts`: the manager session runs concurrently with the dispatch loop
      (ready tasks → per-Muse lock → engine session in its checkout), dependency order comes from
      durable records, and finalization is honest (a failure claim fails the run, failed-dependency
      tasks stay visibly queued, operator-waiting runs are never force-transitioned, successful
      tasks stop in `verifying` when checks exist) + 12 mock-engine integration tests
      (`tests/integration/supervisor.test.ts`, including timeout → `unknown_outcome`, protocol-crash
      failure modes, the settled-wait contract, and the durable approval record)
- [x] ~~Real goal through lifecycle with ≥2 engines and independent workspaces~~ — historical
      host-mode live smoke (2026-10-16/17, `docs/smoke-live-run.md`): OpenCode manager + Qwen worker
      on a real gateway-backed model (Qwen support removed 2026-10-22). Worker edits stayed in its
      own per-task checkout, tasks stopped in `verifying`, and `pluton verify` closed the run
      `completed` / `success`. The smoke exposed four wiring bugs (approval mode never reached the
      engine session, `task.wait` deadlocked on the operator gate, an in-flight wait outlived the
      HTTP transport, denials vanished from the record) — fixed in `cceec89`; an adversarial review
      of that commit found no blockers and its 11 findings (wiring pinned in the suite, blocked-
      dependents wording, event-type collision, drain/timer hygiene, aborted-wait honesty) are
      addressed in `c2d8fcd`
- [x] Engine containers wired into `pluton run` (run-wiring plan Tasks 5–7): one long-lived container per
      Muse (`ensureMuseContainer` — Pluton labels, `host.docker.internal:host-gateway`, workspaces +
      engine-home mounts, project root read-only for coordinator muses), engine sessions tunneled through
      `docker exec -i` (`src/engines/docker-exec.ts` — `-e NAME`-only pass-through so env values never
      enter argv, host→container path rewriting, in-image binary pins, Linux platform env construction),
      and the tool bridge exposed on the host gateway with per-session bearer tokens. `sandbox.kind: docker`
      (the default) fails closed before any run row exists — live-verified on this host (typed
      `sandbox_unavailable`, 0 runs / 0 containers / 0 tasks). Container-mode live E2E executed
      2026-10-17 — PASS (`docs/smoke-live-run.md`: engines image with in-image version proof, per-Muse
      containers reusing the stale-container path, a real worker edit, `pluton verify` closing the run
      `completed` / `success`; the smoke found and fixed one engine-session leak, `ba68557`);
      `local-process` remains the acknowledgement-gated host-mode path

## Phase 7 — Verification and integration `[x]`

- [x] Safe configured checks (argument arrays, allow list = config, conservative deny list of
      shells/destructive tools, bounded output, artifact retention, hard timeouts) —
      `src/verify/runner.ts`; evidence rows in `verification_checks`, `verification.run` events
- [x] Integration checkout (never the user's tree), conflict detection, evidence retention —
      `pluton integrate` creates the per-run checkout under `.pluton/workspaces/`, commits any dirty
      Pluton-managed task checkout first (`19f8f19`), merges verified task branches (`--no-ff`) into
      `pluton/integration/<run>`, runs the configured checks there and writes an artifact; conflicts
      stop the merge, stay on the branch and are recorded; a protected-path gate blocks disallowed
      paths behind an `integration.apply` approval. Never main (ADR-0009) — live-verified
      (`docs/smoke-live-run.md`)
- [x] `pluton verify --run [--task]` repeatable; truthful final verdict logic — failed, errored,
      denied, timed-out and never-run (pending) checks can never be green; run closes from durable
      records only (`applyTaskVerificationVerdict`, `finalizeRunVerdict`) + 5 integration tests

## Phase 8 — Hardening and docs `[~]`

- [~] Failure-mode tests — covered: malformed engine protocol (`acp-client`, mock protocol crash),
      prompt hang/timeout (`supervisor`), Docker daemon/image unavailable and missing tmux
      (`sandbox`, `sandbox-image`), cycles/self-dependency (`task-graph`), git merge conflicts and
      protected-path blocks (`cli-integrate`), approval expiry sweep (`cli-approvals` + live).
      Missing: an auto-continue path for `integration.apply` approvals (re-running `integrate` is
      the documented flow)
- [x] Security review: redaction, secret paths, container config, cleanup ownership — 16 findings from
      the post-Phase-5 review and 10 from the bridge adversarial review all fixed with regression
      tests; threat model and known gaps in `docs/SECURITY.md`
- [x] Docs set with accurate limitations — README, ROADMAP, ADRs 0001–0011, 8 reverse-engineering
      deliverables, `docs/SECURITY.md`, this roadmap's live-status paragraph
- [x] Final delivery report with exact evidence — `docs/delivery-report.md`

---

## Delivered vs planned (live status — updated at session end)

_Phases 0–5 complete; Phase 6 essentially complete (bridge + supervisor + historical live two-engine
goal in, now OpenCode-only; engines containerized via run-wiring Tasks 5–7; dynamic-specialist
operator wiring delivered as `pluton approvals`). Phase 7 complete (verification gate + integration
checkout via `pluton integrate`).
Phase 8 complete (interactive chat TUI for the operator Muse via `pluton`, `pluton chat [muse]`, and `pluton muse chat <muse>`).
Live status (2026-10-18, historical snapshot): 863 tests / 104 files green
(`npm run check` = typecheck + tests). Engines: `mock` (tests/dev only), `opencode`
(live-verified v2.0.29). Qwen was removed on 2026-10-22 and is not a current engine. Working CLI: `init`, `doctor`,
`muse list/show/create/edit`, `muse model list` (real engine catalogues; honest install/auth
errors), `engine list`, `sandbox probe`, `sandbox build-image`, `status`, `task list/show`, `graph`,
`mcp serve`, `run`, `verify`, `chat`, `attach`, `integrate`, `approvals` (list/approve/deny) — all with clean
`--json`. Live engine suites are opt-in (`npm run test:live`; OpenCode 3/3 historically green;
the Qwen suite was removed with Qwen support). Sandbox: worker image `pluton-worker:local`
(`sha256:a6c83676…`, `tmux 3.3a`, `node v24.22.0`) built for real via `pluton sandbox build-image`;
Docker E2E (`PLUTON_E2E_DOCKER=1 npm run test:e2e`) 5/5 green; `pluton doctor` fully green with tmux
verified inside the image. A full post-Phase-5 code review produced 16 findings — all addressed with
regression tests.
Phase 6 bridge core is in: MCP stdio server, restricted tool catalog with
per-call server-side authorization + audit events, exactly-once wakeup registry, engine-side
transport recon (`docs/reverse-engineering/engine-mcp-integration.md`), the HTTP transport, and
`pluton mcp serve` for stdio sessions. An adversarial review of the bridge produced 10 findings — all
addressed with regression tests. The run supervisor is in
(`src/orchestrator/supervisor.ts` + 12 mock-engine integration tests) and the Phase 7 verification gate
is in (`pluton verify`, `src/verify/runner.ts` + 5 integration tests): completion is only reachable
through durable evidence. `pluton run` is wired end to end and was host-mode live-smoked with an
OpenCode manager + Qwen worker goal (historical; `docs/smoke-live-run.md`; the run closed `completed`
only via `pluton verify`). Qwen support was removed in the OpenCode-only migration. Container mode
is wired in the same command (per-Muse containers, `docker exec`
engine spawns, engines-image gate — `1f9521c`, `2695e20`, `45f23f6`); its fail-closed path is
live-verified and its full live E2E ran 2026-10-17 — PASS (engines image with in-image version
proof, per-Muse containers, a real worker edit closed by `pluton verify` `completed`/`success`;
`docs/smoke-live-run.md`).
The attach/integrate/approvals slice landed (`60f513f`…`19f8f19`) and is live-verified on the same
running setup: `pluton attach --json` resolves the Muse container and ensures its tmux session;
`pluton integrate --run` committed a dirty worker checkout (`19f8f19`), merged it `--no-ff` into
`pluton/integration/run_mvbdxegw64ba23de`, passed the configured check inside the integration checkout;
`pluton approvals` list/approve/deny and the expiry sweep (`pluton:timeout`, fail-closed) all ran live against real rows.
The interactive chat TUI slice landed (ADR-0012, `521cd1d`…`168b2bf`): zero-dependency inline renderer (`src/tui/*`), v3 SQLite chat schema, operator tool catalog (`project.status`, `run.list`, `run.get`, `run.start`, `approvals.list`), streaming `ChatSession` with interrupt support, slash commands (`/help`, `/status`, `/runs`, `/run`, `/approvals`, `/approve`, `/deny`, `/new`), background run execution supervisor, and bare `pluton` TTY entry.
Named follow-ups explicitly recorded: fullscreen/alt-screen mode, async engine-approval interactive prompts, tool-output detail / thinking chunk streaming, `@`-file completion in the input editor, dynamic steering prompts during active runs, and arrow-select approval decision panel.
Documented honestly in `docs/SECURITY.md` and `docs/delivery-report.md`.
P1 (audit roadmap PR-1) landed in the working tree 2026-10-18 (not yet committed): configured usage
budgets (`runtime.max_run_input_tokens` / `max_run_output_tokens` / `max_run_cost_usd` plus optional
per-Muse `max_muse_*` variants) are mapped by `usageBudgetsFromRuntime` into the supervisor's
`UsageLedger`, and `runtime.max_retries_per_task` now reaches `RunSupervisor` (the CLI path previously
used the implicit default 2, ignoring the configured default 1). A breach interrupts the session at the
next usage event, with durable `run_usage` rows + a diagnostic (never silent). Covered by
`tests/unit/run-setup.test.ts` and `tests/integration/supervisor-usage-budget.test.ts`; rollback =
revert the change and remove the new keys from `pluton.yaml` first (strict schema).
P1 (audit roadmap PR-2) landed in the working tree 2026-10-18 (not yet committed): the chat TUI
status bar no longer fabricates usage. Cost appears only when an engine actually reported one
(`costUsd` accumulated by `applyEngineEvent`; omitted otherwise), and the context segment renders
`Context: unknown` because no engine reports a real context window — the fabricated
`DEFAULT_CONTEXT_WINDOW_TOKENS` / `DEFAULT_COST_PER_MILLION_TOKENS` estimate is deleted. Covered by
`tests/unit/tui-state.test.ts`, `tests/unit/ui-input-status.test.ts`,
`tests/unit/tui-render-fullscreen.test.ts`, and `tests/integration/chat-session-ui-integration.test.ts`;
rollback = revert (display-only).
P1 (audit roadmap PR-3) landed in the working tree 2026-10-18 (not yet committed): transport retry with bounded exponential backoff and full jitter for side-effect-free phases (engine process spawn and initialize transport handshake) in `src/engines/acp/retry.ts`, wired into `AcpClient` and `OpenCodeEngineAdapter` (previously also wired into the removed Qwen adapter). Prompt turns and mutations are never retried. Covered by `tests/unit/acp-retry.test.ts` and `tests/integration/transport-retry.test.ts`; rollback = revert (retry defaults to 0 when spawnFn is injected).
Dual Desktop + Browser Graphical Application (ADR-0014) landed in the working tree 2026-10-18:
1. Local Application Server (`src/server/*`) binding strictly to loopback (`127.0.0.1`), enforcing timing-safe token authentication (`X-Pluton-Token`), Origin/Host DNS-rebinding protection, and path sandboxing. Provides REST APIs (`/api/health`, `/api/workspace`, `/api/files`, `/api/sessions`, `/api/runs`, `/api/approvals`, `/api/muses`, `/api/models`) and Server-Sent Events (`/api/events`) for streaming tokens, tool states, and approval notifications.
2. Shared Graphical Workspace Frontend (`src/server/static-assets.ts`) delivered as an offline-capable SPA supporting conversation management, real-time message streaming, markdown formatting, tool cards, agent orchestra inspector, security approvals, workspace file inspection, and runtime diagnostics.
3. Desktop Shell Launcher (`src/desktop/launcher.ts`) launching dedicated app-mode windows via Microsoft Edge or Google Chrome (`--app=http://...`) on Windows/macOS/Linux with automatic browser fallback.
4. Windows PowerShell CLI Launcher (`pluton`, `pluton .`, `pluton <path>`, `pluton app`) with `--desktop`, `--browser`, `--port`, `--headless`, `--detach`, `--status`, and `--stop` flags, supporting Windows paths with spaces and drive letters. TUI chat remains accessible via `pluton --tui` or `pluton chat`.
Live test status: 837 tests / 102 files green (`npm run check` = typecheck + unit + integration tests).
P1 (audit roadmap PR-4) landed in the working tree 2026-10-18:
1. Verification Gate Re-dispatch: unblocks downstream dependent tasks once upstream verification verdicts succeed and enables continuous multi-stage pipeline execution without manual re-orchestration via `finalizeRunVerdict`, `pluton verify --dispatch`, and `pluton run --resume`.
2. Structured Network Policy (Audit Gap L7): per-Muse network isolation overrides (`muses.<id>.network_policy`: `none` | `restricted` | `open`), custom Docker network binding (`runtime.internal_network_name`), validated in `src/config/schema.ts`, `src/sandbox/docker.ts`, `src/sandbox/muse-containers.ts`, `src/cli/commands/run.ts`, and `src/cli/commands/approvals.ts`. Covered by `tests/unit/muse-network-policy.test.ts`.
3. Auto-continue Path for Approvals (ADR-0005): automatic multi-stage progression when approving `integration.apply` or resuming parked runs via `decideApproval(..., { autoContinue: true })` and `pluton approvals approve <id> --continue`. Covered by `tests/unit/approvals-autocontinue.test.ts`.
4. Graphical Workspace Enhancements: Interactive Task DAG visualizer with dependency edge tags and task actions in `Agent Orchestra`, interactive approval decision buttons ("Approve & Continue", "Approve", "Deny") with scope inspection in `Security & Operator Approvals`, and Worktree Diff viewer with unified additions/deletions/hunk highlighting in `Workspace Files & Diffs`. Covered by `tests/integration/server-api.test.ts`.
Public-release gate hardening landed 2026-10-18 (commit `17d1a41`), each item
reproduced before the fix and covered by a regression test:
1. Instance matching now compares workspace paths with platform semantics (`sameDirPath`): on Windows/macOS `y:\Pluton` and `Y:\Pluton` are one workspace, so a healthy server is no longer rejected (and duplicated) across path-case variants.
2. `pluton --stop` only signals a PID that passes the authenticated health check; a stale instance file whose PID was recycled by an unrelated process is no longer killed (it reports a warning instead).
3. Startup failures are actionable: `EADDRINUSE`/`EACCES` are wrapped with guidance (`--port`) and a failed start leaves no instance metadata behind; malformed instance files are cleared by `--stop`.
4. One workspace = one server is now enforced by an atomic claim file (`.pluton/run/server.claim`): concurrent launches converge on a single healthy server instead of racing to bind two ports.
5. `/api/files/content` and `/api/files` canonicalize through `realpath` and refuse directory junctions/symlinks that resolve outside the workspace (parity with the engine tool bridge).
6. Token exposure hardening: `Referrer-Policy: no-referrer` on asset and API responses, and the detached `server.log` (which contains the tokenized URL) is created `0600`.
7. Repeatable release gate: `npm run release:check` (typecheck + tests + build + package-content audit + version/working-tree checks) and the staged publish/rollback procedure in `docs/RELEASE.md`.
Cross-platform release-readiness audit landed 2026-10-18 (uncommitted; awaiting owner-authorized commit): the gate was rebuilt around PASS / FAIL / NOT TESTED / BLOCKED semantics and now also verifies `engines.node`, lockfile consistency, README/NOTICES link integrity, packaged-file content (host-local paths, credential shapes), the production dependency audit (NOT TESTED when the registry is unreachable) and POSIX `0600` enforcement (NOT TESTED on Windows); `docs/RELEASE.md` documents every check, the platform matrix and the technical-validation vs publication-authorization split. Two portability defects were reproduced and fixed: `findAppModeBrowser` unconditionally reported `microsoft-edge` on Linux (a missing opener also crashed the host through an unhandled spawn `error` event — reproduced), and the path-traversal test hard-coded Windows paths. Added: CI workflow `.github/workflows/ci.yml` (ubuntu/macos/windows on Node 24 + docker/tmux E2E on Linux; NOT TESTED until a git remote exists) and a clean-install smoke script (`npm run smoke:package`). Local evidence: 863 tests / 104 files green; gate 12 PASS / 0 FAIL / 1 NOT TESTED / 2 owner BLOCKED (exit 0); Docker/tmux E2E 5/5 via Docker Desktop (Linux containers on a Windows host — not a native Linux host); package smoke PASS in a temp path with a space. Native Linux/macOS runs and the public publish remain NOT TESTED / BLOCKED.
Next: owner decisions for the first public publish (outbound license, removing `private`) and the first CI run once a git remote exists._
