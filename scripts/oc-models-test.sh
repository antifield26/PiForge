#!/bin/bash
PW=$(cat /tmp/oc-pw.txt)
AUTH="opencode:$PW"
BASE=http://127.0.0.1:4096

echo "=== MODELS ==="
curl -sS -u "$AUTH" "$BASE/api/model" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const models=j.data||j;console.log("count",models.length);for (const m of models.slice(0,25)){console.log(JSON.stringify({id:m.id,providerID:m.providerID,name:m.name}))}})'

echo "=== DEFAULT MODEL ==="
curl -sS -u "$AUTH" "$BASE/api/model/default"
echo

echo "=== MESSAGE SHAPE ==="
curl -sS -u "$AUTH" "$BASE/api/session" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",async()=>{const j=JSON.parse(d);const sessions=j.data||[];console.log("sessions",sessions.length)})'

# dump one full message from a fresh session
SID=$(curl -sS -X POST -u "$AUTH" -H "content-type: application/json" -d '{"title":"shape-test"}' "$BASE/api/session" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);console.log((j.data||j).id)})')
curl -sS -X POST -u "$AUTH" -H "content-type: application/json" -d '{"text":"say hi"}' "$BASE/api/session/$SID/prompt" > /dev/null
sleep 2
echo "FULL MESSAGE:"
curl -sS -u "$AUTH" "$BASE/api/session/$SID/message" | head -c 2500
echo
