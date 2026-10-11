#!/bin/bash
HOST=cloud.antifield.work
for ip in 104.21.39.129 172.67.145.77; do
  echo "=== $ip GET / ==="
  curl -sS -m 15 --resolve "$HOST:443:$ip" -w "HTTP %{http_code}\n" "https://$HOST/" | head -12
  echo "=== $ip assets ==="
  curl -sS -m 15 -o /dev/null -w "asset HTTP %{http_code}\n" --resolve "$HOST:443:$ip" "https://$HOST/assets/index-CbpUvvFc.js"
done
