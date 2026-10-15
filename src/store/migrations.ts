import { InternalError } from '../domain/errors.ts'
import { getUserVersion, setUserVersion, withTx, type DatabaseSync } from './db.ts'

/**
 * Forward-only numbered migrations (ADR-0002). Rules:
 * - Never edit a shipped migration; add a new one.
 * - Each migration runs inside one transaction together with the user_version bump.
 * - A database whose user_version is newer than this build is refused, not downgraded.
 */
export interface Migration {
  version: number
  name: string
  statements: string[]
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    statements: [
      `CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        config_path TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE muses (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        engine_kind TEXT NOT NULL,
        model TEXT NOT NULL,
        instructions_file TEXT,
        workspace_policy TEXT NOT NULL,
        permissions_json TEXT NOT NULL DEFAULT '[]',
        approval_mode TEXT NOT NULL,
        engine_home TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        goal TEXT NOT NULL,
        origin TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        state TEXT NOT NULL,
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        manager_muse_id TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        supervisor_pid INTEGER,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        final_summary TEXT
      )`,
      `CREATE INDEX idx_runs_project ON runs(project_id, created_at)`,
      `CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        parent_task_id TEXT REFERENCES tasks(id),
        root_task_id TEXT NOT NULL,
        depth INTEGER NOT NULL,
        title TEXT NOT NULL,
        brief TEXT NOT NULL,
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        assignee_muse_id TEXT REFERENCES muses(id),
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        workspace_id TEXT,
        engine_session_id TEXT,
        result_json TEXT,
        failure_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      )`,
      `CREATE INDEX idx_tasks_run ON tasks(run_id, created_at)`,
      `CREATE INDEX idx_tasks_parent ON tasks(parent_task_id)`,
      `CREATE TABLE task_edges (
        run_id TEXT NOT NULL REFERENCES runs(id),
        from_task_id TEXT NOT NULL REFERENCES tasks(id),
        to_task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL,
        PRIMARY KEY (from_task_id, to_task_id, kind)
      )`,
      `CREATE INDEX idx_edges_run ON task_edges(run_id)`,
      `CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        run_id TEXT,
        task_id TEXT,
        muse_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_events_run ON events(run_id, seq)`,
      `CREATE TABLE receipts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT,
        payload_hash TEXT NOT NULL,
        canonical_payload TEXT NOT NULL,
        state TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_receipts_project ON receipts(project_id, created_at)`,
      `CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        run_id TEXT,
        task_id TEXT,
        muse_id TEXT,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        head_commit TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE sandboxes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        muse_id TEXT,
        kind TEXT NOT NULL,
        container_name TEXT,
        container_id TEXT,
        image TEXT,
        state TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE terminals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        muse_id TEXT NOT NULL,
        sandbox_id TEXT,
        tmux_session_name TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        run_id TEXT,
        task_id TEXT,
        requested_by_muse_id TEXT,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        scope_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE verification_checks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        run_id TEXT NOT NULL,
        task_id TEXT,
        name TEXT NOT NULL,
        command_json TEXT NOT NULL,
        cwd TEXT,
        workspace_id TEXT,
        status TEXT NOT NULL,
        exit_code INTEGER,
        stdout_artifact TEXT,
        stderr_artifact TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    ],
  },
]

export const SCHEMA_VERSION: number = MIGRATIONS.length === 0 ? 0 : (MIGRATIONS[MIGRATIONS.length - 1] as Migration).version

export interface MigrationResult {
  from: number
  to: number
  applied: string[]
}

export function migrate(db: DatabaseSync): MigrationResult {
  const from = getUserVersion(db)
  if (from > SCHEMA_VERSION) {
    throw new InternalError(
      `database schema version ${from} is newer than this build supports (${SCHEMA_VERSION}) — upgrade Pluton-Harness`,
      { details: { dbVersion: from, supported: SCHEMA_VERSION } },
    )
  }
  const applied: string[] = []
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue
    withTx(db, () => {
      for (const sql of migration.statements) db.exec(sql)
      setUserVersion(db, migration.version)
    })
    applied.push(`v${migration.version}:${migration.name}`)
  }
  return { from, to: getUserVersion(db), applied }
}
