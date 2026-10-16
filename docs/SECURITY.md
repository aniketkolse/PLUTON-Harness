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

1. **No live networked-engine run has been executed end to end.** The bridge,
   supervisor and gate are exercised against the deterministic mock engine and
   real child processes; an engine session driving a real run through the HTTP
   transport has not been run on this host (§15/§16 of the delivery report).
2. **HTTP transport authentication is a bearer token over loopback.** Any
   process on the host that obtains the token can call the bridge with the
   corresponding identity. Tokens are per-run/launch, short-lived and never
   logged, but the host itself is trusted.
3. **Approvals have no expiry.** A pending approval stays pending until the
   operator decides; there is no automatic timeout-to-denied path yet.
4. **Container hardening is Docker's defaults plus the configured resource
   limits.** No custom seccomp/AppArmor profile, no read-only root filesystem
   guarantee for the worker image beyond what the Dockerfile sets.
5. **Network policy `restricted` is declarative.** The config accepts the value;
   per-Muse network enforcement beyond container defaults is not implemented.
6. **The operator's terminal is trusted.** `pluton attach`-style inspection and
   human commands are not sandboxed against the host.
7. **Deny lists are conservative blocklists**, not capability systems. They
   reduce accidental damage; the config allow list is the real control.

## 9. Reporting

This is a local-first, single-operator tool with no telemetry. Security
relevant findings against the implementation should be filed as issues with a
reproduction against the deterministic mock engine where possible, plus the
store rows (`pluton status --run <id> --json`) and event log segment involved.
