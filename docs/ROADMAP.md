# Pluton-Harness — Roadmap & Phase Checklist

**Motto:** Plan → Delegate → Execute → Verify → Deliver.
Status legend: `[x]` done · `[~]` in progress · `[ ]` not started · `[!]` blocked by environment

Product: Pluton-Harness — CLI-first, local-first orchestration control plane that coordinates a
user-defined team of persistent specialist agent identities ("Muses"), each with its own engine,
model, instructions, permissions, workspace and terminal, backed by a durable runtime.

Pluton is the control plane, **not** a coding model. Engines do inference; Docker/containers do
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
| Other engines | none installed (no codex/claude/gemini/pi); second engine must be installed/verified or live-tested opt-in |
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
      engine protocol (Proposed; addendum in Phase 4), sandbox, checkout/terminal lifecycle
      (Proposed), task persistence/idempotency, delegation, secrets, Git strategy, Windows/WSL2,
      independence/licensing. Single private package (no npm workspaces) — ADR-0001.
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
- [x] Second real engine: **Qwen Code** (`qwen --acp`, v0.25.2), selected and verified per the
      ADR-0003 Phase-4 addendum: explicit mode pinning (`auto`→`default`), composite model values,
      documented absence of `session/close`, qwen-specific notifications ignored, unknown server
      requests refused with -32601, auth mapping (-32000), live suite including resume recall
- [x] Deterministic mock engine (tests only)
- [x] Per-Muse engine/model validation, model discovery, auth-readiness checks, event
      normalization, interrupt/cancel, resume handling
- Note: the live Qwen path on this host is backed by the operator's local 9router
  OpenAI-compatible gateway (no new external credentials); `PLUTON_QWEN_BIN` /
  `npm i -g @qwen-code/qwen-code` documented in the adapter and live-test header

## Phase 5 — Sandboxes, workspace, tmux `[ ]`

- [ ] Worker image (tmux, git, node) with digest pinning
- [ ] Container lifecycle: non-root, cap-drop, CPU/mem/PID limits, mount policy, env allowlist,
      network policy, safe stop/recreate, Pluton-owned labels
- [ ] Per-Muse tmux sessions + safe attach via argument arrays
- [ ] Isolated checkouts (strategy per ADR), diff/commit capture
- [ ] Cross-Muse isolation tests (Docker-dependent → attempt daemon start; else documented NOT RUN)

## Phase 6 — Manager and team execution `[ ]`

- [ ] Default team template (manager/researcher/worker-a/worker-b/qa/reviewer)
- [ ] Restricted Pluton tool bridge (MCP stdio) with per-call authorization
- [ ] Manager plan → validate → dispatch → collect → report flow (plan-first policy)
- [ ] Dynamic specialist proposals with hard limits + audit records
- [ ] Real goal through lifecycle with ≥2 engines and independent workspaces

## Phase 7 — Verification and integration `[ ]`

- [ ] Acceptance criteria + safe configured checks (argument arrays, allow/deny)
- [ ] Integration checkout (never the user's tree), conflict detection, evidence retention
- [ ] `pluton verify` repeatable; truthful final verdict logic; no green on failed/unrun checks

## Phase 8 — Hardening and docs `[ ]`

- [ ] Failure-mode tests (engine missing, malformed protocol, hang, crash, daemon restart,
      tmux absent, Docker unavailable, conflicts, approval timeout, cycles)
- [ ] Security review: redaction, secret paths, container config, cleanup ownership
- [ ] Full docs set + accurate limitations
- [ ] Final delivery report with exact evidence

---

## Delivered vs planned (live status — updated at session end)

_Phase 0–3 complete. Live status as of commit `c53d9c8`: 8 test files / 68 tests green
(`npm run check`). Working CLI: `init`, `doctor`, `muse list/show/create/edit`, `muse model list`,
`engine list`, `status`, `task list/show`, `graph`, `version` — all with `--json`. Planned commands
(`run`, `attach`, `verify`, `integrate`) fail with a stable `not_implemented` code. Docker-dependent
suites: NOT RUN (daemon stopped at recon time) — reproducible commands live in `docs/` test configs
(`npm run test:e2e`). Next: Phase 4 engine adapters (OpenCode first)._
