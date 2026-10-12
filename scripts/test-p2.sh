#!/bin/bash
# P2 smoke test: perf report, file upload/versioning, PWA assets (gateway on localhost).
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

echo "=== PERF ==="
curl -sS -b "$JAR" "$BASE/api/v1/console/perf"
echo
echo "=== FILE v1 ==="
B1=$(printf 'version one' | base64 -w0)
curl -sS -b "$JAR" -X POST "$BASE/api/v1/files" \
  -H 'content-type: application/json' \
  --data-raw "{\"name\":\"note.txt\",\"contentBase64\":\"$B1\"}"
echo
echo "=== FILE v2 overwrite ==="
B2=$(printf 'version two' | base64 -w0)
curl -sS -b "$JAR" -X POST "$BASE/api/v1/files" \
  -H 'content-type: application/json' \
  --data-raw "{\"name\":\"note.txt\",\"contentBase64\":\"$B2\"}"
echo
echo "=== VERSIONS ==="
FID=$(curl -sS -b "$JAR" "$BASE/api/v1/files" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const f=(j.items||[]).find(x=>x.name==="note.txt");console.log(f?f.id:"")})')
curl -sS -b "$JAR" "$BASE/api/v1/files/$FID/versions"
echo
echo "=== MANIFEST ==="
curl -sS -o /dev/null -w 'manifest %{http_code}\n' "$BASE/manifest.webmanifest"
curl -sS -o /dev/null -w 'icon %{http_code}\n' "$BASE/icon.svg"
