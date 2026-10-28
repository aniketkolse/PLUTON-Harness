# Native Execution in Pluton-Harness

Pluton runs engine processes directly on the host. **Native execution is the only
supported substrate** (`sandbox.kind: native`); configs that still select
`sandbox.kind: docker` or `sandbox.kind: local-process` fail with migration
guidance instead of silently falling back to a weaker runtime
(`src/execution/factory.ts`).

This document describes what the native provider enforces, what it does not,
and the exact configuration that selects each mode.

---

## 1. Execution model

- **Host engine execution**: the OpenCode engine is spawned directly on the host
  via ACP over stdio.
- **Git checkout isolation**: workers run in local `git clone` checkouts under
  `.pluton/workspaces/`; the manager runs at the project root.
- **Fail-closed policy selection**: the requested mode and network policy are
  checked against host capabilities before any process, run row or task row is
  created. A missing helper, old kernel or unavailable namespace support is an
  error, never a downgrade.
- **Durable event stream**: lifecycle facts (`execution.session_prepared`,
  `execution.session_started`, `execution.session_exited`,
  `execution.session_closed`) are recorded in SQLite.
- **Process-tree termination**: the whole process tree is terminated on exit,
  timeout or cancellation (`taskkill /t /f` on Windows, process groups on POSIX).

---

## 2. Security and enforcement model

Pluton reports the enforcement it can prove for the current host. The provider
never labels an unconfined session as isolated.

### 2.1 Filesystem policy (Linux confined modes)

Confined modes use the verified `native/landlock-run` helper:

| Mode | Read | Write |
|---|---|---|
| `read-only` | project root, workspace roots, engine home, system runtime roots | session temporary directory only |
| `workspace-write` | same as `read-only` | task checkout/work directory, engine home and session temporary directory |

- Landlock applies path-beneath rules (ABI ≥ 3) inside the helper process.
- System locations such as `/usr`, `/bin`, `/lib` and `/etc` are read/execute
  roots, never write roots.
- A verified helper is mandatory: the TypeScript capability check validates the
  helper ABI, SHA-256, size and target manifest before use
  (`src/execution/capabilities.ts`).
- On Linux, `read-only`/`workspace-write` require Landlock ABI ≥ 3 (Linux kernel
  ≥ 6.2 with Landlock enabled) and the matching helper binary.

### 2.2 Network policy

Network isolation comes from namespaces, not Landlock. Landlock does not mediate
sockets.

| Policy | What the session gets |
|---|---|
| `open` | Host network stack; no network filtering |
| `restricted` | Private network namespace with loopback only; the Pluton tool bridge is reachable through the helper's loopback proxy |
| `none` | No network at all, including the tool bridge and loopback |

- `restricted` and `none` require unprivileged user and network namespaces; if
  they are unavailable the session fails closed.
- `pluton run`, `pluton chat` and the application server reject
  `network_policy: none` because orchestrated sessions need the tool bridge.
- Per-Ship `network_policy` overrides `runtime.network_policy`.

### 2.3 Namespaces and process hygiene

When the host supports them, the helper creates a private user namespace, mount
namespace, private `/tmp`, fresh `/proc` and a PID namespace; the engine runs as
PID 1 inside the namespace. These are reported per session in the enforcement
report rather than assumed.

The provider also enforces:

- **Working-directory boundary**: every spawned process must run inside an
  allowed root (`<project-root>`, `<project-root>/.pluton/workspaces` or
  `<project-root>/.pluton/engine-homes`). A path outside those roots fails with
  `PolicyDeniedError`.
- **Environment filtering**: only a standard runtime allowlist plus explicit
  `sandbox.native.env_allowlist` names reach the child. Unlisted host secrets are
  stripped, and confined helpers receive exactly the request's environment map.
- **Timeouts and output bounds**: `session_timeout_minutes` optionally caps one
  engine session (`0` disables this provider-level cap); `runtime` run/task
  deadlines still apply. `max_output_bytes` caps a single `exec` stream.
- **Process-tree kill**: termination targets the entire tree, not only the
  parent process.

### 2.4 What is not enforced

1. **Unconfined filesystem access**: `unconfined` sessions run as the host user
   and can read or write anything that user can. This is the only supported mode
   on macOS and Windows.
2. **Unconfined network access**: `unconfined` sessions use the host network with
   no filtering. `unconfined` is valid only with `network_policy: open`.
3. **Resource limits**: CPU, memory and PID values are recorded for planning and
   diagnostics but are **not cgroup-enforced**.
4. **Host services**: even a confined session can reach services the host
   exposes through the session bridge or an `open` network. Isolation is not a
   substitute for host hardening.
5. **Processes that escape the helper tree** can outlive graceful termination.
   This is a documented residual risk of the process-tree mechanism.
6. **Terminal attach**: `pluton attach` uses host `tmux`; tmux is a visibility
   and interruption tool, not a security boundary.

### 2.5 Deprecated configuration fields

`acknowledge_partial_enforcement` and `acknowledge_host_network` are still
accepted so older configs load, but they no longer grant or gate any capability.
Use `sandbox.native.mode` (or `mode_by_platform`), `acknowledge_unconfined`, and
`runtime.network_policy` / per-Ship `network_policy` instead.

---

## 3. Configuration

```yaml
version: 1
project:
  name: my-project
  repository: .
  default_branch: main
  verification: []

sandbox:
  kind: native
  native:
    # Filesystem policy on Linux. macOS/Windows must override to unconfined.
    mode: workspace-write
    mode_by_platform:
      linux: workspace-write
      darwin: unconfined
      win32: unconfined
    # Required before an effective unconfined mode can run anywhere.
    acknowledge_unconfined: true
    # Extra host environment variables to pass through (names only).
    env_allowlist:
      - OPENAI_API_BASE
      - CUSTOM_TOOL_PATH
    # Timeout and output bounds.
    terminate_grace_seconds: 2
    session_timeout_minutes: 30
    max_output_bytes: 1048576

runtime:
  # open = host network; restricted = loopback bridge only; none = no network.
  network_policy: open
  max_concurrent_workers: 2

ships:
  manager:
    display_name: Manager
    role: supervisor
    engine: opencode
    model: opencode/deepseek-v4.1-flash-free
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
    permissions:
      - project.read
      - task.create
      - task.delegate
      - task.inspect
      - task.cancel
      - result.collect
      - diff.inspect
      - ship.propose_create
      - approval.request
      - run.stop
  worker-a:
    display_name: Worker
    role: coder
    engine: opencode
    model: opencode/deepseek-v4.1-flash-free
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
    permissions:
      - task.inspect
      - result.collect
      - diff.inspect
```

The `muses:` key is still accepted as an alias for `ships:` for backward
compatibility.

### 3.1 Fail-closed validation gates

Pluton refuses to start when any of these checks fail:

- effective mode is `unconfined` without
  `sandbox.native.acknowledge_unconfined: true`;
- effective mode is `read-only` or `workspace-write` without a verified helper
  and Landlock ABI ≥ 3;
- effective network is `restricted` or `none` without unprivileged user and
  network namespaces;
- platform is macOS or Windows and the effective policy is not
  `unconfined` + `open`;
- `unconfined` is combined with `restricted` or `none`;
- `sandbox.kind` is `docker` or `local-process`;
- `network_policy: none` is used with an orchestrated command that needs the
  tool bridge.

The errors name the failed capability and the exact config fix. There is no
fallback path.

---

## 4. CLI behavior in native mode

| Command | Behavior |
|---|---|
| `pluton run` | Runs multi-agent work on the host; manager at the project root, workers in `.pluton/workspaces/`. The tool bridge binds loopback `127.0.0.1`. |
| `pluton chat` | Starts an interactive host chat session; the tool bridge binds loopback `127.0.0.1`. |
| `pluton doctor` | Reports host runtime, Git, tmux, engines, native provider capability and the effective enforcement report. It does not require Docker. |
| `pluton sandbox probe` | Probes the native provider and prints its backend, capabilities and warnings. |
| `pluton attach` | Attaches to the host tmux session (`=pluton_<proj>_<ship>`); fails closed with `TerminalUnavailableError` when host tmux is missing. |

---

## 5. Durable event schema

All native execution actions log auditable facts to SQLite:

- `execution.session_prepared`: session configured with its mode and network
  policy.
- `execution.session_started`: engine child process spawned, with host PID.
- `execution.session_exited`: engine child exited, with exit code and signal.
- `execution.session_closed`: session closed and process trees terminated.
- `execution.env_filtered`: environment variables outside the safe set and
  allowlist were dropped.
- `execution.session_timeout`: a session exceeded its wall-clock timeout.
- `execution.denied`: a process attempted to run outside the allowed roots.
- `execution.session_error`: process spawn or tree termination failed.

---

## 6. Mode comparison

| Feature | Linux `read-only` / `workspace-write` | `unconfined` (Linux/macOS/Windows) | Legacy `docker` / `local-process` |
|---|---|---|---|
| **Substrate** | Host process inside the verified helper | Host process | Rejected at config validation |
| **Filesystem** | Landlock path rules | Host user's full access | No runtime |
| **Network** | `open` = host; `restricted` = private netns with loopback bridge; `none` = no network | Host network, `open` only | No runtime |
| **Namespaces** | User/mount/PID/network where the host supports them | None | No runtime |
| **CPU/memory/PID limits** | Recorded, not cgroup-enforced | Recorded, not enforced | No runtime |
| **Process-tree kill** | Yes | Yes | No runtime |
| **Environment filtering** | Yes | Yes | No runtime |
| **Dependencies** | Node.js, Git, engine CLI, verified Linux helper | Node.js, Git, engine CLI | — |
| **Intended use** | Hardened local execution and CI on Linux | Desktop development on macOS/Windows or explicit opt-out on Linux | Removed |
