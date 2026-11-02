import { InternalError } from '../domain/errors.ts'
import { getUserVersion, setUserVersion, withTx, type DatabaseSync } from './db.ts'
import { createVerifiedBackup, type BackupResult } from './backup.ts'

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
  {
    version: 8,
    name: 'muse-to-ship-terminology',
    // Rename the `muses` table to `ships` and all `muse_id`-style columns to
    // `ship_id`-style. SQLite's ALTER TABLE ... RENAME TABLE automatically updates
    // internal FK references that point to the renamed table. Column renames are
    // explicit via ALTER TABLE ... RENAME COLUMN. Unique indexes that referenced
    // the old column name are dropped and recreated.
    statements: [
      // 1. Rename the ships table
      `ALTER TABLE muses RENAME TO ships`,
      // 2. Rename columns across tables that carry the old muse_id naming
      `ALTER TABLE runs RENAME COLUMN manager_muse_id TO manager_ship_id`,
      `ALTER TABLE tasks RENAME COLUMN assignee_muse_id TO assignee_ship_id`,
      `ALTER TABLE events RENAME COLUMN muse_id TO ship_id`,
      `ALTER TABLE workspaces RENAME COLUMN muse_id TO ship_id`,
      `ALTER TABLE sandboxes RENAME COLUMN muse_id TO ship_id`,
      `ALTER TABLE terminals RENAME COLUMN muse_id TO ship_id`,
      `ALTER TABLE approvals RENAME COLUMN requested_by_muse_id TO requested_by_ship_id`,
      `ALTER TABLE file_leases RENAME COLUMN muse_id TO ship_id`,
      `ALTER TABLE run_usage RENAME COLUMN muse_id TO ship_id`,
      `ALTER TABLE chat_sessions RENAME COLUMN muse_id TO ship_id`,
      // 3. Recreate unique indexes that referenced the old column name
      `DROP INDEX IF EXISTS idx_sandboxes_project_muse`,
      `CREATE UNIQUE INDEX idx_sandboxes_project_ship ON sandboxes(project_id, IFNULL(ship_id, ''))`,
      `DROP INDEX IF EXISTS idx_terminals_project_muse`,
      `CREATE UNIQUE INDEX idx_terminals_project_ship ON terminals(project_id, IFNULL(ship_id, ''))`,
    ],
  },
  {
    version: 9,
    name: 'session-workspaces',
    // Chat sessions own the workspace they operate on. NULL means "inherit the
    // server project root" for sessions created before this migration; new
    // sessions persist their root explicitly. A run records the workspace and
    // originating session it was started from so background work stays bound
    // to that session even when the operator switches the visible session.
    statements: [
      `ALTER TABLE chat_sessions ADD COLUMN workspace_root TEXT`,
      `ALTER TABLE runs ADD COLUMN workspace_root TEXT`,
      `ALTER TABLE runs ADD COLUMN origin_session_id TEXT`,
    ],
  },
  {
    version: 10,
    name: 'native-execution-sessions',
    // Additive table changes only. Legacy Docker/local-process rows stay in
    // place as read-only history; the active-row partial index lets a shipped
    // row and a new native session coexist without deleting the old one or
    // breaking terminals.sandbox_id references. No table is rebuilt or dropped.
    statements: [
      `ALTER TABLE sandboxes ADD COLUMN active INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE sandboxes ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE sandboxes ADD COLUMN execution_mode TEXT`,
      `ALTER TABLE sandboxes ADD COLUMN network_policy TEXT`,
      `ALTER TABLE sandboxes ADD COLUMN helper_version TEXT`,
      `ALTER TABLE sandboxes ADD COLUMN policy_json TEXT`,
      `ALTER TABLE sandboxes ADD COLUMN session_state TEXT`,
      `ALTER TABLE sandboxes ADD COLUMN last_seen_at TEXT`,
      `ALTER TABLE sandboxes ADD COLUMN exit_code INTEGER`,
      `ALTER TABLE sandboxes ADD COLUMN started_at TEXT`,
      `ALTER TABLE sandboxes ADD COLUMN ended_at TEXT`,
      `UPDATE sandboxes SET legacy = 1, active = 0, session_state = 'legacy'
       WHERE kind IN ('docker', 'local-process')`,
      `DROP INDEX IF EXISTS idx_sandboxes_project_ship`,
      `CREATE UNIQUE INDEX idx_sandboxes_active_ship
       ON sandboxes(project_id, IFNULL(ship_id, '')) WHERE active = 1`,
    ],
  },
  {
    version: 11,
    name: 'session-inbox',
    statements: [
      `CREATE TABLE session_inbox (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'chat',
        state TEXT NOT NULL DEFAULT 'enqueued',
        created_at TEXT NOT NULL,
        processed_at TEXT
      )`,
      `CREATE INDEX idx_inbox_session_state ON session_inbox(session_id, state, seq)`,
    ],
  },
  {
    version: 12,
    name: 'full-text-search',
    statements: [
      `CREATE VIRTUAL TABLE chat_messages_fts USING fts5(
        message_id UNINDEXED,
        session_id UNINDEXED,
        text,
        role UNINDEXED
      )`,
      `CREATE TRIGGER ai_chat_messages_fts AFTER INSERT ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(message_id, session_id, text, role)
        VALUES (new.id, new.session_id, new.text, new.role);
      END`,
      `CREATE TRIGGER ad_chat_messages_fts AFTER DELETE ON chat_messages BEGIN
        DELETE FROM chat_messages_fts WHERE message_id = old.id;
      END`,
      `CREATE TRIGGER au_chat_messages_fts AFTER UPDATE ON chat_messages BEGIN
        DELETE FROM chat_messages_fts WHERE message_id = old.id;
        INSERT INTO chat_messages_fts(message_id, session_id, text, role)
        VALUES (new.id, new.session_id, new.text, new.role);
      END`,
      `CREATE VIRTUAL TABLE events_fts USING fts5(
        event_id UNINDEXED,
        run_id UNINDEXED,
        event_type UNINDEXED,
        text
      )`,
      `CREATE TRIGGER ai_events_fts AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(event_id, run_id, event_type, text)
        VALUES (new.id, IFNULL(new.run_id, ''), new.type, new.payload_json);
      END`,
      `CREATE TRIGGER ad_events_fts AFTER DELETE ON events BEGIN
        DELETE FROM events_fts WHERE event_id = old.id;
      END`,
      `CREATE TRIGGER au_events_fts AFTER UPDATE ON events BEGIN
        DELETE FROM events_fts WHERE event_id = old.id;
        INSERT INTO events_fts(event_id, run_id, event_type, text)
        VALUES (new.id, IFNULL(new.run_id, ''), new.type, new.payload_json);
      END`,
      `INSERT INTO chat_messages_fts(message_id, session_id, text, role)
       SELECT id, session_id, text, role FROM chat_messages`,
      `INSERT INTO events_fts(event_id, run_id, event_type, text)
       SELECT id, IFNULL(run_id, ''), type, payload_json FROM events`,
    ],
  },
  {
    version: 13,
    name: 'verification-attempt-evidence',
    // Additive only: legacy rows default to attempt 0 with unknown (NULL)
    // revision evidence. A verdict requires evidence for the task's CURRENT
    // attempt; historical rows stay as immutable history instead of being
    // rewritten or deleted.
    statements: [
      `ALTER TABLE verification_checks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE verification_checks ADD COLUMN revision TEXT`,
      `ALTER TABLE verification_checks ADD COLUMN worktree_dirty INTEGER`,
      `ALTER TABLE verification_checks ADD COLUMN worktree_fingerprint TEXT`,
      `ALTER TABLE verification_checks ADD COLUMN post_revision TEXT`,
      `ALTER TABLE verification_checks ADD COLUMN post_worktree_fingerprint TEXT`,
      `CREATE INDEX idx_verification_checks_task_attempt ON verification_checks(task_id, attempt)`,
    ],
  },
  {
    version: 14,
    name: 'verification-evidence-identity',
    // Evidence identity is stored, not inferred from NULLs:
    // - `evidence_kind` distinguishes a real Git snapshot, an explicit non-Git
    //   directory and a capture failure. Legacy rows stay NULL and can never
    //   authorize a fresh verdict.
    // - post-check kind/dirty state are recorded with the post fingerprint.
    // - `executor` names the confinement mechanism that actually ran (or
    //   refused) the check.
    // - `superseded_at` retires the rows of an interrupted run when the same
    //   attempt is verified again, without deleting evidence or bumping the
    //   attempt.
    statements: [
      `ALTER TABLE verification_checks ADD COLUMN evidence_kind TEXT`,
      `ALTER TABLE verification_checks ADD COLUMN post_evidence_kind TEXT`,
      `ALTER TABLE verification_checks ADD COLUMN post_worktree_dirty INTEGER`,
      `ALTER TABLE verification_checks ADD COLUMN executor TEXT`,
      `ALTER TABLE verification_checks ADD COLUMN superseded_at TEXT`,
      `CREATE INDEX idx_verification_checks_task_attempt_active
         ON verification_checks(task_id, attempt, superseded_at)`,
    ],
  },
  {
    version: 15,
    name: 'project-sessions',
    // A persistent Build session is the anchor between successive runs in one
    // project. It holds the stable workspace and a monotonic build counter;
    // runs link back through `project_session_id` (legacy runs stay NULL).
    statements: [
      `CREATE TABLE project_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
        workspace_root TEXT NOT NULL,
        active_run_id TEXT,
        build_count INTEGER NOT NULL DEFAULT 0,
        last_goal TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `ALTER TABLE runs ADD COLUMN project_session_id TEXT`,
      `CREATE INDEX idx_runs_project_session ON runs(project_session_id, created_at)`,
    ],
  },
]

export const SCHEMA_VERSION: number = MIGRATIONS.length === 0 ? 0 : (MIGRATIONS[MIGRATIONS.length - 1] as Migration).version

export interface MigrationResult {
  from: number
  to: number
  applied: string[]
}

export function migrate(db: DatabaseSync, targetVersion?: number): MigrationResult {
  const from = getUserVersion(db)
  const currentMax = MIGRATIONS.length === 0 ? 0 : (MIGRATIONS[MIGRATIONS.length - 1] as Migration).version
  const maxVersion = targetVersion ?? currentMax
  if (from > maxVersion) {
    throw new InternalError(
      `database schema version ${from} is newer than this build supports (${maxVersion}) — upgrade Pluton-Harness`,
      { details: { dbVersion: from, supported: maxVersion } },
    )
  }
  const pending = MIGRATIONS.filter(
    (migration) => migration.version > from && (targetVersion === undefined || migration.version <= targetVersion),
  )
  if (pending.length === 0) return { from, to: from, applied: [] }

  // One transaction for the whole pending set: a crash or a failing statement
  // leaves the database exactly at `from`, not at an intermediate version.
  withTx(db, () => {
    for (const migration of pending) {
      for (const sql of migration.statements) db.exec(sql)
      setUserVersion(db, migration.version)
    }
  })
  return {
    from,
    to: getUserVersion(db),
    applied: pending.map((migration) => `v${migration.version}:${migration.name}`),
  }
}

export interface MigrateWithBackupResult extends MigrationResult {
  backup: BackupResult | null
}

/**
 * Bootstrap entry point: verify a pre-migration snapshot before running any
 * pending migration. New databases (version 0) have nothing to preserve and are
 * created directly; in-memory test databases are explicitly exempt.
 */
export function migrateWithBackup(
  db: DatabaseSync,
  args: {
    dbPath: string
    backupDir: string
    now?: () => Date
  },
): MigrateWithBackupResult {
  const from = getUserVersion(db)
  if (from > SCHEMA_VERSION) {
    throw new InternalError(
      `database schema version ${from} is newer than this build supports (${SCHEMA_VERSION}) — upgrade Pluton-Harness`,
      { details: { dbVersion: from, supported: SCHEMA_VERSION } },
    )
  }
  const backup =
    from > 0 && from < SCHEMA_VERSION
      ? createVerifiedBackup(db, {
          dbPath: args.dbPath,
          backupDir: args.backupDir,
          label: `pre-v${SCHEMA_VERSION}`,
          ...(args.now !== undefined ? { now: args.now } : {}),
        })
      : null
  const result = migrate(db)
  return { ...result, backup }
}
