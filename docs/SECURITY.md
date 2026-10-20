# Pluton-Harness security model

Scope: this document describes what Pluton-Harness protects, how, and — with
equal weight — what it does **not** protect. It is referenced by
[ADR-0004](adr/0004-sandbox-container-model.md) and reflects the code as
committed; every claim names the file that implements it.

## 1. Threat model

Trusted:

- the operator's shell and the `pluton` host process;
- the durable store under `<project>/.pluton/state/` (SQLite);
- the project configuration (`pluton.yaml`), which the operator authors.

Semi-trusted (assumed adversarial):

- **engine sessions** — any LLM-driven process (OpenCode, Qwen Code, mocks) is
  treated as an untrusted caller. It decides what tools to call, with what
  arguments, and can be steered by prompt-injected repository content.
- **repository content** — README files, source comments and task briefs may
  contain instructions aimed at the model. Repository content is data, never
  instructions.
- **model output** — summary text, task results and diffs are stored and shown;
  they are bounded and redacted, but they are not trusted input.

## 2. What the engine can reach: the restricted tool surface

An engine session can affect a run **only** through the Pluton tool bridge
(`src/tools/`). There is no other channel: engine processes are launched with a
sanitized environment and communicate with run state exclusively via MCP over
stdio (`pluton mcp serve`) or the loopback HTTP transport.

- **Allowlisted catalog.** `src/tools/catalog.ts` is the complete list of tools.
  Anything else is answered with a typed `not_found` denial and an audited
  `tool.denied` event — the bridge never throws on unknown tools or oversized
  (model-controlled) tool names.
- **Server-side authorization per call.** Permissions are checked inside the
  host process for every call (`src/tools/handlers.ts`); the engine cannot grant
  itself a permission, and tool names are deliberately not permission names
  (e.g. `task.wait` is gated by `result.collect`).
- **Identity is fixed at launch.** The caller Muse and task scope are set when
  the bridge starts (`src/cli/commands/mcp.ts`) and cannot be changed by tool
  arguments. A task-scoped session that is not the task's assignee fails closed
  with a typed error and exit code 1.
- **Scope containment.** A caller sees only itself and its descendants; a task
  cannot depend on work outside its own subtree, a terminal task cannot
  delegate, and delegation enforces depth, fan-out and ancestor-assignee rules
  (`src/orchestrator/task-graph.ts`).

## 3. Filesystem containment

- `project.read` canonicalizes the project root **and** every target with
  `realpath` before the containment and refused-area checks
  (`src/tools/handlers.ts`). Junction/symlink escapes, case variants
  (`.PLUTON` on case-insensitive filesystems) and 8.3 aliases (`PLUTON~1`) are
  all rejected; refused segments are compared case-folded on the canonical
  path.
- Reads go through an open handle with a hard byte cap (512 000 bytes) taken
  from the handle itself, closing the stat/read TOCTOU window; directory
  listings are capped at 200 entries.
- `.pluton`, `.git` and `node_modules` are refused areas for every read.
- **Muses never write into the user's tree.** A Muse with an
  isolated-checkout policy works in a `git clone --local` under
  `.pluton/workspaces/` on a `pluton/<run>/<slug>` branch
  (`src/workspace/manager.ts`; ADR-0005). Removal guards refuse to delete
  anything Pluton did not create.

## 4. Process execution hygiene

- Every external process — git, docker, tmux, engines, verification checks —
  goes through `src/util/exec.ts`: **argv arrays only, never a shell string**,
  sanitized environment, hard timeouts, per-stream output caps with truncation
  markers.
- Git revisions coming from data (workspace base commits) are validated against
  a hex-object-id pattern and passed after `--end-of-options`, so a stored
  value cannot become a git option (`src/tools/handlers.ts`, `diff.inspect`).
- Verification checks (`src/verify/runner.ts`) additionally refuse a
  conservative deny list of shells (`sh`, `bash`, `cmd`, `powershell`, …) and
  destructive tools (`rm`, `mkfs`, `dd`, `chmod`, …) before spawn; the project
  configuration is the allow list.

## 5. Isolation and the sandbox

- Real isolation is the Docker container per Muse (`src/sandbox/`, ADR-0004).
  When the Docker daemon or the worker image is unavailable, Pluton **fails
  closed** with `SandboxUnavailableError` and an exact fix — it never silently
  degrades to unsandboxed execution.
- The dev-only `local-process` backend requires an explicit
  `local_process_acknowledged: true` in the project config and is refused
  otherwise.
- **tmux is not a security boundary.** tmux sessions exist for visibility and
  window-targeted interruption only; the container is the boundary.

## 6. Secrets

- Secrets never appear in `pluton.yaml`, the database, events, logs or process
  argv (ADR-0008). Engine auth is injected as environment variables from
  allowlisted, gitignored secret files at launch time.
- Stored event payloads pass through deep redaction
  (`redactDeep` in the store) and a payload size bound; `pluton doctor` reports
  secret **presence**, never values.

## 7. Durability and honesty guarantees

- State changes and their events are committed in one transaction
  (`src/store/store.ts`); a request ID is recorded before Pluton claims
  acceptance, and replays return the recorded outcome.
- `unknown_outcome` tasks are **never** replayed or reported as success; a
  prompt that exceeds its time bound becomes `unknown_outcome` with the timeout
  recorded as evidence (`src/orchestrator/supervisor.ts`).
- A run completes only from durable records: failing or unknown tasks fail the
  run, tasks with failed dependencies stay visibly `queued`, and when
  verification is configured, `completed` is reachable only through the
  evidence gate (`src/verify/runner.ts`).
- Pending approvals are capped (3 per run) so a model loop cannot grow state
  without bound.

## 8. Known gaps — what is NOT protected yet

Stated plainly so nobody over-reads the guarantees above:

1. **Container-mode live evidence is Windows-Docker-Desktop-only.** A host-mode
   live run executed 2026-10-16/17, and a full container-mode live run (engines
   image, per-Muse containers, `docker exec` spawns, real worker edit closed by
   the verification gate) executed 2026-10-17 — both in
   `docs/smoke-live-run.md`. That smoke found and fixed one engine-session leak
   (`ba68557`). Linux-host container behavior (mount ownership, uid alignment)
   remains unproven — see gap 9 below.
2. **HTTP transport authentication is a bearer token over loopback.** Any
   process on the host that obtains the token can call the bridge with the
   corresponding identity. Tokens are per-run/launch, short-lived and never
   logged, but the host itself is trusted.
3. **Approval expiry is sweep-driven, not timer-driven.** Pending approvals carry an
   operator-configurable TTL (`runtime.approval_timeout_minutes`, default 60, `0` = never); the
   sweep runs when `pluton approvals list/approve/deny` (or the chat TUI `/approvals`, `/approve`, `/deny`
   slash commands) executes and flips overdue pendings to
   `expired` (fail-closed like a denial, `decided_by: pluton:timeout`). No background timer exists:
   a pending approval nobody looks at stays `pending` in the store until the next sweep.
4. **Container hardening is Docker's defaults plus the configured resource
   limits.** No custom seccomp/AppArmor profile, no read-only root filesystem
   guarantee for the worker image beyond what the Dockerfile sets.
5. **Network policy supports per-Muse overrides and internal network binding.**
   The runtime default is configured in `runtime.network_policy` (`restricted` | `none` | `open`).
   Individual Muses can override this via `network_policy: 'none' | 'restricted' | 'open'` in `muses.<id>`.
   When `restricted`, Pluton binds to `runtime.internal_network_name` when specified (e.g. an egress-filtered
   or internal Docker bridge), and `--network none` disconnects egress completely for offline Muses.
6. **The operator's terminal is trusted.** `pluton attach`-style inspection and
   human commands are not sandboxed against the host.
7. **Deny lists are conservative blocklists**, not capability systems. They
   reduce accidental damage; the config allow list is the real control.
8. **Container-mode runs bind the tool bridge on all interfaces.** Containers
   reach the host through the Docker gateway, so the bridge listens on `0.0.0.0`
   for the run's duration (loopback in host mode). Per-session 256-bit bearer
   tokens gate every call, but the port is LAN-reachable while a container-mode
   run is live — firewall the host if the network is untrusted.
9. **Bind-mount ownership is untested on Linux hosts (NOT RUN).** The sandbox
   passes `--user <uid>:<gid>`; on POSIX non-root hosts `resolveContainerUser()`
   selects the host uid:gid, while Windows uses `10001:10001`. If that identity
   does not line up with host-owned engine homes and task checkouts (an explicit
   override, a root host, or a userns-remapped daemon), writes fail. The
   2026-10-17 container-mode live E2E proved writes on Windows Docker Desktop,
   whose mounts are broadly writable — which is exactly why the Linux case stays
   open, not proven. A reproducible native-Linux check and procedure now exist:
   `tests/e2e/linux-bind-mount.e2e.test.ts` and
   `docs/LINUX_BIND_MOUNT_VALIDATION.md`. Status remains **NOT RUN** until it
   executes on a native Linux host; a skipped or Windows run is not evidence.
10. **Engine-side output is redacted by key, not by value.** An engine that
    echoes a secret into its own output (e.g. a request header it was handed)
    could persist it in event payloads; redaction removes known secret-keyed
    fields, not arbitrary value patterns.
11. **The graphical workspace token travels in the launch URL.** In `--browser`
    mode the address bar (and therefore that browser profile's history) shows
    `http://127.0.0.1:<port>/?token=…`; app-mode windows hide it. In `--detach`
    mode the tokenized URL also lands in `.pluton/run/server.log` (created
    owner-only `0600`), and `.pluton/run/server.json` stores it `0600`. The token
    is 256-bit, regenerated on every server start, invalidated when the instance
    file is cleared, sent to the page at most once via the URL (then held in
    `sessionStorage`), and never forwarded to third parties: the SPA loads no
    external subresources and responses carry `Referrer-Policy: no-referrer`.
    The residual exposure is a local same-user process/browser-profile reader —
    the host user is trusted, as everywhere else in this document.
12. **The operator file viewer resolves links before reading.** `/api/files` and
    `/api/files/content` refuse symlinks/junctions that canonicalize outside the
    workspace root (same realpath containment as the engine tool bridge), so a
    malicious repository cannot turn the viewer into an arbitrary-file read.

## 9. Reporting

This is a local-first, single-operator tool with no telemetry. Security
relevant findings against the implementation should be filed as issues with a
reproduction against the deterministic mock engine where possible, plus the
store rows (`pluton status --run <id> --json`) and event log segment involved.
