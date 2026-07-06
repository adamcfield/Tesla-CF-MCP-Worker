#!/usr/bin/env bash
# Rotate the worker's full-scope MCP_AUTH_TOKEN.
#
#   cd tesla-cf-mcp-worker && bash rotate-master-token.sh
#
# The new token is generated LOCALLY, shown once, and set as the Worker secret —
# it never passes through chat or the assistant, which is the whole point of
# rotating (so the exposed old token stops working and the new one is private).
#
# Note: your phone's read-only device token is NOT affected (device tokens are
# stored/validated separately). Only the old master token stops working.
set -euo pipefail
cd "$(dirname "$0")"

NEW=$(openssl rand -hex 32)
echo
echo "  New MCP_AUTH_TOKEN  (copy into your password manager — shown ONCE):"
echo
echo "      $NEW"
echo
read -r -p "  Set this as the Worker secret now? [y/N] " ok
[ "$ok" = "y" ] || { echo "  Aborted — nothing changed."; exit 0; }

printf '%s' "$NEW" | npx wrangler secret put MCP_AUTH_TOKEN
echo
echo "  ✓ Worker secret rotated. The old token (b39719…) no longer works."
echo
echo "  Still to do (so the poller keeps re-arming):"
echo "   • Update GitHub Actions secret:  gh secret set MCP_AUTH_TOKEN --body \"$NEW\""
echo "     (or Settings → Secrets → Actions in the repo UI)"
echo "   • Re-authorize any claude.ai / MCP connector that used the old token."
