#!/bin/bash
# Diagnose password drift between gateway.env, wb.db and the running process.
# Env-file and unit values are redacted before printing; the process environment is filtered to
# the relevant keys and redacted too, so no credential is ever written to the terminal.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

ENV_FILE=$(piforge_gateway_env) || {
  echo "gateway.env not found (looked in /etc/piforge and /home/antifield/piforge)" >&2
  exit 1
}

echo "=== gateway.env keys (values redacted) ==="
sed 's/=.*/=***/' "$ENV_FILE"
echo "=== service ==="
systemctl is-active wb-gateway || true
systemctl show wb-gateway -p Environment -p FragmentPath |
  sed -E 's/([A-Za-z_]*(PASSWORD|SECRET|TOKEN|KEY))=[^ ]*/\1=***/g'
echo "=== users ==="
node "$SCRIPT_DIR/list-users.mjs"
echo "=== env loaded by process (values redacted) ==="
MAINPID=$(systemctl show -p MainPID --value wb-gateway || true)
if [[ -z "$MAINPID" || "$MAINPID" == "0" ]]; then
  echo "wb-gateway has no main PID (service not running)"
else
  tr '\0' '\n' <"/proc/$MAINPID/environ" 2>/dev/null |
    grep -E 'ADMIN_|OPENCODE_' |
    sed -E 's/=.*/=***/' || true
fi
