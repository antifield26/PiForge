#!/bin/bash
# E2E: create session -> switch model -> prompt -> collect SSE + messages
PW=$(cat /tmp/oc-pw.txt)
AUTH="opencode:$PW"
BASE=http://127.0.0.1:4096
MODEL_ID="${MODEL_ID:-ling-3.1-flash-free}"

echo "=== CREATE ==="
SID=$(curl -sS -X POST -u "$AUTH" -H "content-type: application/json" -d '{"title":"e2e"}' "$BASE/api/session" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log((JSON.parse(d).data||JSON.parse(d)).id)})')
echo "SID=$SID"

echo "=== SWITCH MODEL $MODEL_ID ==="
curl -sS -X POST -u "$AUTH" -H "content-type: application/json" \
  -d "{\"model\":{\"id\":\"$MODEL_ID\",\"providerID\":\"opencode\"}}" \
  "$BASE/api/session/$SID/model"
echo

echo "=== SSE BACKGROUND ==="
timeout 12 curl -sS -N -u "$AUTH" "$BASE/api/event" > /tmp/oc-e2e-sse.txt &
SSE_PID=$!

sleep 1
echo "=== PROMPT ==="
curl -sS -X POST -u "$AUTH" -H "content-type: application/json" \
  -d '{"text":"Reply with exactly one word: PONG"}' \
  "$BASE/api/session/$SID/prompt"
echo

wait $SSE_PID 2>/dev/null || true
echo "=== SSE FRAMES (filtered) ==="
grep -E 'session\.step|message\.|session\.execution|permission' /tmp/oc-e2e-sse.txt | head -20

echo "=== MESSAGES ==="
curl -sS -u "$AUTH" "$BASE/api/session/$SID/message" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const msgs=j.data||[];console.log("count",msgs.length);for (const m of msgs){console.log(JSON.stringify({id:m.id,type:m.type,text:(m.text||"").slice(0,100),content:(m.content||[]).map(p=>(p.text||"").slice(0,60)),finish:m.finish,err:m.error&&m.error.message}))}})'
