# Pluton-Harness — final delivery report (§17)

Status date: 2026-10-16 · host: Windows 11 + Docker Desktop (WSL2) · Node v24.22.0 · git `main`,
unpushed. This report states exactly what was built, what was executed and observed, and what was
**not** — per the master prompt's honesty rules. Nothing below is claimed without a file, a commit,
or a command whose output was observed.

## 1. Executive summary

Pluton-Harness is a CLI-first, local-first multi-agent orchestration control plane implemented from
scratch in TypeScript (strict ESM, Node ≥ 24, `node:sqlite`). It coordinates persistent per-Muse
engine identities across different engines and models, isolates tasks in Docker containers and git
checkouts, runs work through a restricted server-authorized tool bridge (MCP stdio + loopback HTTP),
supervises runs from durable state, and gates completion behind recorded verification evidence.

Delivered and test-verified in this environment: Phases 0–5 complete; Phase 6 (bridge,
transport, `pluton mcp serve`, run supervisor, `pluton run` wired end to end, live host-mode smoke
with an OpenCode manager + Qwen worker, engine containers through `docker exec` with an
engines-profile worker image) and Phase 7 gate (`pluton verify`, verdict logic); Phase 8
substantially (adversarial review fixes, failure-mode tests, `docs/SECURITY.md`, this report).
**Not delivered:** `pluton attach`/`integrate` CLI commands, the integration checkout, operator
apply/deny wiring for specialist proposals, and approval expiry. Container-mode runs are wired and
unit/integration-verified; their live E2E is NOT RUN on this host (no Docker daemon) — exact
commands in §7. Those gaps are enumerated in §6 with reproducible commands.

## 2. Evidence base

- Last full local run of this report: `npm run check` → typecheck clean, **423 tests / 32 files
  green** (27 unit files + 5 integration files).
- Host-mode live smoke (2026-10-16/17, `docs/smoke-live-run.md`): OpenCode manager + Qwen worker on a
  real gateway-backed model; run #1 (pre-fix) is kept as the failure of record (run `uncertain`,
  phantom worker "success" with zero edits caught by `pluton verify`); after the fix commit the same
  goal stopped in `verifying` and only `pluton verify` closed it `completed` / `success`.
- Container-mode fail-closed behavior, live on this host (2026-10-17): with `sandbox.kind: docker`
  (the default) and no daemon running, `pluton run` in `.pluton-tmp/smoke-docker/` exited 1 with a
  typed `sandbox_unavailable` envelope (message carries the exact fix) and left **0 runs / 0 tasks /
  0 sandboxes** in the store — the failure happened before the run row existed.
- Container-mode adversarial review (independent subagent, against `45f23f6`): one blocker plus four
  major findings, all addressed in `88bd335` with tests — ACP session cwd mapping, read-only-policy
  mounts, docker client connection env, stale-container reuse validation (`SandboxManager.inspect`),
  `..`-safe path mapping; two findings folded into documented limitations (SECURITY.md §8.8/8.9).
- Opt-in Docker E2E: `PLUTON_E2E_DOCKER=1 npm run test:e2e` → **5/5 green** on this host (worker
  image `pluton-worker:local`, `sha256:a6c83676…`).
- Opt-in live-engine suites: `npm run test:live` → **OpenCode 3/3, Qwen 4/4 green** on this host
  (OpenCode v2.0.29; Qwen Code v0.25.2 via `qwen --acp`, backed by the operator's local gateway —
  no new external credentials were provisioned).
- Milestone commits (newest first): `88bd335` container-mode review fixes · `45f23f6` container-mode
  `docker exec` engine spawn wiring · `2695e20` per-Muse containers · `1f9521c` engines image profile · `c2d8fcd` review fixes of the smoke fix · `cceec89` live-smoke
  fixes (approval wiring, settled waits, transport drain, durable approval events) · `ca0018d`
  `pluton run` wiring · `77fda33` SECURITY.md · `9a460c9` failure-mode tests ·
  `a97f33a` Phase 7 verification gate · `b21ca43` run supervisor · `7397bc6` bridge hardening
  (review findings 1–10) · `7369024` `pluton mcp serve` · `7554537` HTTP transport · `b4fb687`/
  `cf1ca1f` tool bridge · `4368304`/`8808b1b` engine adapters · `c53d9c8`…`13b3859` Phases 0–5.
- Reference repositories (`cloudroom-core` `@3949daa`, `OpenMausBot` `@7d00805`) were inspected
  read-only under `references/` (gitignored); findings are recorded in
  `docs/reverse-engineering/`. No code was copied; `openmausbot/enterprise/` was never used.

## 3. What was built (by phase)

| Phase | Delivered | Key paths | Commit refs |
|---|---|---|---|
| 0 | Project, config schema/loader, doctor, `--json` envelope discipline | `src/config/`, `src/cli/` | early commits |
| 1 | Domain model, SQLite store with WAL/migrations, transactional state+events, request receipts (idempotency), task graph admission (cycles, ancestor rules, depth/fan-out), `status`/`task`/`graph` | `src/store/`, `src/domain/`, `src/orchestrator/task-graph.ts` | `c53d9c8` |
| 2 | Engine contract + registry, OpenCode ACP adapter (live-verified), Qwen Code adapter (recorded-frame conformance), honest capability/auth reporting, `muse`/`engine`/`model` CLI | `src/engines/` | `4368304`, `8808b1b` |
| 3 | Workspace manager (per-task `git clone --local` checkouts on `pluton/<run>/<slug>` branches, removal guards), sandbox managers (Docker with hardening argv; dev-only `local-process` behind explicit acknowledgment), tmux terminal manager through `docker exec`, registry rows | `src/workspace/`, `src/sandbox/`, `src/terminal/` | `13f43a1`→`3628f0b` |
| 4 | Worker image (`docker/worker/Dockerfile`), `pluton sandbox build-image` with drift detection + probe, opt-in Docker/tmux E2E suite (5/5) | `docker/`, `src/sandbox/image.ts`, `tests/e2e/` | `8fc1f09`, `13b3859` |
| 5 | Projects/templates (mixed-engine teams: `worker-b`/`researcher`/`qa` on `qwen`), reviews of Phases 0–5 → 16 findings fixed | `templates/`, `tests/unit/init-templates.test.ts` | `c146f41`→`73206b3` |
| 6 | Restricted tool surface: MCP stdio protocol server, catalog with server-side per-call authorization, handlers, exactly-once wakeup registry, HTTP transport, `pluton mcp serve` for real engine sessions, run supervisor (manager plan → dispatch → collect → finalize) | `src/tools/`, `src/orchestrator/supervisor.ts` | `cf1ca1f`, `b4fb687`, `7554537`, `7369024`, `b21ca43` |
| 6 (review) | Bridge adversarial review → 10 findings fixed with regression tests | `src/tools/handlers.ts` etc. | `7397bc6` |
| 6 (run) | `pluton run` wired to the supervisor: idempotent run admission by request-id, per-Muse HTTP tool-bridge session with bearer tokens, shutdown ordering (abort + bounded drain before `store.close()`) | `src/cli/commands/run.ts`, `src/tools/http-transport.ts` | `ca0018d` |
| 6 (live) | Host-mode live smoke with real engines → 4 wiring bugs found and fixed (approval mode never reached the engine session, `task.wait` deadlocked on the operator gate, an in-flight wait outlived the transport, denials vanished from the record); adversarial review of the fix → 11 findings addressed | `src/engines/approval.ts`, `src/orchestrator/supervisor.ts`, `docs/smoke-live-run.md` | `cceec89`, `c2d8fcd` |
| 6 (containers) | Engines profile in the worker image (`PLUTON_ENGINES=1`, pinned `@opencode/cli@2.0.31` + `@qwen-code/qwen-code@0.25.2`, fail-closed in-image `--version` proof, recorded profile gates dispatch); per-Muse containers (`ensureMuseContainer`: labels, `host.docker.internal:host-gateway`, workspaces + engine-home mounts, durable rows) and the `docker exec` engine spawn seam (`-e NAME`-only env, host→container path rewriting, pinned in-image binaries); `pluton run` container mode fails closed before any run row exists (live-verified) | `docker/worker/Dockerfile`, `src/sandbox/image.ts`, `src/sandbox/muse-containers.ts`, `src/engines/docker-exec.ts`, `src/cli/commands/run.ts` | `1f9521c`, `2695e20`, `45f23f6` |
| 7 | Verification gate: configured argv-array checks through the bounded runner, deny list, evidence rows + events before any verdict, `pluton verify`, truthful verdict/finalization | `src/verify/runner.ts`, `src/cli/main.ts` | `a97f33a` |
| 8 | Failure-mode tests (timeout, protocol crash), `docs/SECURITY.md`, this report | `tests/`, `docs/` | `9a460c9`, `77fda33`, this commit |

## 4. Test evidence — what is actually verified

Commands and results observed at the report commit:

1. `npx tsc -p tsconfig.json` — clean.
2. `npx vitest run` — **423 passed / 32 files** (27 unit, 5 integration). Highlights:
   - `tests/unit/tool-bridge.test.ts` (30): permissions enforced server-side, scope per call, audit
     events, waits event-driven, heartbeat re-read for stdio sessions, review regressions
     (junction escape denied, `.PLUTON` denied, oversized tool name audited, subtree dependencies,
     terminal delegation, approval caps, hostile `baseCommit`).
   - `tests/integration/cli-mcp-serve.test.ts` (3): real child process over stdio — manager admits a
     task that lands in durable state; stdout is exactly the protocol; a non-assignee session fails
     closed.
   - `tests/integration/cli-run.test.ts` (6): `pluton run` drives the manager over the real loopback
     HTTP bridge to a finished run; re-running with the same `--request-id` returns the same run
     without re-driving it; container mode provisions one container per Muse (real
     `ensureMuseContainer` + durable rows, incl. a read-only-policy Muse) and tunnels both engines
     through the real `docker exec` seam (container-facing `host.docker.internal` bridge URL, pinned
     in-image binaries, rewritten engine home, `-e NAME`-only argv, ACP session cwd asserted to be
     the container path); daemon-down and base-image failures close before any run row exists; a
     config without a supervisor Muse fails cleanly with a `--json` envelope.
   - `tests/unit/docker-exec.test.ts` (9): the `docker exec` spawn seam — argv shape, values never in
     argv (`-e NAME` pairs only), host-shaped platform vars (PATH/SystemRoot/APPDATA) never crossing
     into the container while the docker CLI itself still gets them plus the connection env
     (`DOCKER_*`), longest-prefix mount mapping with boundary and `..`-escape refusal, unmapped cwd →
     `ValidationError` with zero spawns.
   - `tests/unit/muse-containers.test.ts` (10): create/reuse/recreate decision table — stale image
     (rebuilt worker image), mount mismatch (policy change), exact-match reuse, managed-label refusal
     at start(), undeterminable state fail-closed, stale containerId carryover.
   - `tests/integration/supervisor.test.ts` (12): dependency order from durable records; failure
     gates the run while dependents stay visibly queued; same-Muse serialization; real-git isolated
     checkout on a run branch with the user branch untouched; verification-aware stop; the
     settled-wait contract (waits resolve when work enters `verifying`, settled is never reported as
     success) and the durable engine-approval record; the default per-Muse factory routes through the
     approval-aware wiring; manager failure; timeout → `unknown_outcome` (never success/replay);
     protocol crash → `unknown_outcome`.
   - `tests/unit/engine-approval.test.ts` (8): the approval-mode → session-mode/policy mapping, the
     effective settings of the adapters the factory actually builds (the smoke regression), and a
     loud refusal of unrecognised stored modes.
   - `tests/integration/verify.test.ts` (5): CLI happy path end-to-end against the real store;
     failing check fails the task though others passed; artifacts written; pending (never-run) check
     can never be green; denied command refused before spawn; non-`verifying` task refused.
   - Store/domain/orchestrator units: transitions, idempotent receipts, cycle/ancestor rejection,
     NULL-safe upserts, and the same suite covers `mcp-server`, `tool-http`, `wakeups`.
3. `PLUTON_E2E_DOCKER=1 npm run test:e2e` — 5/5 green (opt-in; requires a running Docker daemon and
   `pluton sandbox build-image`). Skips cleanly (exit 0, 0 run) where no daemon/image exists — it
   never silently passes.
4. `npm run test:live` — OpenCode 3/3, Qwen 4/4 (opt-in; requires installed/authenticated engines).

## 5. Requirement → evidence map

| Requirement | Where | Evidence |
|---|---|---|
| CLI-first; `--json` clean stdout, diagnostics stderr | `src/cli/output.ts`, every command | integration tests parse stdout envelopes; stderr carries human text only |
| Per-Muse engine/model, no global switch; capabilities never faked | `src/engines/`, config schema | adapter conformance suites; doctor/model list honest errors |
| OpenCode first-class; Qwen Code second real adapter | `src/engines/opencode/`, `src/engines/qwen/` | live suites 3/3 + 4/4 |
| tmux per Muse in Linux containers; tmux ≠ security boundary | `src/terminal/`, ADR-0004/0005, SECURITY.md | E2E tmux roundtrip, window-id kills, duplicate-proofing tests |
| Docker fail-closed | `src/sandbox/` | `sandbox.test.ts`: daemon down → typed error with exact fix |
| Idempotent requests; durably recorded before acceptance | `src/store/store.ts` receipts | `store.test.ts` replay same request-id → same outcome |
| `unknown_outcome` never blindly replayed | `supervisor.ts` unknown path | supervisor tests (timeout, crash) |
| Per-Muse serialized tasks; dependency/cycle/ancestor rejection | `src/orchestrator/mutex.ts`, `task-graph.ts` | unit tests + supervisor serialization test |
| Verification gates run completion; no green on failed/unrun | `src/verify/runner.ts` | 5 verify tests incl. pending check |
| Manager delegates only via restricted tools (server-side authz) | `src/tools/catalog.ts`, `handlers.ts` | 30 bridge tests, adversarial review regressions |
| Bounded specialists; one wakeup per settled child (terminal or awaiting verification) | `muse.propose_create` + approvals cap; `wakeups.ts` | unit tests (cap ≤ 3 pending, dedupe, exactly-once) |
| `pluton run` end-to-end: manager plans → dispatch → verify closes | `src/cli/commands/run.ts`, `src/orchestrator/supervisor.ts` | `cli-run` integration tests (4, incl. container mode through the real `docker exec` seam); host-mode live smoke (`docs/smoke-live-run.md`) — run closed `completed` only via `pluton verify`; container-mode fail-closed live-verified (typed `sandbox_unavailable`, 0 durable rows) |
| Container isolation: engines in per-Muse containers; env values never in argv | `src/sandbox/muse-containers.ts`, `src/engines/docker-exec.ts` | `docker-exec` unit tests (9), `muse-containers` tests (10) + `sandbox.test.ts` additions, container-mode `cli-run` integration tests (reuse validation via `SandboxManager.inspect`); live E2E NOT RUN (no daemon; §7) |
| Isolated per-task checkouts; never touch user tree; no destructive git; no auto-merge to main | `src/workspace/manager.ts` | supervisor checkout test asserts root branch still `main`; removal guards |
| Secrets never in yaml/db/events/logs/argv | ADR-0008, `redactDeep`, doctor presence-only | store/doctor tests; SECURITY.md §6 |
| argv arrays only; timeouts; bounded outputs | `src/util/exec.ts` | `util.test.ts`; runner caps + truncation markers |
| ADRs 0001–0011; 5+ RE deliverables; THIRD_PARTY_NOTICES; no affiliation claims; UNLICENSED | `docs/adr/` (11), `docs/reverse-engineering/` (8), root notices | files present; README/notices state independence |

## 6. What is missing, partial, or deliberately not done

Honest list; none of these are simulated or stubbed-green:

1. **`pluton attach` and `pluton integrate`** — terminal attach UX and the integration checkout with
   conflict detection are planned, not built. ADR-0005/0009 describe the intended behavior.
2. **Operator apply/deny for specialist proposals** — proposals are validated, capped, deduplicated
   and recorded as pending approvals; no CLI applies them into a live team yet.
3. **Approval expiry** — no timeout-to-denied transition exists (SECURITY.md §8.3).
4. **Network policy `restricted`** is accepted in config but not enforced beyond container defaults
   (SECURITY.md §8.5).
5. **Git conflict detection** — needed by `integrate`; not implemented.
6. **Container-mode supervised run** — wired and covered in-process (unit + integration through the
   real `docker exec` seam), and its fail-closed path is live-verified; the full live E2E (engines
   image build, containers on a real daemon, `host.docker.internal` bridge reachability, bind-mount
   writes as uid 10001) is **NOT RUN** on this host: no Docker daemon (`docker version` → npipe not
   found). The host-mode live smoke ran `sandbox.kind: local-process`; procedure + exact commands
   for a daemon-capable host are in `docs/smoke-live-run.md`.
7. **Re-dispatch after the verification gate** — dependents blocked behind an unverified (or failed)
   dependency keep the run open; the record now names them (`blockedTasks` in the run summary and
   `run.finished`), but no re-admission policy exists yet.

## 7. NOT RUN (with reproducible commands)

| Item | Command | Why not run |
|---|---|---|
| Docker E2E re-run at this report | `PLUTON_E2E_DOCKER=1 npm run test:e2e` (after `pluton sandbox build-image`) | green on this host earlier in the session; not re-executed at the exact report commit |
| Live engine re-run at this report | `npm run test:live` | green earlier (3/3, 4/4); not re-executed at the exact report commit |
| Container-mode live goal (E2E) | `docker build --build-arg PLUTON_ENGINES=1 -t pluton-worker:local docker/worker` → `pluton sandbox build-image --engines` → `node bin/pluton.js run --goal … --json` in `.pluton-tmp/smoke-docker/` → `pluton verify --run <id>` | no Docker daemon on this host (`npipe:////./pipe/dockerDesktopLinuxEngine` not found); see `docs/smoke-live-run.md` "Container-mode smoke" — the fail-closed path is live-verified, the full daemon sequence is not |

Everything else in §4 was executed with the reported result.

## 8. Independence and licensing

- Pluton is an original implementation. Reference repositories were studied for architecture
  lessons only; docs/reverse-engineering records what was learned and what was deliberately **not**
  copied (`docs/reverse-engineering/reuse-and-license-audit.md`). `openmausbot/enterprise/` was
  never opened for reuse.
- Third-party attributions: root `THIRD_PARTY_NOTICES.md`. Pluton itself is deliberately
  `"license": "UNLICENSED"` and `"private": true` (ADR-0011).
- No affiliation with Cloudroom, OpenMausBot or the OpenCode project is claimed anywhere; engine
  names are used descriptively for interoperability only.

## 9. Reproduce from scratch

```
node --version                # ≥ 24
npm install
npm run check                 # tsc + 423 tests
node bin/pluton.js doctor     # host readiness — run inside a project (create one: node bin/pluton.js init)
# optional, needs Docker Desktop:
pluton sandbox build-image && PLUTON_E2E_DOCKER=1 npm run test:e2e
pluton sandbox build-image --engines   # container-mode runs additionally need the engines profile
# optional, needs installed engines:
npm run test:live
```

Project state lives in `<project>/.pluton/state/pluton.sqlite` (WAL, forward-only migrations) and
is safe to back up as a file.

## 10. Honesty statement

Every test count, image digest, engine version and green/red result in this report was produced by
commands on this host in this session; things that were not run are listed as NOT RUN in §7, and
things that do not exist are listed in §6. Where the implementation is weaker than the ambition
(live engine wiring, integration checkout, approval lifecycle), the gap is named here and in
`docs/ROADMAP.md` rather than papered over. `docs/SECURITY.md` lists what the security model does
**not** protect with the same precision as what it does.
