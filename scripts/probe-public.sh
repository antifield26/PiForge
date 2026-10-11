#!/bin/bash
echo "=== DNS ==="
getent hosts cloud.antifield.work || echo dns-fail
echo "=== public health ==="
curl -sS -m 10 -w "\nHTTP %{http_code}\n" https://cloud.antifield.work/api/v1/health
echo "=== local health ==="
curl -sS -m 5 http://127.0.0.1:8787/api/v1/health
echo
echo "=== cloudflared ingress ==="
sudo cat /etc/cloudflared/config.yml
