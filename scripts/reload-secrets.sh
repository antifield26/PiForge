#!/usr/bin/env bash
# Re-read PiForge secrets after editing /etc/piforge/gateway.env (or opencode.env).
#
#   bash /home/antifield/piforge/scripts/reload-secrets.sh
#
# systemd reads EnvironmentFile= only when a unit starts, so both services are restarted
# here. The OpenCode password is mirrored from gateway.env into /etc/piforge/opencode.env
# (0640 root:piforge-oc) because that is what opencode-serve.service reads. The legacy
# `Environment=OPENCODE_PASSWORD` drop-in — which leaked the value to every local user
# through `systemctl show -p Environment` — is removed, but only once the installed unit
# actually uses the EnvironmentFile.
#
# No secret is ever printed or passed on a command line.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CONF=/etc/piforge
NEW_ENV="$CONF/gateway.env"
LEGACY_ENV=/home/antifield/piforge/gateway.env
OC_ENV="$CONF/opencode.env"
OC_UNIT=/etc/systemd/system/opencode-serve.service
DROPIN=/etc/systemd/system/opencode-serve.service.d/override.conf

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  SUDO=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    printf '[reload] ERROR: run as root or install sudo\n' >&2
    exit 1
  fi
  SUDO=(sudo)
fi
as_root() { "${SUDO[@]}" "$@"; }
log() { printf '[reload] %s\n' "$*"; }
die() {
  printf '[reload] ERROR: %s\n' "$*" >&2
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

# Read, never source.
PASSWORD=$(as_root grep -E '^OPENCODE_PASSWORD=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true)
PASSWORD="${PASSWORD%$'\r'}"
[[ -n "$PASSWORD" ]] || die "OPENCODE_PASSWORD is not set in $ENV_FILE"

if as_root grep -q '^EnvironmentFile=/etc/piforge/opencode.env' "$OC_UNIT" 2>/dev/null; then
  if ! id -u piforge-oc >/dev/null 2>&1; then
    log "WARN: piforge-oc does not exist yet; run scripts/deploy-pi.sh first to create it"
  else
    TMP=$(mktemp)
    chmod 600 "$TMP"
    printf 'OPENCODE_PASSWORD=%s\n' "$PASSWORD" >"$TMP"
    as_root install -m 0640 -o root -g piforge-oc "$TMP" "$OC_ENV"
    rm -f -- "$TMP"
    log "installed $OC_ENV (0640 root:piforge-oc)"
  fi
  if [[ -f "$DROPIN" ]] && as_root grep -q '^Environment=OPENCODE_PASSWORD=' "$DROPIN"; then
    as_root rm -f "$DROPIN"
    log "removed $DROPIN (Environment= leaked the password through systemctl show)"
  fi
else
  log "opencode-serve.service does not use $OC_ENV yet; leaving the installed unit untouched"
fi
unset PASSWORD

as_root systemctl daemon-reload
as_root systemctl restart opencode-serve
sleep 2
as_root systemctl restart wb-gateway
sleep 2
log "restarted opencode-serve and wb-gateway"

# Verify with the library helper: password in a 0600 curl --config file, never in argv.
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
if OC_PASSWORD=$(piforge_opencode_password); then
  piforge_tmpfile
  CURLRC=$PIFORGE_TMPFILE
  piforge_curlrc "$CURLRC" opencode "$OC_PASSWORD"
  unset OC_PASSWORD
  log "opencode /api/info:"
  curl -sS -m 5 --config "$CURLRC" http://127.0.0.1:4096/api/info || log "WARN: opencode did not answer"
  echo
else
  log "WARN: could not read the OpenCode password back for verification"
fi

log "gateway login check:"
as_root "$(command -v node)" "$SCRIPT_DIR/verify-login.mjs" || log "WARN: login verification failed"
log "DONE"
