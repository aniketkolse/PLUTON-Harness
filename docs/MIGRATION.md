# Migrating to Native Execution in Pluton

Pluton runs engines natively. Docker and `local-process` are no longer execution
substrates: configs that still select them fail closed with migration guidance
(`sandbox.kind 'docker' is no longer supported: native execution is the only
substrate`). This guide moves an existing project and its data to
`sandbox.kind: native`.

---

## 1. What changes

- **No Docker dependency.** `pluton init`, `doctor`, `run`, `chat`, `attach` and
  `verify` do not contact a Docker daemon or use a worker image.
- **Explicit policy.** Linux can use `read-only` or `workspace-write` with
  Landlock/namespaces. macOS and Windows run only `unconfined` and must
  acknowledge it.
- **Durable state is preserved.** Existing runs, tasks, approvals, receipts,
  events, checkouts and engine homes stay in `.pluton/`; no schema conversion or
  data migration is required.
- **OpenCode is the only real engine.** The `mock` adapter remains for tests and
  development.

---

## 2. Configuration changes

1. Set `sandbox.kind: native`.
2. Remove legacy container keys (`sandbox.image`, `sandbox.docker`,
   `sandbox.local_process_acknowledged` if present).
3. Choose `sandbox.native.mode`:
   - Linux: `read-only` or `workspace-write`.
   - macOS/Windows: `unconfined`, with `acknowledge_unconfined: true`.
   - A single config can use `mode_by_platform` so Linux stays confined while a
     developer desktop is explicitly unconfined.
4. Set `runtime.network_policy`:
   - `open` — host network (required with `unconfined`).
   - `restricted` — private network namespace with loopback bridge only.
   - `none` — no network, including the bridge; rejected for `run`, `chat` and
     the server.
5. Remove obsolete Ship `network_policy` values only if they are no longer
   intended. `restricted` and `none` are supported on Linux confined modes when
   user and network namespaces are available.

The deprecated `acknowledge_partial_enforcement` and
`acknowledge_host_network` keys still parse, but they no longer grant or gate
anything. Remove them to avoid implying a control that no longer exists.

### Before (legacy, now rejected)

```yaml
sandbox:
  kind: docker
  docker:
    worker_image: pluton-worker:local
    memory_mb: 4096
    cpus: 2
runtime:
  network_policy: restricted
```

### After (native)

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
  network_policy: open

sandbox:
  kind: native
  native:
    mode: workspace-write
    mode_by_platform:
      linux: workspace-write
      darwin: unconfined
      win32: unconfined
    acknowledge_unconfined: true
    env_allowlist:
      - OPENAI_API_BASE
    session_timeout_minutes: 30
    terminate_grace_seconds: 2
    max_output_bytes: 1048576

ships:
  manager:
    role: supervisor
    engine: opencode
    model: opencode/deepseek-v4.1-flash-free
    workspace_policy: coordinator-read-only
  worker-a:
    role: coder
    engine: opencode
    model: opencode/deepseek-v4.1-flash-free
    workspace_policy: isolated-task-checkout
```

### Configuration reference

| Setting | Type | Default | Description |
|---|---|---|---|
| `sandbox.kind` | `'native'` | `'native'` | Only supported value. `docker`/`local-process` are rejected with guidance. |
| `sandbox.native.mode` | `'read-only' \| 'workspace-write' \| 'unconfined'` | `'workspace-write'` | Filesystem policy on Linux; macOS/Windows must be `unconfined`. |
| `sandbox.native.mode_by_platform` | per-platform modes | unset | Overrides `mode` for `linux`, `darwin` or `win32`. |
| `sandbox.native.acknowledge_unconfined` | `boolean` | unset | Required before an effective `unconfined` mode can run. |
| `sandbox.native.env_allowlist` | `string[]` | `[]` | Additional host environment variable names to pass to engines. |
| `sandbox.native.session_timeout_minutes` | `number` | `0` | Optional wall-clock cap for one engine session; `0` disables it. Run/task deadlines still apply. |
| `sandbox.native.terminate_grace_seconds` | `number` | `2` | Grace period before forced process-tree termination. |
| `sandbox.native.max_output_bytes` | `number` | `1048576` (1 MiB) | Maximum bytes captured from one output stream. |

---

## 3. State preservation and compatibility

- **SQLite** (`.pluton/state/pluton.sqlite`): past runs, tasks, edges,
  approvals, receipts and events remain valid. New sessions append native
  `execution.*` events; no schema migration is needed.
- **Workspaces** (`.pluton/workspaces/`): existing checkouts remain on disk and
  are reused or inspected with the workspace commands. New checkouts are plain
  host directories.
- **Engine homes** (`.pluton/engine-homes/<ship>`): reused directly by native
  engine processes. If an old home contains credentials for a removed engine,
  re-authenticate OpenCode in that Ship's home.
- **History is immutable.** Old events and run rows keep their recorded values;
  only new sessions use the native provider.

### JSONL session/run export and import

`pluton session export <id>` and `pluton session export-run <id>` write every
message/event, in chronological order, to JSONL. The corresponding `import` and
`import-run` commands are deliberately fail-closed:

- An import never overwrites or merges existing rows. If any session, run, task,
  event, or message id already exists in the target database, the whole import
  is refused and nothing is written. To re-import, first delete the existing
  session/run through the app (or restore into a fresh project/database), then
  retry. There is no `--replace` escape hatch.
- Imported `workspaceRoot` values are absolute host paths. They are accepted
  only when they resolve to a readable directory on this host. For a restore
  from another machine, pass `--workspace-root <local-dir>` to both import
  commands; otherwise the import fails with the foreign path in the message.
- Dependency edges and parent chains are validated for cycles, and `depth` /
  `rootTaskId` must match the parent chain. Malformed or inconsistent exports
  are rejected before the transaction starts.

---

## 4. Terminal handling

`pluton attach <ship>` always uses host `tmux`; there is no container transport.
tmux is a visibility/interruption tool, not a security boundary.

- **Debian/Ubuntu:** `sudo apt install tmux`
- **macOS:** `brew install tmux`
- **Windows:** install tmux through Chocolatey, Scoop, Git Bash or MSYS2.

Runs and chat proceed without tmux. Only `pluton attach` fails, with
`TerminalUnavailableError` and an install hint.

---

## 5. CLI behavior

| Command | Native behavior |
|---|---|
| `pluton doctor` | Checks host runtime, Git, tmux, engines, native capabilities and the effective policy. Never spawns Docker. |
| `pluton sandbox probe` | Reports `kind: native`, availability, detail and warnings. No image build and no container runtime. |
| `pluton run` | Spawns host engine processes; workers use `.pluton/workspaces/`; tool bridge binds `127.0.0.1`. |
| `pluton chat` | Spawns the host engine via stdio ACP; bridge binds `127.0.0.1`. |
| `pluton attach` | `tmux attach-session` on the host. |
| `pluton approvals` | Configures native sessions; no container provisioning. |

There is no `pluton sandbox build-image` command and no worker image to rebuild.

---

## 6. Step-by-step migration

1. Update `pluton.yaml` as shown above.
2. Run `pluton doctor` and `pluton sandbox probe`. Resolve any missing helper,
   Landlock ABI, namespace or engine-auth finding before dispatch.
3. Run a small task:
   ```bash
   pluton run --goal "Verify native execution migration"
   ```
4. Confirm tasks run in `.pluton/workspaces/`, `execution.*` events are logged,
   and the run closes from durable verification facts.

On Linux, install the matching `native/landlock-run` helper if the probe reports
it unavailable. On macOS/Windows, expect `unconfined` and read
[`NATIVE_EXECUTION.md`](NATIVE_EXECUTION.md) before acknowledging it.

---

## 7. No Docker rollback

There is no supported rollback to `sandbox.kind: docker` or `local-process`.
A config that selects either value exits before creating a run row. If Linux
confinement is unavailable, either install the verified helper/namespace support
or explicitly choose `unconfined` and accept the documented loss of filesystem
and network confinement.

---

## 8. Engine migration: Qwen Code removed

OpenCode is the only supported real engine. The deterministic `mock` adapter
remains for tests/development.

1. Change every `engine: qwen` to `engine: opencode`.
2. Replace Qwen model ids with OpenCode ids:
   ```bash
   pluton ship model list <ship>
   # or query the engine directly:
   opencode models --standalone
   ```
3. Re-authenticate OpenCode in each Ship's private engine home if it only
   contained Qwen credentials. Credentials are never copied between engines.
4. Remove `PLUTON_QWEN_BIN`, `QWEN_DIR` and Qwen-only variables from shell
   profiles/CI unless the OpenCode provider needs them.
5. Rebuild container profiles: not applicable. There is no worker image.
6. Run `pluton doctor`, then a small native run. Under `autonomous-bounded`,
   approval requests are intentionally denied; use `ask-for-sensitive-actions`
   or `ask-always` when operator prompts are desired.

No SQLite schema migration is required for the engine rename. Historical engine
values remain as immutable history.

---

## 9. Schema v13: verification attempt evidence

Version 13 is additive and automatic. `migrateWithBackup` takes a verified
pre-migration snapshot before applying it; no operator action is required.

- `verification_checks` gains `attempt`, `revision`, `worktree_dirty`,
  `worktree_fingerprint`, `post_revision` and `post_worktree_fingerprint`, plus
  an `(task_id, attempt)` index.
- Existing rows are preserved as history and default to `attempt = 0` with
  null revision/fingerprint evidence. They are never rewritten.
- New checks are bound to the task attempt that produced them. A verdict reads
  only the current attempt, rejects mixed revisions or a check that moved HEAD,
  and a run cannot close `completed` while a completed task's current-attempt
  evidence has a non-passed check.
- On a git checkout the fingerprint covers HEAD plus tracked and untracked
  content (using a throwaway git index; the real index/worktree is untouched).
  Untracked top-level `.pluton/` entries are excluded because Pluton's own
  running process writes the SQLite database and task checkouts there; tracked
  `.pluton/` content remains covered. Non-git workspaces record
  `available: false` / null evidence.
- `pluton integrate` refuses to commit or merge a completed task whose checkout
  no longer matches the verified post-check fingerprint. The report gains a
  `blockedDrift` array and the run records `integration.drift_detected`.
  Integration checkouts committed by an earlier invocation are allowed to be
  re-integrated idempotently.

Downgrading is not supported: a v13 database is refused by older builds
("database schema version 13 is newer than this build supports"). Restore the
pre-migration backup if you must run an older build.
