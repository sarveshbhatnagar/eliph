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
      key_limit  INTEGER NOT NULL DEFAULT 100,
      key_lookup TEXT
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

    CREATE VIRTUAL TABLE IF NOT EXISTS workflows_fts USING fts5(
      name,
      description,
      state_text,
      api_key_id UNINDEXED,
      tokenize = 'unicode61'
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
      org_key_id TEXT REFERENCES org_keys(id),
      key_lookup TEXT
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

  migrateKeyLookup(db)

  return db
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return cols.some(c => c.name === column)
}

// Idempotent migration for databases created before key_lookup existed.
// Legacy rows keep key_lookup = NULL and are backfilled lazily by find().
function migrateKeyLookup(db: Database.Database): void {
  for (const table of ['org_keys', 'api_keys']) {
    if (!hasColumn(db, table, 'key_lookup')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN key_lookup TEXT`)
    }
  }
  // UNIQUE allows repeated NULLs, so legacy rows don't conflict
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_keys_lookup ON org_keys(key_lookup);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_lookup ON api_keys(key_lookup);
  `)
}
