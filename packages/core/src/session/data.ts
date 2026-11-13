import { Session, SessionEvent } from './types'

/** Maximum size of a session's serialized `data` object (UTF-8 bytes of its JSON). */
export const SESSION_DATA_MAX_BYTES = 64 * 1024

/** Only the most recent events are kept; older ones are dropped. */
export const SESSION_EVENTS_MAX = 500

/** Maximum length of an advance/reset note. */
export const SESSION_NOTE_MAX_LENGTH = 2000

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export type SessionDataErrorCode = 'PAYLOAD_TOO_LARGE' | 'BAD_REQUEST'

export class SessionDataError extends Error {
  constructor(message: string, public readonly code: SessionDataErrorCode) {
    super(message)
    this.name = 'SessionDataError'
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deepest nesting allowed in session data. */
export const SESSION_DATA_MAX_DEPTH = 32

/** Throws if any key anywhere in the value could be used for prototype pollution. */
function assertSafeKeys(value: unknown, path: string, depth = 0): void {
  if (depth > SESSION_DATA_MAX_DEPTH) {
    throw new SessionDataError(
      `Session data is nested too deeply (more than ${SESSION_DATA_MAX_DEPTH} levels).`,
      'BAD_REQUEST',
    )
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafeKeys(v, `${path}[${i}]`, depth + 1))
    return
  }
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new SessionDataError(`Session data must not contain the key "${key}" (at ${path}).`, 'BAD_REQUEST')
    }
    assertSafeKeys(value[key], `${path}.${key}`, depth + 1)
  }
}

/**
 * Shallow-merge `patch` into `current` and return a new object. A top-level key
 * set to null in the patch removes that key. Throws SessionDataError when the
 * patch is not an object, contains a forbidden key (__proto__, constructor,
 * prototype) at any depth, or the merged result exceeds SESSION_DATA_MAX_BYTES.
 */
export function mergeSessionData(
  current: Record<string, unknown> | undefined,
  patch: unknown,
): Record<string, unknown> {
  if (!isPlainObject(patch)) {
    throw new SessionDataError('Session data must be a JSON object.', 'BAD_REQUEST')
  }
  // JSON.parse creates "__proto__" as an own key, so Object.keys sees it
  assertSafeKeys(patch, 'data')
  const merged: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(current ?? {})) {
    if (!FORBIDDEN_KEYS.has(k)) merged[k] = v
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k]
    else merged[k] = v
  }
  const bytes = Buffer.byteLength(JSON.stringify(merged), 'utf8')
  if (bytes > SESSION_DATA_MAX_BYTES) {
    throw new SessionDataError(
      `Session data would be ${bytes} bytes once merged; the limit is ${SESSION_DATA_MAX_BYTES} bytes (64 KB). ` +
      'Store less (e.g. ids and links instead of full documents) or remove keys by setting them to null.',
      'PAYLOAD_TOO_LARGE',
    )
  }
  return merged
}

/** Append an event, keeping only the most recent SESSION_EVENTS_MAX. */
export function appendSessionEvent(events: SessionEvent[] | undefined, event: SessionEvent): SessionEvent[] {
  const next = [...(events ?? []), event]
  return next.length > SESSION_EVENTS_MAX ? next.slice(next.length - SESSION_EVENTS_MAX) : next
}

/** The revision a stored session is at (missing on old sessions = 0). */
export function sessionRevision(session: Pick<Session, 'revision'>): number {
  return session.revision ?? 0
}

/** Apply a data patch to a session without changing its state; records a 'data' event. */
export function applyDataPatch(session: Session, patch: unknown, now: Date = new Date()): Session {
  const data = mergeSessionData(session.data, patch)
  return {
    ...session,
    data,
    updatedAt: now,
    events: appendSessionEvent(session.events, { type: 'data', at: now.toISOString() }),
  }
}
