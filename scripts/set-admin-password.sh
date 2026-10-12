#!/usr/bin/env bash
# Rotate the PiForge admin password and restart the gateway so the new value is loaded.
#
#   bash /home/antifield/piforge/scripts/set-admin-password.sh
#   PIFORGE_ADMIN_PASSWORD='…' bash /home/antifield/piforge/scripts/set-admin-password.sh
#
# The password is deliberately NOT accepted as a command-line argument: argv is visible to
# every local user through `ps`. It is never printed, and the file that holds it is written
# through a 0600 temp file with `install`, so it never appears in a command line either.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CONF=/etc/piforge
NEW_ENV="$CONF/gateway.env"
LEGACY_ENV=/home/antifield/piforge/gateway.env

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  SUDO=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    printf '[admin] ERROR: run as root or install sudo\n' >&2
    exit 1
  fi
  SUDO=(sudo)
fi
as_root() { "${SUDO[@]}" "$@"; }
log() { printf '[admin] %s\n' "$*"; }
die() {
  printf '[admin] ERROR: %s\n' "$*" >&2
  exit 1
}

ENV_FILE=""
if [[ -f "$NEW_ENV" ]]; then
  ENV_FILE="$NEW_ENV"
elif [[ -f "$LEGACY_ENV" ]]; then
  ENV_FILE="$LEGACY_ENV"
else
  die "gateway.env not found (looked in $CONF and /home/antifield/piforge)"
fi

if [[ -n "${1:-}" ]]; then
  die "passing the password as an argument is no longer supported (it is visible in ps); use the prompt or PIFORGE_ADMIN_PASSWORD"
fi

NEW="${PIFORGE_ADMIN_PASSWORD:-}"
if [[ -z "$NEW" ]]; then
  if [[ ! -t 0 ]]; then
    die "no TTY to prompt on and PIFORGE_ADMIN_PASSWORD is unset"
  fi
  read -r -s -p "New ADMIN_PASSWORD: " NEW
  printf '\n'
  read -r -s -p "Repeat:              " AGAIN
  printf '\n'
  if [[ "$NEW" != "$AGAIN" ]]; then
    die "the two passwords differ"
  fi
fi
[[ -n "$NEW" ]] || die "empty password"
if [[ "$NEW" == *$'\n'* || "$NEW" == *$'\r'* ]]; then
  die "the password must not contain a line break"
fi

WORK=$(mktemp)
NEXT=$(mktemp)
chmod 600 "$WORK" "$NEXT"
cleanup() { rm -f -- "$WORK" "$NEXT"; }
trap cleanup EXIT

as_root cat "$ENV_FILE" >"$WORK"
# The value travels through the environment, never through argv, so `ps` cannot see it.
ADMIN_PW_NEW="$NEW" awk '
  /^ADMIN_PASSWORD=/ { print "ADMIN_PASSWORD=" ENVIRON["ADMIN_PW_NEW"]; found = 1; next }
  { print }
  END { if (!found) print "ADMIN_PASSWORD=" ENVIRON["ADMIN_PW_NEW"] }
' "$WORK" >"$NEXT"
unset NEW

if [[ "$ENV_FILE" == "$NEW_ENV" ]]; then
  OWNER=root
  GROUP=piforge-gw
  MODE=0640
  getent group piforge-gw >/dev/null 2>&1 || GROUP=root
else
  OWNER=antifield
  GROUP=antifield
  MODE=0600
fi
as_root install -m "$MODE" -o "$OWNER" -g "$GROUP" "$NEXT" "$ENV_FILE"
log "updated ADMIN_PASSWORD in $ENV_FILE ($MODE $OWNER:$GROUP)"

# Immediate DB sync. The gateway's ensureAdminUser() also rotates the hash on start, so a
# failure here is not fatal — say so instead of pretending it worked.
NODE=$(command -v node)
if [[ -n "$NODE" ]]; then
  if id -u piforge-gw >/dev/null 2>&1 && [[ "$ENV_FILE" == "$NEW_ENV" ]]; then
    as_root -u piforge-gw "$NODE" "$SCRIPT_DIR/reset-admin-pw.mjs" ||
      log "WARN: could not sync the DB hash as piforge-gw; the gateway will rotate it on start"
  else
    as_root "$NODE" "$SCRIPT_DIR/reset-admin-pw.mjs" ||
      log "WARN: could not sync the DB hash; the gateway will rotate it on start"
  fi
fi

as_root systemctl restart wb-gateway
sleep 2
log "restarted wb-gateway"

if [[ -n "$NODE" ]]; then
  if as_root "$NODE" "$SCRIPT_DIR/verify-login.mjs"; then
    log "DONE — login verified with the new password"
  else
    log "WARN: login verification failed; check journalctl -u wb-gateway -n 50"
  fi
else
  log "DONE — node not found, skipped the login verification"
fi
