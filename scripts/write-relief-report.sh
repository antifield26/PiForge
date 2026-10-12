#!/bin/bash
# P0.9 write-relief verification report: SD write rate, journald/log2ram state, sqlite pragmas.
#
# Read-only report. The gateway database path comes from lib/env.sh (post-migration first),
# and the DB is opened read-only so the report cannot checkpoint or mutate the live database.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

DB=$(piforge_wb_db)

echo "=== timestamp ==="
date -Is
echo "=== journald config ==="
ls /etc/systemd/journald.conf.d/ 2>/dev/null || echo "(no /etc/systemd/journald.conf.d)"
cat /etc/systemd/journald.conf.d/* 2>/dev/null || true
echo "=== journald storage state ==="
# Storage=volatile means no /var/log/journal persistence
ls -la /var/log/journal 2>/dev/null || echo "no /var/log/journal"
journalctl --disk-usage || true
echo "=== log2ram ==="
systemctl is-active log2ram || true
mount | grep log2ram || true
echo "=== tmpfs /tmp ==="
df -h /tmp
echo "=== sqlite pragmas (gateway db: $DB) ==="
if [[ -r "$DB" ]]; then
  node -e '
const { DatabaseSync } = require("node:sqlite")
let db
try {
  db = new DatabaseSync(process.argv[1], { readOnly: true })
  for (const k of ["journal_mode", "synchronous", "wal_autocheckpoint"]) {
    console.log(k, db.prepare(`PRAGMA ${k}`).get())
  }
} catch (e) {
  console.error("pragma query failed:", e.message)
} finally {
  if (db) db.close()
}
' "$DB" || echo "(pragma query failed — see the error above)"
else
  echo "cannot read $DB (run as root / with sudo)"
fi
echo "=== disk write sample 60s ==="
before=$(awk '$3=="mmcblk0"{print $10}' /proc/diskstats)
t0=$(date +%s)
sleep 60
after=$(awk '$3=="mmcblk0"{print $10}' /proc/diskstats)
t1=$(date +%s)
if [[ -z "$before" || -z "$after" ]]; then
  echo "mmcblk0 not present in /proc/diskstats; skipping the write-rate sample"
else
  dt=$((t1 - t0))
  if ((dt > 0)); then
    delta_sectors=$((after - before))
    delta_bytes=$((delta_sectors * 512))
    rate=$((delta_bytes / dt))
    echo "delta_bytes=$delta_bytes dt=${dt}s rate_Bps=$rate rate_KBps=$((rate / 1024))"
    echo "extrapolated_day_MB=$((rate * 86400 / 1024 / 1024))"
  fi
fi
echo "=== uptime / total write since boot ==="
awk '$3=="mmcblk0"{printf "sectors_written=%s total_GB=%.2f\n", $10, $10*512/1024/1024/1024}' /proc/diskstats
cut -d' ' -f1 /proc/uptime | awk '{printf "uptime_hours=%.2f\n", $1/3600}'
echo "=== metrics_points count ==="
if [[ -r "$DB" ]]; then
  node -e '
const { DatabaseSync } = require("node:sqlite")
let db
try {
  db = new DatabaseSync(process.argv[1], { readOnly: true })
  console.log(db.prepare("SELECT COUNT(*) AS n FROM metrics_points").get())
  console.log(db.prepare("SELECT COUNT(*) AS n FROM service_audit").get())
} catch (e) {
  console.error("count query failed:", e.message)
} finally {
  if (db) db.close()
}
' "$DB" || echo "(count query failed — see the error above)"
else
  echo "cannot read $DB (run as root / with sudo)"
fi
echo "=== zram ==="
swapon --show || true
echo "=== DONE ==="
