#!/bin/bash
set -e
source /home/antifield/piforge/gateway.env
curl -sS -c /tmp/c -X POST http://127.0.0.1:8787/api/v1/auth/login \
  -H 'content-type: application/json' \
  --data-raw "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASSWORD}\"}" >/dev/null
echo "=== SUMMARY ==="
curl -sS -b /tmp/c 'http://127.0.0.1:8787/api/v1/console/metrics/summary' | head -c 500
echo
echo "=== CSV ==="
curl -sS -b /tmp/c 'http://127.0.0.1:8787/api/v1/console/metrics/export?kind=temp&format=csv' | head -6
echo
