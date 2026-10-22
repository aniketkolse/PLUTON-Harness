# Host-mode live smoke — `pluton run` with OpenCode manager + Qwen worker (historical)

> **Historical smoke (2026-10-16/17; engine note 2026-10-22):** Qwen Code support was removed in
> the OpenCode-only migration. The Qwen worker steps and `PLUTON_QWEN_BIN` commands below record
> what was executed at the time; they are **not** current setup instructions and must not be
> rerun as written. Current OpenCode-only configuration is in [`MIGRATION.md`](MIGRATION.md) §8.

Status legend: `[x]` executed on this host · `[ ]` not run · failures stay failures.

This smoke exercises the real path end to end on the host (no Docker):
`pluton run` → manager Muse (OpenCode, ACP) plans and delegates through the
restricted Pluton tool bridge over loopback HTTP → worker Muse (Qwen Code, ACP)
executes in its own per-task checkout → tasks stop in `verifying` → `pluton verify`
runs the project check and applies the verdict.

## Environment (2026-10-16, this host)

| item | value |
|---|---|
| project | `.pluton-tmp/smoke-host/` (gitignored scratch repo) |
| sandbox | `local-process` + `local_process_acknowledged: true` (dev-only; NOT isolation) |
| manager | engine `opencode` v2.0.31, model `opencode/deepseek-v4.1-flash-free` (free tier, no login) |
| worker | engine `qwen` (Qwen Code v0.25.2 via `PLUTON_QWEN_BIN` → `cli-entry.js`), model from the local 9router gateway |
| gateway | 9router `http://127.0.0.1:20128/v1` (operator-local; API key in a gitignored env file outside every repo tree, never printed) |
| verification | one check: `node test/smoke.test.js` |

**Model note:** the plan pinned `cbai/glm-5.2` (the model used by the earlier
Qwen live suite). At smoke time the `cbai` upstream was unreachable through the
gateway (DNS-blackholed: connect timeout to `0.0.0.1:443`), so the worker ran on
`ag/gemini-3.8-flash` from the same gateway — a model substitution, not a code
change. Recorded here rather than silently swapping.

## Procedure (reproducible)

1. Scratch project: `git init` + seed commit; `pluton.yaml` with the two Muses,
   `sandbox.kind: local-process`, one `project.verification` check.
2. Env: `OPENAI_API_KEY` (9router key, gitignored file outside the project tree),
   `OPENAI_BASE_URL=http://127.0.0.1:20128/v1`, `OPENAI_MODEL=<gateway model>`,
   `PLUTON_QWEN_BIN=<cli-entry.js>`, `PLUTON_OPENCODE_BIN=<opencode.exe>`.
   No secrets on argv, in config, or in logs.
3. `pluton doctor` pre-flight (engines discovered; Docker daemon down is fine for host mode).
4. `pluton run --goal "<add README heading + test>" --json` → expect `state: verifying`.
5. `pluton verify --run <id> --json` → expect run `completed` with the check recorded.

## Results — Run #1 (2026-10-16, pre-fix, kept as the failure of record)

Run `run_mvb95krv38bcb72a`; task `task_mvb962r4cfc1f27c`.

| step | result | notes |
|---|---|---|
| doctor pre-flight | `[x]` pass | engines discovered; host binaries resolved from env |
| `pluton run` | `[x]` failed (wiring bugs) | run ended `uncertain` / timeout: the manager burned `task.wait` windows of 600 s + 300 s + 420 s into the 20-minute run deadline |
| worker task | `[x]` phantom success | worker session ran ~10 s (17:40:08→17:40:18); task recorded `{"summary":"stopReason: end_turn","outcome":"success",...}` with **zero file changes** — its `edit` was cancelled by the engine permission layer |
| `pluton verify` | `[x]` failed as expected (2026-10-17) | check `smoke test` exit 1 → task `verifying` → `failed`; run stayed `uncertain` (the run gate only closes a run in `verifying`) — the gate caught the phantom success |

Evidence trail (read-only post-mortem of the SQLite store and worker transcript):

- worker transcript shows the edit tool call followed by `Tool "edit" was canceled by the user.` — a fail-closed permission denial, not a worker hallucination;
- 12 `tool.call` events, all `muse=manager`; no engine-approval event was persisted (the durable
  `approval.engine_decision` record arrived with the fix);
- the manager's waits timed out, so `RunSupervisor` finalized the run as `uncertain` while the task sat in `verifying` (not `completed`), which is honest but deadlocked the plan.

## Findings — Run #1 (all fixed in `cceec89`)

| # | finding | evidence | disposition |
|---|---|---|---|
| F1 | the Muse's `approval_mode` never reached the engine session | adapters were built with no options; qwen fell back to session mode `default` where every edit raises `session/request_permission`, and Pluton's default policy answered `deny` fail-closed | fixed: `src/engines/approval.ts` maps `autonomous-bounded → auto + allow_once`, `ask-for-sensitive-actions → auto + deny`, `ask-always → default + deny`; the supervisor's default `adapterFor` builds every adapter through it |
| F2 | the manager waited for a terminal state while the worker sat in `verifying` | `task.wait` resolved only on terminal states; with a verification gate configured, `completed` never arrives without an operator | fixed: `verifying` counts as work-settled for `task.wait`, wakeups fire on entering `verifying`, and the manager prompt explains the gate |
| F3 | an in-flight `task.wait` outlived the HTTP transport | stderr `tools/call 'task.wait' threw: database is not open` at shutdown | fixed: per-request abort signals (client disconnect + server shutdown), handlers observe them and return promptly; `http.stop()` drains in-flight handlers before `store.close()` |
| F4 | engine approval requests vanished from the record | a denial reached the supervisor but no approval event was persisted, leaving a "successful" no-op task | fixed: engine asks are persisted durably as `approval.engine_decision` events (task+muse attribution, bounded description) — distinct from the tool-bridge `approval.requested` event |
| H1 | the smoke gateway key leaked into the scratch repo's history | `engine-keys.env` was committed (`fe36d36`) and therefore cloned into the worker checkout | fixed: key rotated (old key deleted gateway-side), scratch history purged to a clean seed, key file now lives outside every project tree, poisoned checkout deleted |

Fix commit: `cceec89` — 11 new tests pinning the mapping table, the work-settled
wait (unit + end-to-end), the shutdown drain, and the durable approval events;
suite 387/387 green.

## Results — Run #2 (2026-10-17, post-fix)

Run `run_mvbasupj25811c8c` (request-id `smoke-r2-20261017`); task `task_mvbatbn0f9f3f339`.

| step | result | notes |
|---|---|---|
| doctor pre-flight | `[x]` pass | same host env as run #1 |
| `pluton run` | `[x]` pass | run ended `verifying` / `pending_verification` after ~115 s (run #1 burned 600+300+420 s waits into its deadline); manager summary `stopReason: end_turn` |
| worker task | `[x]` real work landed | qwen session ~54 s (18:25:58→18:26:52Z): `README.md` gained the `## Smoke` section and `test/smoke.test.js` was created in the isolated checkout (git status `M README.md`, `?? test/`) — the exact edit class that was cancelled pre-fix |
| `pluton verify` | `[x]` pass | check `smoke test` exit 0 (79 ms); task `verifying` → `completed` (`1/1 checks passed`) |
| run final state | `[x]` `completed` / `success` | closed by `pluton verify` through the gate |

Durable evidence (read-only queries of the project store):

- the manager's wait resolved on the `verifying` transition: `task.awaiting_verification` and the
  55.4 s `tool.call task.wait` share the timestamp `18:26:52.870Z` — no timeout burn;
- `run.finished` events: `outcome: pending_verification, state: verifying` at 18:27:27Z, then
  `outcome: success, via: verification` at 18:29:22Z;
- 10 `tool.call` events, all `muse=manager` (9 `ok`; one `project.read` `not_found` retried
  immediately); `pluton run` stderr empty — no `database is not open`, no cancellation;
- no engine permission prompt occurred — under `auto` + `allow_once` the classifier auto-approves
  safe edits — so this run emitted no `approval.engine_decision` event: that path is pinned by
  tests, not exercised live here.

## Findings — Run #2

- **F1 confirmed live**: the worker's edit landed; pre-fix it was cancelled. The mechanism the fix
  relies on (`auto` classifier auto-approving safe actions) is exactly what ran.
- **F2 confirmed live**: `task.wait` returned the instant the task entered `verifying`; the run
  finalized ~35 s later once the manager finished inspecting (`task.get_result`, `diff.inspect`,
  `task.inspect`).
- **F3 confirmed live**: shutdown ran with an empty stderr. The abort+drain behavior against an
  in-flight wait is pinned by the reworked transport test (the handler ignores the abort; `stop()`
  must wait for it).
- **F4**: see the durable-record note above — not triggered in this run (no prompt happened).
- Post-smoke adversarial review of `cceec89` (independent subagent; full diff + callers read, suite
  run) returned **no blockers** — safe to ship for this shape — with 11 numbered findings (F1 wiring
  not pinned by the suite, `finalize()` wording for blocked dependents, `approval.requested` type
  collision, drain-timer hygiene, aborted-wait report honesty, doc drift, and others). All are
  addressed in the review-fix commit `c2d8fcd` with tests; suite 391/391 green.

## Container-mode smoke (`sandbox.kind: docker`) — 2026-10-17

**Status: RUN — PASS** (Docker Desktop 29.8.2, linux/amd64). Implementation
under test: Tasks 5–7 of the run-wiring plan plus the adversarial-review fixes
(`1f9521c`, `2695e20`, `45f23f6`, `88bd335`). One real leak was found and fixed
(`ba68557`); the first attempt failed on an operator scripting mistake (not a
Pluton defect) — both recorded below.

Scratch project: `.pluton-tmp/smoke-docker/` (gitignored; same two Muses as
`smoke-host`, `sandbox.kind: docker`), seeded so the configured check FAILS
first: `test/smoke.test.js` exits 1 until `README.md` contains a `## Smoke`
section (scratch commit `025d1b1`) — so a green `pluton verify` proves a real
worker edit rather than a trivial exit 0.

### Operator environment

- 9router gateway re-started for this smoke and bound `0.0.0.0:20128` (its
  loopback-bound predecessor had died; nothing was listening on the port). Key
  read from the gitignored `.pluton-tmp/keys/engine-keys.env`, never printed.
- Container → gateway reachability proven from inside the worker container:
  `host.docker.internal` resolves (192.168.65.254 on Docker Desktop) and a real
  authenticated `/v1/chat/completions` call returns a streamed completion. The
  containers also carry the explicit `host.docker.internal:host-gateway`
  mapping (`src/sandbox/muse-containers.ts`, required by reuse validation).

### Results `[x]`

1. Engines image — PASS:
   - `docker build --build-arg PLUTON_ENGINES=1 -t pluton-worker:local docker/worker`:
     the in-build proof printed `opencode v2.0.31` and `0.25.2`.
   - `docker run --rm pluton-worker:local sh -c "opencode --version && qwen --version"`:
     `opencode v2.0.31`, `0.25.2`.
   - `pluton sandbox build-image --engines --json` in `smoke-docker/`:
     `ok: true`, `profile: engines`, `imageId sha256:3ba7607a…`, `tmux 3.3a`,
     `node v24.22.0` — the recorded profile gate is satisfied.
2. Container-mode `pluton run` — PASS (run `run_mvbdxegw64ba23de`): one
   container per Muse (`pluton-project-mvbcakle23bcab26-manager` / `-worker`,
   reused from the failed first attempt — the stale-container reuse path
   exercised live), the manager planned through the tool bridge
   (`project.read`/`task.create`/`task.wait`/`diff.inspect` tool calls), the
   worker edited `README.md` in its own task checkout, the task stopped in
   `verifying` (`task.awaiting_verification`), and the manager settled.
3. `pluton verify --run run_mvbdxegw64ba23de --json` — PASS: task `completed`
   (1/1 checks passed), run `completed`, outcome `success`.
4. Live argv hygiene, both sessions observed mid-run:

   ```
   docker exec -i -w /pluton/project -e TERM -e XDG_CONFIG_HOME -e XDG_DATA_HOME -e XDG_CACHE_HOME -e HOME pluton-project-…-manager /usr/local/bin/opencode acp --log-level warn
   docker exec -i -w /pluton/workspaces/task_mvbdxru02820485e -e TERM -e OPENAI_API_KEY -e OPENAI_BASE_URL -e OPENAI_MODEL -e QWEN_DIR -e NO_COLOR -e HOME pluton-project-…-worker /usr/local/bin/qwen --acp
   ```

   `-e NAME` pairs only — no `=` after any `-e`, so env values (including the
   API key) never enter argv. Engine binaries are the in-image pins; the
   manager's cwd is the container path of the read-only project mount and the
   worker's is the container path of its task checkout (`mapWorkdir`, `88bd335`);
   qwen's own session log records the same cwd and `authType: openai`.

### Findings

- **Engine sessions leaked on run end (fixed in `ba68557`).** Both finished runs
  left live `docker exec … opencode acp` processes in the manager container:
  `runManagerSession()` never closed its session, and a throwing task prompt
  skipped the per-task close. Both now close in `finally`; two supervisor tests
  pin manager-session close and close-on-throw → `unknown_outcome` (never
  claimed as failure). The close mechanism itself was already live-proven —
  run 2's worker sessions were gone from the process list after their tasks
  settled.
- **One stalled model call (engine/gateway flakiness, not a Pluton defect).**
  qwen wrote its final summary, then a subsequent model request hung with no
  log activity for ~8 minutes and no error; Pluton's prompt timeout interrupted
  the session and the task settled with the work already complete (verification
  passed). The run's ~14-minute wall time is dominated by this stall.

### First attempt — operator script error, not a Pluton defect

The first `pluton run` (run `run_mvbdoxn9aa4372bd`) failed with three
`unknown_outcome` tasks (`engine_protocol_error: acp 'session/prompt' failed:
Internal error (code -32603)`). Root cause: the operator's PowerShell key
extraction — `(Get-Content file) -match '^OPENAI_API_KEY=' -replace …` — on a
single-line file `-match` returns a BOOLEAN, so `$true -replace …` became the
literal key `"True"` (4 chars). qwen inside the container correctly got
`401 Invalid API key` (its own session telemetry records it) and Pluton
recorded honest unknowns — the system behaved as designed. Retried with
`Select-String -Pattern '^OPENAI_API_KEY=(.+)$'` extraction: PASS. Lesson: for
secret extraction in PowerShell use `Select-String` groups, not `-match` on
scalar input — the gitignored `.pluton-tmp/smoke-env.ps1` loader is the
supported path for host-mode runs.

### Fail-closed behavior (verified live with no daemon) `[x]`

Fail-closed behavior of container mode (review focus #1: typed error, zero
containers created, run not started):

```
cd .pluton-tmp/smoke-docker
node Y:\Pluton\bin\pluton.js run --goal "make the smoke test say ok" --acceptance "verification passes" --json
```

Observed (exit 1): `ok: false`, error `code: sandbox_unavailable`, message
`container-mode runs need a reachable sandbox: docker daemon not reachable: …`
with the `Fix: start Docker Desktop …` text from the Docker sandbox probe.
Durable check immediately after (read-only): `runs=0`, `tasks=0`,
`sandboxes=0` — the failure happened before the run row existed, so no
half-started run was recorded.

### Previously unverified — now proven, or explicitly still open

- [x] the `engines` image layer installs working `opencode`/`qwen` on linux
  (in-build proof plus the runtime `--version` run, both recorded above);
- [x] containers reach the host gateway: Docker Desktop DNS plus the explicit
  `--add-host host.docker.internal:host-gateway` spec entry, proven with an
  authenticated model call from inside the worker container;
- [x] container user `10001:10001` writes into bind-mounted checkouts and
  engine homes on Windows Docker Desktop (the worker's edit landed and the
  verification gate ran against it);
- [x] `docker exec -i` stdio tunneling of ACP sessions against the real CLIs,
  including the ACP session cwd mapping (live argv + qwen session log above);
- [ ] on Linux hosts, mount ownership (uid remap/chown) remains untested —
  Docker Desktop's broad mount permissions can mask the problem
  (SECURITY.md §8.9).

## Attach / integrate / approvals slice — live evidence (2026-10-17)

Implementation under test: Tasks 1–9 of
`docs/superpowers/plans/2026-10-17-attach-integrate-approvals.md` (commits `60f513f`…`19f8f19`).
Same live environment as the container-mode smoke above (containers
`pluton-project-mvbcakle23bcab26-{manager,worker}` up; run `run_mvbdxegw64ba23de` completed).
Scratch helpers (seed/dump `.mjs`) live under `.pluton-tmp/` and are never committed.

### `pluton attach` — `[x]` argv + session ensure; interactive leg NOT RUN

`node bin/pluton.js attach manager --json` in `smoke-docker/`:

```json
{ "museId": "manager",
  "containerName": "pluton-project-mvbcakle23bcab26-manager",
  "sessionName": "pluton_smoke-docker_manager",
  "sessionCreated": true,
  "argv": ["docker", "exec", "-it", "pluton-project-mvbcakle23bcab26-manager",
           "tmux", "attach-session", "-t", "=pluton_smoke-docker_manager"],
  "attached": false, "exitCode": null }
```

The session itself is proven inside the container:

```
docker exec pluton-project-mvbcakle23bcab26-manager tmux list-windows -t '=pluton_smoke-docker_manager'
→ 0: shell* (1 panes) [80x24] [layout b25d,80x24,0,0,0] @0 (active)   (has-session exit 0)
```

- `--json` resolves the Muse → container → tmux session, ensures the session exists, and returns
  the exact spawn argv without spawning (`attached: false`, `exitCode: null` by design).
- **NOT RUN:** the interactive `docker exec -it … tmux attach-session` leg itself — this harness
  has no real TTY to attach from; the recorded argv is exactly what a real terminal would exec.

### `pluton integrate` — `[x]` PASS (after one live finding, fixed in `19f8f19`)

First live attempt reported `already_integrated` with the base commit `025d1b1` — the worker's
`README.md` edit was still uncommitted in its task checkout (HEAD == base). Workers leave their
checkout dirty on purpose (the manager reviews the diff; `pluton verify` checks the working tree),
and ADR-0009 commits task changes at integration time — but nothing did. **Live finding**:
`19f8f19` makes `integrate` commit any dirty Pluton-managed task checkout before the
protected-path diff and the merge.

Re-run against run `run_mvbdxegw64ba23de` (task `task_mvbdxru02820485e`):

- committed the dirty task checkout as `e2b77b0` (`integration.task_committed` event; the task
  workspace row's `headCommit` updated);
- merged into `pluton/integration/run_mvbdxegw64ba23de` as `5a75f24` (`integration.task_merged`);
  `git log`: `5a75f24` → `e2b77b0` → `025d1b1`; `README.md` carries the `## Smoke` section;
- checks ran **in the integration checkout**: `smoke test` exit 0 (`integration.checks`); artifact
  written to `.pluton/state/artifacts/integration-run_mvbdxegw64ba23de.json`;
- re-run → `already_integrated`, `committed: []` — idempotent. The user's repo tree was never
  touched; work stays on the `pluton/integration/…` branch (main apply is out of scope, ADR-0009).

### `pluton approvals` — `[x]` PASS

Rows seeded via a scratch `.mjs` against the project store (`expires_at` ± minutes), then the real
CLI:

| step | command | observed |
|---|---|---|
| pending | seed +30 min → `approvals list --json` | row visible, `pending`, `expiresInMinutes: 30` |
| approve | `approvals approve approval_mvbh5tzz3dc0f770 --json` | `approved`, `decidedBy: operator`; `approval.decided` event |
| audit | `approvals list --all --json` | counts `approved: 1`, row carries `decidedAt` |
| expiry sweep | seed −5 min → `approvals list --json` | swept to `expired`, `decidedBy: pluton:timeout`; `approval.expired` event |
| fail-closed | `approvals approve <expired> --json` | exit 1, `ok: false`, `request_conflict` — "already expired" |
| deny | `approvals deny approval_mvbh6jgv9bce1bd3 --json` | `denied`, `decidedBy: operator`; `approval.decided` event |

A read-only dump of the store's events confirms the audit trail (`approval.decided` ×2,
`approval.expired` ×1). The approved `muse.create` apply path (create → `syncMuses` → container
provisioning) is pinned by `tests/integration/cli-approvals.test.ts` (16 tests); the live rows above
used the generic `approval.request` action, so no Muse was instantiated by this smoke.

### Still open after this slice

- interactive attach (real TTY) — NOT RUN in this harness;
- Linux-host mount ownership (SECURITY.md §8.9) — unchanged by this slice;
- `integration.apply` approvals are created by `integrate` when the protected-path gate blocks a
  merge, but nothing auto-continues the integrate command after approval — re-running `integrate`
  is the documented flow.

## Interactive chat TUI slice — live evidence (2026-10-17)

Implementation under test: Tasks 1–11 of `docs/superpowers/plans/2026-10-17-tui-chat.md`
(commits `1e906ca`…`168b2bf`).
Same live environment as the container-mode smoke above (containers
`pluton-project-mvbcakle23bcab26-{manager,worker}` up in `.pluton-tmp/smoke-docker`;
9router gateway at `http://127.0.0.1:20128/v1` with `ag/gemini-3.8-flash` via `smoke-env.ps1`).

### Live smoke session (`.pluton-tmp/chat-smoke.mjs`) — `[x]` PASS

Driven headlessly via `ScriptedIo` against the real container-mode OpenCode adapter and
supervisor background runner:

1. **Header & greeting:**
   ```
   Pluton Chat — smoke-docker (Y:\Pluton\.pluton-tmp\smoke-docker)
   Muse: manager [opencode / opencode/deepseek-v4.1-flash-free] (mode: container)
   Session: chat_mvc3onbo21f096e4 (new, 0 messages)
   Type /help for slash commands, or Ctrl+C to exit.
   ```
2. **Conversation with operator proxy:**
   - Prompt: `Hello operator! In one sentence, what is your role?`
   - Operator Reply: `I'm manager, the operator's proxy in this chat: I inspect state and start runs via the available tools, then report results verbatim — though note I currently only see opencode tools exposed, not any pluton tools.`
3. **Slash command `/status`:**
   - Output:
     ```
     Project: smoke-docker (project_mvbcakle23bcab26)
     Operator: manager (opencode/deepseek-v4.1-flash-free)
     Chat session: chat_mvc3onbo21f096e4 (active)
     Current run: 49da0ddc  failed             2026-10-17 07:44:51  Add a "## Smoke" section to README.md so the smoke test passes
     Pending approvals: 1
     ```
4. **Slash command `/approvals`:**
   - Output:
     ```
     ID                       ACTION          REQUESTED BY     REASON
     approval_mvbhy8a0f5c0a03b  approval.request  -                my first approval
     ```
5. **Slash command `/run` (Background run execution & live event polling):**
   - Command: `/run Add a "## Smoke" section to README.md so the smoke test passes`
   - Started run: `run_mvc3p0ld5722fb47`
   - Real-time event poll notices streamed to chat:
     - `run.started (run_mvc3p0ld5722fb47)`
     - `task.admitted (run_mvc3p0ld5722fb47)`
     - `task.started (run_mvc3p0ld5722fb47)`
     - `task.awaiting_verification: success`
     - `run.finished: verifying`
   - Run settled in `verifying` state with task `task_mvc3pzz1b8ca1861` (`Add '## Smoke' section to README.md`).
6. **Task execution & project verification:**
   - Worker Muse (`qwen` on `ag/gemini-3.8-flash`) executed task in its isolated workspace (`.pluton/workspaces/task_mvc3pzz1b8ca1861/README.md`), adding:
     ```markdown
     ## Smoke

     Run `node test/smoke.test.js` to verify that the container-mode smoke check passes.
     ```
   - Ran `node Y:\Pluton\bin\pluton.js verify --run run_mvc3p0ld5722fb47 --json`:
     `1/1 checks passed` (`smoke test` passed, exitCode 0); task & run transitioned to `completed` (`success`).
7. **Clean exit:**
   - Slash command `/quit` → exitCode 0, session `chat_mvc3onbo21f096e4` committed with `Goodbye.`

### Real raw-mode interactive TUI leg — NOT RUN

This automated agent harness has no raw-mode TTY.
To run the interactive TUI directly on an operator workstation:
```bash
# Link the pluton binary locally
npm link

# Inside any initialized Pluton project
pluton chat
# or specify the supervisor/operator muse:
pluton chat manager
```
Keybindings in raw mode:
- `Enter`: submit prompt
- `Shift+Enter` / `Alt+Enter` / `Ctrl+J`: insert newline
- `Ctrl+C`: interrupt active turn / prompt to quit (twice to exit)
- `Ctrl+D`: exit when input buffer is empty
- `Ctrl+L`: clear and repaint screen
- `PageUp` / `PageDown`: scroll viewport

