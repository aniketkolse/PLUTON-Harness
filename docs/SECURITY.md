# Pluton-Harness security model

Scope: this document describes what Pluton-Harness protects, how, and — with
equal weight — what it does **not** protect. It reflects the native-only runtime.
ADR-0004 records the historical container model and is no longer the execution
contract.

## 1. Threat model

Trusted:

- the operator's shell and the `pluton` host process;
- the durable store under `<project>/.pluton/state/` (SQLite);
- the project configuration (`pluton.yaml`), which the operator authors.

Semi-trusted (assumed adversarial):

- **engine sessions** — any LLM-driven process (OpenCode, or the deterministic
  mock in tests/dev) is treated as an untrusted caller. It decides what tools to call, with what
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
- **Identity is fixed at launch.** The caller Ship and task scope are set when
  the bridge starts (`src/cli/commands/mcp.ts`) and cannot be changed by tool
  arguments. A task-scoped session that is not the task's assignee fails closed
  with a typed error and exit code 1.
- **Scope containment.** A caller sees only itself and its descendants; a task
  cannot depend on work outside its own subtree, a terminal task cannot
  delegate, and delegation enforces depth, fan-out and ancestor-assignee rules
  (`src/orchestrator/task-graph.ts`).
- **Engine permission requests are policy-gated before an approval exists.**
  ACP `session/request_permission` (and equivalent engine asks) pass through
  `src/policy/engine-permissions.ts` first. The pure policy returns
  `allow`/`ask`/`deny` from the Ship's approval mode, workspace policy, session
  workdir, project root and protected paths:
  - `autonomous-bounded` and unknown modes deny at the engine boundary; they
    never turn a proven isolated checkout into blanket engine consent.
  - A manager or non-isolated/read-only session cannot perform a mutating
    action (edit, write, delete, move, execute, or an explicit command), even
    with an operator approval.
  - Paths outside the project root or session workdir, and paths inside `.git`
    or `.pluton`, are denied. Sensitive files (`.env`, keys, credentials) and
    configured protected paths require an operator ask.
  - A read-only auto-allow requires at least one concrete, contained path.
    An empty/missing path list, an oversized or malformed scope, conflicting
    destructive/read fields, or an ask too large to display completely is never
    auto-allowed: it is denied or asked with the full action shown.
  - Path identity is normalized for the host: case-folded on Windows/macOS,
    trailing Win32 dots/spaces stripped, 8.3 aliases (`PLUTON~1`) and
    junction/symlink escapes rejected (`src/util/path-safety.ts`).
  - Destructive shell shapes (recursive delete, disk format, hard reset, force
    push, privilege escalation, remote-code pipe, …) are denied; other commands
    and unrecognized actions ask.
  `allow`/`deny` outcomes are audited without creating an operator row. Only
  `ask` creates the durable, scoped approval the operator can decide; the
  decision is runtime-enforced by the engine channel and cannot override a
  policy `deny`.

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
- `.pluton`, `.git` and `node_modules` are refused areas for every read through
  the tool bridge, and the operator file API refuses to read, overwrite or
  delete any path containing those segments (`src/server/security.ts`). The
  canonical path is checked after `realpath`, so a junction or case variant
  cannot reach a protected area.
- **Ships never write into the user's tree.** A Ship with an
  isolated-checkout policy works in a `git clone --local` under
  `.pluton/workspaces/` on a `pluton/<run>/<slug>` branch
  (`src/workspace/manager.ts`; ADR-0005). Removal guards refuse to delete
  anything Pluton did not create.
- **Session roots are not shared between Ships.** An isolated worker's native
  session is allowed to reach only its own canonical checkout and its own
  engine home; project-root state, other workspaces, other Ships' credentials
  and `.pluton` state are outside its policy. Manager/chat sessions retain the
  broader project/workspace roots by design, and extra operator roots supplied
  to a worker session are ignored (`src/execution/factory.ts`).

## 4. Process execution hygiene

- Every external process — git, tmux, engines, verification checks — goes
  through `src/util/exec.ts`: **argv arrays only, never a shell string**,
  sanitized environment, hard timeouts, per-stream output caps with truncation
  markers.
- Git revisions coming from data (workspace base commits) are validated against
  a hex-object-id pattern and passed after `--end-of-options`, so a stored
  value cannot become a git option (`src/tools/handlers.ts`, `diff.inspect`).
- **Worker `.git` metadata is untrusted.** Evidence capture, status, diff,
  commit and integration use the trusted Git layer in
  `src/workspace/trusted-git.ts`: a throwaway `GIT_DIR` with empty
  config/hooks/attributes, plumbing commands, raw worktree hashing
  (`hash-object --no-filters`), and explicitly disabled external diff/textconv,
  clean filters and fsmonitor. `git status`/`git diff`/`git log` are never run
  against a worker checkout, because those commands execute repository-owned
  filters and helpers. Merge runs with a temporarily replaced minimal config;
  merge drivers, hooks and filters remain excluded. Repository content that
  needs a worker-defined driver is refused rather than executed.
- Verification checks (`src/verify/runner.ts`) refuse a conservative deny list
  of shells (`sh`, `bash`, `cmd`, `powershell`, …) and destructive tools before
  execution; the project configuration is the allow list. Checks do **not** run
  directly on the host: they run through the dedicated executor in
  `src/verify/executor.ts` against a disposable snapshot of the checkout with
  `network: none`. The snapshot excludes `.git` and top-level `.pluton`, the
  environment is an allowlist (`PATH`, locale, `TERM`, `TZ`) with
  `HOME`/`TMPDIR` inside the snapshot, and command resolution refuses
  executables from the workspace `PATH`. On platforms where Landlock and
  namespaces cannot be proven, the executor reports unavailable and every check
  fails closed — there is no silent host fallback. The same boundary runs
  post-integration acceptance checks. On Linux the helper also installs a
  seccomp filter for `restricted`/`none` that denies `socket(AF_UNIX)` and
  `io_uring_setup`; a network namespace isolates IP sockets but not the host's
  AF_UNIX namespace.

## 5. Isolation and the sandbox

Native execution (`sandbox.kind: native`) is the **only supported substrate**
(see [`docs/NATIVE_EXECUTION.md`](NATIVE_EXECUTION.md)). Configs that select
`sandbox.kind: docker` or `sandbox.kind: local-process` fail closed with
migration guidance (`src/execution/factory.ts`); there is no container or
unwrapped-process fallback.

- **Linux confined modes** (`read-only`, `workspace-write`) run every engine
  process through the verified `landlock-run` helper. The helper applies
  Landlock ABI ≥ 3 path rules and creates user, mount, PID and (when requested)
  network namespaces. `read-only` permits writes only to the session temporary
  directory; `workspace-write` additionally permits the task checkout/work
  directory and engine home. System runtime roots are read/execute only.
  A missing helper, helper hash/size mismatch, or Landlock ABI < 3 is an error
  before dispatch.
- **Network policy is namespace-based and, for non-open sessions, seccomp-filtered.**
  `open` uses the host network with no filtering. `restricted` creates a private
  network namespace with loopback only; the session tool bridge is reached
  through the helper's loopback proxy. `none` has no network at all, including
  the bridge, and is therefore rejected for orchestrated commands.
  `restricted`/`none` require unprivileged user and network namespaces; if
  unavailable, the session is refused. Because a network namespace does not
  isolate AF_UNIX sockets, the helper also denies `socket(AF_UNIX)` and
  `io_uring_setup` with `EPERM` for both policies. The bridge proxy is forked
  before the filter and forwards only loopback TCP to the host bridge socket.
- **Unconfined mode** is an explicit escape hatch for hosts without a verified
  confinement implementation (currently macOS and Windows) or an operator
  choosing it on Linux. It requires `acknowledge_unconfined: true` and
  `network_policy: open`. It runs under the host user account with full host
  filesystem and network access; only the working-directory check, environment
  filtering, output bounds, timeouts and process-tree kill remain.
- **Capability honesty.** The enforcement report distinguishes `landlock` from
  `none` and `netns` from `host`. CPU, memory and PID limits are recorded but
  not cgroup-enforced. A process that escapes the helper process tree can
  outlive graceful termination.
- **tmux is not a security boundary.** tmux sessions exist for visibility and
  window-targeted interruption only. `pluton attach` connects directly to host
  tmux; detaching (`Ctrl-B d`) does not kill the running engine or task.

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
- Verification evidence is scoped to the task **attempt** and records an
  explicit kind (`git`, `non-git`, `capture-failed`), the git revision, dirty
  state and content fingerprint the checks ran against, the post-check
  revision/fingerprint, and the executor identity that ran the check. A
  `capture-failed` row is never downgraded to non-Git, and a legacy row with no
  recorded kind can never authorize a fresh verdict. A verdict requires
  complete evidence for the current attempt, rejects checks that mixed
  revisions, kinds or worktree states, rejects a check that moved HEAD or
  changed the worktree, and a run cannot close `completed` while a completed
  task's current-attempt evidence contains a non-passed check or is missing.
  An interrupted same-attempt verification is superseded by a fresh run
  (history is retained, the attempt is not bumped); Git-backed tasks require
  Git evidence, while an explicit non-Git capture is accepted only for a task
  with no checkout. Integration always requires Git evidence, compares the
  checkout with the verified post-check fingerprint, and rebinds the commit to
  that exact fingerprint (a change between verification and commit is refused,
  not silently committed). Drift is reported as `blockedDrift` and audited as
  `integration.drift_detected`, and `pluton integrate` /
  `pluton approvals approve --continue` exit nonzero when a post-integration
  check fails.
- **Tamper detection covers the live worktree, not only commits.** The diff
  handed to independent verification is generated from the base commit to the
  live worktree (uncommitted and untracked changes included) through trusted
  plumbing. Conservative rules reject deleted test files, new
  `skip`/`xit`/`.only`/`fdescribe`, commented-out or removed assertions, and a
  changed/removed `"test"` script in `package.json`. Rejection makes the task
  fail with `tamper_detected` before integration.
- Pending approvals are capped (3 per run) so a model loop cannot grow state
  without bound.

## 8. Known gaps — what is NOT protected yet

Stated plainly so nobody over-reads the guarantees above:

1. **Linux confinement is live-verified only on WSL2 so far.** Confined modes
   need the verified helper plus Landlock ABI ≥ 3, and `restricted`/`none` need
   unprivileged user and network namespaces. The audit executed the helper on
   WSL2 Ubuntu 24.04.5 (`6.18.33.2-microsoft-standard-WSL2`, Landlock ABI 7,
   Node 24.20.0) as an unprivileged user: filesystem boundaries, environment
   allowlisting, timeout/output bounds, AF_UNIX denial, trusted-Git boundaries,
   evidence gating and the `restricted` proxy all passed. This is real kernel
   evidence but not a bare-metal, multi-distro or CI matrix result, and the full
   Linux Vitest suite was not run offline. macOS and Windows still have no
   verified confinement and run engines only `unconfined` (gap 4). Verification
   and post-integration checks are stricter: because they execute
   worker-controlled code, they refuse to run on every non-Linux platform and
   fail closed instead of using an unconfined host fallback.
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
4. **`unconfined` mode has no OS filesystem or network boundary.** It is the
   only supported mode on macOS and Windows and an explicit opt-out on Linux.
   The process runs as the host user, can read or write anything that user can,
   and uses the host network. It requires `acknowledge_unconfined: true` and
   `network_policy: open`; only working-directory checks, environment filtering,
   output bounds, timeouts and process-tree kill remain.
5. **Network policy is namespace- or host-based, not an egress allowlist.**
   The runtime default is `runtime.network_policy`; a Ship may override it with
   `network_policy` (the legacy `muses.<id>` key is accepted as an alias).
   - `open` — the host network stack, unfiltered. This is the only policy valid
     with `unconfined`.
   - `restricted` — a private network namespace with loopback only. The session
     tool bridge is reachable through the helper's loopback proxy; there is no
     external network or DNS. Requires unprivileged user and network namespaces.
   - `none` — no network at all, including the bridge. Orchestrated commands
     (`run`, `chat`, server) reject it because they require the bridge.

   Landlock does not mediate sockets. IP network isolation comes from the
   network namespace; host-local AF_UNIX is denied by the helper's seccomp
   filter, and `io_uring_setup` is denied as a non-seccomp-mediated escape.
   The policy is fixed when the session starts and is not inherited
   across delegation: a task delegated to a Ship with `network_policy: open`
   runs with that Ship's egress. There is no application-level URL allowlist.
   With `open`, a compromised engine can reach any service the host can reach.
6. **The operator's terminal is trusted.** `pluton attach`-style inspection and
   human commands are not sandboxed against the host.
7. **Deny lists and engine permission policy are conservative classifiers**,
   not capability systems. They inspect the bounded scope fields the engine
   supplies (tool kind, command, recognized paths, description). A malicious
   engine can omit or misdescribe a field; the policy then asks or denies, but
   it cannot prove the action's real effect. The OS sandbox/working-directory
   configuration remains the enforcement boundary, and an approval grants only
   the bounded action shown to the operator. Likewise, tamper detection is a
   conservative set of text rules over the verified diff, not a semantic proof
   that a test still asserts the right thing; it deliberately errs toward
   failing the task, and a worker that rewrites tests in a novel way outside
   those shapes may not be caught.
8. **The native tool bridge binds to loopback.** Every run/chat session exposes
   its bridge on `127.0.0.1` only; the former container-mode `0.0.0.0` exposure
   no longer exists. Per-session 256-bit bearer tokens gate every call, but any
   local process that obtains a token can call the bridge with that identity.
   The host is trusted (gap 2).
9. **CPU, memory and PID limits are advisory.** They are recorded on the session
   and used for planning/diagnostics, but there is no cgroup enforcement. A
   process that escapes the helper process tree can also outlive graceful
   termination. Neither is presented as isolation.
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
12. **The operator file viewer resolves links and protects runtime areas.**
    `/api/files` and `/api/files/content` refuse symlinks/junctions that
    canonicalize outside the workspace root, and refuse any read, overwrite or
    delete under `.git`, `.pluton` or `node_modules` (case-insensitive on
    Windows and macOS, which use case-insensitive filesystems by default). The
    same path is checked both lexically and after `realpath`, so a link or case
    variant cannot bypass the gate (`src/server/security.ts`).
13. **Verification inherits the host `PATH`.** The executor skips PATH entries
    inside the snapshot and resolves the command from the remaining host PATH,
    adding the resolved command's directory to the exec roots. A writable
    directory earlier on the operator's `PATH` could shadow a runtime with a
    different binary. The worker cannot normally write such a directory, but
    operators must keep `PATH` clean.
14. **The executor does not drop to a dedicated uid.** It relies on the invoking
    user's DAC plus Landlock. Run Pluton as an unprivileged user: as root,
    root-readable host files under the allowed `/etc` read root (for example
    `/etc/shadow`) are readable inside the check even though the worktree is
    isolated.
15. **The seccomp filter is a narrow denylist, not a syscall allowlist.** It
    denies AF_UNIX and `io_uring_setup` for `restricted`/`none`; other IPC or
    kernel interfaces are not enumerated, and `open` sessions are intentionally
    unfiltered. The `restricted` bridge proxy runs outside the filter by design
    and is trusted helper code.

## 9. Reporting

This is a local-first, single-operator tool with no telemetry. Security
relevant findings against the implementation should be filed as issues with a
reproduction against the deterministic mock engine where possible, plus the
store rows (`pluton status --run <id> --json`) and event log segment involved.
