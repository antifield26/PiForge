#!/bin/bash
echo "=== env keys ==="
sed 's/=.*/=***/' /home/antifield/piforge/gateway.env
echo "=== systemd EnvironmentFile ==="
systemctl cat wb-gateway | grep -i env
echo "=== users table ==="
node /home/antifield/piforge/scripts/list-users.mjs
echo "=== login probe ==="
node /home/antifield/piforge/scripts/login-probe.mjs
