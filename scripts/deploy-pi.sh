#!/usr/bin/env bash
# Install PiForge systemd units and start services (user: antifield).
# Run on the Pi as antifield (needs passwordless sudo for systemctl).
set -euo pipefail

PIFORGE=/home/antifield/piforge
ENV_FILE=$PIFORGE/gateway.env

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[deploy] creating $ENV_FILE"
  umask 077
  cat > "$ENV_FILE" <<EOF
ADMIN_USER=admin
ADMIN_PASSWORD=$(openssl rand -base64 18 | tr '+/' '-_')
SESSION_SECRET=$(openssl rand -base64 32 | tr '+/' '-_')
OPENCODE_PASSWORD=$(openssl rand -base64 32 | tr '+/' '-_')
EOF
fi

# source for systemd EnvironmentFile syntax
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

echo "[deploy] installing systemd units"
sudo cp "$PIFORGE/deploy/wb-gateway.service" /etc/systemd/system/wb-gateway.service
sudo cp "$PIFORGE/deploy/opencode-serve.service" /etc/systemd/system/opencode-serve.service

# inject OPENCODE_PASSWORD into opencode unit via drop-in
sudo mkdir -p /etc/systemd/system/opencode-serve.service.d
sudo tee /etc/systemd/system/opencode-serve.service.d/override.conf >/dev/null <<EOF
[Service]
Environment=OPENCODE_PASSWORD=${OPENCODE_PASSWORD}
EOF

sudo systemctl daemon-reload
sudo systemctl enable opencode-serve.service wb-gateway.service
sudo systemctl restart opencode-serve.service
sleep 2
sudo systemctl restart wb-gateway.service

echo "[deploy] status"
systemctl --no-pager status opencode-serve.service wb-gateway.service | sed -n '1,20p'
echo "[deploy] health"
curl -sS -m 5 http://127.0.0.1:8787/api/v1/health
echo
echo "[deploy] opencode info"
curl -sS -m 5 -u "opencode:${OPENCODE_PASSWORD}" http://127.0.0.1:4096/api/info
echo
echo "[deploy] DONE — credentials in $ENV_FILE (not in git)"
