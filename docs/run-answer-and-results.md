# Run answers and worker results — durable data contract

Live defect fixed 2026-10-21: runs stayed non-terminal after their supervisor died, the run's
final answer was stored as engine metadata (`stopReason: end_turn`) instead of the actual
answer, and worker results were metadata-only char counts with no retrievable content.

## `runs.final_summary` (column `final_summary`)

Persisted with the terminal/verifying transition according to terminal state:

| Run terminal state | `final_summary` holds |
|---|---|
| `completed` | The manager's own streamed answer text (bounded, see below). NULL when the manager streamed no text — an empty answer is honest; never the `stopReason` metadata string. |
| `verifying` | Same answer semantics (the answer exists; verification only decides the verdict). `pluton verify` completing a run keeps an existing answer and only falls back to `N/N tasks verified` when none was ever produced. |
| `failed` (manager crashed) | The manager error first (`errorSummary`), then the manager's streamed explanation, then the engine result summary. |
| `failed` (workers failed) and `cancelled`/`uncertain` | The manager's own streamed explanation (real content — e.g. its narration of what failed), then the manager error, then the engine result summary (metadata) only when nothing better exists — engine metadata must never substitute for available content. |
| start failure / background crash | `supervised start failed: <reason>` or `run crashed before completion: <reason>` (see settlement below). |

Bounded at `MAX_RESULT_TEXT_CHARS = 50_000` in `src/orchestrator/supervisor.ts` (exported;
bound applies at stream time, so persisted values never exceed it). The engine's streamed
`stopReason` is recorded as METADATA in the `run.finished` event payload (`stopReason` key,
plus `answerTruncated: true` when the answer was cut), never as the answer itself.

## Secret redaction on prose (prompt §2.7, at rest)

`redactProseSecrets` (`src/util/redact.ts`) trims high-confidence credential shapes from
free prose before persistence: model-style `sk-…` tokens, `bearer <token>` values, and
`api[_-]?key|password|token|secret: value` assignments (the same pattern set the SPA applies
at display time). Applied where prose enters durable surfaces:

- every prompt's retained answer/result body in `runPrompt` (one choke point for the
  manager answer and all worker result texts); char counts stay raw;
- `settleRunCrashed` final summaries and their `run.finished` `error` payloads;
- the immediate `run_state` frame broadcast by the API route's `failRun`.

`redactDeep` (key-based) already guards structured event payloads. Banked prose in SSE
frames (`run_state` summary/error derived from persisted rows) inherits the at-rest
redaction from the same values; the log-watcher additionally documents its loopback-only
frame policy in place.

## Task results (`tasks.result_json` / `failure_json`)

Schema is additive over the pre-fix record; stored JSON keys:

```
summary        engine result summary (stopReason-style metadata)
outcome        success | failure | cancelled | unknown
engine         adapter kind
textChars      TOTAL streamed assistant text chars (never capped)
text           bounded answer body (≤ MAX_RESULT_TEXT_CHARS chars; absent in pre-fix rows)
textTruncated  true when text streamed beyond the persisted bound
error          prompt error code (only on failures)
```

Retrieval surfaces: `task.get_result` (MCP), run-detail REST (`/api/runs/:id` → `tasks[].result`),
the inspector DAG cards, and the `worker.completed` / `worker.report` SSE events (which carry a
smaller bound, 8k, of the persisted text).

## Right-sized settlement of runs the supervisor never finished

- `POST /api/runs/:id/start` rejections and background-driver rejections (operator-bridge
  `run.start`) settle the row via `settleRunCrashed` (`src/cli/commands/run.ts`): durable
  `failed` row + `run.finished` event (`via: start_failure | background_crash`), terminal-safe
  and idempotent. The CLI chat settles the same way and adds a transcript line; the server route
  adds an immediate `run_state` frame.
- `resumeRun`-style live instances whose row is FAILED → HTTP 409 (`POST /start` may not
  rewrite terminal rows) — Resume applies to non-terminal rows only.

## Stranded-run observability (`supervisorStale`)

`GET /api/runs/:id` returns `supervisorStale: boolean` — true for a non-terminal run whose
supervisor heartbeat is older than `2 × DEFAULT_OWNERSHIP_TTL_MS` (~180 s), or absent after the
run has started. A live supervisor renews every TTL/3 even during long engine prompts, so a
stale heartbeat is durable evidence of driver death — the flag never writes state; recovery is
the operator's explicit Resume (`POST /api/runs/:id/resume`). Recovery and the SPA rendering
live in the UI uncommitted work streams referencing `src/server/static-assets.ts` and
`src/server/log-watcher.ts`.

## Test anchors

- `tests/integration/supervisor.test.ts` → "answer and result persistence" (worker text
  persisted exactly, truncation flags, manager answer → finalSummary, empty-success NULL,
  event metadata, lifecycle-event text), partial-failure policy (failed task keeps durable
  failure body beside a successful sibling; manager explanation wins over engine
  metadata), synthesis failure after workers completed (run fails honestly, worker
  results preserved), fresh-handle restart persistence (reopen the same sqlite file and
  re-read answer/results), pre-fix record compatibility (rows without text keys still
  read back), and at-rest prose redaction.
- `tests/unit/background-run-settle.test.ts` → crash settlement rule (honest fail + event,
  idempotence, competing owner, unknown run).
- `tests/unit/operator-bridge-settlement.test.ts` → the REAL `ApiRouter.watchBackgroundRun`
  seam the operator bridge drives (settle on rejection, preserve terminal outcomes,
  duplicate watchers, pre-attached rejections, credential-shaped crash messages redacted).
- `tests/unit/redact-prose.test.ts` → the prose redaction pattern set itself.
- `tests/integration/spa-ui.test.ts` → `supervisorStale` API semantics + start-failure settle.
