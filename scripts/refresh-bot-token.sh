#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# scripts/refresh-bot-token.sh — refresh the rapiercraft-forgedock[bot] installation token.
#
# Generates a JWT from the app's private key, exchanges it for a 1-hour
# installation token, and re-auths the gh CLI. Idempotent — safe to run
# on every session start or from cron.
#
# Supports two installations:
#   RapierCraftStudios (org)  — installation 144998831 (default)
#   RapierCraft (personal)   — installation 140233364
#
# Usage:  scripts/refresh-bot-token.sh [--pem /path/to/key.pem] [--personal]
#
# Env:    FORGEDOCK_APP_PEM — path to private key (default: secrets/rapiercraft-forgedock.pem)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FORGE_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_ID="4051319"
ORG_INSTALLATION_ID="144998831"
PERSONAL_INSTALLATION_ID="140233364"
DEFAULT_PEM="$FORGE_HOME/secrets/rapiercraft-forgedock.pem"

# --- Parse args ---
PEM_PATH="${FORGEDOCK_APP_PEM:-$DEFAULT_PEM}"
INSTALLATION_ID="$ORG_INSTALLATION_ID"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pem) PEM_PATH="$2"; shift 2 ;;
    --personal) INSTALLATION_ID="$PERSONAL_INSTALLATION_ID"; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$PEM_PATH" ]]; then
  echo "ERROR: Private key not found at $PEM_PATH" >&2
  echo "  Set FORGEDOCK_APP_PEM or pass --pem /path/to/key.pem" >&2
  exit 1
fi

# --- Generate JWT and exchange for installation token ---
INSTALL_TOKEN=$(node -e "
var crypto = require('crypto');
var fs = require('fs');
var https = require('https');
var pem = fs.readFileSync(process.argv[1], 'utf8');
var now = Math.floor(Date.now() / 1000);
var h = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
var p = Buffer.from(JSON.stringify({iat:now-60,exp:now+(9*60),iss:process.argv[2]})).toString('base64url');
var s = crypto.createSign('RSA-SHA256');
s.update(h+'.'+p);
var jwt = h+'.'+p+'.'+s.sign(pem,'base64url');
var opts = {
  hostname: 'api.github.com',
  path: '/app/installations/'+process.argv[3]+'/access_tokens',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer '+jwt,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'forgedock-refresh'
  }
};
var req = https.request(opts, function(res) {
  var body = '';
  res.on('data', function(c) { body += c; });
  res.on('end', function() {
    var t = JSON.parse(body).token;
    if (!t) { process.stderr.write('API error: '+body); process.exit(1); }
    process.stdout.write(t);
  });
});
req.end();
" "$PEM_PATH" "$APP_ID" "$INSTALLATION_ID")

if [[ -z "$INSTALL_TOKEN" ]]; then
  echo "ERROR: Failed to obtain installation token" >&2
  exit 1
fi

# --- Auth gh CLI ---
echo "$INSTALL_TOKEN" | gh auth login --with-token 2>/dev/null

# --- Clean up stale old bot if present ---
if gh auth status 2>&1 | grep -q "rapiercraft-forge\[bot\]"; then
  gh auth logout -h github.com -u "rapiercraft-forge[bot]" 2>/dev/null || true
fi

if [[ "$INSTALLATION_ID" == "$ORG_INSTALLATION_ID" ]]; then
  echo "rapiercraft-forgedock[bot] token refreshed — org (RapierCraftStudios) ~1h"
else
  echo "rapiercraft-forgedock[bot] token refreshed — personal (RapierCraft) ~1h"
fi
