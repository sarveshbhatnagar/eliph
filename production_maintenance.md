# Production Maintenance — Eliph API

**Host:** Mac mini (`sbmacmini`)
**Public URL:** `https://api.eliph.revalent.ai`
**Local port:** `4000`
**Database:** `eliph.db` (SQLite, in project root)
**Tunnel:** Cloudflare (`sbmacmini` tunnel → `api.eliph.revalent.ai`)
**Process manager:** pm2 (`eliph-api`)

---

## Stack

| Layer | Detail |
|---|---|
| Runtime | Node.js v25 |
| Server | Fastify on port 4000 |
| Build | esbuild → `dist/server.js` |
| Persistence | SQLite via `better-sqlite3` |
| Tunnel | cloudflared (`~/.cloudflared/config.yml`) |
| Process | pm2 (`ecosystem.config.js`) |

---

## Day-to-day commands

```bash
pm2 status                   # is the server running?
pm2 logs eliph-api           # live log tail
pm2 logs eliph-api --lines 100  # last 100 lines
pm2 monit                    # live CPU/memory dashboard
curl https://api.eliph.revalent.ai/health  # end-to-end health check
```

---

## Deploying an upgrade

```bash
./deploy.sh
```

What it does internally:
1. Backs up `dist/server.js` → `dist/server.js.bak`
2. `git pull origin main`
3. `npm install`
4. `npm run build` (esbuild, ~36ms)
5. `pm2 reload eliph-api --update-env` (zero-downtime swap)

If `deploy.sh` doesn't exist yet:

```bash
cat > deploy.sh << 'EOF'
#!/bin/bash
set -e
cp dist/server.js dist/server.js.bak 2>/dev/null || true
git pull origin main
npm install
npm run build
pm2 reload eliph-api --update-env
echo "Deploy done. Previous build saved to dist/server.js.bak"
EOF
chmod +x deploy.sh
```

---

## Rollbacks

### Instant rollback (restore previous build)

No rebuild needed — swaps back the binary saved by `deploy.sh`:

```bash
cp dist/server.js.bak dist/server.js
pm2 reload eliph-api
```

### Git rollback (go back to a specific commit)

```bash
git log --oneline          # find the commit to roll back to
git checkout <commit-hash>
npm run build
pm2 reload eliph-api
```

To return to main afterwards:

```bash
git checkout main
```

---

## Database

The SQLite database lives at `eliph.db` in the project root. It is **not** committed to git.

### Backup

```bash
cp eliph.db eliph.db.bak
# or use SQLite's online backup (safe while server is running):
sqlite3 eliph.db ".backup eliph.db.bak"
```

### Restore

```bash
pm2 stop eliph-api
cp eliph.db.bak eliph.db
pm2 start eliph-api
```

### Schema migrations

Migrations are currently manual (no migration framework). Rules:
- **Always additive** — add columns/tables, never remove or rename
- Old code must still run against a newer schema (enables instant rollback)
- Document each schema change here with a date

| Date | Change |
|---|---|
| 2026-02-19 | Initial schema: `workflows`, `sessions`, `api_keys` |
| 2026-05-10 | Added `org_keys` table; added `org_key_id` column to `api_keys` |

### Applying the 2026-05-10 migration to an existing database

If `eliph.db` was created before 2026-05-10, run this once before restarting the server:

```bash
sqlite3 eliph.db "
CREATE TABLE IF NOT EXISTS org_keys (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  key_hash   TEXT NOT NULL,
  key_limit  INTEGER NOT NULL DEFAULT 100
);
ALTER TABLE api_keys ADD COLUMN org_key_id TEXT REFERENCES org_keys(id);
"
```

---

## Bootstrap (first run on a new machine)

```bash
# 1. Install pm2 globally
npm install -g pm2

# 2. Install dependencies and build
npm install
npm run build

# 3. Start the server
pm2 start ecosystem.config.js

# 4. Persist across reboots
pm2 startup    # follow the printed command exactly
pm2 save

# 5. Create the first API key (POST /keys has no auth by design)
curl -X POST https://api.eliph.revalent.ai/keys \
  -H "Content-Type: application/json" \
  -d '{"label": "admin"}' 
# Save the returned rawKey — it is shown only once

# 6. Create the first org key (replace ADMIN_SECRET with your actual value first)
curl -X POST https://api.eliph.revalent.ai/admin/org-keys \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"label": "your-org-name", "keyLimit": 500}'
# Save the returned rawKey — this is the org key to distribute to customers
# Customers use it via POST /keys to create their own API keys
```

---

## Cloudflare tunnel

The tunnel runs as a macOS LaunchDaemon (auto-starts on boot).

```bash
# Config
cat ~/.cloudflared/config.yml

# Status
sudo launchctl list | grep cloudflare

# Restart tunnel (after editing config.yml)
sudo launchctl stop com.cloudflare.cloudflared
sudo launchctl start com.cloudflare.cloudflared

# Add a new hostname
# 1. Edit ~/.cloudflared/config.yml — add ingress rule before the catch-all
# 2. cloudflared tunnel route dns sbmacmini <new-hostname>
# 3. Restart tunnel (commands above)
```

Current ingress:

| Hostname | Local service |
|---|---|
| `ssh.revalent.ai` | `localhost:22` |
| `revalent.ai` | `localhost:3000` |
| `www.revalent.ai` | `localhost:3000` |
| `chat.revalent.ai` | `localhost:4096` |
| `api.eliph.revalent.ai` | `localhost:4000` |

---

## pm2 crash behaviour

Configured in `ecosystem.config.js`:
- `autorestart: true` — restarts automatically on crash
- `restart_delay: 2000` — waits 2 seconds before restarting
- `max_restarts: 10` — stops retrying after 10 consecutive crashes (prevents crash loop)

If pm2 hits the restart cap:

```bash
pm2 logs eliph-api   # read the crash reason
pm2 start eliph-api  # manually re-arm after fixing
```

---

## API reference

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | none | Health check |
| `POST` | `/admin/org-keys` | admin | Create org key |
| `GET` | `/admin/org-keys` | admin | List org keys + key counts |
| `DELETE` | `/admin/org-keys/:id` | admin | Revoke org key |
| `POST` | `/keys` | org key | Create API key (enforces limit) |
| `GET` | `/keys` | org key (own) / admin (all) | List API keys |
| `DELETE` | `/keys/:id` | org key (own) / admin (any) | Delete API key |
| `GET` | `/procedures` | api key | Search procedures |
| `GET` | `/procedure/:name` | api key | Get a procedure |
| `POST` | `/procedure` | api key | Create a procedure |
| `POST` | `/procedure/:name/transition` | api key | Add a transition |
| `DELETE` | `/procedure/:name/transition` | api key | Remove a transition |
| `DELETE` | `/procedure/:name/state/:state` | api key | Remove a state |
| `GET` | `/procedure/:name/states` | api key | List states |
| `POST` | `/session` | api key | Create a session |
| `DELETE` | `/session/:id` | api key | Delete a session |
| `GET` | `/session/:id/state` | api key | Current state + available transitions |
| `GET` | `/session/:id/next` | api key | Next transitions |
| `POST` | `/session/:id/advance` | api key | Advance to next state |
| `POST` | `/session/:id/reset` | api key | Reset to a target state |
| `GET` | `/session/:id/requirements` | api key | Action requirements for current state |
