#!/usr/bin/env bash
# Restore drill: prove that PiForge backups can actually be restored.
#
#   scripts/restore-drill.sh [backup_root]
#   scripts/restore-drill.sh --all [backup_root]
#   scripts/restore-drill.sh --allow-partial [backup_root]
#
# Per archive, in this order:
#   1. the archive must not be PARTIAL — backup.sh stamps STATUS=partial when data was missing,
#      and a partial archive is not a restorable backup, so it fails the drill by default
#      (--allow-partial inspects it anyway and the drill then proves only self-consistency);
#   2. `sha256sum -c SHA256SUMS` runs on the archive itself, before anything is copied out of it;
#   3. the copy in a scratch directory is re-checked with verify-restore.mjs (PRAGMA
#      integrity_check plus the core tables) and wb.db must be present.
# Any failure exits non-zero. Without --all only the newest archive is drilled; --all walks
# every backup-* directory, so an archive that once passed is not assumed to pass forever.
#
# Backups are root-only (0750, secrets 0600), so the drill re-execs itself through sudo
# when it is not already running as root.
#
# Environment:
#   KEEP_SCRATCH=1        keep the scratch directories (their paths are printed)
#   BACKUP_TARGET         backup root, same as the first positional argument
#   DB_PATH               wb.db used for the drill record and the status fallback
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  # `sudo -n` first: a non-interactive probe cannot hang waiting for a password, and on
  # the Pi antifield has NOPASSWD sudo. Without it we keep going and let the checks below
  # fail loudly instead of blocking on a prompt.
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    exec sudo -- "$0" "$@"
  fi
  printf '[restore] WARN: not running as root and non-interactive sudo is unavailable; root-owned backups may be unreadable\n' >&2
fi

ALL=0
ALLOW_PARTIAL=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    --allow-partial) ALLOW_PARTIAL=1 ;;
    -*) printf '[restore] ERROR: unknown option %s (supported: --all, --allow-partial)\n' "$arg" >&2; exit 2 ;;
    *)
      if [[ -n "$TARGET" ]]; then
        printf '[restore] ERROR: more than one backup root given (%s, %s)\n' "$TARGET" "$arg" >&2
        exit 2
      fi
      TARGET="$arg"
      ;;
  esac
done

NEW_TARGET=/var/lib/piforge/backups/piforge
LEGACY_TARGET=/home/antifield/backups/piforge
DB="${DB_PATH:-/var/lib/piforge/wb.db}"

if [[ -n "$TARGET" ]]; then
  :
elif [[ -n "${BACKUP_TARGET:-}" ]]; then
  TARGET="$BACKUP_TARGET"
elif [[ -d "$NEW_TARGET" ]]; then
  TARGET="$NEW_TARGET"
else
  TARGET="$LEGACY_TARGET"
fi

step() { printf '[restore] %s\n' "$*"; }
fail_step() {
  printf '[restore] FAIL: %s\n' "$*" >&2
  FAILED=1
}
FAILED=0
SCRATCHES=()

cleanup() {
  local dir
  if [[ "${KEEP_SCRATCH:-0}" == "1" ]]; then
    for dir in ${SCRATCHES[@]+"${SCRATCHES[@]}"}; do
      printf '[restore] scratch kept: %s\n' "$dir"
    done
    return 0
  fi
  for dir in ${SCRATCHES[@]+"${SCRATCHES[@]}"}; do
    rm -rf -- "$dir"
  done
}
trap cleanup EXIT

# Archive status: the STATUS file written by backup.sh is authoritative. Archives written before
# that marker existed have none, so fall back to the backup_runs row for this exact directory
# (the console path records only the backup root, hence the per-archive file as the primary).
archive_status() { # backup-dir
  local dir="$1" status=""
  status=$(head -n1 "$dir/STATUS" 2>/dev/null || true)
  status="${status//[[:space:]]/}"
  if [[ -z "$status" && -f "$DB" ]] && command -v node >/dev/null 2>&1; then
    status=$(node -e '
      const { DatabaseSync } = require("node:sqlite")
      const db = new DatabaseSync(process.argv[1], { readOnly: true })
      let status = ""
      try {
        const row = db.prepare("SELECT status FROM backup_runs WHERE target = ? ORDER BY id DESC LIMIT 1").get(process.argv[2])
        status = row ? row.status : ""
      } catch {}
      db.close()
      process.stdout.write(status)
    ' "$DB" "$dir" 2>/dev/null || true)
  fi
  printf '%s\n' "${status:-unknown}"
}

drill_one() { # backup-dir
  local backup="$1" status scratch before="$FAILED" files bytes
  status=$(archive_status "$backup")
  step "source=$backup archive-status=$status"

  case "$status" in
    ok) ;;
    unknown)
      step "note: $backup has no STATUS marker and no backup_runs row; treating it as complete"
      ;;
    *)
      if ((ALLOW_PARTIAL)); then
        printf '[restore] WARN: %s is %s — --allow-partial given, a PASS below only proves the archive is self-consistent\n' "$backup" "$status" >&2
      else
        fail_step "$backup is marked $status — a partial archive is not a restorable backup (re-run with --allow-partial to inspect it anyway)"
        return 0
      fi
      ;;
  esac

  # Verify the manifest against the archive itself, before copying or unpacking anything.
  if [[ ! -f "$backup/SHA256SUMS" ]]; then
    fail_step "SHA256SUMS missing from $backup (nothing was unpacked)"
    return 0
  fi
  if ! (cd "$backup" && sha256sum -c --quiet SHA256SUMS); then
    fail_step "sha256sum -c SHA256SUMS failed for $backup (archive corrupt or modified; nothing was unpacked)"
    return 0
  fi
  step "checksums OK ($(wc -l <"$backup/SHA256SUMS" | tr -d ' ') files)"

  scratch=$(mktemp -d "${TMPDIR:-/tmp}/piforge-restore-XXXXXX")
  SCRATCHES+=("$scratch")
  chmod 700 "$scratch"

  if ! cp -a "$backup/." "$scratch/"; then
    fail_step "could not copy $backup into the scratch directory"
    return 0
  fi

  if [[ -f "$scratch/wb.db" ]]; then
    if node "$SCRIPT_DIR/verify-restore.mjs" "$scratch/wb.db"; then
      step "database integrity_check OK and all core tables present"
    else
      fail_step "verify-restore.mjs rejected the restored database (JSON above)"
    fi
  else
    fail_step "wb.db missing from $backup"
  fi

  if ((FAILED == before)); then
    files=$(find "$scratch" -type f | wc -l | tr -d ' ')
    bytes=$(du -sb "$scratch" | awk '{print $1}')
    step "PASS $backup ($files files, $bytes bytes)"
  fi
}

if [[ ! -d "$TARGET" ]]; then
  printf '[restore] FAIL: backup root %s does not exist\n' "$TARGET" >&2
  exit 1
fi

if ((ALL)); then
  mapfile -t BACKUPS < <(find "$TARGET" -maxdepth 1 -mindepth 1 -type d -name 'backup-*' 2>/dev/null | sort -r)
else
  mapfile -t BACKUPS < <(find "$TARGET" -maxdepth 1 -mindepth 1 -type d -name 'backup-*' 2>/dev/null | sort -r | head -n1)
fi
if ((${#BACKUPS[@]} == 0)); then
  printf '[restore] FAIL: no backup-* directory under %s\n' "$TARGET" >&2
  exit 1
fi
step "drilling ${#BACKUPS[@]} archive(s) under $TARGET"

for backup in "${BACKUPS[@]}"; do
  drill_one "$backup"
done

# Record the drill outcome so the workbench backup panel can show it (P3.7).
record_drill() { # ok?
  command -v node >/dev/null 2>&1 || return 0
  [[ -f "$DB" ]] || return 0
  node -e '
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(process.argv[1])
    db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    set.run("restore_drill_at", String(Date.now()))
    set.run("restore_drill_ok", process.argv[2])
    db.close()
  ' "$DB" "$1" 2>/dev/null || true
}

if ((FAILED)); then
  record_drill 0
  printf '[restore] FAIL: at least one archive under %s did not restore cleanly\n' "$TARGET" >&2
  exit 1
fi

record_drill 1
printf '[restore] PASS: all %s archive(s) under %s restore cleanly\n' "${#BACKUPS[@]}" "$TARGET"
