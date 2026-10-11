#!/bin/bash
# Compare login from localhost vs public HTTPS with the password in gateway.env
set -e
source /home/antifield/piforge/gateway.env
echo "username=$ADMIN_USER password_len=${#ADMIN_PASSWORD} first=${ADMIN_PASSWORD:0:1} third=${ADMIN_PASSWORD:0:3}"

echo "=== localhost login ==="
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:8787/api/v1/auth/login \
  -H 'content-type: application/json' \
  --data-raw "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASSWORD}\"}"

HOST=cloud.antifield.work
IP=104.21.39.129
echo "=== public login via $IP ==="
curl -sS -m 20 --resolve "$HOST:443:$IP" -w '\nHTTP %{http_code}\n' \
  -X POST "https://$HOST/api/v1/auth/login" \
  -H 'content-type: application/json' \
  --data-raw "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASSWORD}\"}"

echo "=== public login wrong password (expect 401) ==="
curl -sS -m 20 --resolve "$HOST:443:$IP" -w '\nHTTP %{http_code}\n' \
  -X POST "https://$HOST/api/v1/auth/login" \
  -H 'content-type: application/json' \
  --data-raw "{\"username\":\"${ADMIN_USER}\",\"password\":\"WRONG\"}"

echo "=== last login-related logs ==="
journalctl -u wb-gateway -n 20 --no-pager | grep -iE 'login|auth|401' | tail -10 || true
