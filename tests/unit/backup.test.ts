import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createVerifiedBackup, inspectDatabase } from '../../src/store/backup.ts'
import { openDatabase, setUserVersion } from '../../src/store/db.ts'
import { MIGRATIONS, migrate, migrateWithBackup, SCHEMA_VERSION } from '../../src/store/migrations.ts'

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

function tmpDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pluton-backup-${name}-`))
  tmpDirs.push(dir)
  return dir
}

function openTracked(path: string): DatabaseSync {
  const db = openDatabase(path)
  openDbs.push(db)
  return db
}

function buildV9(path: string): DatabaseSync {
  const db = openTracked(path)
  for (const migration of MIGRATIONS) {
    if (migration.version > 9) continue
    for (const sql of migration.statements) db.exec(sql)
  }
  setUserVersion(db, 9)
  const ts = '2024-01-01T00:00:00.000Z'
  db.prepare(
    `INSERT INTO projects (id, name, root_path, config_path, default_branch, created_at, updated_at)
     VALUES ('project_backup', 'backup', '/backup', '/backup/pluton.yaml', 'main', ?, ?)`,
  ).run(ts, ts)
  db.prepare(
    `INSERT INTO sandboxes (id, project_id, ship_id, kind, container_name, container_id, image, state,
                            created_by, created_at, updated_at)
     VALUES ('sb_legacy', 'project_backup', 'worker-a', 'docker', 'c', 'cid', 'img', 'running', 'run', ?, ?)`,
  ).run(ts, ts)
  db.prepare(
    `INSERT INTO terminals (id, project_id, ship_id, sandbox_id, tmux_session_name, state, created_at, updated_at)
     VALUES ('tm_legacy', 'project_backup', 'worker-a', 'sb_legacy', 'sess', 'present', ?, ?)`,
  ).run(ts, ts)
  return db
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('pre-migration backup', () => {
  it('creates a verified snapshot with matching schema version and row counts', () => {
    const dir = tmpDir('verified')
    const dbPath = join(dir, 'pluton.sqlite')
    const db = buildV9(dbPath)
    const backupDir = join(dir, 'backups')

    const result = createVerifiedBackup(db, { dbPath, backupDir, label: 'pre-v10' })
    expect(result).not.toBeNull()
    expect(existsSync(result!.path)).toBe(true)
    expect(result!.schemaVersion).toBe(9)
    expect(result!.bytes).toBeGreaterThan(0)
    expect(result!.rowCounts['sandboxes']).toBe(1)
    expect(result!.rowCounts['terminals']).toBe(1)

    const inspected = inspectDatabase(result!.path)
    expect(inspected.integrity).toBe('ok')
    expect(inspected.schemaVersion).toBe(9)
    expect(inspected.rowCounts).toEqual(result!.rowCounts)

    const sidecar = readFileSync(`${result!.path}.sha256`, 'utf8').trim()
    const actual = createHash('sha256').update(readFileSync(result!.path)).digest('hex')
    expect(sidecar).toBe(`${actual}  ${result!.path.split(/[\\/]/).pop()}`)

    // Inspect the snapshot without switching it to WAL, so its bytes keep
    // matching the sidecar hash written at creation time.
    const snapshot = new DatabaseSync(result!.path, { readOnly: true })
    try {
      const sandbox = snapshot.prepare(`SELECT id, kind FROM sandboxes`).get() as Record<string, unknown>
      expect(sandbox['id']).toBe('sb_legacy')
      expect(sandbox['kind']).toBe('docker')
      const terminal = snapshot.prepare(`SELECT sandbox_id FROM terminals`).get() as Record<string, unknown>
      expect(terminal['sandbox_id']).toBe('sb_legacy')
    } finally {
      snapshot.close()
    }
  })

  it('skips the snapshot for in-memory databases', () => {
    const db = openTracked(':memory:')
    migrate(db)
    expect(
      createVerifiedBackup(db, { dbPath: ':memory:', backupDir: tmpDir('memory'), label: 'pre-v10' }),
    ).toBeNull()
  })

  it('backs up a v9 database before migrateWithBackup applies v10', () => {
    const dir = tmpDir('upgrade')
    const dbPath = join(dir, 'pluton.sqlite')
    const db = buildV9(dbPath)
    const backupDir = join(dir, 'backups')

    const result = migrateWithBackup(db, { dbPath, backupDir })
    expect(result.from).toBe(9)
    expect(result.to).toBe(SCHEMA_VERSION)
    expect(result.backup).not.toBeNull()
    expect(result.backup!.schemaVersion).toBe(9)

    // The live database advanced to v10...
    expect(inspectDatabase(dbPath).schemaVersion).toBe(SCHEMA_VERSION)
    // ...while the snapshot still holds the v9 schema and the original rows.
    const snapshot = inspectDatabase(result.backup!.path)
    expect(snapshot.schemaVersion).toBe(9)
    expect(snapshot.rowCounts['sandboxes']).toBe(1)
    expect(readdirSync(backupDir)).toHaveLength(2) // snapshot + sha256 sidecar
  })

  it('does not back up a fresh database', () => {
    const dir = tmpDir('fresh')
    const dbPath = join(dir, 'pluton.sqlite')
    const db = openTracked(dbPath)
    const backupDir = join(dir, 'backups')
    const result = migrateWithBackup(db, { dbPath, backupDir })
    expect(result.from).toBe(0)
    expect(result.backup).toBeNull()
    expect(existsSync(backupDir)).toBe(false)
  })

  it('refuses a newer database without creating a snapshot', () => {
    const dir = tmpDir('forward')
    const dbPath = join(dir, 'pluton.sqlite')
    const db = openTracked(dbPath)
    migrate(db)
    setUserVersion(db, SCHEMA_VERSION + 1)
    const backupDir = join(dir, 'backups')
    expect(() => migrateWithBackup(db, { dbPath, backupDir })).toThrow(/newer than this build supports/)
    expect(existsSync(backupDir)).toBe(false)
  })
})
