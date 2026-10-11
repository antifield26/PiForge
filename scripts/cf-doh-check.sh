#!/bin/bash
echo "=== DoH cloudflare-dns.com ==="
curl -sS -m 15 "https://cloudflare-dns.com/dns-query?name=cloud.antifield.work&type=A" -H "accept: application/dns-json"
echo
echo "=== DoH google ==="
curl -sS -m 15 "https://dns.google/resolve?name=cloud.antifield.work&type=A"
echo
echo "=== resolve cfargotunnel ==="
node -e 'import("node:dns/promises").then(async d=>{d.setServers(["1.1.1.1"]); try{console.log(await d.resolve4("b6683fba-30e5-4f49-a785-5680e7a30e21.cfargotunnel.com"))}catch(e){console.log("ERR",e.code)}})'
echo "=== curl via DoH result if any ==="
curl -sS -m 20 --doh-url https://cloudflare-dns.com/dns-query -w "\nHTTP %{http_code}\n" https://cloud.antifield.work/api/v1/health || true
echo "=== curl to tunnel CNAME host ==="
curl -sS -m 15 -w "\nHTTP %{http_code}\n" -H "Host: cloud.antifield.work" https://b6683fba-30e5-4f49-a785-5680e7a30e21.cfargotunnel.com/api/v1/health || true
