#!/bin/bash
# Diagnose gateway login failures: env keys, unit environment, users table, live login probe.
# Every value printed from an env file or a unit is redacted; nothing secret reaches stdout.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

ENV_FILE=$(piforge_gateway_env) || {
  echo "gateway.env not found (looked in /etc/piforge and /home/antifield/piforge)" >&2
  exit 1
}

echo "=== env keys (values redacted) ==="
sed 's/=.*/=***/' "$ENV_FILE"
echo "=== systemd EnvironmentFile ==="
systemctl cat wb-gateway 2>/dev/null | grep -i env |
  sed -E 's/([A-Za-z_]*(PASSWORD|SECRET|TOKEN|KEY))=[^ ]*/\1=***/g' || true
echo "=== users table ==="
node "$SCRIPT_DIR/list-users.mjs"
echo "=== login probe ==="
node "$SCRIPT_DIR/login-probe.mjs"
