#!/bin/bash
set -e
source /home/antifield/piforge/gateway.env
curl -sS -c /tmp/c -X POST http://127.0.0.1:8787/api/v1/auth/login \
  -H 'content-type: application/json' \
  --data-raw "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASSWORD}\"}" > /dev/null

echo "=== LOGS allow ==="
curl -sS -b /tmp/c 'http://127.0.0.1:8787/api/v1/console/logs?unit=wb-gateway.service&lines=5'
echo
echo "=== LOGS deny ssh ==="
curl -sS -b /tmp/c -w '\nHTTP %{http_code}\n' 'http://127.0.0.1:8787/api/v1/console/logs?unit=ssh.service&lines=5'
echo "=== APT ==="
curl -sS -b /tmp/c 'http://127.0.0.1:8787/api/v1/console/apt-check' | head -c 600
echo
