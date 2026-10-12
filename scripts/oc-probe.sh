#!/bin/bash
# Smoke-probe the local OpenCode server (info / location / sessions / events / agents).
#
# The password is read from the local OpenCode config by lib/env.sh's
# piforge_opencode_password and handed to curl in a 0600 --config file: it is never written
# to disk and never appears in argv. The previous version grepped it out of
# /tmp/oc-serve.log and cached it in the world-readable /tmp/oc-pw.txt for the other oc-*.sh
# scripts; a stale copy of that file is deleted here (run this once after upgrading).
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

OC_BASE=${OPENCODE_BASE:-http://127.0.0.1:4096}

if [[ -e /tmp/oc-pw.txt ]]; then
  echo "removing legacy credential file /tmp/oc-pw.txt (the oc-* scripts read the config now)"
  chmod 600 /tmp/oc-pw.txt 2>/dev/null || true
  rm -f -- /tmp/oc-pw.txt
fi

OC_PASSWORD=$(piforge_opencode_password) || {
  echo "OpenCode password not found: set OPENCODE_PASSWORD, or provide a local service.json" >&2
  echo "in the OpenCode home (or a readable /etc/piforge/opencode.env via sudo)." >&2
  exit 1
}
echo "pw_len=${#OC_PASSWORD}"

piforge_tmpfile
CURLRC=$PIFORGE_TMPFILE
piforge_curlrc "$CURLRC" opencode "$OC_PASSWORD"
unset OC_PASSWORD

echo "=== INFO ==="
curl -sS -m 5 --config "$CURLRC" "$OC_BASE/api/info"
echo
echo "=== LOCATION ==="
curl -sS -m 5 --config "$CURLRC" "$OC_BASE/api/location"
echo
echo "=== SESSIONS ==="
curl -sS -m 5 --config "$CURLRC" "$OC_BASE/api/session"
echo
echo "=== SSE 2s ==="
timeout 2 curl -sS -N --config "$CURLRC" "$OC_BASE/api/event" | head -8 || true
echo
echo "=== AGENTS ==="
curl -sS -m 5 --config "$CURLRC" "$OC_BASE/api/agent" | head -c 400 || true
echo
