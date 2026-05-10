export interface Session {
  id: string
  workflowName: string
  workflowOwnerId: string
  currentState: string
  history: string[]
  createdAt: Date
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
