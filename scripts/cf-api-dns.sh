#!/bin/bash
# Ensure the cloudflared public hostname has a CNAME in Cloudflare DNS.
# Twin of scripts/cf-api-dns.mjs — keep the credential handling identical.
#
# The tunnel token never enters this shell: node reads cert.pem itself, and only IDs
# (zone/account) plus API responses are printed.
set -euo pipefail

# sudo resets the environment, so the path is passed to the (stdin) node script only here.
sudo node <<'NODE'
const { readFileSync } = require("node:fs")

const CERT = "/home/antifield/.cloudflared/cert.pem"

let cert
try {
  cert = readFileSync(CERT, "utf8")
} catch (e) {
  console.error(`cf-api-dns: cannot read ${CERT}: ${e.code || e.message}`)
  console.error("cf-api-dns: the tunnel credential is root-readable, run this with sudo")
  process.exit(1)
}

// cert.pem carries a JWT: strip the PEM armour and whitespace, then split on ".".
const token = cert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")
const parts = token.split(".")
if (parts.length !== 3 || !parts[1]) {
  console.error(
    `cf-api-dns: the credential in ${CERT} is not a JWT (expected 3 dot-separated segments, got ${parts.length})`,
  )
  console.error("cf-api-dns: run 'cloudflared tunnel login' to (re)create cert.pem")
  process.exit(1)
}

let payload
try {
  payload = JSON.parse(Buffer.from(parts[1], "base64url").toString())
} catch (e) {
  console.error(`cf-api-dns: the JWT payload is not base64url-encoded JSON: ${e.message}`)
  process.exit(1)
}

console.log("payload keys", Object.keys(payload))
console.log("zoneID", payload.zoneID)
console.log("accountID", payload.accountID)

const zone = payload.zoneID
if (!zone) {
  console.error(`cf-api-dns: the credential payload has no zoneID; keys: ${Object.keys(payload).join(", ")}`)
  process.exit(1)
}

// The whole JWT is the bearer credential.
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

async function main() {
  const list = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records?name=cloud.antifield.work`,
    { headers },
  )
  const listJson = await list.json().catch(() => null)
  console.log("list status", list.status)
  console.log(JSON.stringify(listJson, null, 2).slice(0, 2000))

  if (!listJson || listJson.success !== true) {
    console.error(`cf-api-dns: listing DNS records failed (HTTP ${list.status}); not attempting to create`)
    process.exit(1)
  }
  if (listJson.result && listJson.result.length > 0) {
    console.log("record exists, id", listJson.result[0].id)
    return
  }

  console.log("creating CNAME...")
  const create = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "CNAME",
      name: "cloud.antifield.work",
      content: "b6683fba-30e5-4f49-a785-5680e7a30e21.cfargotunnel.com",
      proxied: true,
      comment: "PiForge workbench via cloudflared",
    }),
  })
  const body = (await create.text()).slice(0, 1000)
  console.log("create", create.status, body)
  if (!create.ok) {
    console.error(`cf-api-dns: creating the CNAME failed (HTTP ${create.status})`)
    process.exit(1)
  }
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
NODE
