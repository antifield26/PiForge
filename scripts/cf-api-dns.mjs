import { readFileSync } from "node:fs"

const cert = readFileSync("/home/antifield/.cloudflared/cert.pem", "utf8")
const token = cert
  .split("\n")
  .filter((l) => l && !l.includes("-----"))
  .join("")
const payload = JSON.parse(Buffer.from(token, "base64url").toString())
const apiToken = payload.apiToken
const zone = payload.zoneID
const headers = {
  Authorization: `Bearer ${apiToken}`,
  "Content-Type": "application/json",
}

const list = await fetch(
  `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records?name=cloud.antifield.work`,
  { headers },
)
const listJson = await list.json()
console.log("list", list.status, JSON.stringify(listJson).slice(0, 2000))

if (listJson.success && listJson.result?.length) {
  console.log("record exists, id", listJson.result[0].id)
} else {
  console.log("creating CNAME...")
  const create = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "CNAME",
      name: "cloud.antifield.work",
      content: "b6683fba-30e5-4f49-a785-5680e7a30e21.cfargotunnel.com",
      proxied: true,
      comment: "PiForge workbench",
    }),
  })
  console.log("create", create.status, (await create.text()).slice(0, 2000))
}
