#!/bin/bash
# Check that both Cloudflare edge IPs serve the SPA shell and the JS bundle it references.
#
# The asset check used to hardcode a build hash (index-CbpUvvFc.js), so it reported a 404 for
# every newer build; the asset path is now taken from the HTML that was just fetched.
set -euo pipefail

HOST=${PIFORGE_PUBLIC_HOST:-cloud.antifield.work}
EDGE_IPS=${PIFORGE_PUBLIC_IPS:-"104.21.39.129 172.67.145.77"}

read -r -a edge_ips <<<"$EDGE_IPS"
for ip in "${edge_ips[@]}"; do
  [[ -n "$ip" ]] || continue
  echo "=== $ip GET / ==="
  page=$(curl -sS -m 15 --resolve "$HOST:443:$ip" "https://$HOST/")
  printf '%s\n' "$page" | head -12
  asset=$(printf '%s' "$page" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1 || true)
  if [[ -z "$asset" ]]; then
    echo "no /assets/*.js reference in the served HTML (SPA shell missing or not built)"
    continue
  fi
  echo "=== $ip asset $asset ==="
  curl -sS -m 15 -o /dev/null -w "asset HTTP %{http_code}\n" --resolve "$HOST:443:$ip" "https://$HOST$asset"
done
