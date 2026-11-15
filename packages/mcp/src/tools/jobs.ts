import { ApiClient } from '../client'

type Data = Record<string, unknown>

interface JobStep { completed_action?: string; data?: Data; note?: string }
interface JobItem { label: string; data?: Data | null; steps?: JobStep[] }
interface JobAdvanceStep extends JobStep { label?: string; session_id?: string; expected_state?: string }

/** Copies the listed keys that have a value, so absent optional fields stay out of the request body. */
function pick<T extends object>(source: T, keys: Array<keyof T>): Partial<T> {
  const out: Partial<T> = {}
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key]
  }
  return out
}

/**
 * The part of an item the API takes. The items a workflow script returns carry
 * more (finalState, error); those describe the script run, not the job, and are
 * left out so its result can be passed here unchanged.
 */
function toItem(item: JobItem) {
  const out: { label: string; data?: Data; steps?: JobStep[] } = { label: item.label, ...pick(item, ['data']) as { data?: Data } }
  if (Array.isArray(item.steps)) out.steps = item.steps.map(step => pick(step, ['completed_action', 'data', 'note']))
  return out
}

const jobPath = (jobId: string) => `/job/${encodeURIComponent(jobId)}`

export function makeJobTools(client: ApiClient) {
  return {
    create_job: async (args: { workflow_name: string; items: JobItem[]; pin?: boolean; actor?: string }) => {
      // Optional fields only when supplied, as in create_session
      const body: { workflow: string; items: unknown; pin?: boolean; actor?: string } = {
        workflow: args.workflow_name,
        // Anything that is not a list of items is sent as it came, so the API explains what is wrong with it
        items: Array.isArray(args.items) ? args.items.map(item => (item && typeof item === 'object' ? toItem(item) : item)) : args.items,
      }
      if (args.pin !== undefined) body.pin = args.pin
      if (args.actor) body.actor = args.actor
      return client.request('POST', '/job', body)
    },

    job_status: async (args: { job_id: string }) => client.request('GET', jobPath(args.job_id)),

    advance_job: async (args: { job_id: string; steps: JobAdvanceStep[]; actor?: string }) => {
      const body: { steps: unknown; actor?: string } = {
        // Null fields are left out (they mean "none"); anything that is not a list of steps is sent as it came
        steps: Array.isArray(args.steps)
          ? args.steps.map(step => (step && typeof step === 'object'
            ? pick(step, ['label', 'session_id', 'completed_action', 'expected_state', 'data', 'note'])
            : step))
          : args.steps,
      }
      if (args.actor) body.actor = args.actor
      return client.request('POST', `${jobPath(args.job_id)}/advance`, body)
    },

    delete_job: async (args: { job_id: string }) => {
      await client.request('DELETE', jobPath(args.job_id))
      return { deleted: true }
    },

    export_workflow: async (args: { workflow_name: string; max_steps?: number }) => {
      const qs = args.max_steps !== undefined ? `?max_steps=${encodeURIComponent(String(args.max_steps))}` : ''
      return client.request('GET', `/procedure/${encodeURIComponent(args.workflow_name)}/workflow-script${qs}`)
    },
  }
}
