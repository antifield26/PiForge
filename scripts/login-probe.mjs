import { readFileSync } from "node:fs"
const env = readFileSync("/home/antifield/piforge/gateway.env", "utf8")
const get = (k) =>
  env
    .split("\n")
    .find((l) => l.startsWith(k + "="))
    ?.slice(k.length + 1)
    .trim()
const body = JSON.stringify({
  username: get("ADMIN_USER") || "admin",
  password: get("ADMIN_PASSWORD"),
})
const res = await fetch("http://127.0.0.1:8787/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
})
console.log(res.status, await res.text())
