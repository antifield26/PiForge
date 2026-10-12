#!/usr/bin/env node
/**
 * Ensure the cloudflared public hostname has a CNAME in Cloudflare DNS.
 *
 * Mirrors scripts/cf-api-dns.sh (same credential, same calls, same order):
 * cloudflared's cert.pem carries a JWT whose *middle* dot-separated segment is the
 * base64url-encoded payload holding zoneID / accountID, and the whole JWT is the API
 * bearer credential. The token is therefore NOT one base64url blob — decoding it without
 * splitting on "." is what used to make this script die inside JSON.parse with a
 * "Unexpected token" error instead of reporting a usable message.
 *
 * Never prints the token. Run with sudo (the tunnel credential is root-readable):
 *   sudo node scripts/cf-api-dns.mjs
 *   CLOUDFLARED_CERT=/path/to/cert.pem node scripts/cf-api-dns.mjs
 */
import { readFileSync } from "node:fs"

const CERT_PATH = process.env.CLOUDFLARED_CERT ?? "/home/antifield/.cloudflared/cert.pem"
const RECORD_NAME = "cloud.antifield.work"
const TUNNEL_TARGET = "b6683fba-30e5-4f49-a785-5680e7a30e21.cfargotunnel.com"
const API = "https://api.cloudflare.com/client/v4"

let cert
try {
  cert = readFileSync(CERT_PATH, "utf8")
} catch (err) {
  console.error(`cf-api-dns: cannot read ${CERT_PATH}: ${err.code ?? err.message}`)
  console.error("cf-api-dns: the tunnel credential is root-readable, run this with sudo")
  process.exit(1)
}

// Same normalisation as the shell twin: drop the PEM armour, drop all whitespace.
const token = cert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")
const parts = token.split(".")
if (parts.length !== 3 || !parts[1]) {
  console.error(
    `cf-api-dns: the credential in ${CERT_PATH} is not a JWT (expected 3 dot-separated ` +
      `segments, got ${parts.length})`,
  )
  console.error(
    "cf-api-dns: run 'cloudflared tunnel login' to (re)create cert.pem, or point " +
      "CLOUDFLARED_CERT at the ARGO TUNNEL TOKEN file",
  )
  process.exit(1)
}

let payload
try {
  payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
} catch (err) {
  console.error(`cf-api-dns: the JWT payload is not base64url-encoded JSON: ${err.message}`)
  process.exit(1)
}
if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
  console.error("cf-api-dns: the JWT payload is not a JSON object")
  process.exit(1)
}

console.log("payload keys", Object.keys(payload))
console.log("zoneID", payload.zoneID)
console.log("accountID", payload.accountID)

const zone = payload.zoneID
if (!zone) {
  console.error(
    "cf-api-dns: the credential payload has no zoneID (not a zone-scoped tunnel " +
      `credential); keys: ${Object.keys(payload).join(", ")}`,
  )
  process.exit(1)
}

// The whole JWT is the bearer credential — not a nested field (the shell twin does the same).
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

async function main() {
  const list = await fetch(`${API}/zones/${zone}/dns_records?name=${RECORD_NAME}`, { headers })
  const listJson = await list.json().catch(() => null)
  console.log("list status", list.status)
  console.log(JSON.stringify(listJson, null, 2).slice(0, 2000))

  if (!listJson || listJson.success !== true) {
    console.error(
      `cf-api-dns: listing DNS records failed (HTTP ${list.status}); not attempting to create`,
    )
    process.exit(1)
  }

  if (listJson.result?.length) {
    console.log("record exists, id", listJson.result[0].id)
    return
  }

  console.log("creating CNAME...")
  const create = await fetch(`${API}/zones/${zone}/dns_records`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "CNAME",
      name: RECORD_NAME,
      content: TUNNEL_TARGET,
      proxied: true,
      comment: "PiForge workbench via cloudflared",
    }),
  })
  const createBody = (await create.text()).slice(0, 1000)
  console.log("create", create.status, createBody)
  if (!create.ok) {
    console.error(`cf-api-dns: creating the CNAME failed (HTTP ${create.status})`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`cf-api-dns: ${err}`)
  process.exit(1)
})
