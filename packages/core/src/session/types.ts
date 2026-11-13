import { WorkflowGraph } from '../graph/types'

export type SessionEventType = 'created' | 'advance' | 'reset' | 'data'

/** One entry in a session's append-only event log. */
export interface SessionEvent {
  type: SessionEventType
  from?: string
  to?: string
  action?: string
  note?: string
  at: string // ISO timestamp
}

export interface Session {
  id: string
  workflowName: string
  workflowOwnerId: string
  currentState: string
  history: string[]
  createdAt: Date
  /** Last modification time. Missing on sessions saved before it existed. */
  updatedAt?: Date
  /** Free-form data carried across conversations. Missing on old sessions = {}. */
  data?: Record<string, unknown>
  /**
   * Append-only event log, capped at the most recent SESSION_EVENTS_MAX entries.
   * Missing on old sessions = [].
   */
  events?: SessionEvent[]
  /**
   * Optimistic-concurrency counter, incremented on every write through the API.
   * Missing on old sessions = 0.
   */
  revision?: number
  /**
   * Snapshot of the procedure graph taken when the session was created with
   * pin: true. When present, the session runs against it instead of the live
   * procedure. Missing on unpinned (and old) sessions.
   */
  pinnedGraph?: WorkflowGraph
}

export interface OrgKey {
  id: string
  label: string
  createdAt: Date
  keyLimit: number
}

export interface ApiKey {
  id: string
  key: string      // bcrypt hash — never stored or returned in plaintext
  label: string
  createdAt: Date
  orgKeyId: string
}

export interface Requirement {
  action: string
  targetState: string
}
