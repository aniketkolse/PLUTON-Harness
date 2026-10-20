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
  {
    version: 2,
    name: 'unique-sandbox-and-terminal-per-muse',
    statements: [
      // Readers resolve "the" sandbox/terminal for a muse with
      // `ORDER BY created_at DESC LIMIT 1`, so when duplicates already exist the
      // newest row per (project_id, muse_id) is kept and the rest are dropped
      // before the unique index below can be created.
      `DELETE FROM sandboxes
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (PARTITION BY project_id, IFNULL(muse_id, '') ORDER BY created_at DESC, id DESC) AS rn
            FROM sandboxes
          ) WHERE rn = 1
        )`,
      `DELETE FROM terminals
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (PARTITION BY project_id, IFNULL(muse_id, '') ORDER BY created_at DESC, id DESC) AS rn
            FROM terminals
          ) WHERE rn = 1
        )`,
      // muse_id is NULL for project-level sandboxes (terminals.muse_id is NOT NULL
      // today, but the expression keeps both tables uniform) and SQLite UNIQUE
      // treats NULLs as distinct, so a plain UNIQUE(project_id, muse_id) index
      // would let duplicate NULL rows through. Building the index over
      // IFNULL(muse_id, '') makes the constraint NULL-safe; the store upserts
      // name the same expression as their ON CONFLICT target.
      `CREATE UNIQUE INDEX idx_sandboxes_project_muse ON sandboxes(project_id, IFNULL(muse_id, ''))`,
      `CREATE UNIQUE INDEX idx_terminals_project_muse ON terminals(project_id, IFNULL(muse_id, ''))`,
    ],
  },
  {
    version: 3,
    name: 'chat-sessions',
    statements: [
      `CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        muse_id TEXT NOT NULL REFERENCES muses(id),
        title TEXT,
        state TEXT NOT NULL,
        native_session_id TEXT,
        resume_token TEXT,
        engine_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_chat_sessions_project ON chat_sessions(project_id, updated_at)`,
      `CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id),
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        meta_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_chat_messages_session_seq ON chat_messages(session_id, seq)`,
    ],
  },
  {
    version: 4,
    name: 'plans',
    statements: [
      `CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        session_id TEXT NOT NULL REFERENCES chat_sessions(id),
        goal TEXT NOT NULL,
        state TEXT NOT NULL,
        tasks_json TEXT NOT NULL DEFAULT '[]',
        run_id TEXT REFERENCES runs(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_plans_session ON plans(session_id, updated_at)`,
      `CREATE INDEX idx_plans_project ON plans(project_id, updated_at)`,
    ],
  },
  {
    version: 5,
    name: 'multi-agent-reliability',
    statements: [
      `ALTER TABLE tasks ADD COLUMN write_scope_json TEXT NOT NULL DEFAULT '[]'`,
      `CREATE TABLE file_leases (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        muse_id TEXT NOT NULL REFERENCES muses(id),
        path TEXT NOT NULL,
        symbols_json TEXT NOT NULL DEFAULT '[]',
        acquired_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active'
      )`,
      `CREATE INDEX idx_file_leases_run ON file_leases(run_id, state)`,
      `CREATE INDEX idx_file_leases_task ON file_leases(task_id, state)`,
      `CREATE TABLE run_usage (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        muse_id TEXT NOT NULL REFERENCES muses(id),
        task_id TEXT REFERENCES tasks(id),
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0.0,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_run_usage_run ON run_usage(run_id)`,
      `CREATE TABLE verifications (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        verdict TEXT NOT NULL,
        criteria_json TEXT NOT NULL DEFAULT '[]',
        tamper_json TEXT NOT NULL DEFAULT '{}',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_verifications_task ON verifications(task_id)`,
    ],
  },
  {
    version: 6,
    name: 'task-assignment-snapshot',
    // Nullable by design, like result_json/failure_json: legacy rows and tasks
    // that were never claimed have no assignment snapshot to report.
    statements: [`ALTER TABLE tasks ADD COLUMN assignment_json TEXT`],
  },
  {
    version: 7,
    name: 'run-supervisor-ownership',
    // NULL = unowned: legacy rows read as claimable, and a row with a token but
    // a NULL heartbeat counts as stale (the claim UPDATE treats both as expired).
    statements: [
      `ALTER TABLE runs ADD COLUMN supervisor_token TEXT`,
      `ALTER TABLE runs ADD COLUMN supervisor_heartbeat_at INTEGER`,
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
