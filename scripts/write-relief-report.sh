#!/bin/bash
# P0.9 write-relief verification report
set -e
echo "=== timestamp ==="
date -Is
echo "=== journald config ==="
ls /etc/systemd/journald.conf.d/
cat /etc/systemd/journald.conf.d/* 2>/dev/null
echo "=== journald storage state ==="
# Storage=volatile means no /var/log/journal persistence
ls -la /var/log/journal 2>/dev/null || echo "no /var/log/journal"
journalctl --disk-usage
echo "=== log2ram ==="
systemctl is-active log2ram
mount | grep log2ram
echo "=== tmpfs /tmp ==="
df -h /tmp
echo "=== sqlite pragmas (gateway db) ==="
node -e '
const { DatabaseSync } = require("node:sqlite")
const p = "/home/antifield/piforge/data/wb.db"
const db = new DatabaseSync(p)
for (const k of ["journal_mode", "synchronous", "wal_autocheckpoint"]) {
  console.log(k, db.prepare(`PRAGMA ${k}`).get())
}
db.close()
'
echo "=== disk write sample 60s ==="
before=$(awk '$3=="mmcblk0"{print $10}' /proc/diskstats)
t0=$(date +%s)
sleep 60
after=$(awk '$3=="mmcblk0"{print $10}' /proc/diskstats)
t1=$(date +%s)
delta_sectors=$((after - before))
delta_bytes=$((delta_sectors * 512))
dt=$((t1 - t0))
rate=$((delta_bytes / dt))
echo "delta_bytes=$delta_bytes dt=${dt}s rate_Bps=$rate rate_KBps=$((rate / 1024))"
echo "extrapolated_day_MB=$((rate * 86400 / 1024 / 1024))"
echo "=== uptime / total write since boot ==="
awk '$3=="mmcblk0"{printf "sectors_written=%s total_GB=%.2f\n", $10, $10*512/1024/1024/1024}' /proc/diskstats
cut -d' ' -f1 /proc/uptime | awk '{printf "uptime_hours=%.2f\n", $1/3600}'
echo "=== metrics_points count ==="
node -e '
const { DatabaseSync } = require("node:sqlite")
const db = new DatabaseSync("/home/antifield/piforge/data/wb.db")
console.log(db.prepare("SELECT COUNT(*) AS n FROM metrics_points").get())
console.log(db.prepare("SELECT COUNT(*) AS n FROM service_audit").get())
db.close()
'
echo "=== zram ==="
swapon --show
echo "=== DONE ==="
