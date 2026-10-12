#!/usr/bin/env bash
# Restore drill: prove that the newest PiForge backup can actually be restored.
#
#   scripts/restore-drill.sh [backup_root]
#
# Fails (non-zero) when: no backup is found, `sha256sum -c` fails, wb.db is missing,
# PRAGMA integrity_check is not "ok", or a core table is absent. The backup is restored
# into a scratch directory that is removed on exit unless KEEP_SCRATCH=1.
#
# Backups are root-only (0750, secrets 0600), so the drill re-execs itself through sudo
# when it is not already running as root.
#
# Environment:
#   KEEP_SCRATCH=1        keep the scratch directory (its path is printed)
#   BACKUP_TARGET         backup root, same as the first positional argument
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

NEW_TARGET=/var/lib/piforge/backups/piforge
LEGACY_TARGET=/home/antifield/backups/piforge

if [[ -n "${1:-}" ]]; then
  TARGET="$1"
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

if [[ ! -d "$TARGET" ]]; then
  printf '[restore] FAIL: backup root %s does not exist\n' "$TARGET" >&2
  exit 1
fi

LATEST=$(find "$TARGET" -maxdepth 1 -mindepth 1 -type d -name 'backup-*' 2>/dev/null | sort -r | head -n1 || true)
if [[ -z "$LATEST" ]]; then
  printf '[restore] FAIL: no backup-* directory under %s\n' "$TARGET" >&2
  exit 1
fi

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/piforge-restore-XXXXXX")
chmod 700 "$SCRATCH"

cleanup() {
  if [[ "${KEEP_SCRATCH:-0}" == "1" ]]; then
    printf '[restore] scratch kept: %s\n' "$SCRATCH"
    return 0
  fi
  rm -rf -- "$SCRATCH"
}
trap cleanup EXIT

printf '[restore] source=%s scratch=%s\n' "$LATEST" "$SCRATCH"

if ! cp -a "$LATEST/." "$SCRATCH/"; then
  fail_step "could not copy $LATEST into the scratch directory"
fi

if [[ -f "$SCRATCH/SHA256SUMS" ]]; then
  # --quiet prints only mismatching entries.
  if (cd "$SCRATCH" && sha256sum -c --quiet SHA256SUMS); then
    step "checksums OK ($(wc -l <"$SCRATCH/SHA256SUMS" | tr -d ' ') files)"
  else
    fail_step "sha256sum -c SHA256SUMS failed"
  fi
else
  fail_step "SHA256SUMS missing from the backup"
fi

if [[ -f "$SCRATCH/wb.db" ]]; then
  if node "$SCRIPT_DIR/verify-restore.mjs" "$SCRATCH/wb.db"; then
    step "database integrity_check OK and all core tables present"
  else
    fail_step "verify-restore.mjs rejected the restored database (JSON above)"
  fi
else
  fail_step "wb.db missing from the backup"
fi

if ((FAILED)); then
  printf '[restore] FAIL: drill failed for %s\n' "$LATEST" >&2
  exit 1
fi

printf '[restore] PASS: %s restores cleanly (%s files, %s bytes)\n' \
  "$LATEST" \
  "$(find "$SCRATCH" -type f | wc -l | tr -d ' ')" \
  "$(du -sb "$SCRATCH" | awk '{print $1}')"
