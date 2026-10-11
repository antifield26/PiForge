#!/bin/bash
echo "=== gateway.env keys ==="
sed 's/=.*/=***/' /home/antifield/piforge/gateway.env
echo "=== service ==="
systemctl is-active wb-gateway
systemctl show wb-gateway -p Environment -p FragmentPath
echo "=== users ==="
node /home/antifield/piforge/scripts/list-users.mjs
echo "=== env loaded by process ==="
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value wb-gateway)/environ | grep -E 'ADMIN_|OPENCODE_' | sed 's/=.*/=***/'
