import { readFileSync } from "node:fs"
const env = readFileSync("/etc/piforge/gateway.env", "utf8")
const get = (k) => env.split("\n").find((l) => l.startsWith(k + "="))?.slice(k.length + 1)
const login = await fetch("http://127.0.0.1:8787/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: get("ADMIN_USER") || "admin", password: get("ADMIN_PASSWORD") }),
})
const cookie = login.headers.get("set-cookie").split(";")[0]
const res = await fetch("http://127.0.0.1:8787/api/v1/console/backups", { headers: { cookie } })
const body = await res.json()
console.log(
  JSON.stringify({
    status: res.status,
    lastStatus: body.lastStatus,
    consecutiveFailures: body.consecutiveFailures,
    lastRestoreDrill: body.lastRestoreDrill,
  }),
)
