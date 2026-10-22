# Docker-Free Pluton Acceptance Report

**Date:** October 2026\
**Status:** ACCEPTED WITH LIMITATIONS\
**Scope:** Elimination of mandatory Docker dependency across installation, onboarding, diagnostics, task execution, terminal attachment, verification, and multi-agent orchestration on the tested Windows host.

> **Independent audit note (2026-10-22):** A separate Docker-absent acceptance audit re-ran these
> workflows and records **ACCEPTED WITH LIMITATIONS** because a true Docker-uninstalled host,
> POSIX/macOS runtime, interactive TTY attach, Docker-mode E2E, and real Qwen execution were not
> executable on the audit host. The audit is authoritative for release status. See
> [`DOCKER_ABSENT_ACCEPTANCE_AUDIT.md`](DOCKER_ABSENT_ACCEPTANCE_AUDIT.md).

---

## 1. Executive Summary

Pluton-Harness was originally conceived with Linux container isolation (`sandbox.kind: docker`) as its sole execution substrate (ADR-0004). While containers provide containerized process isolation, requiring Docker Desktop or the Docker daemon imposed significant friction: installation hurdles on developer laptops, restricted execution in nested CI environments, high resource overhead, and brittle filesystem bind-mount semantics across host operating systems.

This acceptance report documents and verifies the implementation of **native execution** (`sandbox.kind: native`) as the **default runtime substrate** in Pluton.

### Acceptance Verdict: ACCEPTED WITH LIMITATIONS

The native path is implemented and was exercised end to end on Windows with Docker removed from
`PATH`. It does not require Docker for the tested workflows, but it is **not** claimed to be verified
on a host with Docker completely uninstalled, on POSIX/macOS, through a real interactive TTY, or
through Docker-mode E2E. Those gaps are recorded as **NOT VERIFIED** or **BLOCKED** in the audit.

1. **Docker-Free Execution (tested on Windows)**: With every Docker-containing directory removed
   from `PATH`, `pluton init`, `pluton doctor`, `pluton run`, `pluton attach` plan/reattach,
   `pluton verify`, `pluton integrate`, and headless app start/status/stop completed successfully.
   A true Docker-uninstalled host remains **NOT VERIFIED**.
2. **Native Default Substrate**: Configuration schemas (`src/config/schema.ts`) and all project starter templates (`templates/teams/*.yaml`) default to `sandbox.kind: native` with `runtime.network_policy: open`.
3. **Multi-Agent Orchestration Preserved**: Pluton's core value proposition — supervisor-worker delegation, isolated per-task checkouts (`.pluton/workspaces/`), durable SQLite state tracking, approval inbox, and verification gating — functions identically and reliably in native mode.
4. **Host Terminal Management**: Host-native terminal management (`src/terminal/native.ts`) attaches directly to host `tmux` sessions without `docker exec`, and fails closed with actionable diagnostic guidance if `tmux` is absent. Creation and reattachment were verified; an interactive TTY attach was **NOT VERIFIED**.
5. **Guard Testing**: Integration guard tests (`tests/integration/docker-free-runtime.test.ts`) intercept process spawning and assert zero Docker invocations across five guarded lifecycle paths: init, probe, doctor, run, and attach. `verify` and `integrate` were exercised separately through the CLI with Docker hidden. The chat TUI and Docker-mode E2E are **NOT VERIFIED**.

---

## 2. Audit of Remaining Docker References

Docker support has not been deleted; it has been isolated as an **opt-in legacy substrate** (`sandbox.kind: docker`) for teams that explicitly configure container boundaries. A complete audit of all remaining Docker references across the repository was conducted. The references fall into seven well-defined categories:

| Category | Files / Modules | Technical Rationale | Impact on Native Execution |
|---|---|---|---|
| **1. Legacy Container Provider** | `src/sandbox/docker.ts`<br>`src/sandbox/factory.ts`<br>`src/sandbox/muse-containers.ts`<br>`src/sandbox/image.ts`<br>`src/sandbox/types.ts` | Implements `DockerSandboxManager`: container creation argv, inspect, start, stop, remove, and worker image verification. Preserved for backward compatibility when `sandbox.kind: docker` is explicitly chosen. | **None.** Gated strictly by `sandbox.kind === 'docker'`. When `sandbox.kind: native`, `createSandboxManager` or `createNativeExecutionProvider` is selected, and zero container code paths run. |
| **2. Container Engine Transport Seam** | `src/engines/docker-exec.ts` | Tunnels ACP stdio through `docker exec -i` with host-to-container path mapping and environment variable pass-through for container-mode Muses. | **None.** Native execution spawns engine binaries directly on the host via `NativeExecutionProvider` (`src/execution/native.ts`), completely bypassing `dockerExecSpawn`. |
| **3. Terminal Container Attach Fallback** | `src/terminal/attach.ts`<br>`src/terminal/manager.ts` | Builds `docker exec -it <container> tmux attach-session` argument vectors when targeting container sessions. | **None.** When `sandbox.kind: native`, `buildAttachArgv` and `attachToMuseTerminal` dispatch `['tmux', 'attach-session', '-t', target]` directly to the host OS. |
| **4. Live Approval Provisioning Hooks** | `src/cli/commands/approvals.ts`<br>`src/cli/commands/muse-provision.ts` | Provisions container infrastructure when an operator approves a dynamic `muse.create` proposal during a live container-mode run. | **None.** Branch is explicitly gated by `ctx.loaded.config.sandbox.kind === 'docker'`. In native mode, dynamic Muses are configured in-memory and in SQLite without container provisioning. |
| **5. Container Packaging & Build Assets** | `docker/worker/Dockerfile`<br>`scripts/lib/release-gate.mjs`<br>`package.json` | Pinned worker image recipe and release gate asset checks ensuring that npm distribution packages contain container assets for container-mode users. | **None.** Packaging assets do not execute during runtime. Native execution does not pull, build, or reference container images. |
| **6. Unit and Opt-In E2E Test Suites** | `tests/unit/docker-exec.test.ts`<br>`tests/unit/sandbox.test.ts`<br>`tests/e2e/docker-sandbox.e2e.test.ts`<br>`tests/e2e/linux-bind-mount.e2e.test.ts` | Unit tests verify pure argument building logic for container mode. E2E tests are strictly opt-in (`PLUTON_E2E_DOCKER=1`) and skipped during standard runs. | **None.** These tests ensure Docker mode does not regress for users who opt into it. Standard test workflows (`npm test`) run 100% Docker-free. |
| **7. Architecture History & ADRs** | `docs/adr/0004-sandbox-container-model.md`<br>`docs/delivery-report.md`<br>`docs/audits/source-parity-report.md`<br>`docs/smoke-live-run.md`<br>`docs/LINUX_BIND_MOUNT_VALIDATION.md` | Historical architecture decision records and past delivery milestones documenting the evolution from container-only to native-first. | **None.** Documentation files only. |

**Audit Conclusion:** No unisolated or ambient Docker dependencies remain in Pluton's core execution path. All container-specific code paths are guarded behind explicit configuration checks (`sandbox.kind === 'docker'`).

---

## 3. Evidence Matrix

### 3.1 Test Suite Verification
The complete test suite runs and passes with every Docker-containing directory removed from `PATH`:

```
Test Files: 130 passed (130)
Tests:      1211 passed (1211)
Duration:   ~104s
Status:     100% PASS (Windows)
```

### 3.2 Runtime Guard Tests (`tests/integration/docker-free-runtime.test.ts`)
A dedicated integration guard suite intercepts all Node.js `child_process` methods (`spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync`) and raises an immediate assertion error if any invocation of `docker` or `docker.exe` occurs.

The guard suite validates five critical operational areas:

| Test Case | Operational Area | Observed Invocations of `docker` | Result |
|---|---|---|---|
| **a. Project Onboarding** | `runInit` initializes a project from template with `sandbox.kind: native` defaults | 0 | **PASS** |
| **b. Substrate Probing** | `sandboxProbe` probes provider capabilities, returning `provider: native` | 0 | **PASS** |
| **c. Diagnostics** | `runDoctor` does not spawn Docker in native mode and reports it as optional | 0 | **PASS** |
| **d. Multi-Agent Run** | `runRun` plans, delegates, checkouts, and completes task with isolated workspaces | 0 | **PASS** |
| **e. Terminal Attach** | `attachMuse` and `attachToMuseTerminal` resolve host tmux argv in plan mode | 0 | **PASS** |

This guard covers the five paths above. `verify` and `integrate` were executed separately through
the CLI with Docker hidden; they are not part of this guard. The chat TUI and Docker-mode E2E were
not covered.

### 3.3 Live Multi-Agent Execution Verification (`scripts/demo-native-run.mjs`)
A live demonstration script was executed against a clean scratch directory on the host with every Docker-containing directory removed from `PATH`:

```
=== Pluton Native Execution Demonstration ===

1. Scratch project initialized with sandbox.kind: native
2. Sandbox probe result:
   - Available: true
   - Kind: native
   - Detail: native host execution: cwd boundary, explicit env allowlist and process-tree termination
             are enforced; filesystem writes, host networking and CPU/memory limits are NOT OS-confined
   - Warnings: native execution runs engine processes directly on the host (partial enforcement)

3. Executing multi-agent run without Docker...
   Run completed:
   - Run ID: run_mviiw0gmbc24385c
   - State: completed
   - Outcome: success
   - Task counts: { completed: 1 }

4. Durable task facts from SQLite store:
   - Task task_mviiw0mx987a082f: state=completed, assignee=worker-a, workspace=workspace_mviiw124e7489695

5. Workspace checkout isolation:
   - Workspace path: ...\.pluton\workspaces\task_mviiw0mx987a082f
   - Workspace has worker-evidence.txt: true
   - Root dir has worker-evidence.txt: false (isolated!)

6. Durable execution events (8 recorded):
   - [execution.session_prepared] muse=manager (provider=native)
   - [execution.session_started]  muse=manager (pid=11536)
   - [execution.session_prepared] muse=worker-a (provider=native)
   - [execution.session_started]  muse=worker-a (pid=2972)
   - [execution.session_exited]   muse=worker-a (code=0)
   - [execution.session_closed]   muse=worker-a (live process trees terminated)
   - [execution.session_exited]   muse=manager (code=0)
   - [execution.session_closed]   muse=manager (live process trees terminated)

=== Demonstration Succeeded: Native Multi-Agent Orchestration Verified ===
```

### 3.4 Packaging & Quality Validation
A fresh `npm ci` installed 42 locked packages with 0 vulnerabilities. The local quality commands
and the clean-tree release gate pass:

```bash
npm run typecheck # 0 errors
npm run build     # exit 0
npm test          # 130 files passed, 1211 tests passed
node scripts/release-check.mjs
# checks: 15 | passed: 14 | failed: 0 | not tested: 1 (POSIX 0600)
# TECHNICAL VALIDATION: PASS
# PUBLICATION: ELIGIBLE — publishing still requires explicit human approval
```

The gate was run with every Docker-containing directory removed from `PATH`. Publication was not
performed.

---

## 4. Honest Security Analysis: Platform Capabilities

Pluton enforces a strict **honesty policy** regarding security claims: native host execution does not provide OS-level kernel sandboxing, and Pluton does not claim that it does.

### Enforced Security Boundaries (What Native Protects)

1. **Working Directory Confinement**:
   - Every spawned engine process must specify a working directory within allowed host roots:
     - Project root (`<project-root>`)
     - Isolated task workspaces (`<project-root>/.pluton/workspaces/`)
     - Engine homes (`<project-root>/.pluton/engine-homes/`)
   - Every spawned process cwd is canonicalized (real path) and must fall inside these roots; symlink escapes are rejected fail-closed with `PolicyDeniedError`.
   - This is a process-launch boundary, not a filesystem sandbox: engine tools can still access any path the host user can read or write (see limitations below).
2. **Environment Variable Filtering**:
   - Host child processes do not inherit the ambient host environment.
   - Pluton filters environment variables against an allowlist containing standard runtime variables (`PATH`, `HOME`, `USERPROFILE`, `XDG_*`, `CI`, `COLORTERM`) plus explicitly configured keys in `sandbox.native.env_allowlist`.
   - Host secrets, cloud provider tokens, and shell credentials are stripped before process spawn.
3. **Process-Tree Termination**:
   - Engine sessions can be capped by `session_timeout_minutes` (default `0` disables the provider-level cap); run and task deadlines still bound dispatch.
   - When a task completes, times out, or is cancelled, Pluton kills the **entire process tree** (`taskkill /t /f` on Windows; process-group signals on POSIX), preventing orphaned child processes.
4. **Stream Output Bounds**:
   - Process output streams are capped at `max_output_bytes` (default 1MB) per stream, counted in UTF-8 bytes; results report `truncated: true` when the cap is reached.
5. **Loopback Tool Server Binding**:
   - In native mode, the MCP tool bridge binds strictly to loopback (`127.0.0.1`), eliminating the external LAN exposure required by Docker container bridge gateways (`0.0.0.0`).

### Platform Limitations (What Native Does NOT Protect)

1. **Filesystem Permissions**: Host processes execute under the operator's host user account and can access any file accessible to that user account.
2. **Network Egress**: Host processes share the host network stack. Pluton cannot enforce network isolation or firewall rules without containerization or kernel sandboxing.
3. **Resource Limits**: CPU and memory limits configured in `runtime` or `sandbox` serve as planning budgets and diagnostic thresholds, not cgroup hard limits.

### Fail-Closed Governance

Because native execution runs with partial process-policy enforcement rather than OS container sandboxing, Pluton mandates explicit operator consent:

- Pluton **refuses to run** if `sandbox.native.acknowledge_partial_enforcement` is not set to `true`.
- Pluton **refuses to run** if `sandbox.native.acknowledge_host_network` is not set to `true`.
- Pluton **refuses to run** if `runtime.network_policy` is configured as `restricted` or `none` in native mode.

---

## 5. Acceptance Checklist

| Criteria | Status | Evidence |
|---|---|---|
| Native configuration is default across schema and templates | **VERIFIED** | `src/config/schema.ts`, `templates/teams/*.yaml`, `tests/unit/config.test.ts` |
| `pluton init` succeeds without invoking Docker in a fresh Windows scratch repo | **VERIFIED** | `tests/integration/docker-free-runtime.test.ts` (Subtest A) |
| `pluton doctor` does not spawn Docker in native mode | **VERIFIED** | Subtest C, real `runDoctor` guard, and `tests/unit/doctor.test.ts` |
| `pluton doctor` passes on a host with Docker completely uninstalled | **NOT VERIFIED** | Audit §9.1; Docker CLI is installed, so PATH filtering and interception were used |
| `pluton sandbox probe` reports native provider | **VERIFIED** | `tests/integration/docker-free-runtime.test.ts` (Subtest B) |
| `pluton run` completes multi-agent tasks with Docker hidden | **VERIFIED** | Subtest D, `scripts/demo-native-run.mjs`, and the real OpenCode run |
| Task checkout isolation preserved under `.pluton/workspaces/` | **VERIFIED** | `scripts/demo-native-run.mjs` (isolated file assertions) and native containment tests |
| `pluton attach` supports native host tmux sessions | **VERIFIED (plan/reattach)** | `src/terminal/native.ts`, `tests/integration/cli-attach.test.ts`, `tests/unit/attach.test.ts` |
| Interactive TTY attach and chat | **NOT VERIFIED** | Audit §9.3; no TTY in the audit harness |
| `pluton verify` and `pluton integrate` complete with Docker hidden | **VERIFIED** | Audit §5.1 rows 11–12 |
| Guard tests assert 0 Docker calls across guarded native paths | **VERIFIED** | Five paths in `tests/integration/docker-free-runtime.test.ts` |
| Migration guide authored and published | **VERIFIED** | `docs/MIGRATION.md` |
| Security model and README updated | **VERIFIED** | `docs/SECURITY.md`, `README.md`, `docs/NATIVE_EXECUTION.md` |
| POSIX/macOS runtime parity | **NOT VERIFIED** | Audit §9.2; only Windows executed |
| Docker-mode E2E | **BLOCKED** | Audit §9.4; daemon stopped |
| Real Qwen engine execution | **NOT VERIFIED** | Audit §9.5; Qwen paths used the ACP fake |

---

## 6. Conclusion

Pluton's native execution path does **not** require Docker for the tested Windows workflows:
onboarding, diagnostics, substrate probing, multi-agent execution, verification, integration,
headless app start, and host-tmux creation/reattachment all completed with Docker removed from
`PATH`. Docker remains available as a well-isolated legacy alternative for users with specialized
container requirements.

This is **ACCEPTED WITH LIMITATIONS**, not unconditional acceptance. Complete independence on a
Docker-uninstalled host, POSIX/macOS parity, interactive TTY behavior, Docker-mode E2E, and real
Qwen execution remain unverified; see the independent audit for the exact status of each.
