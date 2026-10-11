#!/bin/bash
set -e
source /home/antifield/piforge/gateway.env
curl -sS -c /tmp/c -X POST http://127.0.0.1:8787/api/v1/auth/login \
  -H 'content-type: application/json' \
  --data-raw "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASSWORD}\"}" >/dev/null
echo "=== SD ==="
curl -sS -b /tmp/c http://127.0.0.1:8787/api/v1/console/sd
echo
echo "=== SESSIONS ==="
curl -sS -b /tmp/c http://127.0.0.1:8787/api/v1/agent/sessions | head -c 350
echo
echo "=== BACKUP RUN ==="
curl -sS -b /tmp/c -X POST http://127.0.0.1:8787/api/v1/console/backups/run
echo
echo "=== BACKUPS ==="
curl -sS -b /tmp/c http://127.0.0.1:8787/api/v1/console/backups | head -c 500
echo
