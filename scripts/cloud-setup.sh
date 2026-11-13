#!/usr/bin/env bash
# SessionStart hook: install dependencies in claude.ai cloud sessions only.
# Never fails the session; needs no secrets.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$(dirname "$0")/.." || exit 0
npm ci --no-audit --no-fund >&2 || echo "cloud-setup: npm ci failed (continuing)" >&2
exit 0
