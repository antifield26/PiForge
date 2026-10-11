#!/usr/bin/env bash
# Set admin password and restart wb-gateway so EnvironmentFile is re-read.
# Usage:
#   set-admin-password.sh              # prompt (uses current ADMIN_PASSWORD if empty)
#   set-admin-password.sh 'newpass'    # set explicitly
set -euo pipefail

ENV=/home/antifield/piforge/gateway.env
NEW="${1:-}"

if [[ -z "$NEW" ]]; then
  read -r -s -p "New ADMIN_PASSWORD: " NEW
  echo
fi
if [[ -z "$NEW" ]]; then
  echo "empty password" >&2
  exit 1
fi

# rewrite ADMIN_PASSWORD line, keep others
if grep -q '^ADMIN_PASSWORD=' "$ENV"; then
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${NEW}|" "$ENV"
else
  echo "ADMIN_PASSWORD=${NEW}" >> "$ENV"
fi
chmod 600 "$ENV"

# sync DB hash immediately (works even before restart)
node /home/antifield/piforge/scripts/reset-admin-pw.mjs

# restart so process env + ensureAdminUser rotate from new value
sudo systemctl restart wb-gateway
sleep 2

# verify login
node /home/antifield/piforge/scripts/verify-login.mjs
echo "DONE — password updated and service restarted"
