import { WorkflowGraph } from '../graph/types'
import { Session, ApiKey } from '../session/types'

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

export interface IApiKeyStore {
  find(rawKey: string): Promise<ApiKey | null>
  create(label: string): Promise<{ rawKey: string; record: ApiKey }>
  delete(id: string): Promise<void>
  list(): Promise<Omit<ApiKey, 'key'>[]>
}
