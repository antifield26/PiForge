#!/bin/bash
# Verify systemctl control works for allowlisted units on the Pi.
# NOTE: this restarts the live nginx.service (the allowlisted unit under test).
set -euo pipefail

echo "=== status nginx ==="
systemctl is-active nginx.service || true
echo "=== status cloudflared ==="
systemctl is-active cloudflared.service || true
echo "=== restart nginx (allowlisted) ==="
restart_exit=0
sudo systemctl restart nginx.service || restart_exit=$?
echo "restart_exit=$restart_exit"
if ((restart_exit != 0)); then
  echo "nginx.service restart failed — check the unit and sudo rights" >&2
  exit "$restart_exit"
fi
systemctl is-active nginx.service
echo "=== try ssh (not in workbench allowlist — operator only) ==="
echo "skip destructive"
echo OK
