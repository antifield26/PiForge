#!/bin/bash
# Post-deploy verification: services, health, OpenCode behind the gateway, console, allowlist.
#
# Credentials: gateway.env is read through lib/env.sh (never sourced); the OpenCode password
# travels in a 0600 curl --config file (piforge_curlrc) instead of "-u opencode:...", the
# login body is a 0600 --data @file, and every scratch file is a 0600 mktemp removed on exit.
# Every HTTP check goes through piforge_http_expect, so a non-200 (or a 4xx/5xx that plain
# `curl -sS` would exit 0 on) fails this script instead of printing a body and passing.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

BASE=${BASE:-http://127.0.0.1:8787}
OC_BASE=${OPENCODE_BASE:-http://127.0.0.1:4096}

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

echo "=== systemd ==="
systemctl is-active opencode-serve wb-gateway
echo "=== gateway health ==="
piforge_http_expect 200 -m 5 "$BASE/api/v1/health"
echo "=== opencode info ==="
if OC_PASSWORD=$(piforge_opencode_password); then
  piforge_tmpfile
  CURLRC=$PIFORGE_TMPFILE
  piforge_curlrc "$CURLRC" opencode "$OC_PASSWORD"
  unset OC_PASSWORD
  piforge_http_expect 200 -m 5 --config "$CURLRC" "$OC_BASE/api/info"
else
  echo "opencode password unavailable (no service.json in the OpenCode home, no readable /etc/piforge/opencode.env)" >&2
fi
echo "=== login gateway ==="
piforge_http_expect 200 -m 5 -c "$JAR" -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  --data @"$LOGIN_BODY"
echo "=== agent info via gateway ==="
piforge_http_expect 200 -m 5 -b "$JAR" "$BASE/api/v1/agent/info"
echo "=== console system ==="
piforge_http_expect 200 -m 5 -b "$JAR" "$BASE/api/v1/console/system"
echo "=== allowlist reject (403 expected) ==="
piforge_http_expect 403 -m 5 -b "$JAR" -X POST "$BASE/api/v1/console/services/ssh.service/restart"
echo "=== listening ports ==="
ss -lnt | grep -E '4096|8787' || true
