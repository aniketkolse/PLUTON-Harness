# Host-mode live smoke — `pluton run` with OpenCode manager + Qwen worker

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
