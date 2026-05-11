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
