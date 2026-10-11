#!/usr/bin/env bash
# Restart services after OPENCODE_PASSWORD / gateway.env changes.
set -euo pipefail
ENV=/home/antifield/piforge/gateway.env
# shellcheck disable=SC1090
source "$ENV"
sudo mkdir -p /etc/systemd/system/opencode-serve.service.d
sudo tee /etc/systemd/system/opencode-serve.service.d/override.conf >/dev/null <<EOF
[Service]
Environment=OPENCODE_PASSWORD=${OPENCODE_PASSWORD}
EOF
sudo systemctl daemon-reload
sudo systemctl restart opencode-serve
sleep 2
sudo systemctl restart wb-gateway
sleep 2
echo "=== opencode info ==="
curl -sS -u "opencode:${OPENCODE_PASSWORD}" http://127.0.0.1:4096/api/info
echo
echo "=== login ==="
node /home/antifield/piforge/scripts/verify-login.mjs
