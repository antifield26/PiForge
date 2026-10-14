#!/usr/bin/env bash
# Create the dual-account ops login (`piforge`) and install its restricted sudoers (ADR-9).
#
#   sudo bash /opt/piforge/scripts/setup-ops-account.sh [--demote-antifield]
#
# Dual-account model (FIX-4.9):
#   piforge   — human ops: SSH login + NOPASSWD only for PIFORGE_OPS (runbooks, allowlisted systemctl)
#   antifield — transition login; --demote-antifield removes NOPASSWD: ALL AFTER piforge is proven
#   piforge-gw / piforge-oc — service users (unchanged, no sudo)
#
# Safety:
#   * refuses to demote antifield until `piforge` exists and its sudoers parses
#   * stages sudoers behind a dotted tempfile (sudo ignores dotted names) and visudo-checks
#   * prints a self-rescue checklist and NEVER deletes the antifield account or its keys
#
# Environment:
#   PIFORGE_OPS_SUDOERS   override path of the ops sudoers template (default: deploy/sudoers.d-piforge)
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Prefer the installed runtime template; fall back to a checkout next to this script.
TEMPLATE="${PIFORGE_OPS_SUDOERS:-}"
if [[ -z "$TEMPLATE" ]]; then
  for candidate in \
    "$SCRIPT_DIR/../deploy/sudoers.d-piforge" \
    /opt/piforge/deploy/sudoers.d-piforge \
    /home/antifield/piforge/deploy/sudoers.d-piforge; do
    if [[ -f "$candidate" ]]; then
      TEMPLATE="$candidate"
      break
    fi
  done
fi
[[ -n "$TEMPLATE" && -f "$TEMPLATE" ]] || {
  printf '[ops] ERROR: sudoers template not found (set PIFORGE_OPS_SUDOERS)\n' >&2
  exit 1
}

OPS_USER=piforge
OPS_HOME=/home/piforge
SUDOERS=/etc/sudoers.d/piforge
STAMP=$(date +%Y%m%d-%H%M%S)
DEMOTE=0
for arg in "$@"; do
  case "$arg" in
    --demote-antifield) DEMOTE=1 ;;
    *) printf '[ops] ERROR: unknown argument %s\n' "$arg" >&2; exit 1 ;;
  esac
done

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  printf '[ops] ERROR: run as root (sudo bash %s)\n' "$0" >&2
  exit 1
fi

log() { printf '[ops] %s\n' "$*"; }
die() { printf '[ops] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Ops account
# ---------------------------------------------------------------------------
if id -u "$OPS_USER" >/dev/null 2>&1; then
  log "user $OPS_USER already exists"
else
  useradd --create-home --home-dir "$OPS_HOME" --shell /bin/bash "$OPS_USER"
  log "created $OPS_USER (home $OPS_HOME, bash). Add an SSH key before demoting antifield:"
  log "  install -d -m 0700 -o $OPS_USER -g $OPS_USER $OPS_HOME/.ssh"
  log "  install -m 0600 -o $OPS_USER -g $OPS_USER /path/to/id_ed25519.pub $OPS_HOME/.ssh/authorized_keys"
fi
install -d -m 0750 -o "$OPS_USER" -g "$OPS_USER" "$OPS_HOME"
# Primary group for an interactive human; keep sudo group OFF (only the sudoers file grants).
usermod -a -G gpio "$OPS_USER" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. Restricted sudoers (staged + visudo)
# ---------------------------------------------------------------------------
[[ -f "$TEMPLATE" ]] || die "missing template $TEMPLATE"
# Fail if the template is not the dual-account one (guards against a stale NOPASSWD: ALL).
# Only rule lines count: the header comments intentionally mention the forbidden form.
if grep -vE '^[[:space:]]*#' "$TEMPLATE" | grep -qE 'NOPASSWD:[[:space:]]*ALL'; then
  die "$TEMPLATE grants NOPASSWD: ALL — refusing to install"
fi
if ! grep -q "^${OPS_USER} ALL=" "$TEMPLATE"; then
  die "$TEMPLATE does not grant $OPS_USER"
fi

STAGE=$(mktemp /etc/sudoers.d/.piforge.XXXXXX)
install -m 0440 -o root -g root "$TEMPLATE" "$STAGE"
if ! visudo -c -f "$STAGE"; then
  rm -f "$STAGE"
  die "visudo rejected $TEMPLATE — $SUDOERS left unchanged"
fi
rm -f "$STAGE"

if [[ -f "$SUDOERS" ]]; then
  cp -a "$SUDOERS" "$SUDOERS.bak-$STAMP"
  log "backed up $SUDOERS -> $SUDOERS.bak-$STAMP"
fi
install -m 0440 -o root -g root "$TEMPLATE" "$SUDOERS"
if ! visudo -c -f "$SUDOERS" >/dev/null 2>&1; then
  if [[ -f "$SUDOERS.bak-$STAMP" ]]; then
    install -m 0440 -o root -g root "$SUDOERS.bak-$STAMP" "$SUDOERS"
    die "$SUDOERS does not parse — rolled back"
  fi
  rm -f "$SUDOERS"
  die "$SUDOERS does not parse — removed"
fi
log "installed $SUDOERS (0440, visudo OK)"

# ---------------------------------------------------------------------------
# 3. Optional: demote antifield (high risk — only after piforge SSH is proven)
# ---------------------------------------------------------------------------
ANTIFIELD_SUDO=$(ls /etc/sudoers.d/*antifield* 2>/dev/null | sort -u || true)
if ((DEMOTE)); then
  if ! id -u "$OPS_USER" >/dev/null 2>&1; then
    die "refusing to demote antifield: $OPS_USER does not exist"
  fi
  # `sudo -l` expands Cmnd_Alias, so never grep the alias name; probe a real runbook path.
  if ! sudo -n -l -U "$OPS_USER" 2>/dev/null | grep -q '/opt/piforge/scripts/'; then
    die "refusing to demote antifield: $OPS_USER cannot see PiForge runbooks yet"
  fi
  if [[ -z "$ANTIFIELD_SUDO" ]]; then
    log "no antifield sudoers file found — nothing to demote"
  else
    for f in $ANTIFIELD_SUDO; do
      cp -a "$f" "$f.bak-$STAMP"
      # Drop NOPASSWD: ALL lines / the whole drop-in if it only grants that.
      if grep -qE 'NOPASSWD:[[:space:]]*ALL' "$f"; then
        if [[ "$(grep -cE '^[^#]' "$f")" -le 2 ]]; then
          rm -f "$f"
          log "removed $f (NOPASSWD: ALL drop-in; backup $f.bak-$STAMP)"
        else
          sed -i.bak-sed 's/NOPASSWD:[[:space:]]*ALL/NOPASSWD: PIFORGE_OPS/' "$f" || true
          die "$f mixes grants — manual edit required (backup $f.bak-$STAMP). Do not leave NOPASSWD: ALL."
        fi
      fi
    done
  fi
  log "antifield demotion attempted — VERIFY from a second SSH session before closing this one:"
  log "  ssh antifield@<host> 'sudo -n -l'   # must NOT show (ALL) NOPASSWD: ALL"
  log "  ssh piforge@<host>  'sudo -n -l'   # must show PIFORGE_OPS only"
else
  if [[ -n "$ANTIFIELD_SUDO" ]]; then
    log "NOTE: antifield sudoers still present ($ANTIFIELD_SUDO)."
    log "      After piforge SSH works, re-run with --demote-antifield (keeps backups)."
  fi
fi

# ---------------------------------------------------------------------------
# 4. Self-rescue checklist
# ---------------------------------------------------------------------------
cat <<'EOF'
[ops] ---- self-rescue checklist (do not skip) ----
  1. Keep ONE existing SSH session open as antifield while you test piforge.
  2. From a NEW terminal: ssh piforge@<host> then `sudo -n /opt/piforge/scripts/verify-e2e.mjs`.
  3. Confirm `sudo -n -l -U piforge` shows only PIFORGE_OPS (never ALL).
  4. Only then run: sudo bash setup-ops-account.sh --demote-antifield
  5. Re-check from a third session; if locked out, use the still-open antifield session
     or the Pi console/HDMI login to restore /etc/sudoers.d/*antifield*.bak-<stamp>.
[ops] --------------------------------------------
EOF

log "DONE"
