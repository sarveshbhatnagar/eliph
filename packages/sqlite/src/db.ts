import Database from 'better-sqlite3'

export function openDb(path: string): Database.Database {
  const db = new Database(path)

  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS org_keys (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      key_hash   TEXT NOT NULL,
      key_limit  INTEGER NOT NULL DEFAULT 100
    );

    CREATE TABLE IF NOT EXISTS workflows (
      name        TEXT NOT NULL,
      api_key_id  TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      data        TEXT NOT NULL,
      PRIMARY KEY (name, api_key_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      current_state TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      data          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_workflow_state
      ON sessions(workflow_name, current_state);

    CREATE TABLE IF NOT EXISTS api_keys (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      key_hash   TEXT NOT NULL,
      org_key_id TEXT REFERENCES org_keys(id)
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id             TEXT PRIMARY KEY,
      org_key_id     TEXT NOT NULL,
      api_key_id     TEXT NOT NULL,
      api_key_label  TEXT NOT NULL,
      event_type     TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_org_date
      ON usage_events(org_key_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_usage_key_date
      ON usage_events(api_key_id, created_at);
  `)

  return db
}
