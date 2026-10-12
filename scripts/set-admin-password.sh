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

STAMP=$(date +%Y%m%d-%H%M%S)
ENV_BAK="$ENV_FILE.bak-$STAMP"
if as_root test -f "$ENV_FILE"; then
  # install -m 0600, not cp -a: this copy holds the *old* ADMIN_PASSWORD in plaintext, so it
  # must never be group-readable (the live file is 0640 for the service group).
  as_root install -m 0600 -o root -g root "$ENV_FILE" "$ENV_BAK"
  log "kept the previous secret file as $(basename "$ENV_BAK") (0600 root:root)"
fi

as_root install -m "$MODE" -o "$OWNER" -g "$GROUP" "$NEXT" "$ENV_FILE"
log "updated ADMIN_PASSWORD in $ENV_FILE ($MODE $OWNER:$GROUP)"

# Only the newest two copies of a plaintext secret are kept; the previous file was copied with
# the live 0640, which would leave the old ADMIN_PASSWORD readable by the service group (and in
# every nightly backup) for as long as the copy existed.
mapfile -t OLD_BAKS < <(as_root sh -c "ls -1d '$ENV_FILE'.bak-* 2>/dev/null | sort -r" || true)
if ((${#OLD_BAKS[@]} > 2)); then
  for old in "${OLD_BAKS[@]:2}"; do
    as_root rm -f -- "$old"
    log "pruned old secret copy $(basename "$old")"
  done
fi

# No immediate DB write: ADMIN_PASSWORD is read from gateway.env by the gateway's
# ensureAdminUser() on start, which rotates the stored hash when the configured value changed.
# (The former scripts/reset-admin-pw.mjs no longer exists.)
NODE=$(command -v node)

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
