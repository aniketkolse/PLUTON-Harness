# ADR-0002 — SQLite driver and migration strategy

- Status: Accepted (2026-10-16)

## Context

The runtime needs durable, transactional, queryable state (runs, tasks, dependencies, receipts,
events, approvals, verification) in a local-first product. PostgreSQL or hosted databases are
explicit non-goals. Node 24 is the chosen runtime (ADR-0001).

## Decision

- **Driver:** Node's built-in `node:sqlite` (`DatabaseSync` / `StatementSync`). No third-party
  SQLite dependency.
- **Database file:** `<project>/.pluton/state/pluton.sqlite` (excluded from version control).
- **Pragmas:** WAL journal mode, `foreign_keys=ON`, fixed `busy_timeout`; single writer process
  (the daemon) per project database.
- **Transactions:** every state transition writes state **and** its event/receipt updates inside
  one `IMMEDIATE` transaction through the store layer. No module mutates tables directly.
- **Migrations:** forward-only, numbered, TypeScript modules under
  `src/persistence/migrations/` registered in code; applied at open time, recorded in a
  `schema_migrations(version, name, applied_at)` table. An unknown-newer schema version refuses
  to open with migration guidance (mirrors the config version policy).
- **Testing:** migration tests open an old-version fixture DB, apply migrations, and assert both
  schema and data. WAL files (`-wal`, `-shm`) are treated as part of the DB identity.

## Consequences

- Zero native modules (no `better-sqlite3` rebuild/toolchain pain on Windows).
- `node:sqlite` API surface is newer than `better-sqlite3`; we use only stable constructs
  (`prepare`, `run`, `get`, `all`, `exec`, transactions via `exec('BEGIN IMMEDIATE')` helpers).
- If a future runtime change breaks `node:sqlite`, the store layer isolates the swap.

## Alternatives considered

- **better-sqlite3** — needs a native toolchain/rebuild per Node version on Windows; rejected.
- **sql.js (WASM)** — awkward durability/persistence model; rejected.
- **libsql/Drizzle ORM** — extra dependency weight without need; rejected. Handwritten SQL keeps
  the durability semantics auditable.
- **JSON files** — cannot provide atomic multi-row transitions; rejected.

## Evidence

- Probe on the target host: `node -e "require('node:sqlite')"` →
  `node:sqlite AVAILABLE: DatabaseSync,StatementSync,Session,constants,backup`.
- Env: Node v24.20.0 (recon log in docs/ROADMAP.md).
