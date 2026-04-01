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

  ensureColumn(db, "sessions", "model", "TEXT");
  ensureColumn(db, "sessions", "model_reasoning_effort", "TEXT");
  ensureColumn(db, "sessions", "profile", "TEXT");
  ensureColumn(db, "sessions", "workdir", "TEXT");
  ensureColumn(db, "sessions", "service_tier", "TEXT");
  ensureColumn(db, "sessions", "discord_channel_name", "TEXT");

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

  return db;
}
