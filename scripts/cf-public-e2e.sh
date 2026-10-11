#!/bin/bash
HOST=cloud.antifield.work
IPS="104.21.39.129 172.67.145.77"
for ip in $IPS; do
  echo "=== via $ip ==="
  curl -sS -m 20 --resolve "$HOST:443:$ip" \
    -w "\nHTTP %{http_code}\n" "https://$HOST/api/v1/health" || true
done

echo "=== login via resolve ==="
IP=104.21.39.129
# read admin creds
set -a
source /home/antifield/piforge/gateway.env
set +a
curl -sS -m 20 --resolve "$HOST:443:$IP" \
  -c /tmp/pf-pub-cookies \
  -H 'content-type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
  "https://$HOST/api/v1/auth/login"
echo
curl -sS -m 20 --resolve "$HOST:443:$IP" \
  -b /tmp/pf-pub-cookies \
  "https://$HOST/api/v1/console/system"
echo
