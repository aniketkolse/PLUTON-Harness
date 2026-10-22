# Native Execution in Pluton-Harness

This document describes Pluton's first-class **native execution provider** (`sandbox.kind: native`), introduced to run engine processes directly on the host machine without Docker while preserving Pluton's multi-agent orchestration, Git checkout isolation, and durable state semantics.

---

## 1. Executive Summary

Pluton historically ran AI coding engines inside Docker containers (`sandbox.kind: docker`). While Docker provides Linux container isolation, many developer workstations either lack Docker Desktop, run in environments where nested virtualization is restricted, or prefer direct host execution.

The native execution provider enables Pluton to orchestrate supervisors and workers directly on the host operating system:

- **Host engine execution**: Spawns the OpenCode engine process directly on the host via ACP (Agent Client Protocol) over stdio.
- **Git checkout isolation**: Preserves isolated task checkouts via local Git clones under `.pluton/workspaces/`. A coordinator runs at the project root while workers operate in private checkouts.
- **Fail-closed configuration gates**: Refuses to run unless the operator explicitly acknowledges the partial enforcement and host network exposure.
- **Durable event stream**: Records lifecycle events (`execution.session_prepared`, `execution.session_started`, `execution.session_exited`, `execution.session_closed`) into SQLite.
- **Process tree termination**: Cleans up entire process trees upon task completion, timeout, or cancellation (`taskkill /t /f` on Windows, process-group signals on POSIX).

---

## 2. Security & Enforcement Model

Pluton adheres to a strict **honesty constraint**: native execution does not claim OS-level sandboxing.

### What IS enforced by Pluton
1. **Working directory boundary**: Every spawned process must specify a working directory within allowed host roots:
   - `<project-root>`
   - `<project-root>/.pluton/workspaces`
   - `<project-root>/.pluton/engine-homes`
   Attempts to spawn a process outside these roots are rejected fail-closed with `PolicyDeniedError`.
2. **Environment variable filtering**:
   - Only standard runtime variables (e.g., `PATH`, `HOME`, `USERPROFILE`, `XDG_*`, `CI`, `COLORTERM`) and explicit keys defined in `sandbox.native.env_allowlist` are passed to child processes.
   - Host secrets, API tokens, and unlisted environment variables are stripped.
3. **Session timeouts, dispatch deadlines & process-tree termination**:
   - `sandbox.native.session_timeout_minutes` optionally caps one engine session; the default `0` disables this provider-level cap.
   - `runtime.max_run_minutes` and `runtime.default_task_minutes` still bound how long a run and its tasks may proceed.
   - When a session ends or times out, Pluton kills the entire process tree, not just the parent process.
4. **Output bounds**:
   - `exec` output streams are capped by `sandbox.native.max_output_bytes` (default: 1 MB) to prevent denial of service via memory exhaustion.

### What is NOT enforced (Limitations)
1. **Filesystem confinement**: Host processes run under the operating system account of the current user. They can read or write any file accessible to that user account.
2. **Network confinement**: Host processes share the host network stack. Pluton cannot isolate network egress without containerization or kernel sandboxing.
3. **Resource limits**: CPU and memory limits defined in configuration are recorded for planning and diagnostic budgets, but are **not** cgroup-enforced.
4. **Terminal attach**: Supported via host native `tmux` (`pluton attach <muse>`); requires `tmux` installed on the host OS.

---

## 3. Configuration

To use native execution, configure `sandbox.kind: native` in `pluton.yaml`:

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
    # Mandatory: acknowledge that host processes are not OS-sandboxed
    acknowledge_partial_enforcement: true
    # Mandatory: acknowledge that host processes share the host network
    acknowledge_host_network: true
    # Mode: 'read-only' or 'workspace-write' (default)
    mode: workspace-write
    # Extra host environment variables to pass through
    env_allowlist:
      - OPENAI_API_BASE
      - CUSTOM_TOOL_PATH
    # Timeout and output bounds
    terminate_grace_seconds: 2
    session_timeout_minutes: 30
    max_output_bytes: 1048576

runtime:
  # Must be 'open' when sandbox.kind is 'native'
  network_policy: open
  max_concurrent_workers: 2

muses:
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
      - muse.propose_create
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

### Fail-Closed Validation Gates
If any of the following conditions are violated, Pluton refuses to start:
- `sandbox.native.acknowledge_partial_enforcement` is `false`: fails with `SandboxUnavailableError`.
- `sandbox.native.acknowledge_host_network` is `false`: fails with `SandboxUnavailableError`.
- `runtime.network_policy` (or any Muse's `network_policy`) is `restricted` or `none`: fails with `SandboxUnavailableError` (host processes cannot enforce network boundaries).

---

## 4. CLI Command Behavior Under Native Mode

| Command | Behavior in Native Mode |
|---|---|
| `pluton run` | Runs multi-agent runs on the host; supervisor at project root, workers in `.pluton/workspaces/`. Tool bridge binds loopback `127.0.0.1`. |
| `pluton chat` | Starts interactive chat session on host with read-only workspace policy; tool bridge binds loopback `127.0.0.1`. |
| `pluton doctor` | Checks host native execution provider probe and reports `enforcement: partial`. Does not check Docker or worker images. |
| `pluton sandbox probe` | Probes native provider capabilities: reports `provider: native`, `backend: process-policy`, `enforcement: partial`. |
| `pluton sandbox build-image` | Rejects with `ValidationError`: native execution runs host engine processes and does not use container images. |
| `pluton attach` | Attaches to host native tmux session (`=pluton_<proj>_<muse>`); fails closed with `TerminalUnavailableError` if host tmux is not installed. |

---

## 5. Durable Event Schema

All native execution actions log auditable facts to SQLite:

- `execution.session_prepared`: Emitted when an execution session is configured with its mode and network policy.
- `execution.session_started`: Emitted when an engine child process spawns, capturing the OS process PID.
- `execution.session_exited`: Emitted when an engine child process exits, capturing the exit code and signal.
- `execution.session_closed`: Emitted when the session is closed and all process trees are terminated.
- `execution.env_filtered`: Emitted when environment variables not in the safe set or allowlist are dropped.
- `execution.session_timeout`: Emitted if a process exceeds its wall-clock session timeout.
- `execution.denied`: Emitted if an engine process attempts to run in a directory outside the allowed roots.
- `execution.session_error`: Emitted if process spawning or tree termination fails.

---

## 6. Comparison: Docker vs Native vs Local-Process

| Feature | Docker (`sandbox.kind: docker`) | Native (`sandbox.kind: native`) | Local Process (`sandbox.kind: local-process`) |
|---|---|---|---|
| **Substrate** | Linux container via Docker Desktop / daemon | Host OS processes | Host OS processes (unwrapped) |
| **Enforcement** | Strong (container boundary, network namespacing) | Partial (cwd check, env filtering, tree kill) | None (unconfined) |
| **Network Isolation** | Configurable (`none`, `restricted`, `open`) | Host network (`open` only) | Host network (`open` only) |
| **Process Tree Kill** | Handled by Docker daemon | Handled by Pluton (`taskkill` / process groups) | Node default `child.kill()` |
| **Terminal Attach** | Supported (`docker exec` / tmux) | Supported (host `tmux`) | Disabled |
| **Dependencies** | Docker daemon, worker container image | Node.js, Git, local engine CLI | Node.js, Git, local engine CLI |
| **Audited Facts** | Container create/start/stop records | Durable `execution.*` event stream | Minimal |
| **Intended Use** | Production / hardened local evaluation | First-class host development & CI | Legacy dev-only degraded mode |
