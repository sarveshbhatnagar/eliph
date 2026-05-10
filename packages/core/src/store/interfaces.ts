import { WorkflowGraph } from '../graph/types'
import { Session, ApiKey, OrgKey } from '../session/types'

export interface IWorkflowStore {
  get(name: string): Promise<WorkflowGraph | null>
  list(): Promise<string[]>
  search(query: string): Promise<string[]>
  save(graph: WorkflowGraph): Promise<void>
  delete(name: string): Promise<void>
}

export interface ISessionStore {
  get(id: string): Promise<Session | null>
  save(session: Session): Promise<void>
  delete(id: string): Promise<void>
  findByState(workflowName: string, state: string): Promise<Session[]>
}

export interface IOrgKeyStore {
  create(label: string, keyLimit: number): Promise<{ rawKey: string; record: OrgKey }>
  find(rawKey: string): Promise<OrgKey | null>
  list(): Promise<Array<OrgKey & { keyCount: number }>>
  delete(id: string): Promise<void>
  countKeys(orgKeyId: string): Promise<number>
  updateLimit(id: string, keyLimit: number): Promise<void>
  regenerate(id: string): Promise<{ rawKey: string }>
}

export interface IApiKeyStore {
  find(rawKey: string): Promise<ApiKey | null>
  create(label: string, orgKeyId: string): Promise<{ rawKey: string; record: ApiKey }>
  delete(id: string): Promise<void>
  list(orgKeyId?: string): Promise<Omit<ApiKey, 'key'>[]>
}
