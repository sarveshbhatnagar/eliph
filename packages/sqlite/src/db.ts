import Database from 'better-sqlite3'

export function openDb(path: string): Database.Database {
  const db = new Database(path)

  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      name        TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      data        TEXT NOT NULL
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
      key_hash   TEXT NOT NULL
    );
  `)

  return db
}
