# PLUTON — Release-Readiness Audit and Docker-Verified Build Report

Date: 2026-10-20
Scope: the SPA UI replacement and the supervised ("Build") workflow, audited
independently against the source, exercised in headless Chrome, and executed
end to end against the container-mode worker image.
Working tree at audit time: branch `main`, HEAD `4d18165f05b034dcf72a2a008041005593793e85`.

---

## 1. Executive summary

The SPA replacement is **functionally real and now release-grade for the web
surface**. Every reported claim was re-derived from the source and reproduced.
Twelve defects were found; all twelve are fixed and regression-tested.

The headline finding was critical: **the SPA's supervised-build start swallowed
its own failure**. A run that could not start (Docker down, worker image
missing, manager engine refused) stayed in `created` forever, emitted no
event, and left the browser stuck on "Thinking… / Stop" with no error. The
server now settles such a run into `failed`, writes the `run.finished` event
the SSE log-watcher derives frames from, and reports the reason.

The supervised Build workflow has now been **executed end to end against a real
Docker worker**: the worker container ran, the task was admitted, executed and
settled, the operator verification gate ran the project's check (**exit code
0**), and the run closed `completed` / `success`. Cancellation during execution
was also executed: the cancel reached the supervisor, the run and task closed
`cancelled`, the request was durable, a repeated cancel was safe, and no engine
process was left behind.

**Release recommendation: READY WITH DOCUMENTED LIMITATIONS.**

The limitations are named in section 8 and are all *honest gaps already
labelled as such in the UI*, not silent breakage.

---

## 2. Baseline preservation

The repository arrived with a large dirty tree. Nothing in it was disturbed.

| | Before | After |
|---|---|---|
| Modified tracked files | 69 | 71 |
| Untracked paths | 19 | 24 |
| **Total** | **88** | **95** |

A programmatic comparison of the modified-file set against the baseline showed
**zero removals** — no pre-existing WIP file was reverted, deleted, staged, or
cleaned (100 % of the 69 baseline-modified files are still modified). The seven
additions are exactly the work of this pass:

| Path | Kind | Why |
|---|---|---|
| `package.json` | modified | one added script (`verify:assets`) |
| `src/ui/brand.ts` | modified | comment tying the terminal art to the canonical mark |
| `src/ui/brand-mark.ts` | new | the canonical PLUTON mark |
| `scripts/verify-assets.mjs` | new | embedded-asset verifier |
| `scripts/verify-assets.d.mts` | new | its type declarations |
| `tests/unit/verify-assets.test.ts` | new | keeps the verifier in CI |
| `docs/PLUTON_RELEASE_READINESS_2026-10-20.md` | new | this report |

`tests/integration/spa-ui.test.ts` (already untracked) was extended in place.

No destructive Git operation was run. No secret was printed: the API key was
read from the gitignored key file and only its length was ever reported.

---

## 3. Independent audit findings

Severity: **C** critical, **H** high, **M** medium, **L** low.

### F1 — CRITICAL — a supervised-build start failure was swallowed

* **Evidence** `src/server/routes.ts` — `POST /api/runs/:id/start` launched
  `resumeRun(...)` with `.then(ok, () => { this.activeRunTasks.delete(runId) })`.
  The rejection handler deleted a map key and nothing else: no run state
  change, no event, no broadcast.
* **Root cause** `resumeRun` rejects before any task exists when the substrate
  is unusable (Docker daemon unreachable, worker image missing or drifted,
  manager engine refuses to start). The durable run row already exists at that
  point, so it must be driven to a terminal state.
* **Impact** the run stayed `created` forever; no `run.` event was written, so
  the SSE log-watcher never emitted a terminal frame; the browser stayed busy
  with no error and no way out.
* **Fix** `failRun(runId, err)` — sets the run to `failed` with
  `finalSummary: "supervised start failed: …"`, appends a `run.finished` event
  (`via: 'start_failure'`), and broadcasts the terminal `run_state` frame
  immediately so the client does not wait for the next poll.
* **Regression test** `tests/integration/spa-ui.test.ts` → *"settles a run whose
  supervised start failed, instead of leaving it pending forever"*.
  **Red-green verified**: with the fix reverted the test times out (the run
  never settles); with the fix it passes in ~0.6 s.

### F2 — HIGH — the composer never left its busy state after a build

* **Evidence** `src/server/static-assets.ts` — `startBuild()` set the busy flag
  and never cleared it; the `run_state` SSE handler stored the run id and
  called `refreshActiveRun()` without inspecting `ev.state`; the build branch
  of `handlePrimaryAction` also never cleared it.
* **Impact** after any build the composer stayed "Thinking…" and the Send
  button stayed a Stop button aimed at a finished run. There was no path back
  to "Send" except clicking Stop, which requested cancellation of an
  already-terminal run.
* **Fix** `applyRunState(runState, goal)` reconciles the composer with the
  durable run state: terminal states clear the busy flag and print the outcome
  once per run; live states name what the run is waiting for
  (`Waiting for verification`, `Waiting for approval`, …) instead of the
  generic "Thinking…".
* **Verification** headless Chrome: the transcript shows
  `Build completed — run run_mvfp…` and the status strip returns to `Ready`.

### F3 — HIGH — cancelling a build left the UI busy

`handlePrimaryAction`'s build branch fired the cancel request and toasted, but
never settled the composer. Fixed to clear the busy flag when the server
answers `cancelled: false` (the run was already over) and to leave it to the
terminal frame otherwise.

### F4 — MEDIUM — the 120 kB aggregate attachment limit was declared but never enforced

* **Evidence** `MAX_TOTAL_ATTACH_CHARS = 120000` existed in the client with
  **zero** references; only the 48 kB per-file cap was applied.
* **Impact** the assembled prompt grew without limit, crossed the server's
  request-body bound, and the operator got a transport error instead of a
  reason.
* **Fix** the aggregate bound is now enforced where the file is attached, with
  a message naming the limit. The declared bound was enforced; nothing was
  weakened.

### F5 — MEDIUM — a supervised build was dispatched with no confirmation

A single Enter created a run, provisioned worker containers, and spent engine
tokens. The reference brief and the operator's own risk profile require an
explicit action. A confirmation panel now names the **operation**, the
**workspace root**, and the **goal**, and nothing is dispatched until "Start
build" is pressed. Escape or Cancel dismisses it and creates no run.

### F6 — MEDIUM — no Escape-to-close, and focus was never restored

No `keydown` handler existed anywhere in the client. `closeTopOverlay()` now
dismisses the nearest overlay (attach modal → build confirmation → model
popover → MCP popover) and returns focus to the element that opened it.

### F7 — MEDIUM — a failed file listing had no retry

Both the Files pane and the attach modal rendered `Failed to list files: …` as
dead text. Both now render a **Retry** button that re-issues the same real API
call, with a "Loading files…" state in between.

### F8 — MEDIUM — the status strip implied a measurement that does not exist

The strip read `Context: unknown`. The runtime exposes **no** context-window
usage — only cumulative tokens reported by the engine (`EngineEvent` carries
`inputTokens` / `outputTokens` / `costUsd`; there is no context field). The
label is now `Tokens:` and the value is `not reported` until the engine
reports usage, at which point it shows the measured total in tokens. A
tooltip states the limitation. Nothing is inferred or fabricated.

### F9 — LOW — an oversized request body reset the connection; malformed JSON returned 500

`readJsonBody` called `req.destroy()` on overflow, so the intended
`payload too large (> 1MB)` error could never be delivered, and invalid JSON
threw a plain `Error` that mapped to 500. The body is now drained (never
buffered past the limit), a hard 8 MB stop protects the process, and the
errors map to **413** and **400**.

### F10 — LOW — a failed engine start left a dead MCP registration

The bridge is registered before `adapter.startSession(...)`; when the start
failed the registration survived, so `/api/mcp` reported a server nobody could
reach and the transport kept a live token. The registration is now dropped on
a failed start.

### F11 — MEDIUM — two brand marks for one product

The web header carried a plain boat; the terminal carried a galleon with a
skull. `src/ui/brand-mark.ts` now holds **one** canonical mark (hull → sail →
jib → yard → mast → skull, bottom to top) with the SVG body as the single
source of truth. The web draws the SVG; the terminal keeps its text rendition
of the same layers, documented as such. The two now share the canonical
palette (`#8B5CF6` accent, `#a78bfa` accent-light).

### F12 — MEDIUM — the live run DAG was buried as the last card of Settings

The DAG is **live execution inspection**, not configuration: it is rendered
from `GET /api/runs/:id` (`run.tasks` + `run.edges`) and is co-located with
the run's own action buttons (Verify & Re-dispatch, Resume, View Diff). The
defect was ordering, not placement-in-the-wrong-pane. The "Agent Orchestra"
card now leads the Settings pane (tagged `live run`) so live state precedes
configuration, without adding a fourth tab and without departing from the
pinned three-tab reference layout.

### F13 — the claimed `scripts/verify-assets.mjs` did not exist

The Impeccable report stated that "verify-assets.mjs now unescapes exactly as
TypeScript does and syntax-checks before anything ships". No such file existed
in the repository. It has been written (see section 5), and the hazard it
addresses is real: **a backtick inside the TypeScript template literal
truncates the served JavaScript.** That exact mistake was made during this
pass and caught by the type checker; the verifier now catches it directly.

---

## 4. Supervised Build evidence (Docker-backed, end to end)

### Environment

| item | value |
|---|---|
| Docker | 29.8.2, Docker Desktop, linux |
| worker image | `pluton-worker:local`, profile `engines`, tmux 3.3a, node v24.22.0 |
| image id (re-recorded) | `sha256:107f7ac0f6705ea4a998c3c2a3fabafe09ea7aed50684d9fdc6011b4ab3db7a6` |
| project | `.pluton-tmp/smoke-docker` (gitignored scratch), `sandbox.kind: docker` |
| engine | `opencode` v2.0.31 inside the container |
| model gateway | 9router on `0.0.0.0:20128`, model `ag/gemini-3.8-flash` (key never printed) |
| project check | `node test/smoke.test.js` — fails until README.md contains `## Smoke` |

**Preflight finding:** the recorded build in the scratch project pointed at
`sha256:3ba7607a…`, but the local image was `sha256:8110c52b…`. The runtime
correctly refused container-mode runs ("worker image changed since the recorded
build"). The documented remediation — `pluton sandbox build-image --engines` —
rebuilt and re-recorded the image. **The drift guard works and was not
bypassed.**

### A. Successful build — executed end to end

```
POST /api/runs          -> 201  runId=run_mvfq0roaf365c8fe  state=created
POST /api/runs/:id/start-> 202  {"ok":true,"status":"running","runId":"run_mvfq0roaf365c8fe"}
  5s  state=active   tasks=0
 45s  state=active   tasks=1 [admitted:Add Smoke section to README.md]
 60s  state=active   tasks=1 [running:Add Smoke section to README.md]   <- worker container executing
 90s  state=active   tasks=1 [verifying:Add Smoke section to README.md]  <- work landed
166s  state=verifying tasks=1 [verifying:...]
```

The **same run id** appears in the create response, the start response, the
durable store, the task rows and the SSE frames.

Verification gate — the endpoint the SPA's own *Verify & Re-dispatch* button
calls:

```
POST /api/runs/run_mvfq0roaf365c8fe/verify -> 200
  taskReports[0].verdict = "completed"
  taskReports[0].summary = "1/1 checks passed (4/4 criteria verified independently)"
  taskReports[0].checks  = [{ name: "smoke test", status: "passed", exitCode: 0 }]
  finalVerdict           = { state: "completed", outcome: "success" }
run state after verify = completed   finalSummary = "1/1 tasks verified"
task state after verify = completed
```

The check is seeded to fail until the worker edits `README.md`, so **exit code
0 proves a real edit landed in the task's isolated checkout**, not a trivial
pass.

### B. Build failure — executed

A container-mode project whose worker image does not exist: `resumeRun`
rejects, `failRun` fires, the run closes `failed` with
`finalSummary: "supervised start failed: worker image '…' is not ready for
container-mode runs…"`, and a `run.finished` event is written. Covered by the
regression test in F1 and observed live in the diagnostic run (settled in
577 ms).

### C. Cancellation during execution — executed

```
created run run_mvfqr834262810c7 -> start -> 202
 75s  tasks=[admitted:Add "## Cancelled Smoke" section to README.md]
>>> CANCEL -> 200 {"ok":true,"cancelled":true,"runId":"run_mvfqr834262810c7"}
 80s  state=cancelled tasks=[cancelled:...]
```

Durable event trail:

```
run.cancel_requested {"reason":"operator:spa","requestedBy":"operator:signal"}
run.finished {"outcome":"cancelled","state":"cancelled","taskCounts":{"cancelled":1},
              "managerSummary":"stopReason: cancelled","durationMs":75733}
run.supervisor_released {"pid":34992}
```

* repeated cancel → `200 {"cancelled":false}` — **safe and idempotent**;
* an unrelated run was unaffected;
* **0 live engine exec processes** remained afterwards;
* the two Muse containers stay `Up` by design (one long-lived container per
  Muse, `sleep infinity` + tmux); the supervisor released ownership
  (`run.supervisor_released`).

*Observation (not a defect in outcome):* stderr recorded
`task … failed: invalid task transition: cancelled -> running` — the
supervisor tried to move a task the cancel had already terminalised. The
state machine correctly refused the illegal edge and the durable outcome was
right (`cancelled`, not a false success). The message is noise on a
cancel/admit race.

### D. Reconnection and recovery

* 50 runs are visible to a reconnecting client; re-reading a run returns the
  **same run id** and the same state.
* A browser reload during this work created **no** duplicate run and started
  **no** duplicate execution (asserted in the browser suite).
* Durable vs transient: the run row, the task rows and the event log are
  durable; the SSE frames are derived live from the event log and are
  intentionally not replayed — a reconnecting client reconciles over REST.

### E. Regression across the rest of the surface

MCP registry — the reported "dynamic count" claim, reproduced live with the
real `opencode` engine:

```
BEFORE any engine session: {"connected":0,"total":0,"transportUp":false,"servers":[]}
AFTER  the session started:  {"connected":1,"total":1,"transportUp":true,
  "servers":[{"name":"pluton","kind":"http","state":"connected",
              "engineKind":"opencode",
              "detail":"…the engine-side MCP handshake is not reported by the engine protocol."}]}
```

The count is derived from the live registry, and the response says plainly
that the engine-side handshake is **not** observable — registration count and
connection status are not conflated.

---

## 5. Verification results

Every command below was executed in this pass; the outcome is what it printed.

| # | Command | Outcome |
|---|---|---|
| 1 | `npm run typecheck` | **PASS** (exit 0, no diagnostics) |
| 2 | `npm test` | **PASS** — 114 files, **1063 tests**, 0 failures |
| 3 | `npm run build` | **PASS** (exit 0) |
| 4 | `node scripts/verify-assets.mjs` | **PASS** — 47 checks, incl. the embedded JS parses |
| 5 | `node scripts/release-check.mjs --allow-dirty` | **PASS** — 15 checks: 12 passed, 0 failed, 1 not tested (POSIX modes on Windows), 2 owner blockers (pre-existing: `private: true`, `UNLICENSED` licence) |
| 6 | headless Chrome suite (34 assertions) | **PASS** — 34/34, 0 console errors, 0 exceptions, 0 failed requests, no horizontal overflow at 1920/1200/820 |
| 7 | API-contract probe | **PASS** — auth 401 on all four new endpoints; traversal 403; repeated start 409; repeated cancel idempotent; model errors 400 with the offered list |
| 8 | Docker supervised build (success path) | **PASS end to end** — worker executed, check exit 0, run `completed`/`success` |
| 9 | Docker supervised build (failure path) | **PASS** — run closes `failed`, reason recorded |
| 10 | Docker supervised build (cancellation) | **PASS** — cancel reached the supervisor, run/task `cancelled`, repeat cancel safe, 0 orphan engine processes |
| 11 | Docker MCP registration | **PASS** — 0 → 1 live, transport up, honesty string present |

The browser suite covers, as executable assertions: the canonical brand mark
rendering at ≥16 px; the honest `Tokens: not reported` state; the live run card
leading the Settings pane; Escape closing and focus restoring for all three
overlays; the build confirmation naming the workspace and goal; **no run
created before confirmation**; exactly one run after confirmation; the file
list rendering real workspace files; the model switch offering a genuine Undo
that restores the previous model; no horizontal overflow at three widths.

**Not run / out of scope**

* The raw-mode interactive TUI leg (no TTY in this harness) — the TUI's
  non-interactive surfaces are covered by the suite (1058 → 1063 tests include
  the TUI approval and theme tests).
* Linux-host bind-mount ownership (`docs/SECURITY.md` A-8.9) — unchanged,
  Docker Desktop's permissive mounts mask it.
* `npm run test:e2e` / `test:live` — separate configs, not part of the
  supported check set for this pass.

---

## 6. Files changed

| File | Change |
|---|---|
| `src/server/routes.ts` | `failRun()` (F1); `readJsonBody` overflow/JSON semantics (F9); `validation_failed` → 400/413 mapping; `dropMcpRegistration` on a failed engine start (F10); request-body constants |
| `src/server/static-assets.ts` | canonical brand mark (F11); honest token status (F8); build confirmation (F5); Escape + focus restore (F6); file-list retry + loading state (F7); aggregate attachment cap (F4); `applyRunState` busy reconciliation and run-status text (F2, F3); Undo affordance on the model switch; live run card moved to the top of the Settings pane (F12); toast action support |
| `src/ui/brand-mark.ts` | **new** — the canonical PLUTON mark (layered SVG) and the favicon data URI |
| `src/ui/brand.ts` | comment binding the terminal art to the canonical mark's layers |
| `scripts/verify-assets.mjs` | **new** — 47 embedded-asset checks, including a real parse of the served JavaScript |
| `scripts/verify-assets.d.mts` | **new** — type declarations for the verifier |
| `tests/integration/spa-ui.test.ts` | +3 tests: the run-settles regression (F1), 413 on an oversized body, 400 on malformed JSON |
| `tests/unit/verify-assets.test.ts` | **new** — keeps the verifier in the suite |
| `package.json` | one added script: `verify:assets` |
| `docs/PLUTON_RELEASE_READINESS_2026-10-20.md` | **new** — this report |

---

## 7. Architecture assessment

| # | Invariant | Verdict |
|---|---|---|
| 1 | The server is the authoritative source of run state | **Confirmed strength.** Every read and write goes through the store; the client only reads. The SPA never invents run state. |
| 2 | A run id identifies one run throughout its lifetime | **Confirmed strength.** Verified across create → start → task → verify → cancel → re-read. |
| 3 | Every started run reaches a terminal outcome or a documented recoverable state | **Fixed (F1).** Now enforced by `failRun`; the `verifying` state is a documented, operator-resolvable gate. |
| 4 | Cancellation reaches the actual execution layer | **Confirmed strength.** `run.cancel_requested` → supervisor → `run.finished{cancelled}` observed live. |
| 5 | Authorization, workspace scoping, approvals and permissions are enforced server-side | **Confirmed strength.** Loopback binding, origin/host validation, timing-safe token on every API route, traversal + symlink containment, approvals decided through the shared `decideApproval` path. |
| 6 | The SPA and the TUI share domain services wherever feasible | **Verified trade-off.** The SPA reuses `store`, the tool bridge, the supervisor and the verification runner rather than reimplementing them; the run *detail view* is SPA-local (a rendering concern, not a domain one). |
| 7 | MCP status reflects observable protocol and transport facts | **Confirmed strength.** `connected` requires a live transport and a live engine session; the response states that the engine-side handshake is not reported. |
| 8 | Persisted state and client state reconcile after refresh or reconnect | **Confirmed strength.** REST re-read returns the same run; a reload creates no duplicate execution. |
| 9 | Embedded static assets remain consistent, testable and correctly served | **Fixed (F13).** `scripts/verify-assets.mjs` now parses the served JavaScript and checks the asset contract, and the suite enforces it. |
| 10 | Unsupported capabilities are explicitly represented | **Confirmed strength.** Voice input stays disabled with a reason; thinking effort is labelled "not available"; the token readout reports "not reported" rather than a fake number. |
| 11 | Tests distinguish API acceptance from actual worker execution | **Confirmed strength.** The build-control test asserts `202` (accepted) *and* a terminal durable state; the Docker evidence separates acceptance from execution explicitly. |
| 12 | Build and release checks preserve the existing development workflow | **Confirmed strength.** `npm run check`, `npm run build` and the release gate are unchanged in behaviour; the release gate caught two of this pass's own mistakes (a missing declaration file) and was re-run green. |

### Classified concerns

* **Verified design trade-off** — the workspace file API serves any readable
  file under the workspace root (traversal and symlinks are blocked; `.git`,
  `node_modules`, `.pluton`, `dist`, `coverage` are not listed). This is a
  read-only view of the operator's own workspace on a loopback, token-gated
  server, and the engine tool bridge has the same reach. A secret denylist
  would be a policy decision, not a defect fix.
* **Potential risk requiring evidence** — a chat prompt is not bounded by
  `runtime.max_prompt_chars` in either the CLI chat path or the SPA path
  (that bound applies to task briefs and the tool bridge). The transport-level
  1 MB request bound and the now-enforced 120 kB attachment bound are what
  actually apply today. Both paths behave the same way, so this is a
  consistency-preserving gap, not an SPA regression.
* **Future improvement** — `POST /api/runs/:id/start` guards a duplicate start
  with an in-memory map, so a second *server process* could start the same run.
  The supervisor's ownership fence (`run.supervisor_claimed` /
  `run.supervisor_released`) is the durable guard, and it held in every run
  observed here.
* **Future improvement** — the cancel/admit race logs
  `invalid task transition: cancelled -> running`. The outcome is correct
  (the task stays cancelled); only the log line is noise.

---

## 8. Remaining blockers and limitations

1. **Owner decisions on publication** (pre-existing, unchanged): `package.json`
   has `"private": true` and `"license": "UNLICENSED"`. The release gate
   blocks publication until the owner decides both. Not a code defect.
2. **POSIX file-mode enforcement is not exercised on Windows.** The gate
   reports it as *not tested* and it runs automatically on the Linux/macOS CI
   jobs.
3. **Linux-host bind-mount ownership is untested** (`docs/SECURITY.md`
   A-8.9). Docker Desktop's permissive mounts mask uid-mapping problems; this
   is unchanged from the previous smoke and needs a Linux host to close.
4. **The raw-mode interactive TUI leg was not run** — this harness has no
   TTY. The terminal's non-interactive surfaces are covered by the suite and
   the terminal brand art was rendered and inspected.
5. **Unsupported capabilities remain unsupported, and are labelled as such in
   the UI:** voice input (disabled with a reason), thinking-effort control
   ("this runtime exposes no thinking-effort control"), and context-window
   usage (the engine protocol carries no such field; only cumulative tokens
   are reported).
6. **One noise-level race remains:** a cancelled task can produce
   `invalid task transition: cancelled -> running` on stderr. The durable
   outcome is correct.

---

## 9. Release recommendation

**READY WITH DOCUMENTED LIMITATIONS.**

* Every required automated check passed in this pass: type check, the full
  Vitest suite (1063 tests), the production build, the embedded-asset
  verifier, and the release gate's technical validation.
* The supervised Docker Build workflow — the check the previous report could
  not claim — was **executed end to end** in all three required shapes
  (success, failure, cancellation), with the worker container actually running
  the task and the project's own verification check passing with exit code 0.
* The critical defect found (a swallowed supervised-build failure) is fixed
  with a red-green-verified regression test, and the eleven other findings are
  fixed and covered.
* The limitations above are explicit, pre-existing, and — where the UI is
  concerned — labelled honestly in the product itself rather than papered over.
* Publication still requires the two owner decisions (private flag, licence);
  that gate was already in place before this pass and was not modified.
