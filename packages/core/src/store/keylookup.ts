import { createHash } from 'crypto'

// Deterministic lookup key for a raw API/org key: hex SHA-256 of the raw key.
// Raw keys are random UUIDs (122 bits of entropy), so an unsalted, fast hash
// cannot be brute-forced or rainbow-tabled; it is safe to store and index for
// an O(1) lookup. The bcrypt hash is still stored alongside it.
export function keyLookupHash(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex')
}
