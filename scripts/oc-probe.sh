#!/bin/bash
PW=$(grep 'server password' /tmp/oc-serve.log | tail -1 | sed 's/.*server password //')
echo "pw_len=${#PW}"
echo "$PW" > /tmp/oc-pw.txt
echo "=== INFO ==="
curl -sS -m 5 -u "opencode:$PW" http://127.0.0.1:4096/api/info
echo
echo "=== LOCATION ==="
curl -sS -m 5 -u "opencode:$PW" http://127.0.0.1:4096/api/location
echo
echo "=== SESSIONS ==="
curl -sS -m 5 -u "opencode:$PW" http://127.0.0.1:4096/api/session
echo
echo "=== SSE 2s ==="
timeout 2 curl -sS -N -u "opencode:$PW" http://127.0.0.1:4096/api/event | head -8
echo
echo "=== AGENTS ==="
curl -sS -m 5 -u "opencode:$PW" http://127.0.0.1:4096/api/agent | head -c 400
echo
