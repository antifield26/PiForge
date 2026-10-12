#!/bin/bash
# OpenCode prompt + SSE + permission-endpoint check.
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

echo "=== CREATE SESSION ==="
CREATE=$(curl -sS -X POST --config "$CURLRC" -H "content-type: application/json" -d '{}' "$OC_BASE/api/session")
echo "$CREATE"
SID=$(echo "$CREATE" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);console.log((j.data||j).id)})')
echo "SID=$SID"

echo "=== PROMPT ==="
curl -sS -m 5 -X POST --config "$CURLRC" -H "content-type: application/json" \
  -d '{"text":"Reply with exactly: PONG"}' \
  "$OC_BASE/api/session/$SID/prompt"
echo

echo "=== SSE (while generating) ==="
timeout 6 curl -sS -N --config "$CURLRC" "$OC_BASE/api/event" | head -40 || true
echo

echo "=== MESSAGES ==="
curl -sS --config "$CURLRC" "$OC_BASE/api/session/$SID/message" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const msgs=j.data||j;console.log("count",msgs.length);for (const m of msgs.slice(-3)){console.log(JSON.stringify({id:m.id,role:m.role,parts:(m.parts||[]).map(p=>({type:p.type,text:(p.text||"").slice(0,80)}))},null,0))}})'

echo "=== PERMISSION ENDPOINTS ==="
curl -sS --config "$CURLRC" "$OC_BASE/api/session/$SID/permission" | head -c 300 || true
echo
echo "=== SAVED PERMS ==="
curl -sS --config "$CURLRC" "$OC_BASE/api/permission/saved" | head -c 300 || true
echo
