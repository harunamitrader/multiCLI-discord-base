import { DatabaseSync } from "node:sqlite";

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);
  if (hasColumn) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

export function createDatabase(databasePath, sessionDefaults) {
  const db = new DatabaseSync(databasePath);

  // --- Legacy tables (legacy bridge compatibility) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      codex_thread_id TEXT,
      status TEXT NOT NULL,
      discord_channel_id TEXT,
      discord_channel_name TEXT,
      model TEXT,
      model_reasoning_effort TEXT,
      profile TEXT,
      workdir TEXT,
      service_tier TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_session_id
    ON session_events(session_id, created_at);
  `);

  // --- New multiCLI-discord-base tables ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name       TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      model      TEXT,
      status     TEXT NOT NULL DEFAULT 'stopped',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      workdir    TEXT,
      is_sidebar_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      agent_name           TEXT NOT NULL,
      workspace_id         TEXT NOT NULL,
      provider_session_ref TEXT,
      model                TEXT,
      workdir              TEXT,
      last_run_state       TEXT,
      updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (agent_name, workspace_id)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id              TEXT PRIMARY KEY,
      agent_name      TEXT NOT NULL,
      workspace_id    TEXT NOT NULL,
      prompt          TEXT,
      status          TEXT NOT NULL,
      source          TEXT,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      cost_usd        REAL,
      started_at      TEXT NOT NULL,
      completed_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name   TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      run_id       TEXT,
      role         TEXT NOT NULL,
      content      TEXT,
      metadata     TEXT,
      source       TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS workspace_discord_bindings (
      discord_channel_id TEXT PRIMARY KEY,
      workspace_id       TEXT NOT NULL,
      default_agent      TEXT,
      created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

     CREATE TABLE IF NOT EXISTS app_settings (
       key        TEXT PRIMARY KEY,
       value      TEXT,
       updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
     );

     CREATE TABLE IF NOT EXISTS git_checkpoints (
       id           TEXT PRIMARY KEY,
       workspace_id TEXT NOT NULL,
       agent_name   TEXT,
       run_id       TEXT,
       kind         TEXT NOT NULL,
       label        TEXT,
       workdir      TEXT,
       git_head_sha TEXT,
       stash_ref    TEXT,
       status_json  TEXT,
       created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
     );

     CREATE TABLE IF NOT EXISTS operation_audits (
       id             TEXT PRIMARY KEY,
       workspace_id   TEXT,
       agent_name     TEXT,
       operation_type TEXT NOT NULL,
       target_ref     TEXT,
       status         TEXT NOT NULL,
       dry_run        INTEGER NOT NULL DEFAULT 0,
       requested_by   TEXT,
       source         TEXT,
       details_json   TEXT,
       created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
     );

     CREATE INDEX IF NOT EXISTS idx_runs_agent_workspace
     ON runs(agent_name, workspace_id, started_at);

    CREATE INDEX IF NOT EXISTS idx_messages_agent_workspace
    ON messages(agent_name, workspace_id, created_at);

    -- workspace_agents: which agents belong to each workspace (PTY-first membership)
    CREATE TABLE IF NOT EXISTS workspace_agents (
      workspace_id TEXT NOT NULL,
      agent_name   TEXT NOT NULL,
      is_parent    INTEGER NOT NULL DEFAULT 0,
      added_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, agent_name)
    );

     CREATE INDEX IF NOT EXISTS idx_workspace_agents_workspace
     ON workspace_agents(workspace_id);

     CREATE INDEX IF NOT EXISTS idx_git_checkpoints_workspace
     ON git_checkpoints(workspace_id, created_at DESC);

     CREATE INDEX IF NOT EXISTS idx_operation_audits_workspace
     ON operation_audits(workspace_id, created_at DESC);
   `);

  // --- New column migrations ---
  ensureColumn(db, "agents", "theme_color", "TEXT");
  ensureColumn(db, "agents", "enabled", "INTEGER DEFAULT 1");
  ensureColumn(db, "agents", "settings_json", "TEXT");
  ensureColumn(db, "workspaces", "parent_agent", "TEXT");
  ensureColumn(db, "workspaces", "context_injection_enabled", "INTEGER");
  ensureColumn(db, "workspaces", "is_sidebar_active", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "workspaces", "sort_order", "INTEGER NOT NULL DEFAULT 0");

  // --- Legacy column migrations ---
  ensureColumn(db, "sessions", "model", "TEXT");
  ensureColumn(db, "sessions", "model_reasoning_effort", "TEXT");
  ensureColumn(db, "sessions", "profile", "TEXT");
  ensureColumn(db, "sessions", "workdir", "TEXT");
  ensureColumn(db, "sessions", "service_tier", "TEXT");
  ensureColumn(db, "sessions", "discord_channel_name", "TEXT");

  // provider_session_ref alias for legacy sessions (codex_thread_id互換)
  ensureColumn(db, "sessions", "provider_session_ref", "TEXT");

  if (sessionDefaults) {
    const escape = (value) => String(value).replaceAll("'", "''");
    db.exec(`
      UPDATE sessions
      SET
        model = COALESCE(model, '${escape(sessionDefaults.model)}'),
        model_reasoning_effort = COALESCE(model_reasoning_effort, '${escape(sessionDefaults.reasoningEffort)}'),
        profile = COALESCE(profile, '${escape(sessionDefaults.profile)}'),
        workdir = COALESCE(workdir, '${escape(sessionDefaults.workdir)}'),
        service_tier = CASE
          WHEN service_tier = 'fast' THEN 'fast'
          WHEN service_tier IS NULL OR TRIM(service_tier) = '' THEN '${escape(sessionDefaults.serviceTier)}'
          ELSE 'flex'
        END
    `);

    // Migrate codex_thread_id → provider_session_ref
    db.exec(`
      UPDATE sessions
      SET provider_session_ref = codex_thread_id
      WHERE provider_session_ref IS NULL AND codex_thread_id IS NOT NULL
    `);
  }

  const activeWorkspace = db.prepare("SELECT id FROM workspaces WHERE is_active = 1 LIMIT 1").get();
  if (!activeWorkspace) {
    const firstWorkspace = db.prepare("SELECT id FROM workspaces ORDER BY created_at ASC, name ASC LIMIT 1").get();
    if (firstWorkspace?.id) {
      db.prepare(`
        UPDATE workspaces
        SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END
      `).run(firstWorkspace.id);
    }
  }

  const defaultWorkdirSetting = db.prepare(`
    SELECT value FROM app_settings WHERE key = 'default_workdir'
  `).get();
  const legacyDefaultWorkspace = db.prepare(`
    SELECT workdir FROM workspaces WHERE id = 'default' OR name = 'default' LIMIT 1
  `).get();
  if (
    (!defaultWorkdirSetting || !String(defaultWorkdirSetting.value || "").trim()) &&
    String(legacyDefaultWorkspace?.workdir || "").trim()
  ) {
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('default_workdir', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(String(legacyDefaultWorkspace.workdir).trim());
  }

  return db;
}
