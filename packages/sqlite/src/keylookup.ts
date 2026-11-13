import Database from 'better-sqlite3'
import { keyLookupHash } from '@eliph/core'
import bcrypt from 'bcryptjs'

// key_lookup matches that this process has already confirmed against the row's
// bcrypt hash (row id -> the key_hash it was confirmed against). A match is
// trusted only while the row still carries that same key_hash. This matters if
// an older build, which does not know about key_lookup, regenerates a key
// during a rollback: key_hash changes but the stale key_lookup stays behind.
const verified = new Map<string, string>()

/** Record that key_lookup for this row was written together with this key_hash. */
export function markKeyLookupVerified(id: string, keyHash: string): void {
  verified.set(id, keyHash)
}

// Finds a key row by its raw value. Table and column names are internal
// constants, never user input.
export async function findKeyRow<Row extends { id: string; key_hash: string }>(
  db: Database.Database,
  table: 'api_keys' | 'org_keys',
  columns: string,
  rawKey: string,
): Promise<Row | null> {
  const lookup = keyLookupHash(rawKey)

  // Fast path: one indexed query. bcrypt runs at most once per key per process
  // (the first time a match is seen), never on later requests.
  const row = db
    .prepare(`SELECT ${columns} FROM ${table} WHERE key_lookup = ?`)
    .get(lookup) as Row | undefined
  if (row) {
    if (verified.get(row.id) === row.key_hash) return row
    if (await bcrypt.compare(rawKey, row.key_hash)) {
      verified.set(row.id, row.key_hash)
      return row
    }
    // Stale key_lookup (key_hash was replaced by a build that did not update
    // it): clear it so the row is treated as a legacy row from now on.
    verified.delete(row.id)
    db.prepare(`UPDATE ${table} SET key_lookup = NULL WHERE id = ? AND key_lookup = ?`)
      .run(row.id, lookup)
  }

  // Legacy rows created before key_lookup existed: bcrypt scan over those only,
  // then backfill so the next lookup takes the fast path. Once every row is
  // backfilled this query returns nothing and a miss costs no bcrypt.
  const legacy = db
    .prepare(`SELECT ${columns} FROM ${table} WHERE key_lookup IS NULL`)
    .all() as Row[]
  for (const legacyRow of legacy) {
    if (await bcrypt.compare(rawKey, legacyRow.key_hash)) {
      db.prepare(`UPDATE ${table} SET key_lookup = ? WHERE id = ? AND key_lookup IS NULL`)
        .run(lookup, legacyRow.id)
      verified.set(legacyRow.id, legacyRow.key_hash)
      return legacyRow
    }
  }
  return null
}
