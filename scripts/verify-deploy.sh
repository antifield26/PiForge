#!/bin/bash
set -e
source /home/antifield/piforge/gateway.env
echo "=== systemd ==="
systemctl is-active opencode-serve wb-gateway
echo "=== gateway health ==="
curl -sS http://127.0.0.1:8787/api/v1/health
echo
echo "=== opencode info ==="
curl -sS -u "opencode:${OPENCODE_PASSWORD}" http://127.0.0.1:4096/api/info
echo
echo "=== login gateway ==="
curl -sS -c /tmp/pf-cookies -X POST http://127.0.0.1:8787/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASSWORD}\"}"
echo
echo "=== agent info via gateway ==="
curl -sS -b /tmp/pf-cookies http://127.0.0.1:8787/api/v1/agent/info
echo
echo "=== console system ==="
curl -sS -b /tmp/pf-cookies http://127.0.0.1:8787/api/v1/console/system
echo
echo "=== allowlist reject ==="
curl -sS -o /tmp/pf-reject.json -w "HTTP %{http_code}\n" -b /tmp/pf-cookies -X POST \
  http://127.0.0.1:8787/api/v1/console/services/ssh.service/restart
cat /tmp/pf-reject.json
echo
echo "=== listening ports ==="
ss -lnt | grep -E '4096|8787' || true
