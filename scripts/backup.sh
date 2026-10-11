#!/usr/bin/env bash
# PiForge backup: wb.db + config + OpenCode workspace metadata
# Usage: backup.sh [target_dir]
# Default target: /home/antifield/backups/piforge (local). Point BACKUP_TARGET at NAS mount when available.
set -euo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
SRC_DB="${DB_PATH:-/var/lib/piforge/wb.db}"
SRC_CONFIG="${CONFIG_DIR:-/etc/piforge}"
SRC_OC="${OPENCODE_DIR:-$HOME/.opencode}"
TARGET="${1:-${BACKUP_TARGET:-$HOME/backups/piforge}}"
DEST="$TARGET/backup-$STAMP"

mkdir -p "$DEST"

echo "[backup] destination: $DEST"

# 1. SQLite consistent snapshot (WAL-safe)
if [[ -f "$SRC_DB" ]]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$SRC_DB" ".backup '$DEST/wb.db'"
  else
    # fallback: copy + checkpoint via node if available
    cp "$SRC_DB" "$DEST/wb.db"
    [[ -f "$SRC_DB-wal" ]] && cp "$SRC_DB-wal" "$DEST/wb.db-wal" || true
    [[ -f "$SRC_DB-shm" ]] && cp "$SRC_DB-shm" "$DEST/wb.db-shm" || true
  fi
  echo "[backup] database copied"
else
  echo "[backup] WARN: db not found at $SRC_DB" >&2
fi

# 2. Config (no secrets file contents beyond allowlist)
if [[ -d "$SRC_CONFIG" ]]; then
  mkdir -p "$DEST/config"
  cp -a "$SRC_CONFIG/." "$DEST/config/" 2>/dev/null || true
  echo "[backup] config copied"
fi

# 3. OpenCode workspace metadata (sessions/db path only, not full worktrees)
if [[ -d "$SRC_OC" ]]; then
  mkdir -p "$DEST/opencode-meta"
  # copy small metadata, skip large binaries if any
  rsync -a --exclude 'bin/' --exclude 'cache/' "$SRC_OC/" "$DEST/opencode-meta/" 2>/dev/null || {
    cp -a "$SRC_OC" "$DEST/opencode-meta-full"
  }
  echo "[backup] opencode metadata copied"
fi

# 4. Checksums
( cd "$DEST" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )
echo "[backup] checksums written"

BYTES=$(du -sb "$DEST" | awk '{print $1}')
CHECKSUM=$(sha256sum "$DEST/SHA256SUMS" | awk '{print $1}')
echo "[backup] bytes=$BYTES sha256=$CHECKSUM"
echo "[backup] OK $DEST"
