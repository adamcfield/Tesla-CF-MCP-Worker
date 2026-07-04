#!/usr/bin/env bash
# One-shot setup + deploy for Tesla CF MCP Worker.
#
# Run from tesla-cf-mcp-worker/:  ./setup.sh
# Safe to re-run: every step detects what's already done and skips it.
#
# What it does:
#   1. wrangler login (if needed)
#   2. EC P-256 keypair for command signing (if missing)
#   3. KV namespace + D1 database, IDs patched into wrangler.toml
#   4. Secrets: TESLA_CLIENT_ID/SECRET (prompted), TESLA_PRIVATE_KEY,
#      MCP_AUTH_TOKEN (generated), optional INGEST_TOKEN/WEBHOOK_SECRET
#   5. Deploy, discover the live URL, set PUBLIC_ORIGIN, deploy again
#   6. Print every URL you need for developer.tesla.com and pairing

set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v npx >/dev/null || die "Node.js/npm required"
command -v openssl >/dev/null || die "openssl required"
[ -f wrangler.toml ] || die "run this from the tesla-cf-mcp-worker directory"
[ -d node_modules ] || { say "npm install"; npm install --no-audit --no-fund; }

WR="npx wrangler"

# 1 ─ auth ────────────────────────────────────────────────────────────────
if ! $WR whoami >/dev/null 2>&1 || $WR whoami 2>&1 | grep -q "not authenticated"; then
  say "Logging in to Cloudflare (browser will open)"
  $WR login
fi

# 2 ─ signing key ─────────────────────────────────────────────────────────
KEY=tesla-private-key.pem
if [ ! -f "$KEY" ]; then
  say "Generating EC P-256 command-signing key → $KEY (KEEP THIS FILE SAFE)"
  openssl ecparam -name prime256v1 -genkey -noout -out "$KEY"
  chmod 600 "$KEY"
else
  say "Signing key already exists — reusing $KEY"
fi

# 3 ─ storage bindings ────────────────────────────────────────────────────
if grep -q REPLACE_WITH_KV_NAMESPACE_ID wrangler.toml; then
  say "Creating KV namespace TESLA_KV"
  OUT=$($WR kv namespace create TESLA_KV 2>&1) || { echo "$OUT"; die "KV create failed"; }
  ID=$(echo "$OUT" | grep -oE '"?id"?[ =:]+"[a-f0-9]{32}"' | grep -oE '[a-f0-9]{32}' | head -1)
  [ -n "$ID" ] || { echo "$OUT"; die "could not parse KV namespace id — paste it into wrangler.toml manually"; }
  sed -i.bak "s/REPLACE_WITH_KV_NAMESPACE_ID/$ID/" wrangler.toml
  echo "  KV id: $ID"
else
  say "KV namespace already configured"
fi

if grep -q REPLACE_WITH_D1_DATABASE_ID wrangler.toml; then
  say "Creating D1 database tesla-cf-mcp-worker"
  OUT=$($WR d1 create tesla-cf-mcp-worker 2>&1) || true
  ID=$(echo "$OUT" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
  if [ -z "$ID" ]; then
    # maybe it already exists — look it up
    ID=$($WR d1 list 2>/dev/null | grep tesla-cf-mcp-worker | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
  fi
  [ -n "$ID" ] || { echo "$OUT"; die "could not parse D1 database_id — paste it into wrangler.toml manually"; }
  sed -i.bak "s/REPLACE_WITH_D1_DATABASE_ID/$ID/" wrangler.toml
  echo "  D1 id: $ID"
else
  say "D1 database already configured"
fi
rm -f wrangler.toml.bak

# 4 ─ secrets ─────────────────────────────────────────────────────────────
have_secret() { $WR secret list 2>/dev/null | grep -q "\"$1\""; }

if ! have_secret TESLA_CLIENT_ID; then
  say "Tesla developer app credentials (from https://developer.tesla.com/dashboard)"
  read -rp "  TESLA_CLIENT_ID: " CID
  printf '%s' "$CID" | $WR secret put TESLA_CLIENT_ID
  read -rsp "  TESLA_CLIENT_SECRET (hidden): " CSECRET; echo
  printf '%s' "$CSECRET" | $WR secret put TESLA_CLIENT_SECRET
else
  say "Tesla client credentials already set"
fi

if ! have_secret TESLA_PRIVATE_KEY; then
  say "Uploading signing key as TESLA_PRIVATE_KEY secret"
  $WR secret put TESLA_PRIVATE_KEY < "$KEY"
fi

TOKEN_FILE=.mcp-auth-token
if ! have_secret MCP_AUTH_TOKEN; then
  MCP_TOKEN=$(openssl rand -hex 32)
  printf '%s' "$MCP_TOKEN" > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"
  printf '%s' "$MCP_TOKEN" | $WR secret put MCP_AUTH_TOKEN
  say "Generated MCP_AUTH_TOKEN (saved locally in $TOKEN_FILE — gitignored)"
elif [ -f "$TOKEN_FILE" ]; then
  MCP_TOKEN=$(cat "$TOKEN_FILE")
else
  MCP_TOKEN="<your MCP_AUTH_TOKEN>"
  say "MCP_AUTH_TOKEN already set (value not recoverable — using placeholder in the output below)"
fi

# 5 ─ deploy (twice on first run: URL is only known after the first) ──────
say "Deploying"
DEPLOY_OUT=$($WR deploy 2>&1) || { echo "$DEPLOY_OUT"; die "deploy failed"; }
echo "$DEPLOY_OUT" | tail -5
URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)

CURRENT_ORIGIN=$(grep -oE 'PUBLIC_ORIGIN = "[^"]*"' wrangler.toml | cut -d'"' -f2)
if [ -n "$URL" ] && [ "$CURRENT_ORIGIN" != "$URL" ] && echo "$CURRENT_ORIGIN" | grep -q "YOUR_SUBDOMAIN"; then
  say "Setting PUBLIC_ORIGIN = $URL and redeploying"
  sed -i.bak "s|PUBLIC_ORIGIN = \".*\"|PUBLIC_ORIGIN = \"$URL\"|" wrangler.toml && rm -f wrangler.toml.bak
  $WR deploy >/dev/null 2>&1
elif [ -n "$CURRENT_ORIGIN" ] && ! echo "$CURRENT_ORIGIN" | grep -q "YOUR_SUBDOMAIN"; then
  URL=$CURRENT_ORIGIN   # custom domain configured — trust it
fi
[ -n "$URL" ] || die "could not determine worker URL — check wrangler output above"
DOMAIN=${URL#https://}

# 6 ─ the URLs ────────────────────────────────────────────────────────────
cat <<EOF

════════════════════════════════════════════════════════════════════════
  DEPLOYED: $URL
════════════════════════════════════════════════════════════════════════

Tesla developer app form (https://developer.tesla.com/dashboard):
  Allowed Origin URL:      $URL
  Allowed Redirect URI:    $URL/auth/callback
  Allowed Returned URLs:   (leave empty)
  Scopes: vehicle_device_data, vehicle_location, vehicle_cmds, vehicle_charging_cmds

Then, in order:
  1. Verify key hosting:
       curl $URL/.well-known/appspecific/com.tesla.3p.public-key.pem
  2. Register partner endpoint (after the Tesla app is approved):
       curl -X POST $URL/setup/register-partner -H "Authorization: Bearer $MCP_TOKEN"
  3. Owner grant (open in browser, sign in with your Tesla account):
       $URL/auth/login?key=$MCP_TOKEN
  4. Pair the virtual key (open ON YOUR PHONE near the car):
       https://tesla.com/_ak/$DOMAIN
  5. Connect Claude Code:
       claude mcp add --transport http tesla $URL/mcp \\
         --header "Authorization: Bearer $MCP_TOKEN"
     claude.ai custom connector URL: $URL/mcp  (paste the token at the OAuth screen)

Smoke test: ask Claude to run list_vehicles, then flash_lights.
════════════════════════════════════════════════════════════════════════
EOF
