#!/bin/bash
set -e
PW=$(cat /tmp/oc-pw.txt)
AUTH="opencode:$PW"
BASE=http://127.0.0.1:4096

echo "=== CREATE SESSION ==="
CREATE=$(curl -sS -X POST -u "$AUTH" -H "content-type: application/json" -d '{}' "$BASE/api/session")
echo "$CREATE"
SID=$(echo "$CREATE" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);console.log((j.data||j).id)})')
echo "SID=$SID"

echo "=== PROMPT ==="
curl -sS -m 5 -X POST -u "$AUTH" -H "content-type: application/json" \
  -d '{"text":"Reply with exactly: PONG"}' \
  "$BASE/api/session/$SID/prompt"
echo

echo "=== SSE (while generating) ==="
timeout 6 curl -sS -N -u "$AUTH" "$BASE/api/event" | head -40
echo

echo "=== MESSAGES ==="
curl -sS -u "$AUTH" "$BASE/api/session/$SID/message" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const msgs=j.data||j;console.log("count",msgs.length);for (const m of msgs.slice(-3)){console.log(JSON.stringify({id:m.id,role:m.role,parts:(m.parts||[]).map(p=>({type:p.type,text:(p.text||"").slice(0,80)}))},null,0))}})'

echo "=== PERMISSION ENDPOINTS ==="
curl -sS -u "$AUTH" "$BASE/api/session/$SID/permission" | head -c 300
echo
echo "=== SAVED PERMS ==="
curl -sS -u "$AUTH" "$BASE/api/permission/saved" | head -c 300
echo
