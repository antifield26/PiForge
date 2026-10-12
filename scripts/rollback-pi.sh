#!/usr/bin/env bash
# Roll the PiForge systemd units back to the newest <unit>.bak-<stamp> that
# scripts/deploy-pi.sh left behind, then start the services again.
#
#   ssh antifield@169.254.77.10 'bash /home/antifield/piforge/scripts/rollback-pi.sh'
#
# Data is NOT rolled back. If scripts/deploy-pi.sh migrated /home/antifield/piforge/data to
# /var/lib/piforge, the exact manual steps are printed instead of being executed: moving a
# live database and cloud/ back is a deliberate, verified operation.
set -euo pipefail

UNIT_DIR=/etc/systemd/system
SERVICES=(wb-gateway.service opencode-serve.service)
UNITS=(wb-gateway.service opencode-serve.service piforge-backup.service piforge-backup.timer)
GW_HOME=/var/lib/piforge
OC_HOME=/var/lib/piforge-oc
LEGACY_DATA=/home/antifield/piforge/data
CONF=/etc/piforge

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  SUDO=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    printf '[rollback] ERROR: run as root or install sudo\n' >&2
    exit 1
  fi
  SUDO=(sudo)
fi
as_root() { "${SUDO[@]}" "$@"; }

log() { printf '[rollback] %s\n' "$*"; }

if [[ ! -d "$UNIT_DIR" ]]; then
  printf '[rollback] ERROR: %s not found — is this the Pi?\n' "$UNIT_DIR" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Stop what we are about to replace
# ---------------------------------------------------------------------------
for unit in "${SERVICES[@]}"; do
  if as_root systemctl is-active --quiet "$unit"; then
    as_root systemctl stop "$unit"
    log "stopped $unit"
  else
    log "$unit was not running"
  fi
done
as_root systemctl stop piforge-backup.timer 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. Restore the newest backup of each unit
# ---------------------------------------------------------------------------
restored=0
for unit in "${UNITS[@]}"; do
  newest=$(find "$UNIT_DIR" -maxdepth 1 -type f -name "$unit.bak-*" -printf '%T@ %p\n' 2>/dev/null |
    sort -rn | head -n1 | cut -d' ' -f2- || true)
  if [[ -z "$newest" ]]; then
    log "no $unit.bak-* found — leaving the current unit in place"
    continue
  fi
  as_root install -m 0644 -o root -g root "$newest" "$UNIT_DIR/$unit"
  log "restored $UNIT_DIR/$unit from $(basename "$newest")"
  restored=$((restored + 1))
done

if ((restored == 0)); then
  log "WARN: no unit backups were found, so no unit changed; only a restart was performed"
fi

as_root systemctl daemon-reload
log "systemctl daemon-reload done"

# ---------------------------------------------------------------------------
# 3. Start again
# ---------------------------------------------------------------------------
for unit in "${SERVICES[@]}"; do
  if [[ -f "$UNIT_DIR/$unit" ]]; then
    as_root systemctl start "$unit" || log "WARN: $unit failed to start (journalctl -u $unit -n 50)"
    log "started $unit"
  fi
done
if [[ -f "$UNIT_DIR/piforge-backup.timer" ]]; then
  as_root systemctl start piforge-backup.timer 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 4. Status
# ---------------------------------------------------------------------------
log "=== status ==="
for unit in "${UNITS[@]}"; do
  state=$(as_root systemctl is-active "$unit" 2>/dev/null || true)
  printf '[rollback] %-24s %s\n' "$unit" "${state:-unknown}"
done
if [[ -f "$UNIT_DIR/wb-gateway.service" ]]; then
  printf '[rollback] ExecStart: %s\n' "$(grep -h '^ExecStart=' "$UNIT_DIR/wb-gateway.service" | head -n1)"
  printf '[rollback] User:      %s\n' "$(grep -h '^User=' "$UNIT_DIR/wb-gateway.service" | head -n1)"
fi

# ---------------------------------------------------------------------------
# 5. Data was migrated: print the manual steps, move nothing
# ---------------------------------------------------------------------------
if [[ -f "$GW_HOME/wb.db" && ! -f "$LEGACY_DATA/wb.db" ]]; then
  cat <<EOF

[rollback] The database lives in $GW_HOME (migrated from $LEGACY_DATA) and was NOT moved back.
[rollback] Manual steps, in this order, once you have decided to go back to the old layout:
[rollback]
[rollback]   sudo systemctl stop wb-gateway.service opencode-serve.service
[rollback]   sudo install -d -m 0755 -o antifield -g antifield $LEGACY_DATA
[rollback]   sudo mv $GW_HOME/wb.db $LEGACY_DATA/wb.db
[rollback]   sudo test -f $GW_HOME/wb.db-wal && sudo mv $GW_HOME/wb.db-wal $LEGACY_DATA/wb.db-wal || true
[rollback]   sudo test -f $GW_HOME/wb.db-shm && sudo mv $GW_HOME/wb.db-shm $LEGACY_DATA/wb.db-shm || true
[rollback]   sudo mv $GW_HOME/cloud $LEGACY_DATA/cloud
[rollback]   sudo chown -R antifield:antifield $LEGACY_DATA
[rollback]
[rollback]   # only if the restored units still use the old paths:
[rollback]   sudo mv $CONF/gateway.env /home/antifield/piforge/gateway.env
[rollback]   sudo mv $OC_HOME/.opencode /home/antifield/.opencode
[rollback]   sudo mv $OC_HOME/.config/opencode /home/antifield/.config/opencode
[rollback]   sudo mv $OC_HOME/.local/share/opencode /home/antifield/.local/share/opencode
[rollback]   sudo chown -R antifield:antifield /home/antifield/.opencode /home/antifield/.config/opencode /home/antifield/.local/share/opencode
[rollback]
[rollback]   # the gateway no longer needs root once it runs as antifield again:
[rollback]   sudo rm -f /etc/sudoers.d/piforge-gw
[rollback]   sudo systemctl daemon-reload
[rollback]   sudo systemctl start opencode-serve.service wb-gateway.service
[rollback]
[rollback]   # the root-owned runtime copy is only needed by the piforge-gw/piforge-oc units:
[rollback]   sudo rm -rf /opt/piforge
[rollback]
[rollback] Leave $GW_HOME and $CONF in place until the restored layout is verified.
EOF
else
  log "no migrated data detected at $GW_HOME/wb.db — nothing to move back"
  log "note: the root-owned runtime copy /opt/piforge is only used by the piforge-gw/piforge-oc"
  log "      units; remove it manually (sudo rm -rf /opt/piforge) once those units are gone"
fi
