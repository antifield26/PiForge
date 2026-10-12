#!/usr/bin/env bash
# Check the HTTP status guard added to scripts/lib/env.sh for FIX-B item 13: a 200 passes, any
# other status fails, and a curl-level error fails too. This is the guard cf-public-e2e.sh and
# verify-deploy.sh rely on (plain `curl -sS` exits 0 on a 4xx/5xx).
#
#   bash scripts/tests/http-expect.sh
set -uo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf 'SKIP: node is not in PATH\n' >&2
  exit 2
fi
# shellcheck source=../lib/env.sh
source "$REPO/scripts/lib/env.sh"

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
PORT=$(free_port)
DEAD_PORT=$(free_port)

node -e '
  const http = require("node:http")
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") { res.writeHead(200, { "content-type": "application/json" }); res.end("{\"ok\":true}") }
    else if (req.url === "/forbidden") { res.writeHead(403); res.end("denied") }
    else { res.writeHead(500); res.end("boom") }
  })
  server.listen(Number(process.argv[1]), "127.0.0.1")
' "$PORT" &
SERVER=$!

cleanup() { kill "$SERVER" 2>/dev/null; piforge_cleanup; }
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -sS -o /dev/null -m 2 "http://127.0.0.1:$PORT/ok"; then break; fi
  sleep 0.1
done

FAILED=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; FAILED=1; }
check() { # label expected actual
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (expected [$2] got [$3])"; fi
}

OUT=$(piforge_http_expect 200 "http://127.0.0.1:$PORT/ok" 2>&1); CODE=$?
check "HTTP 200 with expected 200 passes" "0" "$CODE"
check "response body is printed" "1" "$(grep -c '"ok":true' <<<"$OUT" || true)"

OUT=$(piforge_http_expect 200 "http://127.0.0.1:$PORT/boom" 2>&1); CODE=$?
check "HTTP 500 with expected 200 fails" "1" "$CODE"
check "the failing status is reported" "1" "$(grep -c 'FAIL: HTTP 500, expected 200' <<<"$OUT" || true)"

OUT=$(piforge_http_expect 403 "http://127.0.0.1:$PORT/forbidden" 2>&1); CODE=$?
check "HTTP 403 with expected 403 passes (allowlist reject)" "0" "$CODE"

OUT=$(piforge_http_expect 200 "http://127.0.0.1:$PORT/forbidden" 2>&1); CODE=$?
check "HTTP 403 with expected 200 fails" "1" "$CODE"

OUT=$(piforge_http_expect 200 "http://127.0.0.1:$DEAD_PORT/" 2>&1); CODE=$?
check "a connection error fails" "1" "$CODE"
check "the curl failure is reported" "1" "$(grep -c 'curl could not complete' <<<"$OUT" || true)"

if ((FAILED)); then
  printf 'FAILED\n' >&2
  exit 1
fi
printf 'all http-expect checks passed\n'
