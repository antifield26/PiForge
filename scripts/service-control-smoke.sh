#!/bin/bash
# Verify systemctl control works for allowlisted units on the Pi
set -e
echo "=== status nginx ==="
systemctl is-active nginx.service || true
echo "=== status cloudflared ==="
systemctl is-active cloudflared.service || true
echo "=== restart nginx (allowlisted) ==="
sudo systemctl restart nginx.service
echo "restart_exit=$?"
systemctl is-active nginx.service
echo "=== try ssh (not in workbench allowlist — operator only) ==="
echo "skip destructive"
echo OK
