#!/bin/bash
# Dump one OpenCode session's messages through scripts/dump-msgs.mjs.
# Usage: oc-dump-msgs.sh <session-id>
#
# The password is read from the local OpenCode config via lib/env.sh and passed to curl in a
# 0600 --config file. This used to shell out to /tmp/dump-msgs.mjs; it now uses the copy that
# actually lives in the repo.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

OC_BASE=${OPENCODE_BASE:-http://127.0.0.1:4096}
SID="${1:-}"
if [[ -z "$SID" ]]; then
  echo "usage: $(basename -- "$0") <session-id>" >&2
  exit 2
fi

OC_PASSWORD=$(piforge_opencode_password) || {
  echo "OpenCode password not found: set OPENCODE_PASSWORD, or provide a local service.json" >&2
  exit 1
}
piforge_tmpfile
CURLRC=$PIFORGE_TMPFILE
piforge_curlrc "$CURLRC" opencode "$OC_PASSWORD"
unset OC_PASSWORD

curl -sS --config "$CURLRC" "$OC_BASE/api/session/$SID/message" | node "$SCRIPT_DIR/dump-msgs.mjs"
