#!/bin/bash
# LEGACY (reference only). Superseded by scripts/cf-api-dns.sh + scripts/cf-dns-check.sh.
# See scripts/legacy/README.md — do not run this against the Pi.
set -euo pipefail
echo "=== cert.pem (redacted) ==="
# show only non-secret structure
sudo head -c 200 /home/antifield/.cloudflared/cert.pem | sed 's/-----.*//' | head -c 80
echo
echo "=== openssl subject ==="
sudo openssl x509 -in /home/antifield/.cloudflared/cert.pem -noout -subject -issuer -dates 2>/dev/null || true
echo "=== try route dns again with -f ==="
cloudflared tunnel route dns --overwrite-dns b6683fba-30e5-4f49-a785-5680e7a30e21 cloud.antifield.work 2>&1
echo "=== wait and recheck ==="
sleep 5
node /tmp/dns-lookup.mjs cloud.antifield.work
echo "=== also try www apex ==="
node /tmp/dns-lookup.mjs antifield.work
