#!/bin/bash
# LEGACY (reference only). Superseded by scripts/cf-api-dns.sh + scripts/cf-dns-check.sh.
# See scripts/legacy/README.md — do not run this against the Pi.
set -euo pipefail
echo "=== cert.pem (presence only) ==="
# Never print any bytes of cert.pem: it is a cloudflared API credential (JWT-shaped),
# so even a "redacted" prefix leaks usable material. Existence + subject metadata only.
if sudo test -s /home/antifield/.cloudflared/cert.pem; then
  echo "present (contents not printed)"
else
  echo "MISSING"
fi
echo "=== openssl subject ==="
sudo openssl x509 -in /home/antifield/.cloudflared/cert.pem -noout -subject -issuer -dates 2>/dev/null || true
echo "=== try route dns again with -f ==="
cloudflared tunnel route dns --overwrite-dns b6683fba-30e5-4f49-a785-5680e7a30e21 cloud.antifield.work 2>&1
echo "=== wait and recheck ==="
sleep 5
node /tmp/dns-lookup.mjs cloud.antifield.work
echo "=== also try www apex ==="
node /tmp/dns-lookup.mjs antifield.work
