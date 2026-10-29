# PLUTON 3.0 — Phase 0 gap report

**Date:** 2026-10-29
**Repository:** `main` @ `a25c3b4` (clean working tree at audit start)
**Method:** read-only inspection of the current tree plus the baseline commands below.

## Baseline

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS (exit 0) |
| `npm test` | PASS — 151 files, 1330 passed, 10 skipped (219.69 s, exit 0) |

No pre-existing failures were observed. The gap report therefore distinguishes
missing/partial behaviour only, not red baselines.

## Already implemented and verified

- **Concurrent ready-task dispatch.** `RunSupervisor.dispatchReadyTasks()` claims
  every ready task until `maxConcurrentWorkers`, runs each through a per-Ship
  `KeyedMutex`, and tracks them in `inFlight`. Dependency ordering is enforced by
  `store.listReadyTasks()` (task-graph edges), not by prompt text.
- **Durable worker lifecycle events.** `worker.created/started/progress/question/
  waiting/report/completed/failed/cancelled` are emitted by the supervisor and
  persisted by `ServerEventBroadcaster.broadcastWorkerEvent()` for server-owned
  runs.
- **Worker event SSE.** The SPA subscribes to `/api/events`, dispatches
  `worker.*` frames to `handleWorkerEvent()`, and keeps bounded per-worker logs.
- **Run detail API.** `GET /api/runs/:id` already enriches tasks with claim-time
  `role`, `model`, `shipId`, `shipDisplayName`, and `workspace`.
- **Worker inspector shell.** `rightInspector`, `rightInspectorGrid`,
  `worker-partition`, equal-height `flex: 1 1 0` layout, per-partition
  `overflow-y: auto` logs, and a `has-many-workers` overflow mode exist.
- **File leases and workspace isolation.** `FileLeaseManager`, `scope.declare` /
  `scope.release`, isolated per-task checkouts and write-scope conflict checks
  are implemented and covered by `tests/integration/multi-agent-reliability.test.ts`
  and `supervisor-ownership.test.ts`.
- **Approvals, cancellation, retries, verification.** Existing state machine,
  `task.cancel`, revision requeue (`task.request_revision`), circuit breaker,
  and verification gate are implemented.

## Partially implemented or broken

| Area | Current behaviour | Gap |
| --- | --- | --- |
| Parallel delegation guidance | Dispatch is genuinely concurrent | `buildManagerPrompt()` never tells the manager to decompose into independent scopes, assign distinct Ships, declare dependencies, or split write scopes. Parallelism is incidental, not planned. |
| Inspector population | `reconstituteWorkerPartitions()` re-adds **every** task from `/api/runs/:id`; terminal cards are never removed | Inspector is a history list, not an active-worker panel. No empty state. |
| Duplicate identity | Worker header renders `shipName` **and** a `worker-badge-role` chip; supervisor card can repeat role/name | Duplicate labels. |
| Live supervisor updates | Main chat shows only terminal run summaries; worker events render in the inspector only | No planning/delegation/completion/message activity in the conversation. |
| Status styling | `worker-badge-status` is high-contrast, `tool-spinner` is amber, `file-viewer-dirty` is amber | Requested muted treatments missing. |
| Delete-session confirmation | `plutonConfirm({danger:true})` uses the bright `.btn-danger` | Inconsistent with Cancel. |
| Worker detail | No detail view, no per-task history endpoint, no per-worker message route | Missing. |
| Worker-to-worker messaging | Only manager→worker delegation and worker→manager results (`task.get_result`). No peer tool, no recipient cursor, no message event type, no permission | Missing. |

## Missing and requiring implementation

1. **Phase 1** — manager prompt guidance for real parallel decomposition
   (distinct assignees, scopes, dependencies, write scopes, peer coordination)
   plus a two-worker overlap regression test.
2. **Phase 2** — direct worker messaging:
   - `worker.message` permission (defaults for supervisor/researcher/coder/
     tester/reviewer, plus `pluton.yaml`);
   - `ship.message` / `ship.inbox` restricted tools;
   - a `WorkerMessageBus` with per-recipient cursors, stable message IDs,
     bounded payloads/retries/timeouts, cancellation safety, and dedupe;
   - durable `worker.message` events (the event log is the history; no new
     table).
3. **Phase 3** — shared activity mapper, `run_activity` SSE frames derived from
   the durable log, `GET /api/runs/:id/activity?afterSeq=`, and SPA rendering
   with `seq` dedupe and reconnect recovery.
4. **Phase 4** — authoritative active-only inspector filter, card removal on
   terminal events, quiet empty state, preserved in-memory history.
5. **Phase 5** — worker detail view (authoritative detail endpoint + modal),
   operator→worker message route, close-without-cancel behaviour.
6. **Phase 6** — muted RUNNING/COMPLETED labels, grey spinner, grey UNSAVED,
   quiet Delete Session, and duplicate-label removal.

## Known constraints discovered

- `log-watcher` tails from the current latest `seq`; a reconnecting SPA must
  recover missed activity through the REST endpoint, not replay.
- The embedded SPA is a single template-literal file
  (`src/server/static-assets.ts`); existing `tests/integration/spa-ui.test.ts`
  asserts exact CSS/JS strings, so edits must keep those contracts.
- Engine sessions cannot receive injected text mid-turn. Worker messages are
  therefore **pull-based** (`ship.inbox`) and delivered at the recipient's next
  tool call; this is a real runtime capability, not a simulated chat.
- The mock engine is development-only; live engine verification requires
  credentials and is reported separately.

---

# Implementation status (PLUTON 3.0)

**Date:** 2026-10-30
**State:** all six phases implemented; no fabricated progress, no second
scheduler/event system/message store.

## Phase status

| Phase | Status | What shipped |
| --- | --- | --- |
| 1 — parallel delegation | Implemented | `buildManagerPrompt()` now requires independent scopes, distinct assignees, explicit dependencies/write scopes, and names `ship.message`/`ship.inbox`. `buildTaskPrompt()` explains peer coordination. Tests cover concurrent dispatch and manager messaging. |
| 2 — worker messaging | Implemented | `worker.message` permission default for supervisor/researcher/coder/tester/reviewer; `ship.message`/`ship.inbox` tools; `WorkerMessageBus`; durable `worker.message` events + `worker.message.delivered` acks. |
| 3 — live Supervisor progress | Implemented | `ActivityMapper`/`buildRunActivity`; `run_activity` SSE frames from the log watcher; `GET /api/runs/:id/activity?afterSeq=` (and `tail=1`); SPA activity rows deduped by durable `seq`, reconnect resume, transcript-reset tail rebuild. |
| 4 — active-only inspector | Implemented | `ACTIVE_WORKER_STATES` + `syncWorkerPartition`; terminal events remove cards without deleting state/logs/history; quiet empty state; `N active workers`; duplicate role chip removed. |
| 5 — worker detail | Implemented | `buildTaskDetail` + `GET /api/runs/:id/tasks/:taskId/detail`; operator message route; modal with real task/brief/criteria/state/progress/tool calls/files/messages/Supervisor communication/errors/retries/verification/output; close/Esc/backdrop never cancels. |
| 6 — muted UI | Implemented | Muted `.worker-badge-status.is-running/.is-completed`, grey spinner, grey `UNSAVED`, quiet Delete Session; one identity per worker card; equal-height flex cards and independent scrolling retained. |

## Messaging semantics (honest limitation)

Delivery is **pull-based**. An engine turn cannot be injected with text from
outside, so `ship.message` persists a durable event and `ship.inbox` delivers it
at the recipient's next tool call (bounded 1 s wait slices, abortable). History
is the event log; the `worker.message.delivered` event is the at-most-once ack.
There is no in-turn push delivery and no second message database.

## Verification evidence

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS (exit 0) |
| `npm test` | PASS — 152 files, 1344 passed, 10 skipped |
| `npm run check` | PASS (typecheck + full suite) |
| `npm run build` | PASS |
| `npm run test:e2e` | PASS — 1 file, 1 test |

Focused runs used during development: `spa-ui`, `server-api`, `supervisor`,
`worker-messages`, `server-log-watcher` (all green). `bare-entry` requires a
fresh `npm run build` because `bin/pluton.js` loads `dist`.

Visual verification against a seeded durable active run (real store rows,
events, and a git checkout; removed after the check):

- Inspector showed exactly `3 active workers`; the terminal task was excluded.
- Cards were equal height (172 px each), one name per card, status labels muted
  `rgb(161,161,170)` and uppercased.
- Activity rows rendered sender once (`actor` label) and `→ recipient: verb` in
  the text; a live `worker.message` appended by another process appeared through
  SSE without reload.
- Detail modal rendered the real task, criteria, progress, tool calls, messages,
  retries, verification, and output; closing left the task `running` and the
  card in place.
- Operator message persisted exactly once (`worker.message`, `kind:
  instruction`, correct task/ship addressing) and the modal composer sent it.
- Defect found and fixed during visual review: the modal composer input used
  browser-default white styling; it now uses `--bg-inset`/`--border` tokens and
  a regression assertion was added to `spa-ui.test.ts`.

## Deliberately not done

- No live OpenCode credential/run scenario was executed; verification used the
  deterministic mock engine and seeded durable records.
- No second UI surface was added: all progress is the existing conversation +
  inspector + modal, fed by durable events.

