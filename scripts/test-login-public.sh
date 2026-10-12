#!/bin/bash
# Compare login from localhost vs public HTTPS with the credential from gateway.env.
#
# Prints status/length information only: never password characters, never the stored hash.
# The credential is read through lib/env.sh without sourcing the env file, and travels to
# curl in a 0600 --data @file instead of on its command line.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

BASE=${BASE:-http://127.0.0.1:8787}
HOST=${PIFORGE_PUBLIC_HOST:-cloud.antifield.work}
IP=${PIFORGE_PUBLIC_IP:-104.21.39.129}

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

echo "username=$ADMIN_USER password_set=true password_len=${#ADMIN_PASSWORD}"

piforge_tmpfile
LOGIN_BODY=$PIFORGE_TMPFILE
printf '%s' "$ADMIN_PASSWORD" | piforge_login_body "$ADMIN_USER" > "$LOGIN_BODY"

echo "=== localhost login ==="
curl -sS -m 20 -w '\nHTTP %{http_code}\n' -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  --data @"$LOGIN_BODY"

echo "=== public login via $IP ==="
curl -sS -m 20 --resolve "$HOST:443:$IP" -w '\nHTTP %{http_code}\n' \
  -X POST "https://$HOST/api/v1/auth/login" \
  -H 'content-type: application/json' \
  --data @"$LOGIN_BODY"

echo "=== public login wrong password (expect 401) ==="
piforge_tmpfile
WRONG_BODY=$PIFORGE_TMPFILE
printf '%s' 'WRONG' | piforge_login_body "$ADMIN_USER" > "$WRONG_BODY"
curl -sS -m 20 --resolve "$HOST:443:$IP" -w '\nHTTP %{http_code}\n' \
  -X POST "https://$HOST/api/v1/auth/login" \
  -H 'content-type: application/json' \
  --data @"$WRONG_BODY"

echo "=== last login-related logs ==="
journalctl -u wb-gateway -n 20 --no-pager 2>/dev/null | grep -iE 'login|auth|401' | tail -10 || true
