# ADR-0017 — Session Log Query and Cursor Replay

- Status: Accepted (2026-10-25)
- Deciders: Core Architecture Team
- References: ADR-0002 (SQLite Driver & Migrations), ADR-0006 (Task Persistence & Idempotency), ADR-0016 (Static Composition)

## Context

PLUTON persists every observable action as an append-only `events` row with a global monotonic `seq`
(SQLite rowid). Before this decision there was no supported way to read that log:

- `status --run` read the first 1000 project events and filtered by run in memory, so a busy project
  could push a run entirely out of the window and the view would silently show "no recent events";
- the SPA recovered chat transcripts from their own table, but there was no operator/SDK surface for
  "what happened after sequence N", with filters;
- the reference implementation streams with SSE generations plus a `Last-Event-ID` replay window
  (`$events`, atomic window replacement, gap repair). Copying that would add a server-side replay
  buffer and a second source of truth beside SQLite.

The roadmap (P2) asked for a query surface, a replay contract, and reuse by `status --run`. The
question recorded as O1 was whether PLUTON should grow a streaming replay protocol instead.

## Decision

**The durable SQLite log is the replay source of truth. Expose it as a cursor-paginated query, and
keep SSE as a live tail.**

1. **Cursor contract.** `queryEvents(store, { projectId, afterSeq, runId?, taskId?, shipId?, types?,
   since?, until?, limit? })` returns one ascending page plus:
   - `nextAfter` — the last returned `seq` (pass it back as `afterSeq`; it is the `Last-Event-ID`
     equivalent);
   - `hasMore` — computed by fetching `limit + 1` rows, never by a second `COUNT`;
   - `headSeq` — the newest **matching** seq, independent of the page window;
   - `limit` — the effective bounded page size.
   Filters are applied in SQL **before** `LIMIT`; another run's traffic can never crowd matching
   rows out of a page. `afterSeq` is exclusive; pages are strictly ascending, so a client that
   reconnects with the last seq sees each subsequent event exactly once. Rows appended between
   pages are returned on the next page.
2. **CLI surface.** `pluton logs [run]` (alias `log`) exposes the contract:
   `--run`, `--after`, `--limit`, repeatable `--type`, `--task`, `--ship`, `--since`, `--until`, and
   the global `--json`. JSON data is `{ runId, events, nextAfter, hasMore, limit, headSeq }`. Human
   output is one sanitized line per event plus a `cursor #N … head #N … limit N` footer.
3. **`status --run` uses the same reader.** The run tail comes from `recentEvents()` (same filters,
   `ORDER BY seq DESC LIMIT n`, returned oldest-first), removing the silent 1000-event cap.
4. **SSE stays a live tail.** `GET /api/events` continues to start at `latestEventSeq` and stream
   only new events with heartbeats. It does **not** gain generations, history replay, or a server
   buffer. A client that needs history reads the durable log (SPA transcript replay today;
   `pluton logs --json` for operators/SDKs), then resumes the live stream.
5. **No schema change and no full-text search.** The existing `events(run_id, seq)` index plus the
   rowid ordering serve these queries; no migration was added. FTS search (CG-8) remains open and
   requires its own demonstrated need and ADR, not an opportunistic index.

## Contract examples

```text
# first page (oldest first)
pluton logs --limit 100 --json
→ { events: [...], nextAfter: 1234, hasMore: true, headSeq: 1290, limit: 100 }

# continue from the cursor; repeat until hasMore === false
pluton logs --after 1234 --limit 100 --json
→ { events: [...], nextAfter: 1290, hasMore: false, headSeq: 1290, limit: 100 }

# one run, only approval events, since a timestamp
pluton logs run_abc123 --type approval.requested --type approval.decided --since 2026-10-24T00:00:00Z
```

Validation is typed: negative/fractional cursors, out-of-range limits, empty type filters, malformed
or inverted timestamps, and `since > until` are `validation_failed` with a non-zero exit; an unknown
run is `not_found`. A conflicting positional and `--run` reference is `validation_failed`.

## Consequences

### Positive

- One replay contract for the CLI, `status`, the SPA recovery path, and any future SDK; no duplicated
  window logic.
- No gap/duplicate window: the cursor is durable state, so replay survives process restarts and
  reconnects without a server-side buffer.
- No new table, index, or migration; SQLite stays the single source of truth.
- The old silent truncation defect is fixed and regression-tested with >1000 competing events.

### Negative

- A non-SQLite client cannot ask the server to replay history over SSE; it must call the query
  surface (`pluton logs --json` today, an HTTP route if one is ever needed).
- There is no full-text search over event payloads; filters are exact-match on ids/type plus time
  bounds. That is deliberate until a real query need appears.
- Clients must loop on the cursor themselves; the API does not stream an unbounded result set.

### Neutral

- `limit` is bounded at 1000 and defaults to 50 so a single page stays printable and transportable.
- `recentEvents()` is the "newest N" counterpart for inspector views; it shares normalization and
  filtering with the page query, so the two cannot drift.
