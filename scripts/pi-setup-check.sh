#!/bin/bash
set -e
cd /home/antifield/piforge
rm -rf packages/gateway/dist/dist
echo "=== node_modules root ==="
ls node_modules | head -15
echo "=== gateway package ==="
ls packages/gateway
echo "=== try import ==="
node --input-type=module -e 'import("./packages/gateway/dist/index.js").catch(e => { console.error("IMPORT_ERR", e.message); process.exit(1) })' &
sleep 2
curl -sS -m 3 http://127.0.0.1:8787/api/v1/health || echo "no health"
kill %1 2>/dev/null || true
