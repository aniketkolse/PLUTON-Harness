import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { InternalError } from '../domain/errors.ts'
import { getUserVersion, type DatabaseSync as Db } from './db.ts'

/**
 * Pre-migration backup and verification.
 *
 * A migration is the one operation that can destroy years of local history, so
 * the backup is created with SQLite's own `VACUUM INTO` (a consistent snapshot,
 * including WAL contents), verified read-only, and only then is the migration
 * allowed to run. If any verification step fails, the caller aborts before
 * touching the original database.
 */

export interface BackupResult {
  path: string
  sha256: string
  bytes: number
  schemaVersion: number
  rowCounts: Record<string, number>
}

export interface BackupOptions {
  /** Path of the live database; `:memory:` skips backups. */
  dbPath: string
  /** Directory that will hold timestamped backups. */
  backupDir: string
  /** Label used in the filename, e.g. `pre-v10`. */
  label: string
  now?: () => Date
}

export function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function tableCounts(db: DatabaseSync): Record<string, number> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>
  const counts: Record<string, number> = {}
  for (const { name } of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`).get() as
      | { c: number }
      | undefined
    counts[name] = row?.c ?? 0
  }
  return counts
}

export function inspectDatabase(path: string): {
  integrity: string
  schemaVersion: number
  rowCounts: Record<string, number>
} {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined
    const integrity = integrityRow?.integrity_check ?? 'unknown'
    return {
      integrity,
      schemaVersion: getUserVersion(db),
      rowCounts: tableCounts(db),
    }
  } finally {
    db.close()
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Create and verify a pre-migration snapshot. Throws before the migration
 * starts when the source is not a file-backed database, when the snapshot is
 * corrupt, or when any table's row count differs from the source.
 */
export function createVerifiedBackup(db: Db, opts: BackupOptions): BackupResult | null {
  if (opts.dbPath === ':memory:' || !existsSync(opts.dbPath)) return null
  const sourceVersion = getUserVersion(db)
  const sourceCounts = tableCounts(db)
  mkdirSync(opts.backupDir, { recursive: true })

  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')
  const target = join(opts.backupDir, `pluton-${opts.label}-${stamp}-${basename(opts.dbPath)}`)
  if (existsSync(target)) {
    throw new InternalError(`backup target already exists: ${target}`)
  }

  db.exec(`VACUUM INTO ${quoteSqlString(target)}`)

  const inspected = inspectDatabase(target)
  if (inspected.integrity !== 'ok') {
    throw new InternalError(`pre-migration backup failed integrity_check: ${inspected.integrity}`, {
      details: { backup: target, integrity: inspected.integrity },
    })
  }
  if (inspected.schemaVersion !== sourceVersion) {
    throw new InternalError(
      `pre-migration backup schema version ${inspected.schemaVersion} does not match source ${sourceVersion}`,
      { details: { backup: target, sourceVersion, backupVersion: inspected.schemaVersion } },
    )
  }
  for (const [table, expected] of Object.entries(sourceCounts)) {
    const actual = inspected.rowCounts[table]
    if (actual !== expected) {
      throw new InternalError(
        `pre-migration backup row count mismatch for '${table}': source ${expected}, backup ${String(actual)}`,
        { details: { backup: target, table, expected, actual } },
      )
    }
  }

  const sha256 = sha256File(target)
  const bytes = statSync(target).size
  const sidecar = `${target}.sha256`
  const tmp = `${sidecar}.tmp`
  writeFileSync(tmp, `${sha256}  ${basename(target)}\n`, 'utf8')
  renameSync(tmp, sidecar)

  return { path: target, sha256, bytes, schemaVersion: sourceVersion, rowCounts: sourceCounts }
}
