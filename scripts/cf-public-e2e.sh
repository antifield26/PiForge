#!/bin/bash
# Public HTTPS end-to-end check through the Cloudflare edge IPs (health, login, console).
#
# Credentials: read from gateway.env through lib/env.sh (never sourced, so nothing is
# exported into curl's environment), login body is a 0600 --data @file, and the session
# cookie jar is a 0600 mktemp removed on exit instead of a predictable /tmp path.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

HOST=${PIFORGE_PUBLIC_HOST:-cloud.antifield.work}
IP=${PIFORGE_PUBLIC_IP:-104.21.39.129}
EDGE_IPS=${PIFORGE_PUBLIC_IPS:-"104.21.39.129 172.67.145.77"}

ENV_FILE=$(piforge_gateway_env) || {
  echo "gateway.env not found (looked in /etc/piforge and /home/antifield/piforge)" >&2
  exit 1
}
ADMIN_USER=$(piforge_env_get "$ENV_FILE" ADMIN_USER)
ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_PASSWORD=$(piforge_env_get "$ENV_FILE" ADMIN_PASSWORD)
if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ADMIN_PASSWORD is not set in $ENV_FILE" >&2
  exit 1
fi

piforge_tmpfile
JAR=$PIFORGE_TMPFILE
piforge_tmpfile
LOGIN_BODY=$PIFORGE_TMPFILE
printf '%s' "$ADMIN_PASSWORD" | piforge_login_body "$ADMIN_USER" > "$LOGIN_BODY"

read -r -a edge_ips <<<"$EDGE_IPS"
for ip in "${edge_ips[@]}"; do
  [[ -n "$ip" ]] || continue
  echo "=== via $ip ==="
  curl -sS -m 20 --resolve "$HOST:443:$ip" \
    -w "\nHTTP %{http_code}\n" "https://$HOST/api/v1/health" || true
done

echo "=== login via resolve ($IP) ==="
curl -sS -m 20 --resolve "$HOST:443:$IP" \
  -c "$JAR" \
  -H 'content-type: application/json' \
  --data @"$LOGIN_BODY" \
  "https://$HOST/api/v1/auth/login"
echo
curl -sS -m 20 --resolve "$HOST:443:$IP" \
  -b "$JAR" \
  "https://$HOST/api/v1/console/system"
echo
