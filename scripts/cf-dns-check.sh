#!/bin/bash
# Read-only DNS/HTTP check for the public hostname (local resolver, 1.1.1.1, 8.8.8.8, DoH-less).
#
# Exit code is 0 even when DNS is broken on purpose: this is a diagnostic, and the findings
# are in the output. The previous version could hand curl an empty --resolve value
# ("host:443:") when dig returned nothing, which made curl fail with a parse error instead of
# saying that the record was missing; that case is now reported explicitly.
set -euo pipefail

HOST=${PIFORGE_PUBLIC_HOST:-cloud.antifield.work}

echo "=== local ==="
getent hosts "$HOST" || echo local-unresolved
echo "=== 1.1.1.1 ==="
nslookup "$HOST" 1.1.1.1 2>&1 | tail -8 || true
echo "=== 8.8.8.8 ==="
nslookup "$HOST" 8.8.8.8 2>&1 | tail -8 || true
echo "=== dig +short ==="
RESOLVED_IP=""
if command -v dig >/dev/null 2>&1; then
  RESOLVED_IP=$(dig +short "$HOST" @1.1.1.1 2>/dev/null | head -1 || true)
  echo "${RESOLVED_IP:-(no answer from 1.1.1.1)}"
else
  echo "(dig not installed — install dnsutils for this section)"
fi

echo "=== curl with --resolve ==="
if [[ -z "$RESOLVED_IP" ]]; then
  echo "SKIP: no A record for $HOST from 1.1.1.1, so there is no address to --resolve to."
  echo "      Either the record is missing/not proxied yet, or UDP DNS to 1.1.1.1 is blocked."
  echo "      Check the authoritative answer with: dig +short $HOST @1.1.1.1 (or the DoH twin)."
else
  curl -sS -m 20 --resolve "$HOST:443:$RESOLVED_IP" \
    -w "\nHTTP %{http_code}\n" "https://$HOST/api/v1/health" 2>&1 || true
fi

echo "=== curl default ==="
curl -sS -m 20 -w "\nHTTP %{http_code}\n" "https://$HOST/api/v1/health" 2>&1 || true
