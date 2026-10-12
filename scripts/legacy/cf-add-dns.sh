#!/bin/bash
# LEGACY (reference only). Superseded by scripts/cf-api-dns.sh + scripts/cf-dns-check.sh.
# See scripts/legacy/README.md — do not run this against the Pi.
set -euo pipefail
TUNNEL=b6683fba-30e5-4f49-a785-5680e7a30e21
HOST=cloud.antifield.work

echo "=== route dns ==="
cloudflared tunnel route dns "$TUNNEL" "$HOST" 2>&1

echo "=== verify dns ==="
getent hosts "$HOST" || echo "still-unresolved"
sleep 2
getent hosts "$HOST" || echo "still-unresolved-2"

echo "=== https health ==="
curl -sS -m 15 -w "\nHTTP %{http_code}\n" "https://$HOST/api/v1/health" || true
