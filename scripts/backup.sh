#!/usr/bin/env bash
# PiForge backup: consistent wb.db snapshot + /etc/piforge + OpenCode metadata.
#
#   scripts/backup.sh [target_dir]
#
# Paths default to the post-migration layout and fall back to the legacy layout
# (/home/antifield/piforge/data, /home/antifield/piforge/config, /home/antifield/.opencode)
# so the script works before and after scripts/deploy-pi.sh has been run.
#
# Intended to run as root (deploy/piforge-backup.timer runs it nightly). The console's
# "run backup now" button runs it as piforge-gw, which cannot read the OpenCode tree or
# /etc/piforge/opencode.env; those parts are skipped with an explicit warning instead of
# silently producing a smaller backup.
#
# The resulting tree is root-only (0750, secrets and metadata 0600) and protected by
# SHA256SUMS; read it through sudo (scripts/restore-drill.sh re-execs itself as root).
#
# Environment:
#   DB_PATH, CONFIG_DIR, OPENCODE_DIR   override the source paths
#   BACKUP_TARGET                       override the target root
#   KEEP                                how many backup-* dirs to keep (default 14)
#   ALLOW_MISSING_DB=1                  continue when wb.db is absent (restore testing)
#   PIFORGE_SKIP_RECORD=1               do not write a backup_runs row
#
# Exit codes: 0 ok / 2 database missing / 1 anything else.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

STAMP=$(date +%Y%m%d-%H%M%S)
STARTED_MS=$(date +%s%3N)
KEEP="${KEEP:-14}"
ALLOW_MISSING_DB="${ALLOW_MISSING_DB:-0}"

NEW_STATE=/var/lib/piforge
LEGACY_STATE=/home/antifield/piforge/data
NEW_CONFIG=/etc/piforge
LEGACY_CONFIG=/home/antifield/piforge/config
NEW_OC=/var/lib/piforge-oc
# Legacy layout: the OpenCode trees lived in antifield's home directory, not in ~/.opencode
# (the loop below looks for <OPENCODE_DIR>/.config/opencode, .local/share/opencode, ...).
LEGACY_OC=/home/antifield
NEW_TARGET=/var/lib/piforge/backups/piforge
LEGACY_TARGET=/home/antifield/backups/piforge

WARNINGS=()

note() { printf '[backup] %s\n' "$*"; }
warn() {
  printf '[backup] WARN: %s\n' "$*" >&2
  WARNINGS+=("$*")
}

# Set when a required part of the backup could not be captured (permissions, unreadable or
# missing source, failed copy). The snapshot is still usable, but the run must not be
# reported as a clean "ok" — that is exactly how a false-green backup happens.
INCOMPLETE=0
incomplete() {
  INCOMPLETE=1
  warn "$*"
}

# First existing file/dir wins; empty arguments are ignored so env overrides only apply
# when they actually point at something.
pick_file() {
  local candidate
  for candidate in "$@"; do
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}
pick_dir() {
  local candidate
  for candidate in "$@"; do
    if [[ -n "$candidate" && -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

SRC_DB=$(pick_file "${DB_PATH:-}" "$NEW_STATE/wb.db" "$LEGACY_STATE/wb.db" || true)
SRC_DB="${SRC_DB:-${DB_PATH:-$NEW_STATE/wb.db}}"
SRC_CONFIG=$(pick_dir "${CONFIG_DIR:-}" "$NEW_CONFIG" "$LEGACY_CONFIG" || true)
SRC_OC=$(pick_dir "${OPENCODE_DIR:-}" "$NEW_OC" "$LEGACY_OC" || true)

if [[ -n "${1:-}" ]]; then
  TARGET="$1"
elif [[ -n "${BACKUP_TARGET:-}" ]]; then
  TARGET="$BACKUP_TARGET"
elif [[ -d "$NEW_STATE" ]]; then
  TARGET="$NEW_TARGET"
else
  TARGET="$LEGACY_TARGET"
fi
DEST="$TARGET/backup-$STAMP"

# ---------------------------------------------------------------------------
# 0. Preconditions
# ---------------------------------------------------------------------------
if [[ ! -f "$SRC_DB" ]]; then
  printf '[backup] ERROR: database not found (%s or %s)\n' "${DB_PATH:-$NEW_STATE/wb.db}" "$LEGACY_STATE/wb.db" >&2
  if [[ "$ALLOW_MISSING_DB" == "1" ]]; then
    warn "ALLOW_MISSING_DB=1: continuing without a database (restore testing only)"
  else
    printf '[backup] refusing to write an empty backup; set ALLOW_MISSING_DB=1 only for restore testing\n' >&2
    exit 2
  fi
fi

if ! mkdir -p "$TARGET" 2>/dev/null; then
  printf '[backup] ERROR: cannot create target %s\n' "$TARGET" >&2
  exit 1
fi
if [[ ! -w "$TARGET" ]]; then
  printf '[backup] ERROR: target %s is not writable by %s\n' "$TARGET" "$(id -un)" >&2
  exit 1
fi

umask 027
# Two runs inside the same second (console button + timer) must not share a directory.
if [[ -e "$DEST" ]]; then
  DEST="$TARGET/backup-$STAMP-$$"
  note "same-second collision: writing to $(basename "$DEST") instead"
fi
mkdir -p "$DEST"
chmod 0750 "$DEST"
note "destination: $DEST"

# ---------------------------------------------------------------------------
# 1. SQLite snapshot (WAL-safe, never a copy of the live db/wal/shm triple)
# ---------------------------------------------------------------------------
snapshot_db() {
  local src="$1" dest="$2"
  if command -v sqlite3 >/dev/null 2>&1; then
    # SQLite online backup API: consistent while the gateway writes in WAL mode.
    # sqlite3 still exits 0 when a dot-command fails, so check the file it produced.
    if sqlite3 "$src" ".backup \"$dest\"" && [[ -s "$dest" ]]; then
      return 0
    fi
    rm -f -- "$dest"
    warn "sqlite3 .backup did not produce $dest; falling back to node:sqlite"
  fi
  # node:sqlite is always present with Node 26; VACUUM INTO is atomic and WAL-safe, and a
  # read-only source connection guarantees the live database is never modified.
  node -e '
    const { DatabaseSync } = require("node:sqlite")
    const [src, dest] = process.argv.slice(1)
    const db = new DatabaseSync(src, { readOnly: true })
    try {
      db.prepare("VACUUM INTO ?").run(dest)
    } finally {
      db.close()
    }
  ' "$src" "$dest"
  [[ -s "$dest" ]]
}

record_run() {
  local status="$1" message="$2"
  if [[ "${PIFORGE_SKIP_RECORD:-0}" == "1" ]]; then
    note "PIFORGE_SKIP_RECORD=1: not recording this run"
    return 0
  fi
  if [[ ! -f "$SRC_DB" ]]; then
    return 0
  fi
  # Recording must never fail the backup, and never print secret values.
  node "$SCRIPT_DIR/backup-record.mjs" \
    --db "$SRC_DB" \
    --status "$status" \
    --target "$DEST" \
    --bytes "${BYTES:-0}" \
    --checksum "${CHECKSUM:-}" \
    --message "$message" \
    --started-at "$STARTED_MS" >/dev/null ||
    warn "could not record this run in wb.db (non-fatal)"
}

if [[ -f "$SRC_DB" ]]; then
  if snapshot_db "$SRC_DB" "$DEST/wb.db"; then
    chmod 0600 "$DEST/wb.db"
    note "database snapshot: $SRC_DB -> wb.db ($(stat -c '%s' "$DEST/wb.db") bytes)"
  else
    warn "database snapshot failed"
    record_run failed "snapshot failed"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 2. Config (/etc/piforge: allowlist, gateway.env, opencode.env, backup.env)
# ---------------------------------------------------------------------------
if [[ -n "$SRC_CONFIG" ]]; then
  mkdir -p "$DEST/config"
  cp -a "$SRC_CONFIG/." "$DEST/config/" 2>/dev/null || incomplete "could not copy every file from $SRC_CONFIG"
  # Secrets and runtime config are root-only in the archive.
  find "$DEST/config" -type d -exec chmod 0700 {} +
  find "$DEST/config" -type f -exec chmod 0600 {} +
  note "config copied from $SRC_CONFIG"
  for secret in gateway.env opencode.env backup.env; do
    if [[ -f "$SRC_CONFIG/$secret" && ! -r "$SRC_CONFIG/$secret" ]]; then
      incomplete "cannot read $SRC_CONFIG/$secret — this backup is INCOMPLETE (run as root)"
    fi
  done
else
  incomplete "no config directory found ($NEW_CONFIG or $LEGACY_CONFIG)"
fi

# ---------------------------------------------------------------------------
# 3. OpenCode metadata (config/auth/state, never the binary, cache or workspace)
# ---------------------------------------------------------------------------
if [[ -n "$SRC_OC" ]]; then
  for rel in .config/opencode .local/state/opencode .local/share/opencode .opencode; do
    if [[ ! -d "$SRC_OC/$rel" ]]; then
      continue
    fi
    if [[ ! -r "$SRC_OC/$rel" ]]; then
      incomplete "cannot read $SRC_OC/$rel — this backup is INCOMPLETE (run as root)"
      continue
    fi
    mkdir -p "$DEST/opencode-meta/$(dirname "$rel")"
    if command -v rsync >/dev/null 2>&1; then
      # bin/ is the opencode binary; cache/ and workspace/ are large and reproducible.
      rsync -a --exclude 'bin/' --exclude 'cache/' --exclude 'workspace/' \
        "$SRC_OC/$rel/" "$DEST/opencode-meta/$rel/" || incomplete "rsync failed for $SRC_OC/$rel"
    else
      cp -a "$SRC_OC/$rel" "$DEST/opencode-meta/$(dirname "$rel")/" || incomplete "cp failed for $SRC_OC/$rel"
    fi
  done
  if [[ -d "$DEST/opencode-meta" ]]; then
    find "$DEST/opencode-meta" -type d -exec chmod 0700 {} +
    find "$DEST/opencode-meta" -type f -exec chmod 0600 {} +
    note "OpenCode metadata copied from $SRC_OC (workspace/ and cache/ excluded)"
  else
    incomplete "no OpenCode metadata found under $SRC_OC"
  fi
else
  incomplete "no OpenCode home found ($NEW_OC or $LEGACY_OC)"
fi

# ---------------------------------------------------------------------------
# 4. Checksums
# ---------------------------------------------------------------------------
BYTES=0
CHECKSUM=""
if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$DEST"
    find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 -r sha256sum >SHA256SUMS
    chmod 0600 SHA256SUMS
  )
  CHECKSUM=$(sha256sum "$DEST/SHA256SUMS" | awk '{print $1}')
  note "checksums written ($(wc -l <"$DEST/SHA256SUMS" | tr -d ' ') files)"
else
  incomplete "sha256sum not available: no SHA256SUMS written"
fi
BYTES=$(du -sb "$DEST" | awk '{print $1}')
note "bytes=$BYTES sha256=${CHECKSUM:-n/a}"

# ---------------------------------------------------------------------------
# 5. Record the run (best effort) and prune
# ---------------------------------------------------------------------------
MESSAGE="ok"
if ((INCOMPLETE)); then
  MESSAGE="PARTIAL: ${WARNINGS[0]:-incomplete}"
  record_run partial "$MESSAGE"
elif ((${#WARNINGS[@]} > 0)); then
  MESSAGE="ok with ${#WARNINGS[@]} warning(s): ${WARNINGS[0]}"
  record_run ok "$MESSAGE"
else
  record_run ok "$MESSAGE"
fi

if ! [[ "$KEEP" =~ ^[0-9]+$ ]]; then
  warn "KEEP=$KEEP is not a number; falling back to 14"
  KEEP=14
fi
keep_count=$KEEP
if ((keep_count < 1)); then
  keep_count=1
fi
index=0
while IFS= read -r old; do
  [[ -n "$old" ]] || continue
  index=$((index + 1))
  if ((index <= keep_count)); then
    continue
  fi
  case "$old" in
    "$TARGET"/backup-*) rm -rf -- "$old" && note "pruned $(basename "$old")" ;;
    *) warn "refusing to prune unexpected path $old" ;;
  esac
done < <(find "$TARGET" -maxdepth 1 -mindepth 1 -type d -name 'backup-*' 2>/dev/null | sort -r)

if ((INCOMPLETE)); then
  # Printed on stdout as well: the gateway's "run backup now" path classifies the run from stdout.
  note "PARTIAL $DEST"
  printf '[backup] PARTIAL %s — the archive exists but is missing data (run as root for a complete backup)\n' "$DEST" >&2
else
  note "OK $DEST"
fi
