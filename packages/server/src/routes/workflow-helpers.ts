import { WorkflowGraph, graphWarnings } from '@eliph/core'

/** A graph plus its advisory warnings, for routes whose schema is WorkflowGraphWithWarnings#. */
export function withWarnings(graph: WorkflowGraph): WorkflowGraph & { warnings: string[] } {
  return { ...graph, warnings: graphWarnings(graph) }
}

/** 409 body for creating a workflow whose name is already taken by that owner. */
export function workflowExistsConflict(name: string, nameField = 'workflow_name') {
  return {
    error:
      `A procedure named "${name}" already exists. Nothing was changed. ` +
      `Use the existing procedure (fetch it with GET /procedure/${encodeURIComponent(name)} or the procedure tool), ` +
      `pick a different ${nameField}, or pass overwrite: true to replace it (this discards its states and transitions).`,
    code: 'CONFLICT',
  }
}

export const overwriteProperty = {
  type: 'boolean',
  description: 'Replace an existing procedure of the same name (discarding its states and transitions). Without it, an existing name returns 409 CONFLICT.',
}
