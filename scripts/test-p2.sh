#!/bin/bash
set -e
source /home/antifield/piforge/gateway.env
curl -sS -c /tmp/c -X POST http://127.0.0.1:8787/api/v1/auth/login \
  -H 'content-type: application/json' \
  --data-raw "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASSWORD}\"}" >/dev/null

echo "=== PERF ==="
curl -sS -b /tmp/c 'http://127.0.0.1:8787/api/v1/console/perf'
echo
echo "=== FILE v1 ==="
B1=$(printf 'version one' | base64 -w0)
curl -sS -b /tmp/c -X POST 'http://127.0.0.1:8787/api/v1/files' \
  -H 'content-type: application/json' \
  --data-raw "{\"name\":\"note.txt\",\"contentBase64\":\"$B1\"}"
echo
echo "=== FILE v2 overwrite ==="
B2=$(printf 'version two' | base64 -w0)
curl -sS -b /tmp/c -X POST 'http://127.0.0.1:8787/api/v1/files' \
  -H 'content-type: application/json' \
  --data-raw "{\"name\":\"note.txt\",\"contentBase64\":\"$B2\"}"
echo
echo "=== VERSIONS ==="
FID=$(curl -sS -b /tmp/c 'http://127.0.0.1:8787/api/v1/files' | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const f=(j.items||[]).find(x=>x.name==="note.txt");console.log(f?f.id:"")})')
curl -sS -b /tmp/c "http://127.0.0.1:8787/api/v1/files/$FID/versions"
echo
echo "=== MANIFEST ==="
curl -sS -o /dev/null -w 'manifest %{http_code}\n' http://127.0.0.1:8787/manifest.webmanifest
curl -sS -o /dev/null -w 'icon %{http_code}\n' http://127.0.0.1:8787/icon.svg
