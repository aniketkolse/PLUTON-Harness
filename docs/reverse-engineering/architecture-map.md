# Architecture map — cloudroom-core, OpenMausBot, Pluton-Harness

> **Historical study (engine note 2026-10-22):** Qwen references describe the studied third-party
> projects or Pluton's pre-migration adapter. Qwen Code support was removed; those references are
> not current Pluton support or setup instructions. OpenCode is the only supported real engine.

## Purpose

One page per project showing how the pieces are arranged, what owns state transitions, where the
trust boundaries sit, and which parts of each design Pluton adopts. This is a *map*, not the
evidence: every claim here is derived from the three pinned reports in this directory
(`cloudroom-core.md` = **cc**, `openmausbot-runtime.md` = **omb-rt**,
`openmausbot-mcp-workspaces-tests-licensing.md` = **omb-mcp**) and cites their sections or the exact
anchors those reports recorded. Labels: **[Verified]** = read in shipped files by the reports,
**[Inferred]** = reasoned from code shape, **[Unknown]** = not determinable.

Snapshots: cloudroom-core `3949daaea3c7613458e9ad14afddbd267a0a56bc` (Apache-2.0) · OpenMausBot
`7d008053cbdb255c2078fbf772630e634000dce5` (Apache-2.0 except `enterprise/`, source-available) ·
Pluton-Harness as built in this repository (own work, see `docs/adr/`).

---

## 1. cloudroom-core — layered Rust service around one session manager

```
┌────────────────────────────────────────────────────────────────────────┐
│ api/  — HTTP surface                                                   │
│   POST → 202 {session_id, receipt, saving}; SSE with Last-Event-ID     │
│   stable error-code map (cc §10); typed observability taxonomy (cc §9) │
├────────────────────────────────────────────────────────────────────────┤
│ session/ — THE single serialization point (cc §3) [Verified]           │
│   Manager: one active turn per session; queued commands drain          │
│   in order ("src/session/mod.rs:1631-1672")                            │
│   state machine: receipts accepted → delivered → completed / ... /     │
│                  unknown / unknown_after_restart  (cc §5)              │
│   outbox/journal: {seq:020}.record, temp+fsync+rename+dir-fsync,       │
│                   snapshot every 20,000 records, fail-closed writes    │
│                   (JOURNAL_UNWRITABLE blocks mutations) (cc §6)        │
│   sleep.rs: idle sessions sleep after 30 min (cc §1)                   │
├────────────────────────────────────────────────────────────────────────┤
│ runtime/ — engine side                                             │
│   trait Adapter: encode/receive/response/respond/capture/close/       │
│                  clean_exit (cc §7); enum Kind = 8 engines            │
│   structured events only; terminal text is never the managed channel  │
│   linux.rs: cgroup v2 containment, uid/gid drop, no-new-privileges,   │
│              honest degradation when unavailable (cc §8)              │
├────────────────────────────────────────────────────────────────────────┤
│ storage clients / history — HTTPS gzip JSONL (code) vs PostgreSQL     │
│ (README claim) → docs drift recorded, code normative (cc §1)          │
└────────────────────────────────────────────────────────────────────────┘
```

- Ownership: **one privileged service owns all state**; engines are unprivileged children. This
  "privileged core, disposable workers" split is the core lesson (cc §8, [Inferred]).
- Durability model: hand-rolled journal + receipts; acceptance and queueing are one fsynced record
  (cc §6). Recovery: replay snapshot+journal; non-terminal work → `unknown_after_restart`; at most
  one automatic recovery per session (cc §6).
- Explicit non-goals in the public snapshot: task graphs, multi-session coordination, MCP tooling —
  those live in the private product; the report warns not to pretend otherwise (cc §14).

## 2. OpenMausBot — monolith host with a clean durable runtime underneath

```
┌───────────────────────────────────────────────────────────────────────┐
│ Electron UI / companion apps            (out of scope for Pluton)     │
├───────────────────────────────────────────────────────────────────────┤
│ server/index.ts — ~17k-line host: seats, goal runs, cards, watchdogs  │
│   (omb-rt §11 avoid 1; omb-mcp §11.2 item 3)                         │
├───────────────────────────────────────────────────────────────────────┤
│ server/runtime/ — timer-free state machine over SQLite               │
│   one synchronous tick() pass, deepest-first (omb-rt §1/§6)          │
│   Assignment tree: rootId/parentId/depth, modes, budgets, wakes      │
│   write-before-act: row + events commit BEFORE runner is invoked     │
│     (omb-rt: "server/runtime/runtime.ts:364-378")                    │
│   restart policy: cut turn rerun at most once, then failed;          │
│     outward-effect probe; downtime not charged (omb-rt §8, tree.ts:5)│
│   invariants I1–I10 checked after every scenario (omb-rt §9)         │
├───────────────────────────────────────────────────────────────────────┤
│ drivers — provider adapters (omb-rt §4)                              │
│   ProviderDriver (factory) → ProviderInstance → ProviderAdapter      │
│   approvalMode re-asserted per turn (omb-rt: contracts.ts:83-130)    │
│   capability table asserted against registry in tests (omb-rt §11.3) │
├───────────────────────────────────────────────────────────────────────┤
│ MCP gate + tools (omb-mcp §4)                                        │
│   validate policy BEFORE spawning servers (mcp-gate.ts:184-186)      │
│   scope grammar: deny-wins, parse-on-every-use, fail-closed          │
│   approvals: 5 modes, unconfirmed grant → ask, expired never allow   │
├───────────────────────────────────────────────────────────────────────┤
│ storage: runtime.db (SQLite WAL, rows re-validated by zod),         │
│   messages.db, per-thread NDJSON events; tool-result spill files      │
│   (0700 dirs / 0600 files) (omb-rt §3, omb-mcp §7)                   │
└───────────────────────────────────────────────────────────────────────┘
```

- Ownership: the **tick** owns every assignment transition; the host above it keeps UI-state
  concerns — and its own contract lists the leaks where host concerns bleed into runtime truth
  (`parkedSeats` memory-only; omb-rt §11 avoid 2).
- Trust boundaries: MCP calls re-authorized per call; model text is escaped into provenance
  envelopes (omb-rt §11 adapt 4); workspace directories are explicitly *not* a sandbox
  (omb-mcp: "server/workspace.ts:20").
- Strength to keep: a runner-agnostic runtime tested as a pure state machine with fake runner and
  fake clock (omb-rt §9) — deterministic, no timers, no network.

## 3. Cross-project structural lessons Pluton encodes

| Lesson | cloudroom | OpenMausBot | Where Pluton encodes it |
|---|---|---|---|
| One owner of state transitions | `session::Manager` (cc §3) | runtime tick (omb-rt §6) | domain state machine + store (`src/domain/state.ts`, ADR-0006) |
| Commit intent before acting | fsynced receipt record (cc §6) | write-before-act tx (omb-rt §11.1) | `withTx` + `admitRequest` (ADR-0002/0006, tests/unit/store.test.ts) |
| Structural idempotency | request_id receipts, 409 conflict (cc §5) | duplicate brief returns row (omb-rt §6) | receipts + canonical payload hash (ADR-0006, same tests) |
| Typed refusals | stable error codes (cc §10) | closed refusal vocabulary (omb-rt §6) | coded `PlutonError` taxonomy + refusal events (ADR-0007) |
| Fail-closed parsing | journal unwritable blocks writes (cc §6) | corrupt policy never pass-through (omb-mcp §4) | config refusal, path-escape rejection, newer-schema refusal (ADR-0002) |
| Capability honesty | unsupported → explicit 409 (cc §10) | capability table vs registry (omb-rt §11.3) | `EngineCapabilities` + `CapabilityError` (ADR-0003) |
| Uncertainty as a state | `unknown` / `unknown_after_restart` (cc §5) | never-ran vs may-have-run wording (omb-mcp §11.1) | `unknown_outcome` + no auto-replay (ADR-0006) |

## 4. Pluton-Harness — target architecture and current module map

```
CLI (argv in / JSON out)                      src/cli/
  │  commands: init, doctor, muse, engine, status, task, graph, version, sandbox, mcp serve,
  │            run, verify, attach, integrate, approvals (all implemented; --json everywhere)
  ▼
Supervisor (run loop; single writer)          [implemented — Phase 6]
  │  owns the run lifecycle; uses KeyedMutex per Muse  src/orchestrator/mutex.ts [implemented]
  ▼
Orchestrator                                  src/orchestrator/
  │  admitTask: budgets, graph invariants, cycles, ancestor rejection  [implemented]
  │  scheduler: listReadyTasks (dep-complete queued tasks)             [implemented]
  ▼
Engines                    Sandbox            Terminals        Workspaces
  src/engines/ (contract   [implemented]      [implemented]    [implemented]
  + mock; opencode, qwen)  Docker container   tmux per Muse    per-task checkout
  ▼
Verification / Integration                    [implemented — Phase 7]
  ▼
Durable store — ONE SQLite DB per project     src/store/  [implemented]
  db.ts (WAL, FK on, BEGIN IMMEDIATE) · migrations.ts (forward-only)
  store.ts: projects, muses, runs, tasks, edges, events, receipts, …
  .pluton/state/pluton.sqlite   (bootstrap: src/bootstrap.ts)
```

Data flow for a run (target, with current implementation coverage):

1. `pluton run "<goal>"` → `run.create` request → **receipt** written, run row created in one tx
   (**implemented** — `pluton run` is wired end to end and live-smoked).
2. Manager Muse plans (engine adapter — **implemented**) → `admitTask` per unit (**implemented**) →
   dependency edges + `task.admitted` events, budget-checked.
3. Task dispatch: checkout provisioned (**implemented**), container running (**implemented**), prompt
   sent through the engine adapter (**implemented**), events normalized and recorded
   (**store side implemented**).
4. Child completion → exactly one wake receipt for the parent (ADR-0007; **implemented**).
5. Verification checks run in the task checkout, results recorded; a run is never marked completed
   when required checks failed (ADR-0006; **implemented**).
6. Integration through a Pluton-owned checkout; conflicts stop and preserve both branches; the
   user's working tree is never touched (ADR-0005/0009; **implemented** — `pluton integrate`,
   live-verified).

Separate state axes (never compressed into one status string): **run state**, **task state**,
**engine process state**, **sandbox state** — all defined in `src/domain/state.ts` with the same
transition-table discipline; only that module defines transitions.

Trust boundaries (ADR-0004/0005/0008/0010):

- Engine processes run inside the Muse's Linux container; tmux is terminal persistence, **not** a
  security boundary; native-Windows tmux is not part of the supported path.
- Docker unavailable → fail closed with an exact fix message; the dev-only `local-process` sandbox
  requires explicit `sandbox.local_process_acknowledged: true`.
- The user's repository is read-only to Pluton; all writes go to `.pluton/` paths and Pluton-owned
  checkouts.
- Every delegation call through the tool bridge is authorized server-side per call (ADR-0007);
  engine config lives in per-Muse engine homes, never in the user's global engine config (ADR-0008).
- Secrets: presence-only auth checks, redaction before any event/log/DB write
  (`src/util/redact.ts`), env allowlist per process.

## 5. Status snapshot (updated 2026-10-17, commit 19f8f19)

| Area | Status | Evidence |
|---|---|---|
| CLI skeleton + JSON discipline | Implemented | `src/cli/`, integration tests spawn `bin/pluton.js` |
| Domain state machines (run/task) | Implemented + tested | `src/domain/state.ts`, `tests/unit/domain.test.ts` |
| Config validation | Implemented + tested | `src/config/`, `tests/unit/config.test.ts` |
| Durable store + migrations | Implemented + tested | `src/store/`, `tests/unit/store.test.ts` |
| Idempotent receipts | Implemented + tested | duplicate/conflict/rollback/reopen tests |
| Task-graph admission + budgets | Implemented + tested | `src/orchestrator/task-graph.ts` |
| Per-Muse serialization | Implemented + tested | `src/orchestrator/mutex.ts`, supervisor serialization test |
| Engine adapters (real) | Implemented + live-verified | OpenCode 3/3 + Qwen 4/4 (`npm run test:live`) |
| Sandbox / tmux / checkouts | Implemented + live-verified | Docker E2E 5/5; container-mode run PASS 2026-10-17 |
| Manager flow / tool bridge | Implemented + live-verified | `src/tools/`, supervisor tests + host/container live smokes |
| Verification / integration | Implemented + live-verified | `pluton verify`; `pluton integrate` live PASS 2026-10-17 |
| Attach / approvals | Implemented + live-verified | `pluton attach` (argv + session ensure live); `pluton approvals` list/approve/deny + expiry sweep live |
| Machine event streaming | Open (no decision) | see `implementation-decisions.md` O1 |

Test evidence for the claims above: `npm run check` (tsc + vitest) green with 37 files / 492 tests on
2026-10-17; Docker-dependent suites ran live on this host (`PLUTON_E2E_DOCKER=1 npm run test:e2e`
5/5) and the live smokes are recorded in `docs/smoke-live-run.md`.

## 6. Keeping this map honest

- Status rows move only when a test or command output proves them (README "NOT RUN" convention).
- Architectural decisions that change this map must land as an ADR *before* the code, and the map's
  module boxes must keep pointing at real paths in `src/`.
- The three reference reports remain the evidence of record; this file may be re-derived from them
  at any time without touching the read-only checkouts under `references/`.
