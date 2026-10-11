#!/bin/bash
HOST=cloud.antifield.work
echo "=== local ==="
getent hosts "$HOST" || echo local-unresolved
echo "=== 1.1.1.1 ==="
nslookup "$HOST" 1.1.1.1 2>&1 | tail -8 || true
echo "=== 8.8.8.8 ==="
nslookup "$HOST" 8.8.8.8 2>&1 | tail -8 || true
echo "=== dig +short ==="
dig +short "$HOST" @1.1.1.1 2>/dev/null || true
echo "=== curl remote DNS ==="
curl -sS -m 20 --resolve "$HOST:443:$(dig +short "$HOST" @1.1.1.1 | head -1)" \
  -w "\nHTTP %{http_code}\n" "https://$HOST/api/v1/health" 2>&1 || true
echo "=== curl default ==="
curl -sS -m 20 -w "\nHTTP %{http_code}\n" "https://$HOST/api/v1/health" 2>&1 || true
