# cloudroom-core — architecture reverse-engineering report

Read-only study of `Y:\Pluton\references\cloudroom-core` at `main @ 3949daaea3c7613458e9ad14afddbd267a0a56bc`, prepared as design input for Pluton (TypeScript CLI-first multi-agent orchestrator). No file in the reference tree was modified.

Evidence labels used throughout: **[Verified]** = read directly in shipped files (path + line refs); **[Inferred]** = reasoned from evidence, not directly stated; **[Unknown]** = not determinable from this snapshot. Where docs and code disagree, code is normative and the divergence is recorded.

## 1. Snapshot

- Product: "Cloudroom", a privileged "core" service for running third-party agent CLIs inside owned compute; crate `cloudroom 0.1.58` (`Cargo.toml`), Rust edition 2024, `rust-version = 1.89`. [Verified]
- Git: branch `main`, HEAD `3949daaea3c7613458e9ad14afddbd267a0a56bc`, commit date `Wed Oct 14 20:42:19 2026 -0700`. [Verified]
- Commit subject: "Publish core 0.1.58: Devin in Cloud threads, subagents never start twice, stuck commands fail at once instead of freezing a thread" — accurate against the code discussed below. [Verified]
- License: **Apache-2.0**. `LICENSE` is the Apache License 2.0 text; `Cargo.toml:6` declares `license = "Apache-2.0"`. No other license file exists. [Verified]
- Nature: one long-running service that (a) owns sandboxed workspaces, (b) runs 8 external agent harnesses as unprivileged children, (c) exposes an HTTP/SSE API consumed by a private control plane and small clients, and (d) journals all session activity locally before uploading history over HTTPS. [Verified]
- Size: `src/` ≈ 23,953 lines. Top-level modules:
  - `api` — HTTP surface (router, auth, error mapping).
  - `session` — session manager, state machine, journal, guards (the heart).
  - `runtime` — engine adapter layer, process driver, containment.
  - `workspace` — workspace lifecycle and disk policy.
  - `observability` — diagnostics, metrics, system sampling.
  - `secrets`, `sync`, `preview`, `computer_use`, `mac` — credential brokering, file sync, preview servers, computer-use, macOS host integration.
  - plus `config.rs`, `lib.rs` (feature list), `main.rs`. [Verified]
- Repo layout also ships `adr/` (1 file), `docs/` (incl. `database/*.sql`), `install/`, `integrations/bb/` (TypeScript client), `tests/`, `.github/workflows/ci.yml`. [Verified]
- Dependencies are deliberately thin: `axum`, `tokio`, `serde`, `reqwest` (rustls), `flate2`, `tokio-stream`, `hyper`. **No database driver or ORM anywhere in `src/`** — persistence is a hand-rolled file journal. [Verified]
- The published repo is a *subset* of a larger private product:
  - Only 1 ADR ships (`adr/0001-…`) while code and docs cite ADR numbers up to ≥0237.
  - `docs/database/*.sql` exist but `src/` never reads `CLOUDROOM_DATABASE_URL`; the repo's own `AGENTS.md` says "SQL and application instructions live in `docs/database/`" and "Only the owner applies production migrations" — SQL belongs to the private side.
  - `README` claims PostgreSQL-backed history and only 4 harnesses (Codex, Claude Code, Pi, Cursor); code implements HTTPS gzip JSONL history and 8 harnesses. [Verified + Inferred]
- Stub check: `grep` for `todo!`, `unimplemented!`, `TODO`, `FIXME` in `src/` found none (only benign "Unsupported" error strings). Everything described below is shipped behavior, not scaffolding. [Verified]
- Publication hygiene: the repo's own `AGENTS.md` says "Keep credentials and internal notes in ignored files. Review changes before publication" — consistent with a curated export rather than the full private history. [Verified]

## 2. Reproducibility method

- Read-only only: `git log/show`, Glob/Grep over `src/`, `docs/`, `adr/`, `tests/`, `install/`, `integrations/`, then targeted line reads of key functions. No builds, installs, clones, or git mutations inside the reference tree. [Verified]
- Every behavioral claim was matched against code; doc-only statements are labeled; doc-vs-code divergences are collected in §1, §13 and §14 with both sides named.
- Quoting policy: at most a few lines per citation; all line numbers refer to the pinned commit.
- Limits:
  - Work ran on Windows; Linux containment paths (cgroups, `pre_exec`, in-sandbox execution) were read but never executed.
  - Engine protocol claims were cross-checked against the repo's own protocol-accurate fixtures, not against real vendor binaries.
  - Where the mechanism was confirmed only through tests (e.g. PID-reuse safety), the label says so.

## 3. Module boundaries

- `src/lib.rs` — crate wiring plus the `FEATURES` list (`lib.rs:19–59`). Features gate API capabilities; a missing feature/harness capability means "explicitly unsupported", never an ambiguous failure. [Verified]
- `src/main.rs`, `src/config.rs` — process bootstrap and configuration; `CLOUDROOM_STATE_DIR` and related env vars select persistence roots. [Verified]
- `src/api/mod.rs` — the axum HTTP shell:
  - router `27–99`;
  - auth middleware `470–508`;
  - central error-code mapping `510–572` (string→stable code).
  - Thin translation layer over `session::Manager`; no business logic beyond auth/limits/error mapping. [Verified]
- `src/session/` — the heart of the product:
  - `mod.rs` — `Manager`: `open` (302–434) boot/recovery; `start` (654–826) request acceptance; `launch` (828–944) engine spawn/re-attach; `command` (965–1351) input ingestion; `deliver` (1384–1437) input transmission; `advance` (1631–1672) event-driven transitions; `restore_all` (1727–1755) boot sweep; `relaunch` (1779–1952) resume/retry; `record_native` (1954–2219) native-identity persistence and unexpected-exit settling; `shutdown` (2221–2270) graceful stop. [Verified]
  - `state.rs` — replayable state machine: `finish_receipt` (164–199) terminal-state rules; `apply` (213–545) record replay; `append` (547–581) record creation; snapshots every `SNAPSHOT_EVERY = 20_000` records (line 7), snapshot build 76–146. [Verified]
  - `outbox.rs` — durable journal: `append` (104–109); `begin_upload` (151–158) intent-before-send cursor; `acknowledge` (172–179) advance-on-success cursor; atomic fsync write path (181–203). [Verified]
  - `guard.rs` — disk guard + history uploader loops: `RESCUE_AFTER=30s` (6), `UPLOAD_AFTER=30s` (8), `UPLOAD_RECORDS=1024` (10); `rescue` (184), `start_uploader` (228), `upload_batch` (311), `flush_history` (341). [Verified]
  - `sleep.rs` — idle suspension: `IDLE_SLEEP_MS = 30 min` (5); decisions 130–249. [Verified]
  - `history.rs` — cloud history transport (119–218, 332–345) and `saved_history_only` synthesis for local-only history (263). [Verified]
  - `children.rs` — child sessions/subagent bookkeeping (commit subject: "subagents never start twice"). [File + commit Verified; internals lightly read]
  - Child/subagent coordination is request-scoped: a child already starting cannot be started again from a duplicate request — a direct consequence of the receipt dedupe in §5. [Verified via commit subject + §5 mechanism]
  - `catalog.rs` — model catalog surfaced to clients. [File Verified]
  - `thread.rs` — multi-session (Cloud) threads, including Devin integration. [File + commit Verified]
  - `automation.rs`, `teleport.rs`, `prompt.rs`, `report.rs`, `accounts.rs` — automation hooks, machine transfer, prompt/status assembly, reporting, account handling. [File existence Verified]
- `src/runtime/` — engine layer:
  - `mod.rs` — `enum Kind` (42–54), `trait Adapter: Send` (281–309), `spawn_inner` (423–585), `capabilities` (631–641), checkpoint (961–975), command env construction (977–1004). [Verified]
  - `process.rs` — line-based JSON subprocess driver; `MAX_LINE` = 16 KiB (16:16); spawn loop 97–277; exit/cleanup 214–266; call-uncertainty handling 341–381. [Verified]
  - `linux.rs` — containment (§8). [Verified]
  - Engine files: `codex.rs`, `pi.rs`, `cursor.rs` (shared ACP base), `cursor_print.rs`, `claude.rs` (+ `claude_auth.rs`, `claude_login.rs`, `claude_skills.rs`, `claude_version.rs`), `fx.rs`, `opencode.rs`, `hermes.rs`, `devin.rs`; plus `auth.rs`, `command_guard.rs`, `files.rs`, `terminal.rs`. [Verified]
- `src/workspace/` — `mod.rs` (workspace lifecycle), `files.rs` (file operations), `storage.rs` (disk `Policy` 15–67; hysteresis 75–101/149–168; `FRESH=5s` 213). [Verified]
- `src/observability/` — `mod.rs` (diagnostics pipeline), `metrics.rs`, `system.rs`, `tests.rs`. [Verified]
- Structural pattern: **every mutation flows through `session::Manager`**; runtime adapters never write journal records themselves; the API is a thin shell. One serialization point owns all durability guarantees. This is the single most transferable design property of the repo. [Verified by call structure]
- Dependency direction looks one-way: `api → session → runtime → workspace`; `runtime` does not call back into `api`, and observability reads from all without owning state. No import cycles were observed among top-level modules. [Inferred from call structure]

## 4. Session lifecycle

- States visible in replay logic (state.rs): `pending`, `starting`, `resuming`, `starting_turn`, `running`, `interrupting`, `closing`, `idle`, `sleeping`, `suspended`, `rewinding`, `closed`, `failed`, `process_lost`, `waiting_for_files`, `saved_history_only`. [Verified]
  - `waiting_for_files` is only checked/replayed in this snapshot — **no producer exists here**; vestigial or private-product-only. Flagged again in §13.
  - `saved_history_only` is synthesized for local-only history (`history.rs:263`), i.e. a session that exists but has no live handle.
- `Manager::open` (302–434): rebuilds in-memory state from `snapshot.json` + journal replay; classifies crash outcomes (§6); emits the boot sweep via `restore_all`. [Verified]
- Start path: `start` (654–826) validates the request (auth/feature/capability), writes the receipt, then `launch` (828–944) spawns or re-attaches the engine, moving `starting/resuming → starting_turn → running`. [Verified]
- Input path: `command` (965–1351):
  1. verify `request_id` (idempotency, §5);
  2. check per-engine capabilities (`session.capabilities[cmd] == false` ⇒ 409 conflict);
  3. write acceptance+queue as **one** fsynced receipt record;
  4. hand off to `deliver` (1384–1437).
  - `deliver` failure classification: `InvalidInput → failed`; any other error → `unknown` (1402–1406). [Verified]
- Event path: `advance` (1631–1672) consumes engine output, detects turn end, schedules next dispatch/transition; the thread goes idle when the turn completes with no queued work. [Verified]
- Turn model: one active turn per session; queued commands drain sequentially, each turn launched by `advance` when the previous one ends. There is no parallel turn execution inside a session — parallelism lives at the session/thread layer (`thread.rs`). [Verified for sequencing; Inferred for the thread-layer split]
- Native identity: `record_native` (1954–2219) persists the engine's own session/thread ids so any restart reattaches the **same** native rollout instead of starting fresh. Unexpected exit handling: the lost turn settles as `unknown` when stopping/closing, else `unknown_after_restart` (2168–2179); pending interrupts settle as `unknown_after_restart` (2181–2182). [Verified]
- Recovery paths:
  - `restore_all` (1727–1755) — boot-time sweep; `restores_awake` re-launches only sessions with recent/work meaning, not everything.
  - `relaunch` (1779–1952) — resume/retry machinery.
  - Explicit `POST /v1/sessions/{id}/resume` — operator-driven retry of a failed startup with a **new** request_id.
  - `closed` is terminal: recovery never re-opens closed sessions. [Verified]
- Idle/sleep:
  - after 30 min without work (`IDLE_SLEEP_MS`), idle sessions suspend (free `opencode`-style idle semantics; see sleep.rs 130–249);
  - an explicit `sleep` command exists for the operator;
  - a background-process baseline check (workload `process_count`) keeps a session awake while child processes still run;
  - on restart, only work/recent sessions are restored awake;
  - a drain endpoint holds acceptance of new work when nothing is running. [Verified]
- Graceful shutdown: `shutdown` (2221–2270) settles unresolved work as `unknown`, drains queues, and stops accepting via `service_stopping`. [Verified]

## 5. Requests/receipts idempotency

- Every command carries a `request_id`; session ids are deterministic: `cr_{request}`. Same request id ⇒ same session, across restarts and clients. [Verified]
- Retry semantics: re-posting the same `request_id` with identical command+input returns the **same receipt**; a differing payload under the same id yields `409 request_conflict` (`api/mod.rs:552`). [Verified]
- Acceptance atomicity: acceptance and queue insertion are a **single fsynced `receipt` record** — there is no window where a command is acked but not queued. After a crash, replay either sees the whole receipt or nothing. [Verified]
- Legacy compatibility: older `enqueue` records are ignored as a no-op on replay (`state.rs:483`), i.e. the older two-record design is dead but tolerated. [Verified]
- Receipt lifecycle: `accepted → delivered →` one of `completed | interrupted | failed | unknown | unknown_after_restart`. [Verified]
  - `finish_receipt` (state.rs:164–199) forbids transitions out of `completed/interrupted/failed/unknown_after_restart`, but allows `unknown` to settle later once certainty arrives.
- Failure classification is deterministic where possible:
  - engine rejects the input (`InvalidInput`) ⇒ `failed` — safe to redo under a new id;
  - anything else (timeout, pipe loss, mid-flight death) ⇒ `unknown` — must not be blindly re-sent (mod.rs:1402–1406).
- Queue semantics across crash:
  - `startup_timeout` preserves the queue for the retry;
  - queued receipts on non-eligible sessions settle as `failed`;
  - `unknown_after_restart` requires explicit re-drive (new request id). [Verified]
- Net effect: every client-visible outcome is either a stable receipt state or an explicit uncertainty; no silent loss, no silent duplication. [Verified]
- Re-drive recipe for clients: on `unknown*` outcomes, poll/stream until settlement or resubmit with a **new** request_id after resume — the same rule the core's own tests assert. [Verified from test contracts]

## 6. Crash & uncertainty semantics

- Journal layout (under `CLOUDROOM_STATE_DIR`):
  - one file per record, `{seq:020}.record` — append-only, ordered by name;
  - `saved` and `uploading` cursors;
  - `snapshot.json` every 20,000 records (`SNAPSHOT_EVERY`, state.rs:7);
  - exclusive `lock` file for the single writer;
  - every write = temp file + fsync + rename + directory fsync (`outbox.rs:181–203`). [Verified]
- Snapshots are accelerators, not authority: `snapshot.json` fast-forwards replay and the remaining records are re-applied on top (`apply` 213–545); a stale or bad snapshot cannot corrupt state, only slow recovery. [Inferred from replay design]
- Fail-closed storage: any journal write failure flips `writable=false` and blocks **all** mutations with `JOURNAL_UNWRITABLE` = "session journal is not writable" until restart. The service degrades to reject, never to silent amnesia. [Verified]
- Crash classification on `Manager::open` (302–434):
  - resumable ⇔ `can_resume || startup_timeout || (resuming && !has_dispatched)`;
  - non-terminal, non-queued receipts ⇒ `unknown_after_restart`;
  - queued receipts on non-eligible sessions ⇒ `failed`;
  - at most **one** automatic crash recovery per session (`recovery_attempted`) — repeated crashes do not loop;
  - failed resume ⇒ `process_lost` with `startup_error ∈ {startup_timeout, empty_session, missing_history, resume_failed}`. [Verified]
- Graceful vs hard death:
  - graceful shutdown writes `unknown` for unsettled work;
  - a hard crash heals as `unknown_after_restart` on next open;
  - both mean "delivery uncertain"; the caller re-drives explicitly, which prevents duplicate side effects from optimistic retries. [Verified]
- Process driver (`runtime/process.rs`):
  - line-based JSON with a 16 KiB per-line cap (16:16); spawn loop 97–277;
  - exit/cleanup 214–266 distinguishes protocol goodbye (`clean_exit`) from collapse;
  - call-uncertainty handling 341–381: a call that was in flight when the child died is reported uncertain, never failed;
  - test `unresponsive_harness_is_not_reported_as_cleanly_closed` codifies this contract. [Verified]
- "Stuck commands fail at once instead of freezing a thread" (commit subject) — the deliver/uncertainty path above is that mechanism. [Verified via code + commit]
- PID-reuse safety:
  - boot `runtime::reconcile` kills prior workloads by workload identity/cgroup rather than bare PID;
  - tests include `test_reused_pid_never_kills_unrelated_process`. [Verified via tests; mechanism partly Inferred from linux.rs]

## 7. Engine adapters

- One trait abstracts every engine — `trait Adapter: Send` (runtime/mod.rs:281–309) with methods `encode / receive / response / respond / capture / close / clean_exit`. `enum Kind` (42–54) enumerates the 8 shipped engines: **Codex, Pi, Cursor, Claude Code, Fx, OpenCode, Hermes, Devin**. [Verified]
- The trait shape means engines exchange structured events, not raw terminal text; raw I/O and its 16 KiB line cap are owned by `process.rs`. [Verified]
- Protocol mapping:
  - Codex — its app-server JSON protocol (fixture `tests/core_fixture.py` implements it faithfully, incl. crash/no-reply/reject/late-reject/hold-resume modes);
  - Cursor + OpenCode — shared ACP base in `runtime/cursor.rs` (flavor/capabilities 20–51, open/attach 65–118, send 183–209);
  - `cursor_print.rs` — a print-mode variant of Cursor;
  - Pi — own protocol (`pi_fixture.py`), with the test guarantee that native identity exists before the first prompt and resume never creates a missing file;
  - Claude Code — its own file, with `claude_auth/login/skills/version` support modules;
  - Fx, Hermes, Devin — own files under the same trait. [Verified for file/protocol families; per-engine internals partially read]
- OpenCode specifics (most complete observable adapter):
  - runs `opencode acp`;
  - `OPENCODE_CONFIG_CONTENT` disables the question tool and autoupdate (opencode.rs:41–56);
  - resume via `session/load`, validated during start (85–113, 144–162);
  - model/effort via `session/set_config_option`;
  - effort mapping `low→minimal`, `max→xhigh`;
  - native id format: `ses_` + 26 alphanumerics;
  - sessions stored in `opencode.db` (SQLite). [Verified]
- Capability gating: per-engine capabilities via `Handle::capabilities()` / `cursor::capabilities(kind)` (631–641); a command the engine lacks (`session.capabilities[cmd] == false`) ⇒ `409` conflict, never a silent no-op. [Verified]
- Deterministic restart seams:
  - `checkpoint` (961–975);
  - command env construction (977–1004);
  - both exist so the core can relaunch harnesses with reproducible identities/env;
  - secrets stay out of agent reach: `tests/core_e2e.py:385` asserts `CLOUDROOM_DATABASE_URL` never reaches agent env. [Verified]
- Resume contract: native identity is captured (`record_native` 1954–2219) so a restart reattaches the same native rollout; test `resume_reattaches_and_continues_the_native_rollout`. [Verified]
- Uniformity: the trait boundary means new engines pay an encoding cost but inherit every lifecycle/idempotency/containment guarantee for free. This is the adapter pattern to copy. [Verified + Inferred]
- Authoring cost: a new engine implements encoding/decoding plus capability declaration; it inherits receipt semantics, containment, journaling, and shutdown handling for free. [Inferred from trait boundary]

## 8. Linux containment

- Privileged core, unprivileged agents:
  - `runtime/linux.rs` `Workload` (26–202) uses cgroup v2 (delegated root) to freeze/kill/count workloads when the policy provides `cgroup_root`;
  - fallback `Group::Marked`: each workload's processes carry inherited env `CLOUDROOM_WORKLOAD`; used when `cgroup_root: null` + `agent_sudo: true` (38–58, 189). [Verified]
- `as_agent` (306–353): `pre_exec` drops to agent uid/gid, sets `PR_SET_NO_NEW_PRIVS`, and clears ambient capabilities — the harness cannot keep privileges even if it tries. [Verified]
- Boot hygiene: `runtime::reconcile` kills all prior workloads at startup; safe across PID reuse. [Verified]
- Honest degradation: with neither cgroup nor marking available, "unprotected" mode simply waits on the PID (`wait_for_exit`) instead of pretending to isolate. [Verified]
- Pause-aware I/O (366–388): containment state (paused/frozen) is folded into agent I/O so a paused workload fails fast instead of hanging the API. [Verified]
- Disk rescue (guard.rs:184): under frozen storage, the top-writing **process group** is killed — deliberately never the harness group, protecting the control path during an emergency. [Verified]
- Requirement: the host must delegate a cgroup v2 subtree to the service (`cgroup_root` policy); the package ships `install/` units and `sandbox-start.sh` to set this up. [Verified for install artifacts; unit specifics lightly read]
- Portability note: everything here is Linux-specific; only the principle (privileged core, unprivileged contained workers, kill-by-group) transfers to Pluton on Windows/macOS. [Inferred]

## 9. Storage & observability

- Disk `Policy` (workspace/storage.rs:15–67):
  - thresholds roughly `warn 5 GB / pause 2 GB / resume 2.5 GB`;
  - +1/5 hysteresis between pause and resume (75–101, 149–168) to avoid flapping;
  - measurements considered fresh for 5 s (`FRESH`, 213) before re-probing. [Verified]
- Guard loop: 1 s cadence; rescue after 30 s frozen (`RESCUE_AFTER`, guard.rs:6). [Verified]
- Uploader batching: 30 s age (`UPLOAD_AFTER`, 8), 1024 records (`UPLOAD_RECORDS`, 10), with size caps (8 MB batch, 4096 item ceiling per the uploader loop). [Verified]
- Upload ordering and idempotence:
  - `begin_upload(end)` persists intent **before** bytes leave (outbox.rs:151–158);
  - `acknowledge(id)` advances only on success (172–179);
  - retry resends the identical byte range — uploads are idempotent by construction;
  - uploads go through short-lived links;
  - a 412 mismatch triggers record-by-record compare; a real mismatch is a permanent conflict and the record is **never** acked (never silently dropped). [Verified]
- History transport: HTTPS gzip JSONL (history.rs:1–3, 119–218); machines without an account can set `CLOUDROOM_LOCAL_HISTORY=1` to keep history local (and surface `saved_history_only` sessions). [Verified]
- Diagnostics:
  - `diagnostics.jsonl` with ~8 MiB rotation, mode 0600, 1024-entry queue, 5-minute upload cadence, best-effort semantics;
  - protected stderr capture: 16 KiB/process, 32-capture queue, 1 MiB files mode 0600 under `harness-diagnostics/`. [Verified]
- Guarantee split: journal records and receipts are fsync-guaranteed; diagnostics and stderr captures are explicitly best-effort; history uploads are durable but asynchronous (ordered, resumable). [Verified for the categories; "non-blocking" Inferred]
- Signal taxonomy (enum names): `Api, AgentStart, AgentExit, HistoryUpload, HistoryFault, StorageStale, AuthHealth, Resources, ComputerUse, Diagnostics` — observability events are a first-class contract, not freeform log strings. [Verified]

## 10. API surface

- Async command model: `POST` command → `202 {session_id, receipt, saving}`; clients poll/stream for settlement. [Verified]
- Limits: 64 KiB request body limit. [Verified]
- Auth: bearer token or `x-cloudroom-token`, compared in constant time (api/mod.rs:470–508). [Verified]
- Streaming: `GET .../stream` (SSE) with `Last-Event-ID` replay, so a reconnecting CLI does not miss events. [Verified]
- Error codes are mapped centrally (510–572) from internal error strings to stable client codes, including `request_conflict`, `storage_blocked`, `service_stopping`, `harness_not_configured`, and the auth codes. Clients switch on these strings, not on HTTP body text. [Verified]
- Feature/capability negotiation: `FEATURES` (lib.rs:19–59) combined with per-harness capabilities; an absent flag ⇒ explicit "unsupported" (§7), which keeps clients from guessing what a machine can do. [Verified]
- The shipped TypeScript client `integrations/bb/client.ts` mirrors this surface (receipts, stream, retries) and is a ready reference for how consumers were expected to call the core. [Verified]

## 11. The repo's own ADRs

- `adr/` contains exactly one ADR: `0001-accept-privileged-core-service.md` — accepts shipping one privileged core service (isolation via cgroups/containment, single writer for state) and rejects per-agent sandboxes run by callers. [Verified]
- Code and docs reference ADR numbers up to ≥0237, but only 0001 is present ⇒ the public ADR set is a tiny sliver (~0.4%) of the original. Many design decisions are unreproducible from this snapshot. [Verified]
- Consequence visible in code, consistent with ADR-0001's threat model:
  - no privileged env reaches agents;
  - workloads are contained/killed by group, not by trust;
  - the harness is never trusted with coordination state. [Inferred from §8 evidence]

## 12. Tests

- Rust integration suites: `tests/runtime.rs`, `tests/adapters.rs`, `tests/journal.rs`, `tests/storage.rs`, `tests/terminal.rs`. [Verified]
- Python fixtures implement *real* protocols, not mocks:
  - `tests/core_fixture.py` — Codex app-server with modes: crash, no-reply, reject, late-reject, hold-resume;
  - `tests/pi_fixture.py` — Pi protocol;
  - `tests/fake_api.py` — fake website, incl. `down` outage mode to test upload/backpressure behavior. [Verified]
- Strongest named tests (behavioral contracts worth copying):
  - `resume_reattaches_and_continues_the_native_rollout`
  - `unresponsive_harness_is_not_reported_as_cleanly_closed`
  - `shutdown_cancels_pending_commands_as_uncertain`
  - `pending_records_and_acknowledgements_survive_restart`
  - `gaps_and_uncertain_writes_fail_closed`
  - `journal_survives_killed_writer`
  - `both_harnesses_obey_request_and_shutdown_contract`
  - `pi_native_identity_exists_before_first_prompt_and_resume_never_creates_missing_file`. [Verified]
- Python recovery classes:
  - `test_agent_crash_recovers_once_and_failed_resume_settles_queue`
  - `test_repeated_crash_does_not_loop`
  - `test_reused_pid_never_kills_unrelated_process`. [Verified]
- CI (`.github/workflows/ci.yml`): `cargo fmt` check, `clippy -D warnings`, full `cargo test`, Python fixture runs, plus disposable storage/Postgres checks. [Verified]
- Pattern to copy: protocol-accurate fixtures whose state machines can stall, reject late, or die mid-turn — uncertainty is tested as a first-class outcome, not an edge case. [Verified]
- Fixtures are mode-driven, letting tests assert exact receipt states (`delivered` / `failed` / `unknown`) after each injected failure — the receipt state machine is itself under test. [Verified from test names + fixture modes]

## 13. Applicability to Pluton

Adapt (3):

1. **Receipts as the unit of dispatch.**
   - One fsynced record = accepted+queued; stable `request_id`; identical retry ⇒ same receipt; conflicting payload ⇒ hard conflict.
   - Pluton's task/subagent dispatch should adopt this shape (per-task receipt with explicit terminal vs uncertain states), because long-running agents make retries inevitable and dedupe must be structural, not best-effort. [Verified pattern]
2. **Fail-closed uncertainty semantics.**
   - Distinguish `failed` (deterministic rejection — safe under new id) from `unknown` / `unknown_after_restart` (never blind-resend); explicit resume with fresh request id; at most one automatic recovery, then stop, to avoid crash loops.
   - Pluton's LLM/tool calls are ambiguity-prone in exactly the same way; encoding these states in the task machine prevents duplicate side effects. [Verified pattern]
3. **Journal-first durability, idempotent cursors, fail-closed writes.**
   - fsync-before-ack; single-writer lock; snapshot every N records; persistence of upload intent before send so retries resend identical bytes; write failure ⇒ stop mutating.
   - Pluton does not need to hand-roll this (`outbox.rs` is ~200 dense lines of subtle code); it needs the *semantics*. WAL-mode SQLite or an append-only event log can provide them cheaply. [Verified pattern; storage-choice Inferred as simpler for Pluton]

Avoid (3):

1. **Doc/repo drift.**
   - README claims Postgres history & 4 harnesses; code ships HTTPS JSONL & 8 harnesses; `docs/database` is dead weight here; ADR references point to 0237 with 1 shipped.
   - Pluton must single-source its docs (generate from code or maintain a normative spec), or every downstream reader pays this tax — the same tax this report had to pay line by line. [Verified divergence]
2. **Re-creating a bespoke durable journal.**
   - The full machinery (outbox + guard + sleep + rescue + pause-aware I/O) is justified only because the service is privileged, offline-first, and stores bytes it cannot afford to lose twice.
   - Copying the mechanism instead of the semantics would buy bugs without guarantees. Use mature storage primitives; keep the invariants as tests. [Inferred]
3. **Vestigial states and unshippable promises.**
   - `waiting_for_files` has no producer in this snapshot; `rewinding`/`suspended` exist for private features; states with dead producers make conformance testing impossible.
   - Publish a minimal state set where every state has a real producer and a defined exit. [Verified + Inferred]

Other transferables:

- Capability negotiation via a feature list + per-engine capability map, with "unsupported ⇒ explicit conflict".
- Deterministic session ids (`cr_{request}`) as a cheap idempotency key for sessions.
- SSE with `Last-Event-ID` for CLI streaming (matches Pluton's CLI-first posture).
- The TS client in `integrations/bb/` as a reference for Pluton's SDK surface.
- Containment ideas (§8) are Linux-specific; treat ADR-0001's principle (privileged core, unprivileged workers) as the portable part. [Verified for cited items; portability Inferred]
- The stable error taxonomy (`request_conflict`, `storage_blocked`, `service_stopping`, `harness_not_configured`) maps directly onto Pluton CLI exit/error codes. [Verified pattern]

License finding: Apache-2.0 permits reuse and adaptation **with attribution** — any code copied into Pluton must retain the license text/notices, and modified files must be marked as changed. [Verified]

## 14. Coverage gaps

- Not inspected in depth (file existence confirmed only): `docs/setup.md`, `docs/dashboard.md`, `docs/previews.md`; full bodies of `runtime/claude.rs`, `codex.rs`, `pi.rs`, `cursor_print.rs`; auth/login modules (`claude_auth/login`, `cursor_auth`, `pi_auth`); `terminal.rs`; `preview/mod.rs`; `session/teleport.rs`; `session/thread.rs`; `sync/*`; `mac/*`; `computer_use` internals; install scripts beyond `cloudroom.service` and `sandbox-start.sh`. [Verified gap]
- Nothing was executed: cgroup/`pre_exec` containment and all Linux-only paths are read-verified only; engine protocol behavior is cross-checked against repo fixtures, not real vendor binaries. [Verified gap]
- Private-subset black holes: ADRs 0002–0237, the control plane, the producer of `waiting_for_files`, the dashboard, and the `docs/database` migration pipeline live outside this snapshot. [Verified gap]
- Windows host limitation: macOS (`mac/*`, teleport) and Linux containment cannot be validated from this environment. [Verified gap]
- Line-level verification density: every section carries at least one [Verified] anchor tied to a path + line range; §§7–9 are the densest because engine/containment/storage code was read function-by-function. [Method note]
- Two doc statements remain [Unknown] rather than disproven:
  - whether the `hosts` README's "no account needed" ever held (core requires `CLOUDROOM_API_URL` unless `CLOUDROOM_LOCAL_HISTORY=1`);
  - whether the README's Postgres claim described an older architecture or the private side. [Unknown]

— End of report. Method: read-only source/docs study; labels per §2. Snapshot: `cloudroom 0.1.58 @ 3949daae` (Oct 14, 2026).
