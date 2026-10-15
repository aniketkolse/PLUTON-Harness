# Comparison matrix — cloudroom-core vs OpenMausBot vs Pluton decisions

## Purpose

This document is the side-by-side bridge between the three Phase 1 reverse-engineering reports and
Pluton-Harness's recorded decisions. It exists so that an implementer can quote one row of evidence
per design choice instead of re-reading three reports, and so that a reviewer can see where Pluton
follows prior art, where it adapts it, and which dimensions are not yet decided.

Rules used while writing:

- Every claim is traceable to one of the three reports at their pinned snapshots; citations are
  reproduced from the reports. No line number appears here that the reports did not record.
- Evidence labels are preserved: **[Verified]** (read in shipped files), **[Inferred]** (reasoned
  from code shape), **[Unknown]** (not determinable) — the reports' own convention.
- When a report does not cover a dimension for a project, the cell says **not covered in report**.
  Nothing is guessed to fill a cell.
- The Pluton column records what the ADRs decided; the Status: line at the end of each Pluton
  cell records what is actually built. Phase 2 (domain/config/CLI skeleton) and Phase 3 (durable
  store, receipts, task-graph admission, `status`/`task`/`graph` CLI) have shipped as of commit
  `c53d9c8` with 68 passing tests in 8 files (per `docs/ROADMAP.md`, "Phase 0–3 complete");
  runtime execution — engines, sandbox, verification — is still future, and rows that depend on it
  keep their "not implemented" status.

### Citation legend

| Slug | Report |
|---|---|
| `cc` | `docs/reverse-engineering/cloudroom-core.md` — cloudroom 0.1.58 @ `3949daaea3c7613458e9ad14afddbd267a0a56bc` |
| `omb-rt` | `docs/reverse-engineering/openmausbot-runtime.md` — OpenMausBot @ `7d008053cbdb255c2078fbf772630e634000dce5` |
| `omb-mcp` | `docs/reverse-engineering/openmausbot-mcp-workspaces-tests-licensing.md` — same OpenMausBot pin |

Citations read as `(report: path-in-reference-repo:lines)`. Where a report recorded no line, the
citation repeats only what the report recorded (usually its section number); no lines are invented.

### Cross-report notes (conflicts, near-conflicts, gaps)

- **No direct contradiction** between the three reports was found while building this matrix.
  Overlapping findings agree; e.g. the restart rerun-once rule is cited in both OpenMausBot reports
  (`omb-rt`: `docs/runtime-contract.md` §5, `server/runtime/tree.ts:5`; `omb-mcp`:
  `docs/runtime-contract.md:66-79`).
- **Near-conflict — engine process lifetime.** `omb-rt` records Claude Code keeping "one retained
  CLI process per thread" (`omb-rt`: `server/drivers/claude.ts:1`), while `omb-mcp` describes
  per-turn child processes as the general pattern (`omb-mcp`: §6.3, `server/procs.ts`). The reports
  describe different engines, not contradictory facts, but "one process per turn" must not be
  generalized across engines.
- **Within-project drift recorded by `cc` (not a cross-report conflict).** The cloudroom README
  claims PostgreSQL-backed history and 4 harnesses; the shipped code implements HTTPS gzip JSONL
  history and 8 harnesses; the report's rule is that code is normative and the divergence is
  recorded (`cc`: §1, §13).
- **Terminology collisions.** `cc` "adapter" ≈ `omb` "driver" ≈ Pluton "engine adapter". OpenMausBot
  itself contains two unrelated "loop guard" concepts and two "store" modules (`omb-rt`: §10) — do
  not merge them with `cc`'s disk `guard.rs`.
- **Coverage gaps kept visible:** approval/permission models and MCP/tool gating are not covered for
  cloudroom-core in `cc`; terminal/PTY semantics are not covered in depth for cloudroom-core
  (`cc`: §14) and do not exist as a subsystem in OpenMausBot (`omb-mcp`: §6.3). Cells say so.

## Dimension tables

### 1. Session/process model

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Session/process model | One long-running privileged service owns sandboxed workspaces and runs 8 external harnesses as unprivileged children (`cc`: §1); one active turn per session, queued commands drain sequentially (`cc`: `src/session/mod.rs:1631-1672`); idle sleep after 30 min (`cc`: `src/session/sleep.rs:5`). | Node "harness" hosts ~22 provider drivers; every unit of work is an `Assignment` row in SQLite (`omb-rt`: §1); same-conversation turns never overlap (`omb-rt`: `server/runtime/runtime.ts:310`); no timers — one synchronous `tick()` (`omb-rt`: `server/runtime/runtime.ts:227-236`). | CLI + local daemon; per-Muse serialization in MVP — a Muse never overlaps its own tasks (ADR-0006, Accepted); one long-lived container per Muse (ADR-0004, Accepted); one tmux session per Muse (ADR-0005, Proposed). Status: partially implemented — per-Muse serialization primitive exists (`src/orchestrator/mutex.ts`, tested); the daemon run loop is not implemented. |

- Both references put all state transitions behind one owner: cloudroom `session::Manager` is the single serialization point (`cc`: §3); OpenMausBot's tick owns every assignment transition (`omb-rt`: §6). Pluton's owner is the daemon runtime (ADR-0006).
- The serialization unit differs: cloudroom serializes per session, OpenMausBot per conversation, Pluton per Muse — the coarsest choice, because the Muse is the resource-holding identity (ADR-0006 scheduling rule).
- Neither reference ever places the managed engine process inside the user-facing terminal; Pluton repeats that split explicitly (ADR-0005: engine supervised separately from tmux).
- Cloudroom restores only work/recent sessions at boot (`cc`: `src/session/mod.rs:1727-1755`); OpenMausBot re-parks and reruns per its restart table (`omb-rt`: §8). Pluton's restart rule is recorded in ADR-0006 (see row 5).

### 2. Engine adapter abstraction

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Engine adapter abstraction | One trait abstracts every engine: `trait Adapter: Send` with `encode / receive / response / respond / capture / close / clean_exit` (`cc`: `src/runtime/mod.rs:281-309`); `enum Kind` lists 8 engines (`cc`: `src/runtime/mod.rs:42-54`); engines exchange structured events, not terminal text (`cc`: §7); new engines inherit lifecycle guarantees for free (`cc`: §7, [Inferred]). | Three layers: `ProviderDriver` factory → `ProviderInstance` runtime → `ProviderAdapter` turn surface (`omb-rt`: `server/contracts.ts:430-445, 394-422, 185-253`); `SendTurnInput` re-asserts `approvalMode` every turn (`omb-rt`: `server/contracts.ts:83-130`); registry downgrades failures to shadow instances (`omb-rt`: `server/harness/registry.ts:50`, `registry.test.ts:75-114`). | One `EngineAdapter` contract + explicit capabilities record; unsupported features fail with capability errors, never fabricated behaviour (ADR-0003, Proposed). OpenCode via ACP primary; `opencode run --format json` is a recorded fallback; second engine deferred to a Phase 4 addendum. Status: skeleton exists (`src/engines/contract/types.ts`), runtime not implemented. |

- Both projects isolate protocol encoding behind one interface and report capabilities instead of guessing; `omb` goes further with a tested capability table asserted in both directions (`omb-rt`: `capabilities.test.ts:39-47`).
- OpenMausBot keeps safety-relevant helpers separate on purpose — `reviewPermission` is not inferred from generic text helpers (`omb-rt`: `server/contracts.ts:394-422`); Pluton's contract keeps `authStatus` presence-only for the same reason (`src/engines/contract/types.ts`).
- Pluton's ADR-0003 explicitly separates the structured protocol channel from the tmux/terminal channel — the same separation both references maintain (`cc`: §7; `omb-mcp`: §6.3).
- Adding an engine is a descriptor + capability probe in all three designs; none require touching the core lifecycle (`cc`: §7 [Inferred]; ADR-0003 consequences).

### 3. Durability and write ordering

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Durability & write ordering | Hand-rolled file journal: one `{seq:020}.record` per record, temp file + fsync + rename + directory fsync (`cc`: `src/session/outbox.rs:181-203`); acceptance and queue insertion are a single fsynced receipt record (`cc`: `src/session/mod.rs:965-1351`); upload intent persisted before bytes leave (`cc`: `src/session/outbox.rs:151-158`); any journal write failure flips `writable=false` and blocks all mutations with `JOURNAL_UNWRITABLE` (`cc`: §6). | `node:sqlite` `DatabaseSync`, WAL, file 0600 / dir 0700 (`omb-rt`: `server/runtime/store.ts:191`, `store.test.ts:162-183`); row mutation + "admitted"/"started" events + inbox delivery written in one transaction **before** the runner is invoked (`omb-rt`: `server/runtime/runtime.ts:364-378`); a write failure starts nothing (`omb-rt`: `server/runtime/runtime.ts:376`). | SQLite via `node:sqlite`, WAL, single writer daemon, fixed `busy_timeout`; every transition writes state and its event/receipt updates in one `IMMEDIATE` transaction through the store layer; no module mutates tables directly (ADR-0002, Accepted; restated in ADR-0006). Status: implemented at the store layer (`src/store/db.ts` + migrations + `store.ts`, tests in `tests/unit/store.test.ts` incl. rollback atomicity); daemon-level write-before-act integration arrives with the run loop. |

- Both references commit intent durably before acting; Pluton's ADR-0002 transaction rule is the same invariant expressed in SQLite terms.
- The cloudroom report explicitly recommends against re-creating its bespoke journal (~200 dense lines in `outbox.rs`) and adopting the semantics instead (`cc`: §13 avoid 2, [Inferred]); Pluton follows that: no fsync/rename code of its own.
- Cloudroom's fail-closed write posture (reject, never silent amnesia) maps to Pluton's "a crash can lose the pending operation, never split it" (ADR-0006); a damaged store must fail loudly, not degrade.
- OpenMausBot's write-before-act transaction is the single strongest pattern in its runtime (`omb-rt`: §11.1); Pluton adopts it as the store-layer rule.

### 4. Idempotency and receipts

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Idempotency/receipts | Every command carries a `request_id`; session ids are deterministic `cr_{request}`; identical retry returns the same receipt; a differing payload under the same id yields `409 request_conflict` (`cc`: `src/api/mod.rs:552`); receipt lifecycle `accepted → delivered → completed / interrupted / failed / unknown / unknown_after_restart`, illegal exits forbidden (`cc`: `src/session/state.rs:164-199`); legacy `enqueue` records ignored on replay (`cc`: `src/session/state.rs:483`). | Typed enqueue refusals: `NOT_RUNNING, WRONG_SPEAKER, ANCESTOR, ALREADY_COMPLETED, ROOM_ANCESTOR, BUDGET, DEPTH` (`omb-rt`: `server/runtime-coordinator.ts:183-217`); a duplicate brief returns the existing row (`duplicate: true`) (`omb-rt`: `server/runtime-coordinator.ts:192-193`); MCP `send_*_message` takes an optional `send_id` and returns the first receipt on replay (`omb-mcp`: `scripts/mcp-server.ts:144-147`); exactly one report and at most one wake per resume (`omb-rt`: `server/runtime/runtime.ts:589-609, 626-648`). | `request_receipts` row per request: `request_id`, target kind+id, sha256 of canonical payload, state, result/error. Same id + same payload returns the stored receipt and dispatch is never repeated; same id + different payload → `request_conflict`; IDs generated by default, callers may supply them (ADR-0006, Accepted). A completed child wakes its parent exactly once (ADR-0007, Accepted). Status: implemented (`Store.admitRequest`): duplicate returns the stored receipt and creates nothing; changed payload → `request_conflict` + audit event; failing create rolls back; receipts survive reopen (`tests/unit/store.test.ts`). |

- Both references dedupe structurally (a row/receipt), never best-effort; Pluton's hash-of-payload check is the cloudroom rule generalised beyond a single target type.
- Cloudroom's deterministic session ids (`cr_{request}`) are a cheap extra idempotency key (`cc`: §13 transferables); Pluton keeps caller-suppliable request IDs but does not derive resource ids from them (ADR-0006).
- OpenMausBot's refusal vocabulary is closed and typed — the model for Pluton's "refusals are first-class, inspectable outcomes" (ADR-0007).
- "Exactly one wake per completion" is asserted in both references and encoded as a receipt rule in Pluton (ADR-0007); it exists specifically to prevent duplicate parent activation.

### 5. Crash and replay policy

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Crash/replay policy | `Manager::open` replays snapshot + journal and classifies crash outcomes: non-terminal non-queued receipts → `unknown_after_restart`; queued receipts on non-eligible sessions → `failed`; **at most one** automatic recovery per session (`recovery_attempted`); failed resume → `process_lost` with `startup_error` (`cc`: `src/session/mod.rs:302-434`); graceful shutdown writes `unknown`; a hard crash heals as `unknown_after_restart`; both mean "delivery uncertain" (`cc`: §6). | A turn cut by shutdown/crash is rerun **at most once** with the same inputs, marked rerun; cut twice → `failed(interrupted)` with fixed `CUT_TWICE` detail (`omb-rt`: `server/runtime/tree.ts:5`); before rerunning, the host's optional `outward` port is asked; a cut turn that already acted outward is not rerun (`omb-rt`: `server/runtime/runtime.ts:663-668`, `runtime.test.ts:863-915`); absent/empty/throwing `outward` means "nothing known" and the turn reruns once (`omb-mcp`: `docs/runtime-contract.md:81`). | At startup the runtime reloads non-terminal work; `running` → `unknown_outcome` unless engine-native resume is verified; **an interrupted or externally-uncertain action is never auto-replayed** — only an explicit, policy-checked retry (new attempt, previous evidence preserved) may re-dispatch; no exactly-once claims for external side effects (ADR-0006, Accepted). Status: restart classification still not implemented (no runtime auto-replay exists); receipts and tasks survive a store reopen (`tests/unit/store.test.ts`). |

- The three policies agree on the core rule: never blindly resend uncertain work; they differ in the default — cloudroom and OpenMausBot rerun strictly once, Pluton defaults to `unknown_outcome` and waits for an explicit retry.
- Because Pluton never auto-reruns, OpenMausBot's `outward`-effect probe (a strong idea) is not needed in the MVP; if Pluton ever adopts rerun-once, it must adopt the equivalent probe (tracked as open; see `implementation-decisions.md`).
- Both references cap automatic recovery at one attempt to avoid crash loops (`cc`: `recovery_attempted`; `omb-rt`: `tree.ts:5`); Pluton's explicit-retry rule has the same effect, with a human-visible receipt.
- OpenMausBot's "downtime is nobody's budget" clock clamp (`omb-rt`: `server/runtime/runtime.ts:655-657`) is specifically relevant to Pluton's wall-clock budgets and is adopted (ADR-0007).

### 6. State storage

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| State storage | Append-only journal files + `saved`/`uploading` cursors + `snapshot.json` every 20,000 records + exclusive lock; **no database driver or ORM anywhere in `src/`** (`cc`: §1); snapshots are accelerators, replay of the remaining records is authority (`cc`: `src/session/state.rs:213-545`, [Inferred]); history transport is HTTPS gzip JSONL (`cc`: `src/session/history.rs:119-218`). | `runtime.db` SQLite (tables `assignments`, `assignment_events`, `inbox`; every row re-validated by zod on read) (`omb-rt`: `server/runtime/store.ts:20-79, 103-169`); `messages.db` SQLite; `bots.json`/`groups.json` host stores; per-thread events/native/decision NDJSON; tool-result spill files 0600/dir 0700; `parkedSeats` is memory-only in the host (`omb-rt`: `server/index.ts:2156`). | One SQLite database per project at `<project>/.pluton/state/pluton.sqlite` (WAL; `-wal`/`-shm` treated as part of DB identity); forward-only numbered migrations; events append-only with monotonically increasing ids; "all task truth is readable from SQLite; the CLI never invents state" (ADR-0002 and ADR-0006, Accepted). Status: implemented — single SQLite DB per project, WAL, forward-only migrations, append-only events (`src/store/*`, tested). |

- The two references sit at opposite ends: cloudroom deliberately hand-rolls everything (privileged, offline-first, no DB driver), OpenMausBot standardizes on SQLite; the cloudroom report itself suggests mature storage primitives for Pluton (`cc`: §13 adapt 3, [Inferred]) — Pluton chose SQLite (ADR-0002).
- OpenMausBot's zod-on-every-read is its defence against corrupted rows; Pluton's equivalents are typed domain models plus strict store access (ADR-0002 "no module mutates tables directly") — a concrete test for this is listed in `implementation-decisions.md`.
- OpenMausBot documents its own memory-only state (`parkedSeats`) as a known wart (`omb-mcp`: `docs/runtime-contract.md:135-136`); Pluton's rule is the opposite: task truth in SQLite only (ADR-0006).
- Cloudroom's snapshot interval (`SNAPSHOT_EVERY = 20_000`, `cc`: `src/session/state.rs:7`) has no Pluton equivalent and is not needed at MVP scale; replay authority stays with rows, not snapshots.

### 7. Task and delegation model

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Task/delegation model | Public snapshot has no task graph; child sessions/subagent bookkeeping lives in `children.rs` and is request-scoped — "subagents never start twice" is a consequence of receipt dedupe (`cc`: §3; internals lightly read); multi-session coordination is the private "Cloud threads" layer (`thread.rs`, `cc`: §3). | `Assignment` tree is the unit of work: `rootId/parentId/depth`, `origin person/routine/outside`, `requester`/`assignee`, `mode work/consult/notify`, `reply resume/poll/none`, lifecycle `queued → running → …` with `waiting`/`resume`/`needs_input` branches (`omb-rt`: `server/runtime/types.ts`); deepest-first fixed tick passes; loop guards `NO_PROGRESS_STRIKES = 2`, `SAME_ERROR_STRIKES = 3` (`omb-rt`: `server/runtime/tree.ts:38-39, 53-61`); budgets renew only on durable progress (`omb-rt`: `server/runtime/runtime.ts:650-653`). | Delegation only through the daemon's restricted tool bridge, validated server-side per call; hard limits (defaults): `max_team_size` 8, `max_delegation_depth` 3, `max_tasks_per_run` 20, `max_child_tasks_per_task` 5, max concurrent workers 3; graph invariants: no cycles, no delegation to an ancestor, depth = parent + 1, task-count cap checked transactionally; `muse.propose_create` validated and approval-gated when it expands capability (ADR-0007, Accepted). Status: admission implemented (`src/orchestrator/task-graph.ts`): depth/fan-out/run-size/dependency/cycle checks transactional + `task.admitted` events (`tests/unit/task-graph.test.ts`); the restricted tool bridge is still future. |

- OpenMausBot's `Assignment` record is described by its own contract as replacing "two delegation systems, six wake lanes, a dozen clocks and ten trust wordings" (`omb-mcp`: `docs/runtime-contract.md:1-3`) — a direct warning against Pluton ever running two task sources.
- Pluton's limits are numerically smaller than OpenMausBot's (`DEFAULT_LIMITS`: depth 4, requests 24, executions 48, wakes 48 — `omb-rt`: `server/runtime/types.ts:322-331`); the shape (depth, counters, wake budget) is the same, values differ by product stage.
- Loop protection direction is shared: OpenMausBot stops no-progress continuations with fixed wording; Pluton bans "Manager prose as authoritative state" (ADR-0007) and relies on explicit states plus budgets.
- Cloudroom's public subset cannot settle task-model questions — treat it as y=receipts-and-session-lifecycle only; its private control plane is explicitly out of the snapshot (`cc`: §14).

### 8. Approval and permission model

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Approval/permission model | **Not covered in report** — no human-approval or permission-prompt model is described; the nearest recorded mechanism is capability gating (a command the engine lacks → 409 conflict; see row 9). | Five modes `ask / edits / auto / full / custom`, default `full` (`omb-mcp`: `shared/approval-mode.ts:5-7, 47-51`); resolution fails closed: unknown persisted value → `ask`, legacy bit → safe `auto`, unconfirmed two-phase grant runs only as `ask` (`omb-mcp`: `shared/approval-mode.ts:61-78`); `autoVerdict` order — questions are never auto-answered, exact saved command/tool grants approve, otherwise a card (`omb-mcp`: `server/auto-approve.ts:91-117`); elevation journal `prepared→confirmed→activated→committed`, a grant surviving restart is revoked (`omb-rt`: `server/store.ts:290-299, 521-537`); ACP permissions deny unless explicit allow (`omb-rt`: `server/drivers/acp/core.ts:1041-1055`). | `needs_approval` is a first-class state (ADR-0006); `muse.propose_create` requires an approval record when it adds an engine or expands capabilities (ADR-0007); protected paths require approval before integration (ADR-0009); `pluton approve` is a planned command (README command families). No dedicated approval-level ADR exists yet — default mode is an open item (`implementation-decisions.md`). Status: partially decided, not implemented. |

- OpenMausBot's fail-closed resolution (unknown → most restrictive; unconfirmed grant → ask) is the behavioural rule Pluton should reproduce, whatever the mode vocabulary becomes.
- OpenMausBot's default is the most permissive mode (`full`); its own report flags this as wrong for a local-first dev tool (`omb-mcp`: §11.2 item 1). Pluton must not inherit that default.
- "A typed line never answers a card" (`omb-mcp`: `docs/runtime-contract.md:39`) — approval is a durable card/state, never prose; Pluton's `needs_approval` state follows the same principle.
- Permission decision logs (redacted, fire-and-forget, stable rule names — `omb-mcp`: §4.4) are not yet reflected in any Pluton ADR; they are a candidate for the Phase 6 tool bridge.

### 9. Tool and MCP gating

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Tool/MCP gating | **MCP not covered in report.** Analog recorded: a `FEATURES` list gates API capabilities and a missing feature/harness capability means "explicitly unsupported", never an ambiguous failure (`cc`: `src/lib.rs:19-59`); an engine lacking a command yields `409` conflict (`cc`: `src/runtime/mod.rs:631-641`). | Three interposition layers: a per-server stdio **gate** (validate policy before spawning — "corrupt policy must never become pass-through", `omb-mcp`: `server/mcp-gate.ts:184-186`), mount-time filtering, route auth, engine-level native contracts (`omb-mcp`: §4.2 table); scope language with deny-wins and parse-on-every-use fail-closed (`omb-mcp`: `shared/tool-scope.ts:69-78`); `toolScopeWidens` gates widening edits (`omb-mcp`: `shared/tool-scope.ts:106-134`); native tool scoping is engine-contract-bound (verified only for Pi/Grok) (`omb-mcp`: `docs/tool-selection.md:75-79`). | Delegation happens only through the daemon's restricted tool bridge; every call is validated server-side against caller identity, task, policy and runtime state (ADR-0007, Accepted). `@modelcontextprotocol/sdk` is added when the tool bridge is implemented (ADR-0001, Accepted); ROADMAP Phase 6 lists the bridge as not started. Status: decided at policy level; bridge design open. |

- The gate-not-advisory principle is the highest-leverage pattern in the `omb-mcp` report: engine MCP configuration is input to Pluton's gate, never authority (`omb-mcp`: §11.1 item 1).
- Deny-wins plus parse-on-every-use ("a corrupt persisted value can never widen access") is directly transferable to Pluton's permission catalog (`src/domain/permissions.ts` declares names; enforcement is server-side per call by design).
- OpenMausBot's honest limitation — native tool scoping only where an engine contract is verified (`omb-mcp`: `docs/tool-selection.md:78`) — must be mirrored as an explicit capability, not a silent partial gate (ADR-0003 capability-error rule).
- cloudroom-core offers no MCP prior art; its contribution to this dimension is the "unsupported is explicit" error posture (`cc`: §10).

### 10. Workspace isolation

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Workspace isolation | Linux containment: cgroup v2 delegated root or fallback marked process group (`cc`: `src/runtime/linux.rs:26-202`); `as_agent` drops uid/gid, sets `PR_SET_NO_NEW_PRIVS`, clears ambient capabilities (`cc`: `src/runtime/linux.rs:306-353`); boot reconcile kills prior workloads safely across PID reuse (`cc`: §6, §8); honest degradation — with no cgroup/marking the service "simply waits on the PID" instead of pretending to isolate (`cc`: §8). | "Directory organization, not a shell sandbox" (`omb-mcp`: `server/workspace.ts:20`); per-bot workspace doubles as file memory (0700/0600); per-task workspace dirs with id validation; shadow-git checkpoints per (bot, cwd) with privacy refusals (never at root/`$HOME`/Desktop) and a 120 s git timeout (`omb-mcp`: `server/checkpoints.ts:106-113, 149-176`); **no** per-bot git worktree isolation anywhere (`omb-mcp`: §6.2, [Inferred]); hosted sandboxes are remote ssh/docker transports. | Docker Linux containers, one long-lived container per Muse; baseline hardening (non-root, `--cap-drop ALL`, no-new-privileges, pids/memory/cpu limits, no Docker socket, no host network by default); mounts are an allowlist (task checkout rw, Muse engine home rw, explicitly granted data); env allowlist only; `io.pluton.*` labels revalidated before stop/kill; Docker unavailable → fail closed with exact fix; dev-only `local-process` sandbox requires `sandbox.local_process_acknowledged: true` (ADR-0004, Accepted; checkout granularity per task in ADR-0005, Proposed). Status: decided, not implemented (Phase 5). |

- Cloudroom's containment is Linux-specific and read-only verified; the portable part is the principle "privileged core, unprivileged workers, kill by group" (`cc`: §8, [Inferred]) — Pluton's Docker model is the Windows-host equivalent.
- OpenMausBot explicitly does **not** claim a sandbox for its workspace directories; Pluton's claims must stay equally precise: container isolation is the boundary, tmux and directories are not (ADR-0004 context; ADR-0005).
- Shadow-git checkpoints are a snapshot idea Pluton does not adopt (it uses per-task clones for mount semantics, ADR-0005 alternatives); both avoid touching the user's repository.
- Public git discipline: OpenMausBot clears `GIT_*` redirection env vars before running git (`omb-mcp`: `server/checkpoints.ts:185-188`); the same hygiene concern applies to Pluton's clone/diff commands and belongs in Phase 5 tests.

### 11. Terminal and PTY handling

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Terminal/PTY handling | **Not covered in report** beyond file existence: `src/runtime/terminal.rs` was not inspected in depth (`cc`: §14, coverage gap); managed engine I/O is a line-based JSON subprocess driver with a 16 KiB per-line cap, not a PTY (`cc`: `src/runtime/process.rs:16:16, 97-277`). | No terminal multiplexer, PTY or attachable session in the server; the only `tmux/pty` grep hit is a comment ("disk persists, tmux does not") (`omb-mcp`: `server/boat.ts:3`); per-turn child processes with centralized process-tree reaping (`killCliTree`, Windows uses `taskkill /T`) (`omb-mcp`: §6.3); Claude Code retains one CLI process per thread (`omb-rt`: `server/drivers/claude.ts:1`). | tmux is terminal persistence, not a security boundary: one tmux session per Muse (`pluton_<project>_<muse>`, after sanitization + uniqueness checks), one window per task created at dispatch, default `shell` window; attach/detach and window closure never affect task lifecycle; the managed engine process is supervised separately and never runs inside the user's tmux pane (ADR-0005, Proposed); tmux runs inside the worker container, never as a Windows-native control-plane dependency (ADR-0004, Accepted); Pluton never claims tmux support on native Windows (ADR-0010, Accepted). Status: decided, not implemented (Phase 5). |

- Neither reference uses a PTY for the managed channel; both keep structured protocol I/O separate from human terminals — Pluton's ADR-0003 states the same channel separation.
- OpenMausBot's per-engine reconciliation note applies (see cross-report notes): process lifetime is an engine property (`claude.ts:1` retained process vs per-turn spawns), and Pluton's adapter contract must express it per adapter, not globally.
- Neither report records terminal resize/scrollback semantics; Pluton's attach path is specified as argument-array based and non-authoritative for lifecycle (ADR-0005), with tests pending on this host.

### 12. Events and streaming

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Events/streaming | Async command model: `POST` → `202 {session_id, receipt, saving}`; clients poll or stream for settlement (`cc`: §10); SSE endpoint with `Last-Event-ID` replay so a reconnecting CLI does not miss events (`cc`: §10, no line recorded); central stable error-code mapping (`cc`: `src/api/mod.rs:510-572`); typed observability signal taxonomy, not freeform log strings (`cc`: §9). | `RuntimeEvent` discriminated union with a hand-written validator; corrupt lines are skipped, not rendered (`omb-mcp`: `server/thread-events.ts:139-227`); SSE fan-out writes every durable event or disconnects the client to reconnect and replay; only `screen` frames are dropped under backpressure; >4 MiB buffered → disconnect + replay (`omb-mcp`: `server/sse-fanout.ts:11-38`); "hold instead of poll" (`wait=MS&version=V`) (`omb-mcp`: §7.3); CLI `events` streams JSON lines, exit code 3 signals "a human must answer" (`omb-mcp`: `docs/headless-cli.md:45-62`). | Events are append-only, monotonically sequenced, typed, bounded and redacted (ADR-0006, Accepted); parents wait event-driven with timeout, not by polling loops (ADR-0007, Accepted); CLI surfaces `pluton logs` / `status` with `--json` (README command families). **No ADR records a machine streaming/replay protocol** (no SSE/Last-Event-ID decision) — open item in `implementation-decisions.md`. Status: store-level event rows implemented (append-only seq, bounded, redacted — `src/store/store.ts`, `tests/unit/util.test.ts`); no machine streaming/replay protocol is decided or implemented. |

- Both references treat event delivery as a contract (validated union / stable codes), not logs; Pluton's bounded redacted event rows follow the same stance.
- `Last-Event-ID`-style replay is the reconnect story in both references and is the natural candidate for Pluton's first JSON streaming surface; it is not yet decided.
- OpenMausBot's "hold instead of poll" pattern is worth remembering for `pluton wait`-style verbs; ADR-0007 only mandates event-driven waiting inside the runtime today.

### 13. Testing strategy

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Testing strategy | Rust integration suites (`tests/runtime.rs`, `adapters.rs`, `journal.rs`, `storage.rs`, `terminal.rs`); Python fixtures implement **real** protocols with modes crash / no-reply / reject / late-reject / hold-resume (`cc`: `tests/core_fixture.py`); named contract tests include `unresponsive_harness_is_not_reported_as_cleanly_closed` and `resume_reattaches_and_continues_the_native_rollout` (`cc`: §12); CI runs fmt, `clippy -D warnings`, full `cargo test` + fixtures (`cc`: §12). | vitest + `tsc -b` typecheck + `oxlint --deny-warnings`; runtime tested as a pure state machine over `FakeRunner` + `FakeClock` (`omb-rt`: `server/runtime/testing/fake-runner.ts`, 343 lines); `scenarios.test.ts` S01–S29 + R-S1..R-S15 map one-to-one to contract sections (`omb-rt`: §9); `checkInvariants()` I1–I10 executed after every scenario (`omb-rt`: `server/runtime/invariants.ts:29-123`); capability tables cross-checked against the registry in both directions (`omb-rt`: `capabilities.test.ts:39-47`); isolated-fixture verification ("always launch an isolated fixture; never verify mutations against the user's live app") (`omb-mcp`: `docs/verification/README.md:9-41`). | Fixture-replay conformance suite per adapter + opt-in live tests (ADR-0003, Proposed); migrations tested by opening an old-version fixture DB and asserting schema and data (ADR-0002, Accepted); dependency-direction unit test asserts the module graph (ADR-0001, Accepted); deterministic drive of the whole machine with a mock engine before any real model runs (ADR-0006, Accepted); "anything not executed is reported as NOT RUN with a reproducible command" (README, ROADMAP). Status: eight test files (68 tests) as of commit `c53d9c8`, including spawned-CLI integration tests (`tests/integration/cli-status.test.ts`) and store crash-reload coverage; fixture-replay adapter suites and opt-in live tests are not implemented. |

- Both references make uncertainty testable as a first-class outcome (fixture modes; fake clock stalls) — this is the pattern Pluton's Phase 8 failure-mode list depends on.
- OpenMausBot's expected-capability table that fails when a driver and the table drift is the cheapest anti-drift mechanism found across both reports (`omb-rt`: §11.3); Pluton's capability test should copy the pattern, not the table.
- The isolated-fixture rule (never mutate a live app/state) maps directly onto Pluton e2e tests using a temporary project directory.
- Cloudroom's "state machine under test" approach (fixtures assert exact receipt states after injected failures — `cc`: §12) matches Pluton's plan to assert `unknown_outcome` instead of success.

### 14. Honesty conventions (how each project signals uncertainty)

| Dimension | cloudroom-core (evidence) | openmausbot (evidence) | Pluton decision (ADR ref) |
|---|---|---|---|
| Honesty conventions | Explicit uncertainty states (`unknown`, `unknown_after_restart`) instead of optimistic success (`cc`: §5, §6); fail-closed storage instead of silent amnesia (`cc`: §6); honest degradation ("unprotected" mode admits it waits on the PID) (`cc`: §8); explicit "unsupported" instead of ambiguous failures (`cc`: §10). Counter-example recorded: doc-vs-code drift — README claims PostgreSQL history and 4 harnesses vs HTTPS JSONL and 8 harnesses in code, code normative (`cc`: §1). | Error text distinguishes **never ran** (`ECONNREFUSED`) from **may have run, check before repeating** (`omb-mcp`: `server/harness-mcp-proxy.ts:29-39`); "a line not read to its end is 'could not read', never 'clear'" (`omb-mcp`: `server/safety-floor.ts:3`); unconfirmed control calls are refused (`omb-mcp`: `server/control-client.ts:28-30`); documented open risks left in source ("a bot's shell is a loopback caller too…" — `omb-mcp`: `server/request-auth.ts:29-32`); known limits written down (safety floor off by default and inert on Windows servers — `omb-mcp`: `docs/verification/safety-floor.md:6-15`). Counter-examples: stale doc line numbers; removed tool aliases surviving as internal labels (`omb-rt`: §10). | README status banner keeps docs accurate and reports anything unexecuted as NOT RUN with a reproducible command; ADRs carry explicit statuses (Accepted / Proposed) and ADR-0003 defers its own second-engine choice to a Phase 4 addendum; ADR-0004 documents the `restricted` network mode as *not* an egress filter; ADR-0011 records that Pluton's own license is undecided rather than guessing one. Status: convention adopted; enforcement mechanism (CI docs check) still open. |

- All three projects have the same failure mode observed somewhere: documentation that outlives the code it described. Pluton's countermeasure is the strongest available short of automation — status labels plus NOT RUN evidence — but it is manual today.
- OpenMausBot is the best prior art for *agent-facing* honesty: telling the model exactly what is safe to retry; Pluton's tool-bridge error contract should adopt this wording discipline (open item O4).
- Cloudroom's explicit receipt states are honesty encoded in the state machine; Pluton does the same with `unknown_outcome` (ADR-0006) rather than a broader `failed`.
- "Unreadable = not clear" (config, policy, scope parsing) is a rule Pluton should apply to every parse path; today only ADR-0007's load-time validation and ADR-0002's unknown-newer-schema refusal encode parts of it.

## Bottom line

- The strongest shared prior art across both projects is durable-intent-before-action, structural idempotency, and explicit uncertainty; Pluton's ADR-0006 is an intentional synthesis of cloudroom receipts and OpenMausBot write-before-act transactions.
- The sharpest differences Pluton must not blur: OpenMausBot serializes per conversation and reruns cut turns once; cloudroom reruns at most once per session; Pluton serializes per Muse and does not auto-rerun at all.
- Dimensions where Pluton currently has no recorded decision — event streaming protocol, approval model and default, tool-bridge gating design, outbound license — are enumerated as "Still open" in `implementation-decisions.md`.
