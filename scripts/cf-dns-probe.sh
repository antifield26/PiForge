#!/bin/bash
echo "=== cloudflared version ==="
cloudflared --version
echo "=== cert / config ==="
ls -la /etc/cloudflared/ ~/.cloudflared/ 2>/dev/null || true
echo "=== credentials file keys ==="
python3 -c 'import json,sys; d=json.load(open("/etc/cloudflared/b6683fba-30e5-4f49-a785-5680e7a30e21.json")); print(list(d.keys()))' 2>/dev/null || node -e 'const d=require("/etc/cloudflared/b6683fba-30e5-4f49-a785-5680e7a30e21.json"); console.log(Object.keys(d))'
echo "=== tunnel list ==="
cloudflared tunnel list 2>&1 | head -20
echo "=== route dns help ==="
cloudflared tunnel route dns --help 2>&1 | head -25
