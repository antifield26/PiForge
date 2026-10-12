#!/bin/bash
# Public reachability probe: DNS, public health, local health, cloudflared ingress config.
set -euo pipefail

HOST=${PIFORGE_PUBLIC_HOST:-cloud.antifield.work}

echo "=== DNS ==="
getent hosts "$HOST" || echo dns-fail
echo "=== public health ==="
curl -sS -m 10 -w "\nHTTP %{http_code}\n" "https://$HOST/api/v1/health" || true
echo "=== local health ==="
curl -sS -m 5 http://127.0.0.1:8787/api/v1/health || true
echo
echo "=== cloudflared ingress ==="
sudo cat /etc/cloudflared/config.yml 2>/dev/null || echo "(cannot read /etc/cloudflared/config.yml)"
