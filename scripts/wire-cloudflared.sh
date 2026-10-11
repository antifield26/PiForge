#!/bin/bash
set -e
sudo cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak.$(date +%Y%m%d%H%M%S)
sudo tee /etc/cloudflared/config.yml >/dev/null <<'EOF'
tunnel: b6683fba-30e5-4f49-a785-5680e7a30e21
credentials-file: /etc/cloudflared/b6683fba-30e5-4f49-a785-5680e7a30e21.json
protocol: http2

ingress:
  - hostname: cloud.antifield.work
    service: http://127.0.0.1:8787
  - hostname: mc.antifield.work
    service: tcp://localhost:25565
  - service: http_status:404
EOF
sudo systemctl restart cloudflared
sleep 3
systemctl is-active cloudflared
echo "=== tunnel log ==="
journalctl -u cloudflared -n 8 --no-pager
