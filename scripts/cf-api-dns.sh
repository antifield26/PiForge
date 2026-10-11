#!/bin/bash
set -e
CERT=/home/antifield/.cloudflared/cert.pem
# decode JWT payload without printing the token
PAYLOAD=$(sudo grep -v -- ----- "$CERT" | tr -d '\n')
# use node to decode and query API
sudo node <<'NODE'
const { readFileSync } = require("fs")
const cert = readFileSync("/home/antifield/.cloudflared/cert.pem", "utf8")
const token = cert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")
const parts = token.split(".")
const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString())
console.log("payload keys", Object.keys(payload))
console.log("zoneID", payload.zoneID)
console.log("accountID", payload.accountID)

const zone = payload.zoneID
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

async function main() {
  const list = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records?name=cloud.antifield.work`,
    { headers },
  )
  const listJson = await list.json()
  console.log("list status", list.status)
  console.log(JSON.stringify(listJson, null, 2).slice(0, 2000))

  if (!listJson.result || listJson.result.length === 0) {
    console.log("creating CNAME...")
    const create = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "CNAME",
          name: "cloud.antifield.work",
          content: "b6683fba-30e5-4f49-a785-5680e7a30e21.cfargotunnel.com",
          proxied: true,
          comment: "PiForge workbench via cloudflared",
        }),
      },
    )
    console.log("create", create.status, (await create.text()).slice(0, 1000))
  }
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
NODE
