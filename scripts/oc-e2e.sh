#!/bin/bash
# OpenCode E2E: create session -> switch model -> prompt -> collect SSE + messages.
#
# The password is read from the local OpenCode config via lib/env.sh and passed to curl in a
# 0600 --config file; the SSE capture goes to a 0600 mktemp removed on exit. No /tmp/oc-pw.txt.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

OC_BASE=${OPENCODE_BASE:-http://127.0.0.1:4096}
MODEL_ID="${MODEL_ID:-ling-3.1-flash-free}"

OC_PASSWORD=$(piforge_opencode_password) || {
  echo "OpenCode password not found: set OPENCODE_PASSWORD, or provide a local service.json" >&2
  exit 1
}
piforge_tmpfile
CURLRC=$PIFORGE_TMPFILE
piforge_curlrc "$CURLRC" opencode "$OC_PASSWORD"
unset OC_PASSWORD

echo "=== CREATE ==="
SID=$(curl -sS -X POST --config "$CURLRC" -H "content-type: application/json" -d '{"title":"e2e"}' "$OC_BASE/api/session" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log((JSON.parse(d).data||JSON.parse(d)).id)})')
echo "SID=$SID"

echo "=== SWITCH MODEL $MODEL_ID ==="
curl -sS -X POST --config "$CURLRC" -H "content-type: application/json" \
  -d "{\"model\":{\"id\":\"$MODEL_ID\",\"providerID\":\"opencode\"}}" \
  "$OC_BASE/api/session/$SID/model"
echo

echo "=== SSE BACKGROUND ==="
piforge_tmpfile
SSE_FILE=$PIFORGE_TMPFILE
timeout 12 curl -sS -N --config "$CURLRC" "$OC_BASE/api/event" >"$SSE_FILE" &
SSE_PID=$!

sleep 1
echo "=== PROMPT ==="
curl -sS -X POST --config "$CURLRC" -H "content-type: application/json" \
  -d '{"text":"Reply with exactly one word: PONG"}' \
  "$OC_BASE/api/session/$SID/prompt"
echo

wait "$SSE_PID" 2>/dev/null || true
echo "=== SSE FRAMES (filtered) ==="
grep -E 'session\.step|message\.|session\.execution|permission' "$SSE_FILE" | head -20 || true

echo "=== MESSAGES ==="
curl -sS --config "$CURLRC" "$OC_BASE/api/session/$SID/message" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const msgs=j.data||[];console.log("count",msgs.length);for (const m of msgs){console.log(JSON.stringify({id:m.id,type:m.type,text:(m.text||"").slice(0,100),content:(m.content||[]).map(p=>(p.text||"").slice(0,60)),finish:m.finish,err:m.error&&m.error.message}))}})'
