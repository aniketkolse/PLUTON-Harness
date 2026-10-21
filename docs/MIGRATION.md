# Migrating from Docker to Native Execution in Pluton

This guide explains how to migrate existing Pluton projects from Docker container execution (`sandbox.kind: docker`) to native host execution (`sandbox.kind: native`).

---

## 1. Executive Summary

Historically, Pluton ran AI coding engines (such as OpenCode and Qwen Code) inside dedicated Linux containers via Docker Desktop or the Docker engine. Pluton now provides **first-class native execution** as its default runtime substrate:

- **Zero Docker dependency**: Run `pluton init`, `pluton doctor`, `pluton run`, `pluton chat`, `pluton attach`, and `pluton verify` without Docker Desktop, Linux containers, or WSL2 virtual machine overhead.
- **Lower latency and resource consumption**: Eliminates VM boot times, container creation overhead, and bind-mount translation latency.
- **Durable multi-agent safety**: Preserves Git checkout isolation (`.pluton/workspaces/`), working directory confinement, environment variable allowlisting, process tree cleanup, and durable SQLite event tracking.
- **Seamless state preservation**: Existing runs, tasks, approvals, receipts, and workspace checkouts remain intact with zero database migration required.

---

## 2. Configuration Changes

Migrating an existing project requires updating `pluton.yaml` to specify `sandbox.kind: native`, setting `runtime.network_policy: open`, and adding the required native safety acknowledgements.

### Required YAML Modifications

In `pluton.yaml`:

1. Change `sandbox.kind` from `docker` to `native`.
2. Add the `native` configuration block with explicit acknowledgements:
   - `acknowledge_partial_enforcement: true`
   - `acknowledge_host_network: true`
3. Change `runtime.network_policy` to `open` (and remove any per-Muse `network_policy: restricted` or `none` overrides).

### Why `runtime.network_policy: open` is Required

In container mode, Pluton leveraged Docker virtual bridge networks (`--network none` or isolated bridge networks) to restrict container egress. Because native host processes execute under the host operating system and share the host network stack, Pluton cannot enforce network isolation without kernel-level containerization.

Pluton adheres to a strict **honesty and fail-closed guarantee**: it will refuse to start if configured with `network_policy: restricted` or `network_policy: none` in native mode, rather than making unverified security claims. Setting `runtime.network_policy: open` and acknowledging `acknowledge_host_network: true` confirms operator awareness.

### YAML Transformation Example

#### Before: Docker-Based Configuration (`sandbox.kind: docker`)

```yaml
version: 1

project:
  name: my-app
  repository: .
  default_branch: main
  verification:
    - name: unit-tests
      command: ["npm", "test"]

runtime:
  max_concurrent_workers: 3
  max_team_size: 8
  network_policy: restricted # Uses Docker network egress filtering

sandbox:
  kind: docker # Runs engines inside Linux containers
  docker:
    worker_image: pluton-worker:local
    memory_mb: 4096
    cpus: 2

muses:
  manager:
    role: supervisor
    engine: qwen
    model: test/model-a
    workspace_policy: coordinator-read-only
  worker-a:
    role: coder
    engine: qwen
    model: test/model-a
    workspace_policy: isolated-task-checkout
```

#### After: Native Configuration (`sandbox.kind: native`)

```yaml
version: 1

project:
  name: my-app
  repository: .
  default_branch: main
  verification:
    - name: unit-tests
      command: ["npm", "test"]

runtime:
  max_concurrent_workers: 3
  max_team_size: 8
  network_policy: open # Native processes share the host network

sandbox:
  kind: native
  native:
    # Required: acknowledges that host processes are not OS-sandboxed
    acknowledge_partial_enforcement: true
    # Required: acknowledges that host processes use the host network
    acknowledge_host_network: true
    # Execution mode: 'workspace-write' (default) or 'read-only'
    mode: workspace-write
    # Extra host environment variables to allow through to child processes
    env_allowlist:
      - OPENAI_API_BASE
      - ANTHROPIC_API_KEY
    # Wall-clock timeout bounds
    session_timeout_minutes: 30
    terminate_grace_seconds: 2
    max_output_bytes: 1048576

muses:
  manager:
    role: supervisor
    engine: qwen
    model: test/model-a
    workspace_policy: coordinator-read-only
  worker-a:
    role: coder
    engine: qwen
    model: test/model-a
    workspace_policy: isolated-task-checkout
```

### Configuration Parameter Reference

| Setting | Type | Default | Description |
|---|---|---|---|
| `sandbox.kind` | `string` | `'native'` | Substrate choice: `'native'`, `'docker'`, or `'local-process'` |
| `sandbox.native.acknowledge_partial_enforcement` | `boolean` | `true` (templates) | Mandatory acknowledgement of process-policy boundaries |
| `sandbox.native.acknowledge_host_network` | `boolean` | `true` (templates) | Mandatory acknowledgement of host network sharing |
| `sandbox.native.mode` | `'workspace-write' \| 'read-only'` | `'workspace-write'` | Allowed filesystem write scope for native sessions |
| `sandbox.native.env_allowlist` | `string[]` | `[]` | Explicit host environment variables to pass to engines |
| `sandbox.native.session_timeout_minutes` | `number` | `30` | Maximum wall-clock duration for an engine session |
| `sandbox.native.terminate_grace_seconds` | `number` | `2` | Grace period before sending SIGKILL / `taskkill /f` |
| `sandbox.native.max_output_bytes` | `number` | `1048576` (1MB) | Maximum stdout/stderr bytes captured before truncation |

---

## 3. State Preservation & Compatibility

Migrating to native execution does **not** invalidate or discard any existing project data:

### Durable SQLite State (`.pluton/state/`)
- All past runs, tasks, dependency edges, approvals, receipts, and event logs in `.pluton/state/pluton.db` remain 100% valid and readable.
- No schema migrations or data conversions are necessary.
- Subsequent runs will append native execution events (`execution.session_prepared`, `execution.session_started`, `execution.session_exited`, `execution.session_closed`) to the existing event log.

### Workspace Checkouts (`.pluton/workspaces/`)
- Worker tasks continue to use isolated `git clone --local` checkouts under `.pluton/workspaces/task_<id>`.
- Existing workspaces created under Docker mode remain on disk and can be inspected via `pluton workspace list` or cleaned with `pluton workspace clean`.
- In native mode, checkouts are created directly on the host filesystem without Docker volume mounts.

### Engine Homes (`.pluton/engine-homes/`)
- Cached engine states, authentication tokens, and configuration files under `.pluton/engine-homes/<muse>` are reused directly by native engine processes.

---

## 4. Terminal Handling & Attach

Pluton supports interactive terminal inspection via `pluton attach <muse>` in both Docker and native modes. However, the transport mechanism differs:

### Docker Mode vs Native Mode Attach

| Aspect | Docker (`sandbox.kind: docker`) | Native (`sandbox.kind: native`) |
|---|---|---|
| **Tmux Host** | Runs inside the worker Linux container | Runs on the host OS |
| **Command Spawned** | `docker exec -it <container> tmux attach-session -t =<session>` | `tmux attach-session -t =<session>` |
| **Container Dependency** | Requires Docker daemon and running Muse container | None; attaches directly to host tmux |
| **Missing Tmux Handling** | Fails if container is stopped or missing | Fails with `TerminalUnavailableError` and install instructions |
| **Disconnection Safety** | Detaching (`Ctrl-B d`) leaves worker running | Detaching (`Ctrl-B d`) leaves worker running |

### Host Tmux Installation

To use `pluton attach` in native mode, `tmux` must be present on the host `PATH`:

- **Debian / Ubuntu / WSL2**: `sudo apt install tmux`
- **macOS**: `brew install tmux`
- **Windows (Native)**: Install via Chocolatey (`choco install tmux`), Scoop (`scoop install tmux`), or use Git Bash / MSYS2 tmux.

If `tmux` is not installed on the host, task execution and multi-agent runs proceed without issue. If the operator attempts to run `pluton attach`, Pluton provides an actionable diagnostic error:

```
TerminalUnavailableError: could not attach to host tmux session: spawn tmux ENOENT
Fix: install tmux (e.g. apt install tmux, brew install tmux, or choco install tmux)
```

---

## 5. CLI Command Behaviors

After switching to `sandbox.kind: native`, CLI commands adapt to native execution:

| Command | Docker Mode | Native Mode |
|---|---|---|
| `pluton doctor` | Requires Docker CLI and running Docker daemon (`fail` if absent) | Docker checks are marked `optional (info)`; passes on Docker-free hosts |
| `pluton sandbox probe` | Probes Docker daemon version, ping, and worker image | Probes host native process-policy provider; reports `enforcement: partial` |
| `pluton sandbox build-image` | Builds `docker/worker/Dockerfile` with pinned toolchain | Rejects with `ValidationError` (container images are not used in native mode) |
| `pluton run` | Spawns worker containers, bridges network via `0.0.0.0` | Spawns host child processes, bridges tool server via `127.0.0.1` |
| `pluton chat` | Connects to containerized engine via `docker exec` | Connects directly to host engine process via stdio ACP |
| `pluton attach` | Spawns `docker exec -it` into container tmux | Spawns `tmux attach-session` into host tmux |
| `pluton approvals` | Provisions specialist container if `muse.create` approved | Configures native session dynamically with zero container calls |

---

## 6. Migration Step-by-Step Procedure

Follow these steps to migrate an existing project:

### Step 1: Update `pluton.yaml`
Edit `pluton.yaml` in your project root as shown in the YAML transformation section above:
- Set `sandbox.kind: native`
- Add `native.acknowledge_partial_enforcement: true` and `native.acknowledge_host_network: true`
- Set `runtime.network_policy: open`

### Step 2: Validate Environment with `pluton doctor`
Run doctor to verify your project configuration, engines, and host prerequisites:
```bash
pluton doctor
```
Expected output:
- `docker-cli`: marked `optional (not required for native host execution)` (or pass if installed).
- `sandbox`: reports `pass` with `provider: native`.
- Overall exit code `0`.

### Step 3: Verify Substrate Probe
Probe the sandbox substrate:
```bash
pluton sandbox probe
```
Expected output:
- `Kind: native`
- `Available: true`
- `Image: null`
- Informational notice regarding host partial enforcement boundaries.

### Step 4: Run a Test Task
Execute a test run with a simple verification check:
```bash
pluton run --goal "Verify native execution migration"
```
Observe that:
- Runs execute without invoking Docker.
- Tasks execute in `.pluton/workspaces/`.
- `execution.*` lifecycle events are logged to SQLite.
- Run completes with `state: completed`.

---

## 7. Rollback Procedure

If your team requires strict OS-level container isolation or containerized network egress filtering, you can roll back to Docker mode at any time:

1. In `pluton.yaml`, set:
   ```yaml
   sandbox:
     kind: docker
   runtime:
     network_policy: restricted # or 'none' / 'open'
   ```
2. Ensure Docker Desktop or the Docker daemon is running.
3. Re-build the worker image if necessary:
   ```bash
   pluton sandbox build-image
   ```
4. Verify with `pluton doctor`.
