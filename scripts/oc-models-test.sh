#!/bin/bash
# OpenCode model/session shape dump.
#
# The password is read from the local OpenCode config via lib/env.sh and passed to curl in a
# 0600 --config file; no password file is read or written.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

OC_BASE=${OPENCODE_BASE:-http://127.0.0.1:4096}

OC_PASSWORD=$(piforge_opencode_password) || {
  echo "OpenCode password not found: set OPENCODE_PASSWORD, or provide a local service.json" >&2
  exit 1
}
piforge_tmpfile
CURLRC=$PIFORGE_TMPFILE
piforge_curlrc "$CURLRC" opencode "$OC_PASSWORD"
unset OC_PASSWORD

echo "=== MODELS ==="
curl -sS --config "$CURLRC" "$OC_BASE/api/model" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const models=j.data||j;console.log("count",models.length);for (const m of models.slice(0,25)){console.log(JSON.stringify({id:m.id,providerID:m.providerID,name:m.name}))}})'

echo "=== DEFAULT MODEL ==="
curl -sS --config "$CURLRC" "$OC_BASE/api/model/default"
echo

echo "=== MESSAGE SHAPE ==="
curl -sS --config "$CURLRC" "$OC_BASE/api/session" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const sessions=j.data||[];console.log("sessions",sessions.length)})'

# dump one full message from a fresh session
SID=$(curl -sS -X POST --config "$CURLRC" -H "content-type: application/json" -d '{"title":"shape-test"}' "$OC_BASE/api/session" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);console.log((j.data||j).id)})')
curl -sS -X POST --config "$CURLRC" -H "content-type: application/json" -d '{"text":"say hi"}' "$OC_BASE/api/session/$SID/prompt" >/dev/null
sleep 2
echo "FULL MESSAGE:"
curl -sS --config "$CURLRC" "$OC_BASE/api/session/$SID/message" | head -c 2500 || true
echo
