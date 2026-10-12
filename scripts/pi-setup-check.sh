#!/bin/bash
# Pi runtime sanity check: dependency layout, gateway import, local health endpoint.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

if [[ -f "$REPO_ROOT/package.json" ]]; then
  cd "$REPO_ROOT"
  # Stale nested build output from an earlier packaging mistake.
  rm -rf -- "$REPO_ROOT/packages/gateway/dist/dist"
else
  echo "refusing to run: $REPO_ROOT does not look like the PiForge checkout" >&2
  exit 1
fi

echo "=== node_modules root ==="
ls node_modules | head -15
echo "=== gateway package ==="
ls packages/gateway
echo "=== try import ==="
node --input-type=module -e 'import("./packages/gateway/dist/index.js").catch(e => { console.error("IMPORT_ERR", e.message); process.exit(1) })' &
import_pid=$!
sleep 2
curl -sS -m 3 http://127.0.0.1:8787/api/v1/health || echo "no health"
kill "$import_pid" 2>/dev/null || true
wait "$import_pid" 2>/dev/null || true
