# Docker-Absent Acceptance Audit — PLUTON Native Execution

**Audit date:** 2026-10-22

**Auditor:** Independent code/runtime audit (not the migration author)

**Gate decision:** **ACCEPTED WITH LIMITATIONS**

**Baseline commit:** `1a42d61` (`main`, pre-validation HEAD)

**Worktree:** post-hardening review fixes plus this audit; no push or release performed

---

## 1. Executive verdict

The native execution path is real, selectable by default, and operational without Docker on two
independent hosts: Windows 11 and a real WSL 2 Ubuntu 24.04 userland with the repository on ext4
(not a Windows proxy). Onboarding, diagnostics, substrate probing, multi-agent task execution,
isolated checkout writing, verification, integration, terminal attach/chat, and headless app startup
were exercised. The strongest end-to-end evidence is:

- the complete Linux suite passed with Docker removed from `PATH`: **130 files, 1,211 passed,
  1 skipped** (the skip is the Windows-only `tests/unit/workspace.test.ts` case);
- the complete Windows suite passed: **130 files, 1,212 passed**;
- the Linux release gate passed **15/15**, including the real POSIX 0600 permission probe, package
  scanning, dependency audit, typecheck, tests, and build;
- the Windows release gate passed **14/0/1**; the only not-tested item is POSIX 0600, which Windows
  does not enforce;
- a post-fix real **OpenCode v2.1.2** run on Windows, `run_mvj7x6ig87b32c2e`, reached
  **completed/success** with one task, one passed verification check, 23 durable events, 8 native
  execution events, and **zero sandbox rows**. The artifact was `native-real-engine.txt` with exact
  bytes `6F-6B` (`ok`, 2 bytes) only in the task checkout; the project-root copy was absent;
- a real **OpenCode v2.1.2** run on Linux, `run_mvj5w3i8844a4ab5`, also reached
  **completed/success** with one task, 21 durable events, 8 native execution events, and zero sandbox
  rows. Its artifact was `ok\n` (3 bytes) only in the checkout; the root copy was absent, and no
  OpenCode process remained;
- a fake-engine verification/integration run reached `verifying`, passed `pluton verify`, and was
  merged by `pluton integrate` with its checks passing;
- a real Linux PTY exercised `pluton attach`: the host session `pluton_pluton_manager` was created,
  the real chat TUI rendered, the deterministic TUI demo exited with `q`, detach returned to the outer
  shell with `INNER_ALIVE:0`, reattach accepted `REATTACHED_INPUT_OK`, and cleanup returned
  `INNER_KILL:0` (probe exit 0).

Several defects were confirmed and fixed during the review: `doctor` spawned Docker even in native
mode; `exec` output limits were counted in UTF-16 code units instead of UTF-8 bytes, and decoded
output could still exceed the byte cap when a multibyte sequence was split; isolated workers were not
independently constrained to `.pluton/workspaces/`, and an isolated-policy worker could bypass that
check when the caller reported `isolatedCheckout: false`; the repository's own `pluton.yaml` still
selected Docker/restricted; and a legitimate checkout name beginning with `..` was rejected. The
post-hardening review additionally fixed OpenCode one-shot service reuse (`--standalone`), the
platform semantics used by `sameDirPath`, a release-gate false positive for paths beginning with
`/root`, and two Windows-path test portability issues. No security control was weakened.

The gate is **not** unconditional **ACCEPTED** because the following required dimensions still lack
direct execution:

- a true Docker-uninstalled machine (Docker CLI 29.8.2 is installed; its daemon is stopped);
- macOS runtime parity (no macOS host or SSH target was available);
- interactive TTY attach/chat on Windows and macOS (Linux WSL PTY is now **PASS**; the Windows
  harness is non-interactive and `winpty` is absent);
- Docker-mode container E2E (legacy opt-in path; daemon intentionally not started);
- a real Qwen Code engine (`qwen` is absent/not configured; the Qwen paths used the repository's ACP
  fake).

The first real Windows attempt, `run_mvj7jw3y432500d4`, is recorded as a Manager-planning limitation:
the Manager created a dependent QA task, then cancelled it when the worker task parked in
`verifying`; the worker task and its verification passed, but `finalizeRunVerdict` correctly refuses
to mark a run completed when any task is not completed. The second run with a one-task budget closed
cleanly. This was not a native-execution or cleanup defect.

No remaining defect was found that blocks the normal native path. The limitations are
environmental/coverage limitations, not evidence of a hidden Docker dependency.

---

## 2. Scope and method

The audit checked the requirements in:

- `docs/NATIVE_EXECUTION.md`
- `docs/MIGRATION.md`
- `docs/ACCEPTANCE_REPORT.md`
- `docs/SECURITY.md`
- `docs/superpowers/plans/2026-10-21-docker-free-pluton.md`

Method:

1. Recorded the baseline commit, worktree, toolchain, and Docker installation state.
2. Read the native provider, factory, terminal, config, doctor, run, chat, server, approval, and
   sandbox-selection code paths.
3. Ran the baseline focused and full suites, typecheck, build, and release gate.
4. Reproduced native workflows through the real CLI with Docker removed from `PATH`.
5. Used the repository's child-process guard suite, which intercepts `spawn`, `spawnSync`, `exec`,
   `execSync`, `execFile`, and `execFileSync` and fails on any `docker`/`docker.exe` invocation.
6. Ran a real OpenCode engine through the native provider and checked durable state, checkout
   contents, execution events, sandbox rows, and orphan processes.
7. Ran `pluton verify`, `pluton integrate`, headless app start/status/stop, and host-tmux
   creation/reattachment.
8. Ran cancellation, restart-reconciliation, and workspace-isolation tests.
9. Ran the release gate with and without `--allow-dirty`, and recorded the exact failures.
10. Repeated the suite, build, POSIX permission check, and release gate inside a real WSL 2 Ubuntu
    24.04 userland with the repository on ext4.
11. Ran a post-fix real OpenCode smoke on Windows and Linux, then inspected the SQLite durable state,
    task checkouts, project roots, verification checks, sandbox rows, and matching processes.
12. Exercised a real PTY through tmux on Linux: attach, chat TUI, demo TUI, detach, liveness check,
    reattach, input, and cleanup.
13. Kept fake-engine and real-engine evidence separate; no credential or secret environment value
    is reproduced in this report.
14. Re-ran the release gate after the reviewed changes were committed.

Status vocabulary used below: **PASS** (executed and met the criterion), **FAIL** (executed and did
not meet it), **BLOCKED** (could not execute because of a concrete environmental constraint), and
**NOT VERIFIED** (no direct execution; source/CI inspection only). For release-gate checks,
**NOT VERIFIED** is the audit equivalent of the gate's **NOT TESTED**.

---

## 3. Environment and repository state

| Item | Windows host | Linux host |
|---|---|---|
| OS | Windows 11, `Microsoft Windows NT 10.0.26300.0` | WSL 2 Ubuntu 24.04.5 LTS, kernel `6.18.33.2-microsoft-standard-WSL2` |
| Filesystem | `Y:\Pluton` | `/root/pluton` on ext4 |
| Node.js | `v24.20.0` | `v24.20.0` |
| npm | `10.9.9` | `11.19.0` |
| Git | `2.56.0.windows.2` | `2.43.0` |
| OpenCode | `v2.1.2` | `v2.1.2` |
| tmux | `3.6a-win32` (optional; no host TTY) | `3.4` |
| Docker CLI | `29.8.2`, build `7fc2dff` | not installed in the Ubuntu userland |
| Docker daemon | not reachable (`dockerDesktopLinuxEngine` pipe absent) | not applicable |
| Shell | PowerShell | Bash via `wsl.exe -d Ubuntu-24.04 -u root` |
| Qwen | absent / not configured | absent / not configured |
| macOS | no host or SSH target | **NOT VERIFIED** |

Repository state at validation start:

```text
branch: main
HEAD:   1a42d61
status: six modified tracked files (the review fixes) plus this audit report
ahead:  local commits only; nothing pushed or published
```

The audit did not uninstall Docker, start Docker Desktop, stop shared services, reset the
repository, or discard user changes. Docker was only queried read-only (`--version`, `info`). The
pre-existing Windows `opencode serve --service` process belongs to the active agent harness, not to
the native run; it was left untouched and is not counted as run cleanup evidence.

---

## 4. What "Docker absent" means in this audit

Docker is installed on the audit host, so a literal uninstall was not performed. Two independent
techniques were used instead:

### 4.1 PATH filtering

For native CLI runs, every `PATH` entry containing `Docker` was removed in the child PowerShell
process:

```powershell
$env:PATH = (($env:PATH -split ';') | Where-Object { $_ -notmatch 'Docker' }) -join ';'
Get-Command docker -ErrorAction SilentlyContinue   # returns nothing
```

This proves the tested command cannot resolve `docker` by name. It does **not** prove behavior on
an OS where Docker was never installed; that distinction is recorded as a limitation.

### 4.2 Child-process interception

`tests/integration/docker-free-runtime.test.ts` wraps the six Node child-process entry points and
throws immediately when the executable basename is `docker` or `docker.exe`. The suite covers five
lifecycle paths: `init`, `sandbox probe`, `doctor`, a full multi-agent `run`, and `attach` plan
mode. A self-test confirms the interceptor really blocks a deliberate `docker ps`.

This is the strongest available substitute for a Docker-uninstalled host. It is not a formal proof
over code branches the suite never executes.

### 4.3 Docker inventory

Docker code remains in the repository as **opt-in legacy support**. The runtime selection points
are gated:

| Area | Native path | Docker path | Gate |
|---|---|---|---|
| Config schema | `sandbox.kind` defaults to `native` | `docker` enum retained | `src/config/schema.ts` |
| Team templates | All templates emit `kind: native`, `network_policy: open`, both acknowledgements | Commented opt-in | `templates/teams/*.yaml` |
| `pluton init` | Writes native defaults | Never invokes Docker | `src/cli/commands/init.ts` |
| `pluton doctor` | Reports Docker as `info` **without spawning it** | Probes CLI, daemon, image | `src/cli/commands/doctor.ts` |
| `pluton sandbox probe` | Native provider probe | Docker daemon/image probe | `src/cli/commands/sandbox.ts` |
| `pluton run` | `createNativeExecutionProvider` | `docker exec` contexts and containers | `src/cli/commands/run.ts` |
| `pluton chat` / SPA chat | Native adapter wrapping host engines | Container adapter | `src/cli/commands/chat.ts`, `src/server/routes.ts` |
| `pluton attach` | Host `tmux attach-session` | `docker exec -it … tmux attach-session` | `src/cli/commands/attach.ts`, `src/terminal/attach.ts` |
| `pluton approvals` | No container provisioning | Specialist container if Docker-mode run | `src/cli/commands/approvals.ts` |
| Sandbox manager/image | `createSandboxManager` throws for native | Docker manager / worker image | `src/sandbox/factory.ts` |
| `docker-exec.ts` | Not called | Used only by Docker branch | `src/cli/commands/run.ts` |
| Docker E2E | Excluded from `npm test` | Opt-in `vitest.e2e.config.ts` | `vitest.config.ts` |
| Docker assets | Unused | Worker Dockerfile/engines profile | `docker/worker/` |

The only unconditional Docker spawn found on the normal native path was `doctor`; it is fixed and
covered by a real no-spawn test. Remaining Docker references are selection-gated, documentation,
tests, or unused Docker assets. Static imports of Docker modules do not spawn Docker.

---

## 5. Acceptance matrix

### 5.1 Native lifecycle

| # | Scenario | Exact command / method | Status | Evidence | Implication / remediation |
|---|---|---|---|---|---|
| 1 | Typecheck | `npm run typecheck` | **PASS** | exit 0, no diagnostics | none |
| 2 | Build | `npm run build` | **PASS** | exit 0 | none |
| 3 | Full suite, Docker hidden | Windows: `$env:PATH = …; npm test`; Linux: `npm test` in WSL Ubuntu | **PASS** | Windows 130 files / 1,212 passed; Linux 130 files / 1,211 passed, 1 skipped (Windows-only `workspace.test.ts` case) | proves the suite does not need Docker on either executed platform |
| 4 | Clean onboarding | Docker hidden; `pluton init --team full-stack --name init-audit` | **PASS** | exit 0; generated `kind: native`, `network_policy: open`, both acknowledgements | default onboarding is Docker-free |
| 5 | Diagnostics, repo config | Docker hidden; `pluton --json doctor` in repository | **PASS** | exit 0; 15 ok / 0 warn / 0 fail; `docker-cli: not probed — native mode does not use Docker` | native doctor does not probe Docker |
| 6 | Diagnostics, opencode-only native project | Docker hidden; `pluton --json doctor` | **PASS** | exit 0; engine and auth checks pass | no Docker requirement |
| 7 | Diagnostics, full-stack template | Docker hidden; `pluton --json doctor` in fresh init | **PASS (Docker dimension)** | exit 1; 12 ok / 2 warn / 1 fail; sole fail `engine:qwen: not installed`; Docker `info` not probed | Qwen is an engine prerequisite, not a Docker dependency |
| 8 | Substrate probe | Docker hidden; `pluton --json sandbox probe` | **PASS** | `kind=native`, `available=true`, `dispatchReady=true`, `image=null` | no daemon/image needed |
| 9 | Multi-agent run, fake engine | Docker hidden; `pluton --json run --goal …` | **PASS** | `run_mvj0j6m717d0bfd2` completed/success; 1 task completed | manager + worker executed natively |
| 10 | Real-engine runs | Docker hidden; OpenCode v2.1.2 runs on Windows and Linux | **PASS** | Windows post-fix `run_mvj7x6ig87b32c2e` completed/success, 1 task, verification passed, exact 2-byte `ok` in checkout; Linux `run_mvj5w3i8844a4ab5` completed/success, 1 task, 3-byte `ok\n` in checkout; both 8 native execution events and 0 sandboxes | real engine works under the native provider on both OSes |
| 11 | Verification gate | Docker hidden; run with verification config, then `pluton --json verify --run <id>` | **PASS** | run `verifying/pending_verification` → `completed/success`; 1/1 checks passed | verification is Docker-free |
| 12 | Integration | Docker hidden; `pluton --json integrate --run <id>` | **PASS** | 1 task merged; integration workspace created; checks passed | merge/integration is Docker-free |
| 13 | App startup | Docker hidden; `pluton --json app --headless --detach --port 43123`, `--status`, `--stop` | **PASS** | start/status/stop exit 0; PID 13952 stopped | server/startup is Docker-free |
| 14 | Terminal creation/reattach | Docker hidden; `pluton --json attach manager` twice; `tmux send-keys`/`capture-pane` | **PASS** | session `pluton_audit-doctor_manager`; `containerName=host`; marker visible; reattach same session; kill 0 | host-tmux path works |
| 15 | Interactive attach/chat | real Linux PTY: outer tmux, `pluton attach`, real chat TUI, demo TUI, detach, reattach | **PASS (Linux)** | session `pluton_pluton_manager`; chat and `pluton --demo` rendered; `INNER_ALIVE:0`; `REATTACHED_INPUT_OK`; `INNER_KILL:0`; probe exit 0 | requirement exercised in a real Linux terminal; Windows/macOS interactive TTY remains unverified |
| 16 | Cancellation / recovery | `npx vitest run tests/integration/supervisor.test.ts tests/unit/workspace.test.ts tests/integration/cli-workspace.test.ts` | **PASS** | 3 files, 90 tests; restart reconciliation and cancellation included | orchestration recovery preserved |
| 17 | Native process-tree kill | focused native tests on Windows and Linux | **PASS** | hung exec and session-timeout tests pass; heartbeat stops; Linux process-group cleanup tests pass | no orphaned child observed |
| 18 | Docker-hidden full suite | same as #3 | **PASS** | Windows 1,212/1,212; Linux 1,211 passed + 1 Windows-only skip | strongest suite-level proof on both executed platforms |

### 5.2 Isolation and security

| # | Scenario | Command / method | Status | Evidence |
|---|---|---|---|---|
| 19 | Worker writes only its checkout | `pluton --json run …`; inspect root + `.pluton/workspaces` on Windows and Linux | **PASS** | fake run and both real runs: evidence file exists under `.pluton/workspaces/<task>/`, absent at project root |
| 20 | Symlink cwd escape rejected | `npx vitest run tests/unit/native-execution.test.ts` | **PASS** | new test creates a junction/symlink outside the root; `prepare()` throws `PolicyDeniedError` |
| 21 | Direct cwd escape rejected | same native-execution suite | **PASS** | existing test with a directory outside allowed roots throws `PolicyDeniedError` |
| 22 | Isolated worker workdir hardening | `npx vitest run tests/unit/native-config.test.ts` | **PASS** | tests reject project root, engine-home, resolving symlink-to-root workdirs, and false-flag isolated-policy runs; a `..cache` checkout is accepted |
| 23 | Environment allowlist | `npx vitest run tests/integration/native-execution.test.ts` | **PASS** | unit/integration tests show allowlisted value present, host secret absent, filtered names recorded |
| 24 | Output bounds | `npx vitest run tests/unit/native-execution.test.ts` | **PASS** | UTF-8 tests cover 100-byte and split 101-byte caps; decoded output never exceeds the cap and truncation adds no replacement character |
| 25 | Execution events/provider | store queries per run | **PASS** | Windows `run_mvj7x6ig87b32c2e`: 23 events, 8 `execution.*`; Linux `run_mvj5w3i8844a4ab5`: 21 events, 8 `execution.*`; all `provider: native` |
| 26 | No sandbox rows | store query: `select * from sandboxes` | **PASS** | zero rows after both real runs |
| 27 | Orphan cleanup | Windows `Get-CimInstance Win32_Process`; Linux `pgrep`/`ps` filters | **PASS** | no process matching `pluton-real-smoke-win-20261022`; no Linux `opencode` process remained; a pre-existing Windows `opencode serve --service` belongs to the active agent harness, not the run |
| 28 | Loopback tool bridge | source inspection + real OpenCode runs | **PASS (source/test)** | native chat/run use `127.0.0.1`; both real runs exercised the bridge |
| 29 | Full filesystem/network confinement | design/docs inspection | **NOT CLAIMED** | native is explicitly partial: host user filesystem and network are not kernel-confined |

### 5.3 Quality and release

| # | Scenario | Command / method | Status | Evidence |
|---|---|---|---|---|
| 30 | Focused native/config/doctor/guard tests | `npx vitest run tests/unit/native-execution.test.ts tests/unit/native-config.test.ts tests/unit/doctor.test.ts tests/integration/docker-free-runtime.test.ts tests/integration/native-execution.test.ts` | **PASS** | 5 files, 43 tests |
| 31 | Orchestration/workspace tests | `npx vitest run tests/integration/supervisor.test.ts tests/unit/workspace.test.ts tests/integration/cli-workspace.test.ts` | **PASS** | 3 files, 90 tests |
| 32 | Release gate, clean-tree requirement | `node scripts/release-check.mjs` after commit, Docker hidden | **PASS (Windows + Linux)** | Linux 15/15 including POSIX 0600; Windows 15 checks, 14 passed, 0 failed, 1 not tested (POSIX 0600); `TECHNICAL VALIDATION: PASS`; publication remains explicitly gated |
| 33 | Release gate with `--allow-dirty` | `node scripts/release-check.mjs --allow-dirty` before commit on both hosts | **PASS (technical, pre-commit)** | Linux 15/15; Windows 14 passed, 0 failed, 1 not tested (POSIX 0600); publication blocked by override |
| 34 | POSIX permission enforcement | release-gate output in WSL Ubuntu 24.04 | **PASS (Linux)** | file created with mode 0600 and observed 0600; Windows remains not tested |
| 35 | Linux runtime | full suite, focused suites, gate, real run, PTY on WSL 2 Ubuntu 24.04 | **PASS** | 130 files / 1,211 passed + 1 Windows-only skip; gate 15/15; real run completed; PTY exit 0 |
| 36 | macOS runtime | no macOS host or SSH target | **NOT VERIFIED** | macOS process-group, signal, path, and 0600 behavior unexecuted |
| 37 | True Docker-uninstalled host | `Get-Command docker` after PATH filter | **NOT VERIFIED** | Docker is installed; PATH filtering + interception used on Windows; WSL Ubuntu has no Docker CLI but is not a separate physical host |
| 38 | Legacy Docker E2E | Docker-mode `pluton --json doctor` | **BLOCKED** | Docker mode correctly fails closed with daemon stopped; no container run attempted |
| 39 | Real Qwen engine | `qwen` presence check / source inspection | **BLOCKED** | `qwen` is absent/not configured; Qwen paths used the repository's ACP fake; real OpenCode was used |
| 40 | Fresh dependency installation | `npm ci` with Docker hidden | **PASS (Windows)** | 42 packages installed, 0 vulnerabilities; the post-install suite passed 130 files / 1,211 tests at the earlier baseline, and the final suite passed 1,212 | locked install is reproducible on Windows; a fresh Linux clone additionally lacks two gitignored fixtures (see §9) |

Rows marked **FAIL**, **BLOCKED**, or **NOT VERIFIED** are not passes. Their remediation/next step
is the matching item in §9; PASS rows have no remediation. No row was marked PASS merely because
the implementation appeared to support it.

---

## 6. Detailed evidence

### 6.1 Clean onboarding and default config

Command (Docker hidden):

```powershell
$env:PATH = (($env:PATH -split ';') | Where-Object { $_ -notmatch 'Docker' }) -join ';'
pluton init --team full-stack --name init-audit
```

Observed:

```text
init exit: 0
network_policy: open
kind: native
acknowledge_partial_enforcement: true
acknowledge_host_network: true
probe kind=native available=True image= dispatchReady=True
```

The repository's own `pluton.yaml` was also migrated from `kind: docker` /
`network_policy: restricted` to `kind: native` / `network_policy: open` with both acknowledgements.
Docker remains available by changing `sandbox.kind` back to `docker`.

### 6.2 Native doctor does not spawn Docker

Command (Docker hidden, repository config):

```powershell
pluton --json doctor
```

Observed:

```text
doctor exit: 0
pass  node: v24.20.0
pass  git: git version 2.56.0.windows.2
pass  config: Y:\Pluton (project 'Pluton', 7 muse(s))
pass  engine:opencode: opencode v2.1.2
pass  sandbox: native host execution: cwd boundary, explicit env allowlist and process-tree termination are enforced; filesystem writes, host networking and CPU/memory limits are NOT OS-confined (partial enforcement)
info  docker-cli: not probed — native mode does not use Docker; optional for legacy container workers
info  native-enforcement: ... Host tmux attach is available when tmux is installed on the host.
info  tmux: host tmux is used for `pluton attach` when available; optional for headless native execution.
summary: 15 ok, 0 warn, 0 fail
```

With Docker visible, the same `docker-cli` line is still `info` and still says `not probed`; the
mode check, not Docker availability, controls the branch.

The full-stack fresh-init doctor exits 1 only because `engine:qwen` is not installed:

```text
doctor exit=1 summary=12 ok/2 warn/1 fail
info docker-cli: not probed — native mode does not use Docker; optional for legacy container workers
fail engine:qwen: not installed / not on PATH
pass sandbox: native host execution ...
```

This is an engine prerequisite failure, not a Docker requirement. A native opencode-only config
passes 15/0/0.

### 6.3 Fake-engine multi-agent run and checkout isolation

Command (Docker hidden):

```powershell
$env:PLUTON_QWEN_BIN = 'Y:\Pluton\tests\helpers\fake-qwen-cli.mjs'
pluton --json run --goal 'demonstrate a native CLI multi-agent run without Docker' `
  --acceptance 'worker evidence exists only in its checkout'
```

Observed:

```json
{
  "run": { "id": "run_mvj0j6m717d0bfd2", "state": "completed", "outcome": "success" },
  "taskCounts": { "completed": 1 },
  "managerSummary": "Manager orchestrated native worker task successfully.",
  "unfinishedTasks": [],
  "blockedTasks": []
}
```

Task `task_mvj0j6u11fd42759` used workspace `workspace_mvj0j7i569fa1b39`. The evidence file
`worker-evidence.txt` existed only under `.pluton/workspaces/task_mvj0j6u11fd42759/`; the project
root file was absent. Durable state had 17 events total, 8 `execution.*` events, all with
`provider: native`, and zero sandbox rows.

### 6.4 Real OpenCode engine runs (post-fix)

**Windows (authoritative success).** Docker hidden, scratch Git project, native config, OpenCode
`opencode/deepseek-v4.1-flash-free`, one-task budget:

```powershell
pluton --json run `
  --goal "Create a file named native-real-engine.txt in the worker checkout containing exactly the text ok. Do not modify any other file." `
  --acceptance "native-real-engine.txt exists with content ok"
pluton --json verify --run run_mvj7x6ig87b32c2e
```

The run first returned `verifying/pending_verification`. `verify` then returned:

```json
{
  "run": { "id": "run_mvj7x6ig87b32c2e", "state": "completed" },
  "tasks": [
    {
      "taskId": "task_mvj7ypnu550c07c4",
      "verdict": "completed",
      "summary": "1/1 checks passed (4/4 criteria verified independently)",
      "checks": [{ "name": "real-engine-file", "status": "passed", "exitCode": 0, "note": null }]
    }
  ],
  "runVerdict": {
    "runId": "run_mvj7x6ig87b32c2e",
    "state": "completed",
    "outcome": "success"
  }
}
```

The worker used workspace `workspace_mvj7yq660cc02b29`. Durable state had 23 events, 8
`execution.*` events all with `provider: native`, zero sandbox rows, and both `task.completed` and
`run.finished` (success) persisted. The artifact was found only in
`.pluton/workspaces/task_mvj7ypnu550c07c4/`, contained exactly `ok` (2 bytes, hex `6F-6B`), and the
project-root copy was absent. No process matching the scratch path remained; a pre-existing
`opencode serve --service` process belongs to the active agent harness and predates the run.

**Linux.** The same native OpenCode flow was run from `/root/pluton-real-smoke2` on WSL 2 Ubuntu:

```bash
node /root/pluton/bin/pluton.js --json run \
  --goal "Delegate exactly one task to worker-a to create native-real-engine.txt in the worker checkout containing exactly the text ok. Wait for that task, inspect its diff, then reply with a one-line summary and stop. Do not explore the repository."
```

Run `run_mvj5w3i8844a4ab5` completed/success with task `task_mvj5xzdpb0b896f7` and workspace
`workspace_mvj5xzg21bb2ef19`. Durable state had 21 events, 8 `execution.*` events all native, and
zero sandbox rows. The artifact was `ok\n` (3 bytes, hex `6f 6b 0a`) only in the checkout; the root
copy was absent and no `opencode` process remained. No project verification check was configured
for this Linux run, so its completion evidence is the worker/manager result plus direct checkout
inspection, not a verification row.

**Additional Windows attempt (not counted as PASS).** `run_mvj7jw3y432500d4` reached `verifying`;
task `task_mvj7lnhhbeff8bd2` completed and its `real-engine-file` verification passed. The Manager
had also created dependent QA task `task_mvj7m1x4667387c1` and then cancelled it when the worker
parked in `verifying`. `finalizeRunVerdict` correctly refused to mark the run completed because one
task was not completed, so the run ended `failed`. This is a Manager-planning limitation under a
dependency/gate race, not a native-execution, checkout, verification, or cleanup defect; the second
run with a one-task budget closed successfully.

### 6.5 Verification and integration

A fake-engine run with `project.verification` configured ended in:

```text
run exit=0 id=run_mvj1dua956da94a4 state=verifying outcome=pending_verification
```

Then:

```powershell
pluton --json verify --run run_mvj1dua956da94a4
```

Observed:

```json
{
  "run": { "id": "run_mvj1dua956da94a4", "state": "completed" },
  "tasks": [
    {
      "taskId": "task_mvj1dugtc5d25a84",
      "verdict": "completed",
      "summary": "1/1 checks passed (1/1 criteria verified independently)",
      "checks": [{ "name": "smoke", "status": "passed", "exitCode": 0, "note": null }]
    }
  ],
  "runVerdict": {
    "runId": "run_mvj1dua956da94a4",
    "state": "completed",
    "outcome": "success"
  }
}
```

Then:

```powershell
pluton --json integrate --run run_mvj1dua956da94a4
```

Observed: task merged into `pluton/integration/run_mvj1dua956da94a4`, integration workspace
`workspace_mvj1e4c43c844a91`, one committed task, no conflicts, and the `smoke` check passed.

### 6.6 Application startup

Docker hidden, in the same scratch project:

```powershell
pluton --json app --headless --detach --port 43123
pluton --json app --status
pluton --json app --stop
```

Observed: start exit 0 (`mode: headless`, loopback URL, PID 13952), status exit 0 (`reused: true`),
stop exit 0 (`stopped: true`). PID 13952 was gone after stop; no matching scratch `node` processes
remained.

### 6.7 Host-tmux attach and interactive TTY

**Windows plan-mode attach.** Docker hidden:

```powershell
pluton --json attach manager
```

Observed:

```text
attach exit=0
containerName=host
sessionName=pluton_audit-doctor_manager
argv=tmux attach-session -t =pluton_audit-doctor_manager
has-session=0
pane marker=pluton-attach-post-fix-ok
reattach same session=True
kill=0
```

The session was created, a command was sent into its pane and captured, a second `attach` resolved
the same session, and the session was killed cleanly. This harness is non-interactive, so it does
not by itself prove an interactive handoff.

**Linux real PTY.** The repository was mounted at `/root/pluton` on WSL 2 Ubuntu 24.04 and a real
PTY probe was run from `/root/run-linux-tty-clean.sh` (outer tmux session; `C-a` prefix). The
observed sequence was:

```text
attach -> session pluton_pluton_manager created
real chat TUI rendered (Mode: chat, Model: opencode/deepseek-v4.1-flash-free)
Ctrl+C twice exited the chat TUI
global pluton --demo rendered and exited with q
detach -> INNER_ALIVE:0
reattach -> REATTACHED_INPUT_OK accepted
second detach -> INNER_KILL:0
probe exit 0
```

Evidence is in `/root/tty-attach-chat.log` and `/root/tty-clean.stdout`; the final log lines include
`INNER_ALIVE:0`, `REATTACHED_INPUT_OK`, and `INNER_KILL:0`. This satisfies the interactive
attach/chat requirement on Linux. `pluton chat --demo` did not launch the deterministic demo; the
real chat TUI plus global `pluton --demo` were used instead. That option-collision behavior was not
changed, and it is recorded as a limitation rather than silently counted as a demo pass. Windows and
macOS interactive TTY runs were not available.

### 6.8 Cancellation, recovery, and process cleanup

```powershell
npx vitest run tests/integration/supervisor.test.ts tests/unit/workspace.test.ts tests/integration/cli-workspace.test.ts
```

Result: 3 files, 90 tests passed. This includes restart reconciliation (T1–T7), cancellation
interrupting live sessions (CS-9), workspace branching/cleanup, and durable run/task transitions.
The native-provider focused tests additionally verify that a hung `exec` is killed at its timeout
and that a process tree (parent + heartbeat child) stops on cancellation. The Linux full suite and
focused native/security suites passed as well; after the Linux real run, `pgrep -a opencode`
returned no process, and no process matched the Windows scratch path after either Windows run.

### 6.9 Full suite and release gate

Windows final full suite, with Docker removed from `PATH`:

```text
Test Files  130 passed (130)
Tests       1212 passed (1212)
Duration    ~104 s
```

Linux final full suite, in WSL 2 Ubuntu 24.04 with Docker absent from the userland:

```text
Test Files  130 passed (130)
Tests       1211 passed | 1 skipped (1212)
Skip        tests/unit/workspace.test.ts (Windows-only case)
```

The Linux skip is intentional and platform-scoped, not a suppressed native-execution test. The
focused native/security suites and orchestration/workspace suites also passed on both hosts.

`--allow-dirty` gate runs before commit:

```text
Windows: checks 15 | passed 14 | failed 0 | not tested 1 (POSIX 0600)
Linux:   checks 15 | passed 15 | failed 0 | not tested 0
```

After the reviewed changes and this report were committed, the required clean-tree gate was run on
both hosts with Docker hidden:

```text
Linux:
  [PASS] working tree clean
  [PASS] typecheck + tests (130 files / 1,211 passed, 1 skipped)
  [PASS] build, package contents, dependency audit, owner decisions
  [PASS] file permission enforcement (POSIX 0600)
  checks: 15 | passed: 15 | failed: 0 | not tested: 0 | owner blockers: 0
  TECHNICAL VALIDATION: PASS

Windows:
  [PASS] working tree clean
  [PASS] typecheck + tests (130 files / 1,212 passed)
  [PASS] build, package contents, dependency audit, owner decisions
  [NOT TESTED] POSIX 0600 permission enforcement (Windows does not enforce POSIX mode bits)
  checks: 15 | passed: 14 | failed: 0 | not tested: 1 | owner blockers: 0
  TECHNICAL VALIDATION: PASS
```

Publication was not performed and nothing was pushed. The POSIX permission check remains part of the
platform-parity limitation below; it is now directly exercised on Linux.

### 6.10 Legacy Docker branch regression

Docker mode was not exercised end to end because the daemon is stopped and starting a shared
service is outside the audit's non-destructive scope. A read-only `doctor` check in a Docker-mode
scratch config confirmed the legacy branch is still selected correctly and fails closed:

```text
docker-mode doctor exit=1
pass docker-cli: Docker version 29.8.2, build 7fc2dff
fail docker-daemon: daemon not reachable — worker containers cannot start
fail sandbox: docker daemon not reachable ...
```

This does not verify container execution, image build, or Docker-mode task runs.

---

## 7. Security findings

### 7.1 Confirmed and fixed

1. **UTF-8 output cap (fixed).** `exec` counted JavaScript string length, so a 100-"byte" cap
   allowed 200 bytes of 2-byte characters. It now captures `Buffer` chunks, counts raw bytes, and
   trims a partial multibyte sequence before decoding; a second pass bounds malformed child output
   whose replacement characters could otherwise expand past the cap. Regressions:
   `bounds output by UTF-8 bytes, not UTF-16 code units` and
   `keeps decoded UTF-8 output within the byte cap when a multibyte sequence is split`.
2. **Isolated-worker workdir boundary (fixed).** `nativeSpecForMuse` previously allowed any workdir
   inside the provider's broad roots, including the project root or an engine home. It now
   canonicalizes existing paths with `realpath` and rejects `isolatedCheckout: true` workdirs that
   are not strictly below `.pluton/workspaces/` with `PolicyDeniedError`. A run session whose Muse
   has `workspace_policy: isolated-task-checkout` now also fails closed if the caller reports
   `isolatedCheckout: false`, rather than trusting the flag alone. Regressions cover the project
   root, an engine home, a workspace symlink resolving to the project root, a legitimate
   `..cache` checkout name, and the false-flag wiring case.
3. **Native doctor Docker spawn (fixed).** `doctor` invoked `docker --version` even when
   `sandbox.kind` was native. It now skips the Docker probe entirely outside Docker mode and reports
   a static `info`; the guard test was changed from an injected fake `runFn` to the real
   `runDoctor`, so a regression fails on a real spawn.
4. **Repository default config (fixed).** The checked-in `pluton.yaml` selected Docker/restricted.
   It now selects native/open with both acknowledgements, so a fresh checkout exercises the native
   default. Docker remains an explicit opt-in.
5. **Misleading security documentation (fixed).** The prior acceptance report conflated cwd
   confinement with filesystem confinement and claimed "truncation markers" that do not exist.
   Both claims are corrected; native mode is documented as a process-launch boundary with partial
   enforcement.
6. **Stale timeout/default and tmux documentation (fixed).** `MIGRATION.md` said
   `session_timeout_minutes` defaulted to 30 (actual default is 0); docs implied every session was
   always bounded; architecture/CLI/attach comments described Docker as the default and host tmux
   on Windows as unsupported. These are corrected.
7. **OpenCode one-shot service lifecycle (fixed).** `models` and `auth list` used OpenCode's shared
   managed service. Concurrent doctor/model probes could collide on the service port and leave a
   detached `opencode serve --service` process. Both one-shot commands now pass `--standalone`;
   adapter assertions check the argv and the Linux live probe passed without leaving a persistent
   service.

### 7.2 Confirmed protections

- Cwd is resolved with `realpath` and checked against allowed roots; symlink/junction escapes are
  rejected fail-closed.
- Environment values are allowlisted; host secrets are not inherited by default.
- Native `exec` output is bounded by bytes; process trees are terminated on exit/timeout/cancel.
  Linux process-group cleanup tests passed; Windows and Linux real runs left no matching process.
- Native chat/run tool bridges are configured to bind to loopback (`127.0.0.1`) in source; the real
  OpenCode runs exercised the bridge successfully. Docker's host-gateway exposure is not used.
- Isolated task checkouts are real Git worktrees under `.pluton/workspaces/`; the fake run and both
  real runs on Windows and Linux showed evidence only in the checkout.
- Orchestration retains durable state, approval channels, verification gating, and cancellation.
  The Windows real run persisted `task.completed` and `run.finished` with a passed verification
  check; the Linux real run persisted completion with 8 native execution events.

### 7.3 Residual security limitations (by design)

- Native processes run as the host user. Filesystem, network, CPU, and memory are **not**
  OS-confined. An engine tool can read or write any file the user can access. The acknowledgements
  and `doctor` text make this explicit.
- `network_policy` must be `open` for native; per-Muse `restricted`/`none` values fail closed rather
  than being silently ignored.
- tmux is a visibility/attachment tool, not a security boundary.
- Output truncation now trims a partial multibyte sequence at the byte cap, so decoded output stays
  within the cap and truncation does not add replacement characters. Invalid UTF-8 emitted by a
  child may still decode with replacement characters; the fallback keeps the decoded byte length
  within the cap.

---

## 8. Defects fixed during the audit

| # | Severity | Defect | Reproduction | Fix | Regression |
|---|---|---|---|---|---|
| 1 | High (claim integrity) | `doctor` spawned Docker in native mode, contradicting "zero Docker invocations" | source trace + guard test with injected `runFn` masked the spawn | Docker probe gated to `sandbox.kind: docker`; static native `info` | real `runDoctor` no-spawn test + guard suite |
| 2 | Medium | `exec` output cap counted UTF-16 code units, not UTF-8 bytes | 100-byte cap returned 100 chars / 200 bytes | Buffer chunk capture and byte accounting | UTF-8 byte-bound test |
| 3 | Medium | Isolated worker workdir not independently constrained to task workspaces | `nativeSpecForMuse` accepted project root/engine home with `isolatedCheckout: true`; a workspace symlink to the project root also passed the lexical check | realpath-canonicalized `.pluton/workspaces/` containment check | project root, engine home, and symlink-to-root cases |
| 4 | Medium | Repository's own config still selected Docker/restricted | `pluton.yaml` had `kind: docker`, `network_policy: restricted` | migrated to native/open with acknowledgements | repo `doctor` 15/0/0 Docker-hidden |
| 5 | Low | Docs/help overstated timeout, output, confinement, Docker-default, and tmux behavior | doc/source comparison | corrected `MIGRATION`, `NATIVE_EXECUTION`, `SECURITY`, `ACCEPTANCE_REPORT`, architecture, CLI help, attach comments | doc review; build/tests |
| 6 | Low | Guard test for doctor injected a fake runner, so it could not prove zero real spawns | test inspection | removed injection; real `runDoctor` under child-process guard | suite passes with Docker hidden |
| 7 | Hardening | Provider cwd symlink-escape protection existed but had no regression test | existing behavior passed when tested | added junction/symlink escape test | test passes |
| 8 | Medium | UTF-8 cap could be exceeded after decoding a split multibyte sequence | 101-byte cap + 2-byte characters produced 103 decoded bytes | trim the partial sequence before decode; bounded fallback for malformed input | split-sequence regression asserts decoded bytes <= cap and no replacement character |
| 9 | Low | Legitimate checkout name beginning with `..` was rejected as an escape | `.pluton/workspaces/..cache` failed the prefix check | exact `..` / `..<separator>` containment comparison | `..cache` checkout test |
| 10 | Medium | Isolated-policy worker could bypass containment when the caller reported no checkout | `nativeSpecForMuse` with `isolatedCheckout: false` returned a read-only root spec | fail closed for `sessionKind: run` + `isolated-task-checkout` | false-flag regression |
| 11 | Low | `doctor` reported "no project config" when config loading threw | invalid `pluton.yaml` + native mode | distinguish `configError` from an absent config | doctor config-error test |
| 12 | Medium | OpenCode one-shot `models`/`auth list` reused the shared managed service | concurrent doctor/model probes collided on the service port and could leave a detached `opencode serve --service` | pass `--standalone` for both one-shot commands | adapter argv assertions; Linux live probe 2 passed / 1 skipped with no persistent service |
| 13 | Medium | `sameDirPath` applied host path semantics to the requested target platform | a `win32` path comparison used POSIX rules when evaluated on Linux (and vice versa) | select `win32`/`posix` path semantics from the `platform` argument | `app-lifecycle` platform-path test, 12/12 on Windows and Linux |
| 14 | Low | Release-gate leak regex false-positived on a one-segment `/root` home | `/root` was reduced to the bare word `root`, matching ordinary prose | preserve the leading separator for absolute POSIX paths | `release-gate` 27/27 on both hosts, including positive and negative `/root` cases |
| 15 | Low | Windows-path unit tests used host `join`, so they failed on Linux | `opencode-pure` assertions produced `/...` instead of `C:\\...` under WSL | use `win32.join` for Windows fixtures | `opencode-pure` 10/10 on Windows and Linux |

No security control was weakened to obtain a pass. One checked-in configuration posture did change:
`pluton.yaml` moved from Docker/`restricted` networking to native/`open` with both acknowledgements,
because native mode cannot enforce a restricted network. That is an explicit, documented trade-off,
not a hidden weakening. The native provider's partial-enforcement model was preserved rather than
being described as stronger than it is.

---

## 9. Remaining risks and limitations

1. **True Docker absence is not proven.** Docker CLI 29.8.2 is installed. PATH filtering and
   child-process interception are strong proxies, but an OS without Docker may expose installer or
   packaging assumptions not present here. Remediation: repeat the matrix on a clean VM/image with
   no Docker packages.
2. **macOS runtime is unverified.** Linux POSIX is now executed in WSL 2 Ubuntu 24.04: process-group
   cleanup, signals, path handling, and POSIX 0600 pass. No macOS host or SSH target was available,
   so macOS process-group, signal, path, and permission behavior remains **NOT VERIFIED**.
   Remediation: run the full matrix and release gate on a macOS runner.
3. **Interactive attach/chat is verified on Linux only.** A real Linux PTY exercised attach, the
   chat TUI, demo TUI, detach, reattach, and cleanup. The Windows harness is non-interactive and
   `winpty` is absent; macOS was unavailable. `pluton chat --demo` did not launch the deterministic
   demo (the real chat TUI and global `pluton --demo` were used), and that option collision was not
   changed. Remediation: manual TTY acceptance on Windows and macOS, and decide whether to fix the
   `chat --demo` option collision.
4. **Legacy Docker mode is not E2E-tested here.** The daemon is stopped; Docker mode correctly
   fails closed in `doctor`, but container creation, image build, and Docker-mode task execution
   were not run. This is the opt-in legacy path, outside the native acceptance gate, but it remains
   a regression risk. Remediation: run the opt-in Docker E2E suite on a host with Docker Desktop.
5. **Real Qwen is blocked.** `qwen` is absent/not configured; Qwen workflows used the repository's
   fake ACP engine. Real OpenCode v2.1.2 succeeded on Windows and Linux, but one engine is not broad
   engine coverage. Remediation: install/configure Qwen and repeat the real-engine smoke.
6. **Native isolation is partial by design.** Filesystem, network, and resource limits are not
   kernel-enforced. The acknowledgements and `doctor` text are accurate, but operators must not
   treat native mode as a container boundary.
7. **UTF-8 truncation now trims a partial multibyte sequence** before decoding, so truncation does
   not add replacement characters and the decoded byte length stays within the cap. Malformed UTF-8
   emitted by a child may still decode with replacement characters; the fallback bounds the bytes.
8. **Release-gate coverage differs by OS.** Linux passed 15/15 including POSIX 0600; Windows passed
   14/0/1 because Windows does not enforce POSIX mode bits. Both clean-tree gates were run after the
   reviewed commit. Publication was not performed and nothing was pushed; macOS CI remains
   outstanding.
9. **Full-stack template requires Qwen.** A fresh full-stack `doctor` exits 1 when Qwen is absent,
   even though Docker is not involved. This is an engine prerequisite, not a Docker regression;
   users can use an opencode-only team or install Qwen.
10. **Fresh dependency installation is verified on Windows only, and the Linux workspace was
    prepared.** `npm ci` with Docker hidden installed 42 locked packages with 0 vulnerabilities, and
    the post-install suite passed 130 files / 1,211 tests at the earlier baseline; the final Windows
    suite is 1,212. A fresh Linux clone lacks two gitignored fixtures
    (`.pluton/roles/` and `.pluton-tmp/smoke-docker/pluton.yaml`), so those fixture-dependent tests
    fail until the fixtures are provisioned. The prepared Linux workspace passed 1,211 plus one
    Windows-only skip; this is a test-fixture packaging gap, not a native-execution failure.
11. **Manager planning can produce a non-success run after verification.** In the first Windows real
    attempt, the Manager created a dependent QA task and cancelled it when the worker parked in
    `verifying`; the worker and verification passed, but the run correctly ended `failed` because a
    non-completed task remained. The one-task-budget rerun closed `completed/success`. This is a
    Manager-planning limitation, not a native-execution or cleanup defect.
12. **Real-engine evidence differs slightly by platform.** The Windows run had a configured
    `real-engine-file` verification check and produced exact 2-byte `ok`; the Linux run had no
    project verification check, produced 3-byte `ok\n`, and was validated by direct checkout
    inspection plus durable events. Both prove checkout-only native execution, but the verification
    depth is not identical.

---

## 10. Gate decision

### **ACCEPTED WITH LIMITATIONS**

The native execution migration meets the core Docker-free acceptance criteria on two executed hosts,
Windows 11 and WSL 2 Ubuntu 24.04:

- default config/onboarding is native and Docker-free;
- native init, doctor, probe, run, task execution, checkout isolation, verification, integration,
  app startup, terminal creation/reattachment, interactive attach/chat (Linux PTY), and process
  cleanup work with Docker hidden;
- the full suite passes with Docker hidden on both hosts (Windows 1,212; Linux 1,211 plus one
  Windows-only skip);
- real OpenCode v2.1.2 runs complete natively on both hosts and write only in their isolated
  checkouts; the Windows run also persisted a passed verification check and `run.finished` success;
- Docker remains an explicit opt-in legacy path and correctly fails closed when its daemon is
  unavailable;
- no blocking native-path defect remains after the reviewed fixes above.

The decision is not unconditional **ACCEPTED** because true Docker absence, macOS runtime,
interactive TTY on Windows/macOS, Docker-mode E2E, and real Qwen execution still lack direct
evidence. Those are recorded as **BLOCKED** or **NOT VERIFIED**, not hidden as PASS. The Linux TTY
requirement is now satisfied and is no longer a gate blocker.

The reviewed changes are committed and both clean-tree release gates were run: Linux **15/15**
(including POSIX 0600) and Windows **14/0/1** (POSIX 0600 not tested on Windows). Technical
validation passed on both hosts; nothing was pushed or published.

**Conditions to upgrade to ACCEPTED:**

1. Re-run this matrix (including `npm ci`) on a host/VM with no Docker packages installed and no
   Docker daemon.
2. Run the release gate on macOS and a fresh Ubuntu clone; provision or remove the two gitignored
   Linux fixtures (`.pluton/roles/` and `.pluton-tmp/smoke-docker/pluton.yaml`) so a clean clone is
   self-sufficient.
3. Perform a real TTY attach and interactive chat test on Windows and macOS, with and without tmux,
   and decide whether the `pluton chat --demo` option collision should be fixed.
4. Run the opt-in Docker E2E suite on a host with a working Docker daemon.
5. Run at least one real Qwen engine smoke in addition to OpenCode.

---

## Appendix A — Files changed by this audit

Implementation and tests:

- `src/execution/native.ts` — byte-accurate output capture.
- `src/execution/factory.ts` — isolated-worker workspace containment.
- `src/cli/commands/doctor.ts` — no Docker spawn outside Docker mode; native/local-process info;
  corrected tmux text.
- `src/cli/commands/run.ts`, `src/cli/commands/attach.ts`, `src/cli/main.ts`,
  `src/config/schema.ts`, `src/terminal/attach.ts` — native-first comments/help.
- `tests/unit/native-execution.test.ts` — UTF-8 cap, symlink escape.
- `tests/unit/native-config.test.ts` - isolated workdir boundary and symlink-to-root containment.
- `tests/unit/doctor.test.ts` — no-probe assertions.
- `tests/integration/docker-free-runtime.test.ts` — real `runDoctor` no-spawn guard.

Post-hardening review fixes:

- `src/engines/opencode/adapter.ts` — `--standalone` for one-shot `models` and `auth list` queries.
- `tests/unit/opencode-adapter.test.ts` — argv assertions for both one-shot commands.
- `src/server/instance.ts` — target-platform path semantics in `sameDirPath`.
  Existing `tests/unit/app-lifecycle.test.ts` supplies the Windows/POSIX regression coverage.
- `scripts/lib/release-gate.mjs` — anchor single-segment POSIX paths to a leading separator.
- `tests/unit/release-gate.test.ts` — `/root` false-positive and true-positive regression.
- `tests/unit/opencode-pure.test.ts` — use `win32.join` for Windows-path fixtures on Linux.

Configuration and documentation:

- `pluton.yaml` — native/open with acknowledgements.
- `docs/MIGRATION.md` — timeout default and doctor behavior.
- `docs/NATIVE_EXECUTION.md` — optional session timeout vs run/task deadlines.
- `docs/SECURITY.md` — optional session timeout; partial enforcement wording.
- `docs/ACCEPTANCE_REPORT.md` — corrected confinement/output claims, test counts, audit note.
- `docs/PLUTON_ARCHITECTURE.md` — native execution and host-tmux sections.
- `docs/DOCKER_ABSENT_ACCEPTANCE_AUDIT.md` — this report.

No commits were pushed or released. The reviewed change set is committed, and both clean-tree
release gates passed (Linux 15/15; Windows 14/0/1 with POSIX 0600 not applicable).

---

## Appendix B — Key commands run

```powershell
# Windows baseline / final quality
npm run typecheck
npm run build
npm test
npm test                                  # with Docker removed from PATH
node scripts/release-check.mjs
node scripts/release-check.mjs --allow-dirty

# Windows native lifecycle, Docker hidden
pluton init --team full-stack --name init-audit
pluton --json doctor
pluton --json sandbox probe
pluton --json run --goal "..." --acceptance "..."
pluton --json verify --run run_mvj7x6ig87b32c2e
pluton --json integrate --run <id>
pluton --json app --headless --detach --port 43123
pluton --json app --status
pluton --json app --stop
pluton --json attach manager

# Focused suites
npx vitest run tests/unit/native-execution.test.ts tests/unit/native-config.test.ts tests/unit/doctor.test.ts tests/integration/docker-free-runtime.test.ts tests/integration/native-execution.test.ts
npx vitest run tests/integration/supervisor.test.ts tests/unit/workspace.test.ts tests/integration/cli-workspace.test.ts
npx vitest run tests/unit/opencode-adapter.test.ts tests/unit/opencode-pure.test.ts tests/unit/release-gate.test.ts tests/unit/app-lifecycle.test.ts
```

```bash
# Linux (WSL 2 Ubuntu 24.04, repository on ext4)
cd /root/pluton
npm test
node scripts/release-check.mjs --allow-dirty
node scripts/release-check.mjs            # after commit

# Real OpenCode smoke
cd /root/pluton-real-smoke2
node /root/pluton/bin/pluton.js --json run \
  --goal "Delegate exactly one task to worker-a to create native-real-engine.txt in the worker checkout containing exactly the text ok. Wait for that task, inspect its diff, then reply with a one-line summary and stop. Do not explore the repository."

# Interactive PTY
bash /root/run-linux-tty-clean.sh
# Expected markers: INNER_ALIVE:0, REATTACHED_INPUT_OK, INNER_KILL:0, probe exit 0.

# Process and durable-state inspection
pgrep -a opencode
node /root/inspect-linux-runs.mjs
```
