#!/bin/bash
# Console metrics smoke test (gateway on localhost).
#
# Credentials: read from gateway.env through lib/env.sh (never sourced), login body passed
# as a 0600 --data @file, session cookie jar is a 0600 mktemp removed on exit.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

BASE=${BASE:-http://127.0.0.1:8787}

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

curl -sS -c "$JAR" -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' --data @"$LOGIN_BODY" > /dev/null

echo "=== SUMMARY ==="
curl -sS -b "$JAR" "$BASE/api/v1/console/metrics/summary" | head -c 500
echo
echo "=== CSV ==="
curl -sS -b "$JAR" "$BASE/api/v1/console/metrics/export?kind=temp&format=csv" | head -6
echo
