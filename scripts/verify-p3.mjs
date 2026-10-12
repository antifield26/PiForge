#!/usr/bin/env node
// P3.1.5 / P3.2.4 / P3.3 acceptance: alerts, thresholds, session management on the live gateway.
import { readFileSync } from "node:fs"

const BASE = process.env.BASE ?? "http://127.0.0.1:8787"
const results = []
function ok(name, detail = "") {
  results.push({ name, ok: true, detail })
  console.log(`ok   ${name}${detail ? " — " + detail : ""}`)
}
function fail(name, detail = "") {
  results.push({ name, ok: false, detail })
  console.log(`FAIL ${name}${detail ? " — " + detail : ""}`)
}

function readAdmin() {
  const env = readFileSync("/etc/piforge/gateway.env", "utf8")
  const get = (k) => env.split("\n").find((l) => l.startsWith(k + "="))?.slice(k.length + 1)
  return { username: get("ADMIN_USER") ?? "admin", password: get("ADMIN_PASSWORD") }
}

async function login() {
  const cred = readAdmin()
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cred),
  })
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
  const cookie = res.headers.get("set-cookie").split(";")[0]
  return cookie
}

async function api(cookie, path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      cookie,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  const text = res.status === 204 ? "" : await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const cookie = await login()
ok("login for acceptance")

// --- thresholds ---
const th = await api(cookie, "/api/v1/console/alerts/thresholds")
if (th.status === 200 && typeof th.body.sdDayWriteBytes === "number") {
  ok("thresholds readable", JSON.stringify(th.body))
} else {
  fail("thresholds readable", `status=${th.status}`)
}

const setTh = await api(cookie, "/api/v1/console/alerts/thresholds", {
  method: "POST",
  body: JSON.stringify({ sdDayWriteBytes: 1024, memAvailableMb: 999999, cooldownMinutes: 1 }),
})
if (setTh.status === 200 && setTh.body.memAvailableMb === 999999) {
  ok("thresholds writable (force mem_low / sd_write_high)")
} else {
  fail("thresholds writable", `status=${setTh.status} body=${JSON.stringify(setTh.body)}`)
}

// --- force detectors via a direct raise path is not exposed; instead call the
// internal detector through a crafted backup status is hard. Use the alerts API
// after poking settings: we POST thresholds so mem is "low" by any real reading,
// then wait for the 60s detector OR invoke via a tiny node one-liner as root.
// Faster path: run the detector function directly against the live DB.
const { runDetectors } = await import("/opt/piforge/packages/gateway/dist/modules/console/alerts.js")
const { openDb } = await import("/opt/piforge/packages/gateway/dist/db/index.js")
const db = openDb("/var/lib/piforge/wb.db")
const det = await runDetectors(db, {
  lastBackupStatus: "failed",
  sdDayWriteBytes: 5_000_000_000,
  memAvailableMb: 1,
  now: Date.now(),
})
// The live gateway detector may already have raised some of these inside the
// cooldown window; success is that all three kinds exist afterwards, not that
// this call inserted all three rows.
ok("detectors executed", `raised_now=${det.raised.length}`)

const list = await api(cookie, "/api/v1/console/alerts")
if (list.status === 200 && list.body.items.length > 0) {
  ok("alerts listed", `items=${list.body.items.length} unread=${list.body.unread}`)
} else {
  fail("alerts listed", `status=${list.status} ${JSON.stringify(list.body)}`)
}

const kinds = new Set((list.body.items ?? []).map((a) => a.kind))
if (kinds.has("backup_failed") && kinds.has("mem_low") && kinds.has("sd_write_high")) {
  ok("alert kinds cover backup/mem/sd", [...kinds].join(","))
} else {
  fail("alert kinds cover backup/mem/sd", [...kinds].join(","))
}

// cooldown: second run with same key must not add
const before = list.body.items.length
const det2 = await runDetectors(db, {
  lastBackupStatus: "failed",
  sdDayWriteBytes: 5_000_000_000,
  memAvailableMb: 1,
  now: Date.now() + 1000,
})
const list2 = await api(cookie, "/api/v1/console/alerts")
if (det2.raised.length === 0 && list2.body.items.length === before) {
  ok("cooldown suppresses duplicates")
} else {
  fail("cooldown suppresses duplicates", `raised2=${det2.raised.length} items=${list2.body.items.length} before=${before}`)
}

const read = await api(cookie, "/api/v1/console/alerts/read", {
  method: "POST",
  body: JSON.stringify({ ids: "all" }),
})
const afterRead = await api(cookie, "/api/v1/console/alerts")
if (read.status === 200 && afterRead.body.unread === 0) {
  ok("mark-all-read clears unread")
} else {
  fail("mark-all-read clears unread", JSON.stringify(afterRead.body))
}

// restore sane thresholds
await api(cookie, "/api/v1/console/alerts/thresholds", {
  method: "POST",
  body: JSON.stringify({ sdDayWriteBytes: 500 * 1024 * 1024, memAvailableMb: 256, cooldownMinutes: 30 }),
})
ok("thresholds restored")

// --- sessions (P3.3) ---
const sess = await api(cookie, "/api/v1/auth/sessions")
if (sess.status === 200 && sess.body.items.length >= 1 && sess.body.items.some((s) => s.current)) {
  ok("session list works", `n=${sess.body.items.length}`)
} else {
  fail("session list works", `status=${sess.status}`)
}

// create a second session and revoke it
const login2 = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(readAdmin()),
})
const cookie2 = login2.headers.get("set-cookie").split(";")[0]
const sess2 = await api(cookie, "/api/v1/auth/sessions")
const other = sess2.body.items.find((s) => !s.current)
if (other) {
  const del = await api(cookie, `/api/v1/auth/sessions/${other.id}`, { method: "DELETE" })
  const me2 = await api(cookie2, "/api/v1/auth/me")
  if (del.status === 200 && me2.status === 401) {
    ok("revoke other session kills that cookie")
  } else {
    fail("revoke other session kills that cookie", `del=${del.status} me2=${me2.status}`)
  }
} else {
  fail("revoke other session kills that cookie", "no second session")
}

const rev = await api(cookie, "/api/v1/auth/sessions/revoke-all", { method: "POST", body: "{}" })
const sess3 = await api(cookie, "/api/v1/auth/sessions")
if (rev.status === 200 && sess3.body.items.length === 1 && sess3.body.items[0].current) {
  ok("revoke-all keeps current session")
} else {
  fail("revoke-all keeps current session", JSON.stringify(sess3.body))
}

db.close()

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(JSON.stringify({ passed, failed }, null, 2))
process.exit(failed > 0 ? 1 : 0)
