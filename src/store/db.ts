import { DatabaseSync } from 'node:sqlite'

export type { DatabaseSync }

/**
 * Single place that opens SQLite databases. Every connection gets the same
 * pragmas; transaction helpers are explicit (BEGIN IMMEDIATE / COMMIT /
 * ROLLBACK) so a crash can never leave a half-applied write: either the whole
 * receipt+state+event batch is on disk, or none of it (prompt §5 durability).
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  // WAL: readers don't block the writer; fsync'd on commit by SQLite itself.
  db.exec('PRAGMA journal_mode = WAL')
  // Foreign keys are enforced for every connection (SQLite defaults them OFF).
  db.exec('PRAGMA foreign_keys = ON')
  // Fail with a busy error after 5s instead of throwing immediately under contention.
  db.exec('PRAGMA busy_timeout = 5000')
  // NORMAL is the recommended durability/throughput point for WAL mode.
  db.exec('PRAGMA synchronous = NORMAL')
  return db
}

export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // A rollback failure means the transaction already ended; the original error is what matters.
    }
    throw e
  }
}

export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get()
  const v = row?.['user_version']
  return typeof v === 'number' ? v : 0
}

/** PRAGMA does not accept bound parameters; the value is a compile-time literal. */
export function setUserVersion(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new TypeError(`setUserVersion: invalid version ${version}`)
  }
  db.exec(`PRAGMA user_version = ${version}`)
}
