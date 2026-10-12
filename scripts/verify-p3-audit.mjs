#!/usr/bin/env node
// P3.4 acceptance: audit filter + login audit + CSV export on the live gateway.
import { readFileSync } from "node:fs"

const BASE = "http://127.0.0.1:8787"
const results = []
const ok = (n, d = "") => {
  results.push({ n, ok: true })
  console.log(`ok   ${n}${d ? " — " + d : ""}`)
}
const fail = (n, d = "") => {
  results.push({ n, ok: false })
  console.log(`FAIL ${n}${d ? " — " + d : ""}`)
}

const env = readFileSync("/etc/piforge/gateway.env", "utf8")
const get = (k) => env.split("\n").find((l) => l.startsWith(k + "="))?.slice(k.length + 1)
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: get("ADMIN_USER") ?? "admin", password: get("ADMIN_PASSWORD") }),
})
// A 429 here (the login limiter is 10/IP/5min and repeated acceptance runs share one IP) used to
// surface as `Cannot read properties of null` three lines later, which reads like a code defect
// instead of "wait and retry". Report it as what it is.
if (!login.ok) {
  const retry = login.headers.get("retry-after")
  console.error(
    `login failed: HTTP ${login.status}${retry ? ` (rate limited, retry after ${retry}s)` : ""} — ` +
      `wait for the login window to clear and re-run`,
  )
  process.exit(2)
}
const cookie = login.headers.get("set-cookie").split(";")[0]

async function api(path) {
  const res = await fetch(BASE + path, { headers: { cookie } })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, headers: res.headers }
}

const audit = await api("/api/v1/console/audit?limit=20")
if (audit.status === 200 && Array.isArray(audit.body.items) && Array.isArray(audit.body.units)) {
  ok("service audit lists with units", `items=${audit.body.items.length} units=${audit.body.units.length}`)
} else {
  fail("service audit lists with units", `status=${audit.status}`)
}

const filtered = await api("/api/v1/console/audit?allowed=0&limit=10")
if (
  filtered.status === 200 &&
  filtered.body.items.every((r) => r.allowed === 0)
) {
  ok("service audit filter allowed=0")
} else {
  fail("service audit filter allowed=0", JSON.stringify(filtered.body).slice(0, 120))
}

const logins = await api("/api/v1/console/audit/login?limit=10")
if (logins.status === 200 && Array.isArray(logins.body.items)) {
  ok("login audit lists", `items=${logins.body.items.length}`)
} else {
  fail("login audit lists", `status=${logins.status}`)
}

const csv = await api("/api/v1/console/audit/export?kind=service&limit=20")
const csvText = typeof csv.body === "string" ? csv.body : ""
if (
  csv.status === 200 &&
  csvText.startsWith("id,ts,iso,user_id,unit,action,allowed,result,client_ip") &&
  (csv.headers.get("content-disposition") ?? "").includes("service-audit")
) {
  ok("service audit CSV export")
} else {
  fail("service audit CSV export", `status=${csv.status} head=${csvText.slice(0, 60)}`)
}

const csvLogin = await api("/api/v1/console/audit/export?kind=login")
const csvLoginText = typeof csvLogin.body === "string" ? csvLogin.body : ""
if (csvLogin.status === 200 && csvLoginText.startsWith("id,ts,iso,username,ok,client_ip,user_agent")) {
  ok("login audit CSV export")
} else {
  fail("login audit CSV export", `status=${csvLogin.status}`)
}

const anon = await fetch(`${BASE}/api/v1/console/audit/export`)
if (anon.status === 401) ok("audit export rejects anonymous")
else fail("audit export rejects anonymous", `status=${anon.status}`)

const passed = results.filter((r) => r.ok).length
console.log(JSON.stringify({ passed, failed: results.length - passed }))
process.exit(results.length - passed > 0 ? 1 : 0)
