#!/usr/bin/env bash
# Restore drill: restore latest backup into a scratch dir and verify checksums + db open
set -euo pipefail

TARGET="${1:-$HOME/backups/piforge}"
LATEST=$(ls -1dt "$TARGET"/backup-* 2>/dev/null | head -1)
if [[ -z "${LATEST:-}" ]]; then
  echo "[restore] no backups found in $TARGET" >&2
  exit 1
fi

SCRATCH=$(mktemp -d /tmp/piforge-restore-XXXXXX)
echo "[restore] source=$LATEST scratch=$SCRATCH"

cp -a "$LATEST/." "$SCRATCH/"
cd "$SCRATCH"
sha256sum -c SHA256SUMS
echo "[restore] checksums OK"

if [[ -f wb.db ]]; then
  SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
  node "$SCRIPT_DIR/verify-restore.mjs" "$SCRATCH/wb.db"
  echo "[restore] database opens OK"
else
  echo "[restore] WARN: wb.db missing" >&2
fi

echo "[restore] DRILL OK — scratch=$SCRATCH (delete when done)"
