export interface Session {
  id: string
  workflowName: string
  currentState: string
  history: string[]
  createdAt: Date
}

export interface ApiKey {
  id: string
  key: string      // bcrypt hash — never stored or returned in plaintext
  label: string
  createdAt: Date
}

export interface Requirement {
  action: string
  targetState: string
}
