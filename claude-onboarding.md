# Connecting Eliph to Claude

Eliph exposes a remote MCP server that gives Claude access to your workflow procedures and sessions. This guide covers two clients: **Claude.ai** (browser) and **Claude Code** (CLI).

---

## Prerequisites

You need an **API key**. Ask your Eliph admin to create one for you, or if you have an org key, create one yourself:

```bash
curl -X POST https://eliph-api.revalent.ai/keys \
  -H "Authorization: Bearer YOUR_ORG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label": "my-claude-key"}'
```

Save the `rawKey` from the response — **it is shown only once**.

---

## Claude.ai

1. Go to **claude.ai → Settings → Integrations**
2. Click **Add custom connector**
3. Enter the URL:
   ```
   https://eliph-mcp.revalent.ai/mcp
   ```
4. Click **Connect** — you will be redirected to the Eliph authorization page
5. Paste your API key and click **Authorise**
6. You will be redirected back to Claude.ai — Eliph tools are now available

That's it. No OAuth Client ID or Client Secret needed.

---

## Claude Code (CLI)

Run this once in your terminal:

```bash
claude mcp add --transport http eliph https://eliph-mcp.revalent.ai/mcp \
  --header "Authorization: Bearer YOUR_API_KEY"
```

Verify it connected:

```bash
claude mcp list
# eliph: https://eliph-mcp.revalent.ai/mcp (HTTP) - ✓ Connected
```

Start a new Claude Code session — Eliph tools will be available immediately.

---

## What you can do

Once connected, Claude can:

| Action | Example prompt |
|---|---|
| Browse workflows | *"What workflows are available in Eliph?"* |
| Create a workflow | *"Create an Eliph workflow for customer onboarding"* |
| Run a workflow | *"Start a session for the trade_evaluation workflow"* |
| Advance through states | *"What's the next step in my session?"* |
| Check session state | *"Where is session abc-123 right now?"* |
| Run a workflow over many items | *"Review these five PRs with the code_review workflow, one run each"* |
| Check a whole job | *"Is the review job done? Which runs are stuck?"* |

### Jobs: the same workflow for many pieces of work

A session is one run of a workflow. When several pieces of work each follow the same workflow (five PRs, twenty tickets), use a **job**: a group of sessions, one per piece of work, each with its own `label`. Parallel agents then never share a session.

| Tool | Purpose |
|---|---|
| `create_job` | Create one run per item (`items: [{ label, data }]`). An item may carry `steps` to record work that already happened. |
| `job_status` | Is the whole job done? Returns `done`, counts per state and where each run is. |
| `advance_job` | Advance several runs in one call, by `label` or `session_id`. |
| `delete_job` | Delete every run of a job. |
| `export_workflow` | Turn a workflow into a Claude Code Workflow script that runs it over many items in parallel. |
| `sync_job` | Bring runs of a job up to date with reported steps; already recorded steps are skipped, so it is safe to repeat. |
| `list_sessions` with `job_id` | List the runs of one job. |

Each run is an ordinary session, so `advance`, `current_state` and the other session tools work on it by session id.

**Running a workflow with parallel agents (Claude Code):**

1. `export_workflow` returns a `script`, an `argsExample` and `notes` (read the notes: they list caveats).
2. Pass the script to the Workflow tool with args `{ items: [{ label, data }] }`. It runs one agent per state, per item.
3. When it returns, pass its result's `items` to `create_job` with the same workflow name. That one call records every run and checks each reported path against the workflow; a run whose path is refused gets an `error` and the others are unaffected. If the result has `batches` (more than 2000 steps in total), call `create_job` once per batch with the items it names.

**Live progress.** By default nothing is recorded until step 3. To watch a run while it is going, call `export_workflow` with `live: true` and change the steps: first `create_job` with the items (no steps), then run the script with args `{ job_id, items }`, and when it returns call `sync_job` with its result's `job_id` and `items` (not `create_job`). The script's agents record each step with `sync_job` as they finish it, so `job_status` shows where every run is. `sync_job` skips steps that are already recorded, so the final call only adds what an agent failed to record. Live mode costs one extra tool call per step.

A workflow with probabilistic transitions, no `start` state, or a non-terminal state with no way out cannot be exported (`NOT_EXPORTABLE`).

### When several agents work on the same session

Pass `expected_state` (the state you believe the session is in) to `advance`, `reset_state` or a step of `advance_job`. If the session is somewhere else the call fails with `STATE_MISMATCH` and nothing changes, so a step two agents both report is applied only once. Pass `actor` to record who did a step in the session event log.

### Transition formats

When building workflows, use these formats:

```
start -> review              # deterministic (auto-advances)
review -approved-> done      # symbolic (requires completed_action: "approved")
start -.7-> pass             # probabilistic 70% (all from same state must sum to 1.0)
start -.3-> fail             # probabilistic 30%
```

### Terminal states

The state named `end` is automatically terminal. For other end states (e.g. `approved`, `rejected`), use the `mark_terminal` tool after creating the state.

---

## Troubleshooting

**"Workflow not found"**
Each API key has its own isolated procedure namespace. Make sure you're using the same key that created the workflow.

**"Session is already in terminal state"**
The workflow has completed — no further advances are possible. Create a new session to run it again.

**"Session ... is in state X, not Y (expected_state)"**
Another agent already moved the session. Nothing was changed; call `current_state` (or `job_status`) to see where it is now and continue from there.

**"requires a completed_action"**
The current state has symbolic transitions. Call `next_transitions` to see valid action names, then advance with `completed_action: "action_name"`.

**Reconnecting (Claude Code)**
```bash
claude mcp remove eliph
claude mcp add --transport http eliph https://eliph-mcp.revalent.ai/mcp \
  --header "Authorization: Bearer YOUR_API_KEY"
```

---

## Reference

| Endpoint | Purpose |
|---|---|
| `https://eliph-api.revalent.ai` | REST API |
| `https://eliph-mcp.revalent.ai/mcp` | MCP server (use this in Claude) |
| `https://eliph-docs.revalent.ai` | Full API documentation |
