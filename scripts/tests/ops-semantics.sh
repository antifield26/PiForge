#!/usr/bin/env bash
# Functional check for the backup/restore semantics changed by FIX-B (items 4, 5, 6).
#
#   bash scripts/tests/ops-semantics.sh
#
# Runs entirely inside a mktemp -d: no root, no Pi, no systemd (a Windows host with Git bash
# and node is enough). Exits non-zero on the first unexpected result.
set -uo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf 'SKIP: node is not in PATH (needed to build the fixture wb.db)\n' >&2
  exit 2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/piforge-fixb-XXXXXX")
trap 'rm -rf -- "$WORK"' EXIT

FAILED=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; FAILED=1; }
check() { # label expected actual
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (expected [$2] got [$3])"; fi
}
make_wb_db() { # path
  node -e '
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(process.argv[1])
    for (const t of ["users","sessions","todos","notes","bookmarks","cloud_files","metrics_points","service_audit"]) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY)`)
    }
    db.exec(`CREATE TABLE IF NOT EXISTS backup_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER,
      status TEXT NOT NULL, target TEXT NOT NULL, bytes INTEGER, checksum TEXT, message TEXT)`)
    db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.close()
  ' "$1"
}
seal() { # dir status
  printf '%s\n' "$2" >"$1/STATUS"
  ( cd "$1" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 -r sha256sum >SHA256SUMS )
}

printf '== item 4: ALLOW_MISSING_DB=1 must not report ok\n'
T1="$WORK/t1"; mkdir -p "$T1"
OUT1=$(DB_PATH="$WORK/absent.db" ALLOW_MISSING_DB=1 BACKUP_TARGET="$T1" PIFORGE_SKIP_RECORD=1 KEEP=14 \
  bash "$REPO/scripts/backup.sh" 2>"$WORK/t1.stderr")
CODE1=$?
check "no '[backup] OK' line" "0" "$(grep -c '^\[backup\] OK ' <<<"$OUT1" || true)"
check "PARTIAL is reported on stdout (the gateway reads this)" "1" "$(grep -c '^\[backup\] PARTIAL ' <<<"$OUT1" || true)"
check "PARTIAL also goes to stderr" "1" "$(grep -c '^\[backup\] PARTIAL' "$WORK/t1.stderr" || true)"
check "exit code stays 0 (the gateway classifies from stdout)" "0" "$CODE1"
DEST1=$(find "$T1" -maxdepth 1 -mindepth 1 -type d -name 'backup-*' | head -n1)
check "STATUS marker says partial" "partial" "$(tr -d '[:space:]' <"$DEST1/STATUS")"
check "STATUS is covered by SHA256SUMS" "0" "$(cd "$DEST1" && sha256sum -c --quiet SHA256SUMS >/dev/null 2>&1; echo $?)"

printf '== item 5: retention prunes only verified ok archives\n'
T2="$WORK/t2"; mkdir -p "$T2"
mk_archive() { # name status corrupt
  local dir="$T2/$1"
  mkdir -p "$dir"
  printf 'payload %s\n' "$1" >"$dir/wb.db"
  seal "$dir" "$2"
  if [[ "${3:-0}" == "1" ]]; then printf 'tampered\n' >>"$dir/wb.db"; fi
}
mk_archive backup-20260101-000001 ok
mk_archive backup-20260101-000002 ok 1
mk_archive backup-20260101-000003 partial
mkdir -p "$T2/backup-20260101-000004"
printf 'payload\n' >"$T2/backup-20260101-000004/wb.db"

OUT2=$(DB_PATH="$WORK/absent.db" ALLOW_MISSING_DB=1 BACKUP_TARGET="$T2" PIFORGE_SKIP_RECORD=1 KEEP=1 \
  bash "$REPO/scripts/backup.sh" 2>&1)
exists() { [[ -d "$T2/$1" ]] && echo present || echo gone; }
check "verified ok archive pruned" "gone" "$(exists backup-20260101-000001)"
check "archive with a failing checksum kept" "present" "$(exists backup-20260101-000002)"
check "archive marked partial kept" "present" "$(exists backup-20260101-000003)"
check "archive without a manifest kept" "present" "$(exists backup-20260101-000004)"
check "three skips warned about" "3" "$(grep -c 'keeping backup-' <<<"$OUT2" || true)"

printf '== item 6: restore-drill --all / PARTIAL refusal / checksum gate\n'
T3="$WORK/t3"; mkdir -p "$T3"
DB3="$WORK/wb3.db"; make_wb_db "$DB3"
mk_drill_archive() { # dir status
  mkdir -p "$1"
  cp "$DB3" "$1/wb.db"
  seal "$1" "$2"
}
mk_drill_archive "$T3/backup-20260101-000001" ok
mk_drill_archive "$T3/backup-20260101-000002" partial
mk_drill_archive "$T3/backup-20260101-000003" ok
printf 'corruption\n' >>"$T3/backup-20260101-000003/wb.db"

OUT3=$(DB_PATH="$DB3" bash "$REPO/scripts/restore-drill.sh" --all "$T3" 2>&1)
CODE3=$?
printf '%s\n' "$OUT3" | sed 's/^/     /'
check "--all drills every archive" "3" "$(grep -c 'source=.*backup-' <<<"$OUT3" || true)"
check "any failure exits non-zero" "1" "$CODE3"
check "intact archive passes" "1" "$(grep -c 'PASS .*backup-20260101-000001' <<<"$OUT3" || true)"
check "partial archive refused by default" "1" "$(grep -c 'is marked partial' <<<"$OUT3" || true)"
check "checksum gate fires before unpacking" "1" "$(grep -c 'sha256sum -c SHA256SUMS failed' <<<"$OUT3" || true)"

T4="$WORK/t4"; mkdir -p "$T4"
cp -a "$T3/backup-20260101-000002" "$T4/"
OUT4=$(DB_PATH="$DB3" bash "$REPO/scripts/restore-drill.sh" --allow-partial "$T4" 2>&1)
CODE4=$?
check "--allow-partial accepts a partial archive" "0" "$CODE4"
check "--allow-partial still restores the database" "1" "$(grep -c 'database integrity_check OK' <<<"$OUT4" || true)"

# An archive without a STATUS marker (written before this fix) falls back to backup_runs.
T5="$WORK/t5"; mkdir -p "$T5/backup-20260101-000005"
cp "$DB3" "$T5/backup-20260101-000005/wb.db"
( cd "$T5/backup-20260101-000005" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 -r sha256sum >SHA256SUMS )
node -e '
  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(process.argv[1])
  db.prepare("INSERT INTO backup_runs (started_at, finished_at, status, target) VALUES (?, ?, ?, ?)")
    .run(Date.now(), Date.now(), "partial", process.argv[2])
  db.close()
' "$DB3" "$T5/backup-20260101-000005"
OUT5=$(DB_PATH="$DB3" bash "$REPO/scripts/restore-drill.sh" "$T5" 2>&1)
CODE5=$?
check "marker-less PARTIAL detected from backup_runs" "1" "$CODE5"
check "and refused with the same message" "1" "$(grep -c 'is marked partial' <<<"$OUT5" || true)"

# item 8: the exact manifest pipeline oc-snapshot.sh uses must not reference itself, otherwise
# `sha256sum -c` can never pass. The script itself needs /var/lib/piforge-oc, so only the
# pipeline is exercised here.
printf '== item 8: oc-snapshot manifest excludes itself\n'
T8="$WORK/t8"; mkdir -p "$T8"
printf 'payload\n' >"$T8/file"
( cd "$T8" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 -r sha256sum >SHA256SUMS )
check "manifest verifies" "0" "$(cd "$T8" && sha256sum -c --quiet SHA256SUMS >/dev/null 2>&1; echo $?)"
check "manifest does not list SHA256SUMS" "0" "$(grep -c 'SHA256SUMS$' "$T8/SHA256SUMS" || true)"

if ((FAILED)); then
  printf 'FAILED\n' >&2
  exit 1
fi
printf 'all ops-semantics checks passed\n'
