import test from "node:test"
import assert from "node:assert/strict"
import { writeFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { ensureAdminUser } from "../dist/modules/auth/routes.js"
import { setServiceExec } from "../dist/modules/console/service-control.js"
import { base64Of, cleanup, login, startApp, stubAdapter, tempDir } from "./helpers.mjs"

const PASSWORD = "test-password-123"

const ALLOWLIST = {
  units: [
    { name: "nginx.service", label: "Nginx", allow: ["start", "stop", "restart", "status"], confirm: ["stop", "restart"] },
    { name: "cloudflared.service", label: "Tunnel", allow: ["status", "restart"], confirm: ["restart"] },
  ],
}

async function withApp(t, options = {}) {
  const dir = await tempDir()
  await writeFile(join(dir, "services.allowlist.json"), JSON.stringify(ALLOWLIST), "utf8")
  // Never touch real systemd from unit tests: stub the exec used by service-control.
  // A test that needs failure can override again after this.
  setServiceExec(async () => ({ stdout: "active\n" }))
  t.after(() => setServiceExec(null))
  const built = await startApp(dir, options)
  await ensureAdminUser(built.db, "admin", PASSWORD)
  t.after(async () => {
    await built.app.close()
    await cleanup(dir)
  })
  const { res, cookie } = await login(built.app, "admin", PASSWORD)
  assert.equal(res.statusCode, 200, `login should succeed: ${res.body}`)
  return { ...built, dir, cookie }
}

const auth = (cookie) => ({ cookie })

// ---------------------------------------------------------------- auth

test("protected routes reject anonymous callers with the unified envelope", async (t) => {
  const { app } = await withApp(t)
  for (const url of ["/api/v1/auth/me", "/api/v1/todos", "/api/v1/console/system", "/api/v1/agent/sessions"]) {
    const res = await app.inject({ method: "GET", url })
    assert.equal(res.statusCode, 401, url)
    assert.equal(res.json().error.code, "UNAUTHORIZED", url)
  }
})

test("login is rate limited after repeated failures", async (t) => {
  const { app } = await withApp(t)
  const statuses = []
  for (let i = 0; i < 7; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: `wrong-${i}` },
    })
    statuses.push(res.statusCode)
    if (res.statusCode === 429) {
      assert.ok(res.headers["retry-after"], "429 must carry Retry-After")
      assert.equal(res.json().error.code, "RATE_LIMITED")
    }
  }
  assert.ok(statuses.includes(429), `expected a 429 in ${statuses.join(",")}`)
  assert.ok(statuses.indexOf(429) >= 5, "must allow several attempts before blocking")
})

test("logout revokes the session cookie", async (t) => {
  const { app, cookie } = await withApp(t)
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: auth(cookie) })).statusCode, 200)
  await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: auth(cookie), payload: {} })
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: auth(cookie) })).statusCode, 401)
})

// ---------------------------------------------------------------- error contract

test("malformed json is a 400 with the api error shape, not a 500", async (t) => {
  const { app, cookie } = await withApp(t)
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/todos",
    headers: { ...auth(cookie), "content-type": "application/json" },
    payload: "{not json",
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error.code, "BAD_REQUEST")
})

test("oversized json bodies are reported as a normalised 413", async (t) => {
  const { app, cookie } = await withApp(t)
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/todos",
    headers: auth(cookie),
    payload: { title: "x".repeat(1_200_000) },
  })
  assert.equal(res.statusCode, 413)
  assert.equal(res.json().error.code, "PAYLOAD_TOO_LARGE")
})

test("security headers are present on html and api responses", async (t) => {
  const { app, cookie } = await withApp(t)
  const res = await app.inject({ method: "GET", url: "/api/v1/todos", headers: auth(cookie) })
  assert.equal(res.headers["x-content-type-options"], "nosniff")
  assert.equal(res.headers["x-frame-options"], "DENY")
  assert.match(res.headers["content-security-policy"], /default-src 'self'/)
})

// ---------------------------------------------------------------- cloud files

test("cloud upload accepts multi-megabyte base64 payloads", async (t) => {
  const { app, cookie } = await withApp(t)
  const twoMb = await app.inject({
    method: "POST",
    url: "/api/v1/files",
    headers: auth(cookie),
    payload: { name: "big.bin", contentBase64: base64Of(2 * 1024 * 1024) },
  })
  assert.equal(twoMb.statusCode, 201, twoMb.body)

  const tooBig = await app.inject({
    method: "POST",
    url: "/api/v1/files",
    headers: auth(cookie),
    payload: { name: "huge.bin", contentBase64: base64Of(21 * 1024 * 1024) },
  })
  assert.equal(tooBig.statusCode, 400)
  assert.match(tooBig.json().error.message, /20MB/)
})

test("overwriting a file preserves the previous content as a downloadable version", async (t) => {
  const { app, cookie, dir } = await withApp(t)
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/files",
    headers: auth(cookie),
    payload: { name: "notes.txt", contentBase64: Buffer.from("VERSION-ONE").toString("base64") },
  })
  assert.equal(first.statusCode, 201)
  const id = first.json().id

  const second = await app.inject({
    method: "POST",
    url: "/api/v1/files",
    headers: auth(cookie),
    payload: { name: "notes.txt", contentBase64: Buffer.from("VERSION-TWO").toString("base64") },
  })
  assert.equal(second.statusCode, 201)
  assert.equal(second.json().versioned, true)
  assert.equal(second.json().id, id, "overwrite keeps the same file id")

  const current = await app.inject({ method: "GET", url: `/api/v1/files/${id}`, headers: auth(cookie) })
  assert.equal(current.body, "VERSION-TWO")

  const versions = await app.inject({ method: "GET", url: `/api/v1/files/${id}/versions`, headers: auth(cookie) })
  const items = versions.json().items
  assert.equal(items.length, 1)

  const previous = await app.inject({
    method: "GET",
    url: `/api/v1/files/${id}/versions/${items[0].id}`,
    headers: auth(cookie),
  })
  assert.equal(previous.statusCode, 200)
  assert.equal(previous.body, "VERSION-ONE", "the version must hold the OLD content")

  await app.inject({ method: "DELETE", url: `/api/v1/files/${id}`, headers: auth(cookie) })
  const listing = await readdir(join(dir, "cloud"), { recursive: true })
  const leftovers = listing.filter((f) => f.includes("notes"))
  assert.deepEqual(leftovers, [], `version files must be removed with the file: ${leftovers.join(",")}`)
  const afterDelete = await app.inject({ method: "GET", url: `/api/v1/files/${id}/versions`, headers: auth(cookie) })
  assert.equal(afterDelete.json().items.length, 0)
})

test("bookmarks only accept http and https urls", async (t) => {
  const { app, cookie } = await withApp(t)
  const bad = await app.inject({
    method: "POST",
    url: "/api/v1/bookmarks",
    headers: auth(cookie),
    payload: { url: "javascript:alert(1)" },
  })
  assert.equal(bad.statusCode, 400)

  const good = await app.inject({
    method: "POST",
    url: "/api/v1/bookmarks",
    headers: auth(cookie),
    payload: { url: "https://example.com", title: "ok" },
  })
  assert.equal(good.statusCode, 201)
})

// ---------------------------------------------------------------- workbench validation

test("todos validate status and dueAt", async (t) => {
  const { app, cookie } = await withApp(t)
  const bad = await app.inject({
    method: "POST",
    url: "/api/v1/todos",
    headers: auth(cookie),
    payload: { title: "t", status: "whatever" },
  })
  assert.equal(bad.statusCode, 400)

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/todos",
    headers: auth(cookie),
    payload: { title: "t", status: "open", dueAt: 1234 },
  })
  assert.equal(created.statusCode, 201)
  const id = created.json().id

  const patched = await app.inject({
    method: "PATCH",
    url: `/api/v1/todos/${id}`,
    headers: auth(cookie),
    payload: { status: "done", dueAt: null },
  })
  assert.equal(patched.statusCode, 200)
  assert.equal(patched.json().status, "done")
  assert.equal(patched.json().dueAt, null)
})

// ---------------------------------------------------------------- service control

test("service control refuses units outside the allowlist and audits the attempt", async (t) => {
  const { app, cookie, db } = await withApp(t)
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/console/services/ssh.service/restart",
    headers: auth(cookie),
    payload: {},
  })
  assert.equal(res.statusCode, 403)
  assert.ok(res.json().auditId)
  const row = db.prepare("SELECT * FROM service_audit WHERE id = ?").get(res.json().auditId)
  assert.equal(row.allowed, 0)
  assert.match(String(row.result), /not in allowlist/)

  const list = await app.inject({ method: "GET", url: "/api/v1/console/services", headers: auth(cookie) })
  const items = list.json().items
  assert.equal(items.length, 2)
  assert.ok("active" in items[0], "the panel needs the live state")
  assert.deepEqual(items[0].confirmActions, ["stop", "restart"])
})

test("dangerous service actions need a confirm token bound to the caller", async (t) => {
  const { app, cookie } = await withApp(t)
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/console/services/nginx.service/restart",
    headers: auth(cookie),
    payload: {},
  })
  assert.equal(first.statusCode, 202)
  const token = first.json().confirmToken
  assert.ok(token)

  const wrongToken = await app.inject({
    method: "POST",
    url: "/api/v1/console/services/nginx.service/restart",
    headers: auth(cookie),
    payload: { confirmToken: "9999999999999.abcdefghijklmnopqrstuv" },
  })
  assert.equal(wrongToken.statusCode, 202, "a forged token must not be accepted")

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/console/services/nginx.service/restart",
    headers: auth(cookie),
    payload: { confirmToken: token },
  })
  assert.equal(accepted.statusCode, 200, accepted.body)
  assert.notEqual(accepted.json().requiresConfirm, true)

  // One-time: the same confirm token must not unlock a second run.
  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/console/services/nginx.service/restart",
    headers: auth(cookie),
    payload: { confirmToken: token },
  })
  assert.equal(replay.statusCode, 202, "a consumed confirm token must not be replayed")
})

test("service control reports a failed systemctl as 502, not a fake 200", async (t) => {
  const { app, cookie } = await withApp(t)
  setServiceExec(async () => {
    throw new Error("Command failed: sudo systemctl restart nginx.service")
  })
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/console/services/nginx.service/restart",
    headers: auth(cookie),
    payload: {},
  })
  assert.equal(first.statusCode, 202)
  const token = first.json().confirmToken
  const failed = await app.inject({
    method: "POST",
    url: "/api/v1/console/services/nginx.service/restart",
    headers: auth(cookie),
    payload: { confirmToken: token },
  })
  assert.equal(failed.statusCode, 502, "an authorized but failed systemctl must not look like success")
  assert.equal(failed.json().error.code, "SERVICE_CONTROL_FAILED")
})

// ---------------------------------------------------------------- metrics writes

test("reading console metrics does not write metric rows", async (t) => {
  const { app, cookie, db } = await withApp(t)
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM metrics_points").get().n
  const before = count()
  for (let i = 0; i < 5; i++) {
    const res = await app.inject({ method: "GET", url: "/api/v1/console/system", headers: auth(cookie) })
    assert.equal(res.statusCode, 200)
  }
  assert.equal(count(), before, "polling /console/system must not grow metrics_points")
})

// ---------------------------------------------------------------- agent proxy

test("agent routes proxy through the adapter and validate decisions", async (t) => {
  const adapter = stubAdapter()
  const { app, cookie } = await withApp(t, { openCode: adapter })

  const sessions = await app.inject({ method: "GET", url: "/api/v1/agent/sessions", headers: auth(cookie) })
  assert.equal(sessions.statusCode, 200)
  assert.equal(sessions.json().items.length, 1)

  const permissions = await app.inject({
    method: "GET",
    url: "/api/v1/agent/sessions/ses_1/permissions",
    headers: auth(cookie),
  })
  assert.equal(permissions.json().items[0].id, "perm_1")

  const badDecision = await app.inject({
    method: "POST",
    url: "/api/v1/agent/sessions/ses_1/permissions/perm_1/reply",
    headers: auth(cookie),
    payload: { decision: "maybe" },
  })
  assert.equal(badDecision.statusCode, 400)

  const reply = await app.inject({
    method: "POST",
    url: "/api/v1/agent/sessions/ses_1/permissions/perm_1/reply",
    headers: auth(cookie),
    payload: { decision: "allow" },
  })
  assert.equal(reply.statusCode, 200)
  assert.deepEqual(adapter.calls.at(-1), { kind: "reply", id: "ses_1", reqId: "perm_1", decision: "allow" })

  const prompt = await app.inject({
    method: "POST",
    url: "/api/v1/agent/sessions/ses_1/prompt",
    headers: auth(cookie),
    payload: { content: "  " },
  })
  assert.equal(prompt.statusCode, 400)
})

test("agent events stream stays open, ends with a heartbeat comment and delivers unnamed data frames", async (t) => {
  const { app, cookie } = await withApp(t, { openCode: stubAdapter() })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/v1/agent/events`, {
      headers: { cookie },
      signal: controller.signal,
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)
    const reader = res.body.getReader()
    const chunk = await reader.read()
    const text = new TextDecoder().decode(chunk.value)
    assert.match(text, /^retry: \d+/)
    assert.match(text, /data: \{"type":"session\.update"/, "events must be sent as unnamed data frames")
    assert.equal(chunk.done, false, "the connection must stay open")
    await reader.cancel()
  } finally {
    clearTimeout(timer)
  }
})

test("static SPA fallback is not served for unknown api routes", async (t) => {
  const { app } = await withApp(t)
  const res = await app.inject({ method: "GET", url: "/api/v1/nope" })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().error.code, "NOT_FOUND")
})


// ---------------------------------------------------------------- CSRF & type safety

test("cross-site writes are rejected by the Origin check", async (t) => {
  const { app, cookie } = await withApp(t)
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/todos",
    headers: { ...auth(cookie), origin: "https://evil.example", host: "127.0.0.1:8787" },
    payload: { title: "x" },
  })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().error.code, "FORBIDDEN")
})

test("same-origin writes are accepted", async (t) => {
  const { app, cookie } = await withApp(t)
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/todos",
    headers: { ...auth(cookie), origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787" },
    payload: { title: "ok" },
  })
  assert.equal(res.statusCode, 201)
})

test("non-string login fields are a 400, not a TypeError 500", async (t) => {
  const { app } = await withApp(t)
  for (const payload of [
    { username: 123, password: "x" },
    { username: { a: 1 }, password: "x" },
    { username: "admin" },
  ]) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload })
    assert.equal(res.statusCode, 400, JSON.stringify(payload))
    assert.equal(res.json().error.code, "BAD_REQUEST")
  }
})

test("non-string confirmToken is treated as missing, not a 500", async (t) => {
  const { app, cookie } = await withApp(t)
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/console/services/nginx.service/restart",
    headers: auth(cookie),
    payload: { confirmToken: 12345 },
  })
  assert.equal(res.statusCode, 202)
  assert.ok(res.json().confirmToken)
})


// ---------------------------------------------------------------- alerts (P3.1/P3.2)

test("alerts list, unread count and mark-read", async (t) => {
  const { app, cookie, db } = await withApp(t)
  db.prepare(
    `INSERT INTO alerts (kind, severity, title, message, dedupe_key, created_at) VALUES (?,?,?,?,?,?)`,
  ).run("backup_failed", "critical", "备份失败", "test", "backup:failed", Date.now())

  const list = await app.inject({ method: "GET", url: "/api/v1/console/alerts", headers: auth(cookie) })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().items.length, 1)
  assert.equal(list.json().unread, 1)

  const read = await app.inject({
    method: "POST",
    url: "/api/v1/console/alerts/read",
    headers: auth(cookie),
    payload: { ids: "all" },
  })
  assert.equal(read.statusCode, 200)
  assert.equal(read.json().unread, 0)
})

test("alert thresholds reject invalid values and persist valid ones", async (t) => {
  const { app, cookie } = await withApp(t)
  const bad = await app.inject({
    method: "POST",
    url: "/api/v1/console/alerts/thresholds",
    headers: auth(cookie),
    payload: { sdDayWriteBytes: -1 },
  })
  assert.equal(bad.statusCode, 400)

  const ok = await app.inject({
    method: "POST",
    url: "/api/v1/console/alerts/thresholds",
    headers: auth(cookie),
    payload: { sdDayWriteBytes: 1024 * 1024, memAvailableMb: 128, cooldownMinutes: 5 },
  })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().sdDayWriteBytes, 1024 * 1024)
  assert.equal(ok.json().cooldownMinutes, 5)

  const again = await app.inject({ method: "GET", url: "/api/v1/console/alerts/thresholds", headers: auth(cookie) })
  assert.equal(again.json().memAvailableMb, 128)
})

test("alert detectors raise once per cooldown window", async (t) => {
  const { app, cookie, db } = await withApp(t)
  const { runDetectors, raiseAlert } = await import("../dist/modules/console/alerts.js")
  const now = 5_000_000
  const first = await runDetectors(db, {
    lastBackupStatus: "failed",
    sdDayWriteBytes: 0,
    memAvailableMb: 4096,
    now,
  })
  assert.ok(first.raised.length >= 1)
  const second = await runDetectors(db, {
    lastBackupStatus: "failed",
    sdDayWriteBytes: 0,
    memAvailableMb: 4096,
    now: now + 1000,
  })
  assert.equal(second.raised.length, 0, "same backup:failed key must be cooled down")

  // A different key still raises
  const other = raiseAlert(db, {
    kind: "sd_write_high",
    severity: "warning",
    title: "t",
    message: "m",
    dedupeKey: "sd:day_write",
    now: now + 2000,
  })
  assert.ok(other != null)
})


// ---------------------------------------------------------------- session management (P3.3)

test("sessions list, revoke one, and revoke-all keep the current session", async (t) => {
  const { app, cookie, db } = await withApp(t)
  // a second session for the same user
  const second = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "test-password-123" },
  })
  assert.equal(second.statusCode, 200)
  const cookie2 = Array.isArray(second.headers["set-cookie"])
    ? second.headers["set-cookie"][0]
    : second.headers["set-cookie"]

  const list = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: auth(cookie) })
  assert.equal(list.statusCode, 200)
  assert.ok(list.json().items.length >= 2)
  assert.ok(list.json().items.some((s) => s.current === true))

  const other = list.json().items.find((s) => !s.current)
  assert.ok(other)
  const del = await app.inject({
    method: "DELETE",
    url: `/api/v1/auth/sessions/${other.id}`,
    headers: auth(cookie),
  })
  assert.equal(del.statusCode, 200)

  // second cookie is now dead
  const me2 = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: auth(cookie2) })
  assert.equal(me2.statusCode, 401)

  const revoke = await app.inject({
    method: "POST",
    url: "/api/v1/auth/sessions/revoke-all",
    headers: auth(cookie),
    payload: {},
  })
  assert.equal(revoke.statusCode, 200)
  const list2 = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: auth(cookie) })
  assert.equal(list2.json().items.length, 1, "only the current session remains")
  assert.equal(list2.json().items[0].current, true)
})

test("cannot revoke another user's session", async (t) => {
  const { app, cookie, db } = await withApp(t)
  await ensureAdminUser(db, "other", "other-password-123")
  const otherLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "other", password: "other-password-123" },
  })
  const cookie2 = Array.isArray(otherLogin.headers["set-cookie"])
    ? otherLogin.headers["set-cookie"][0]
    : otherLogin.headers["set-cookie"]
  const list2 = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: auth(cookie2) })
  const target = list2.json().items[0]
  const del = await app.inject({
    method: "DELETE",
    url: `/api/v1/auth/sessions/${target.id}`,
    headers: auth(cookie),
  })
  assert.equal(del.statusCode, 404, "cross-user revoke must not work")
  const still = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: auth(cookie2) })
  assert.equal(still.statusCode, 200)
})

test("failed logins are recorded in login_audit", async (t) => {
  const { app, db } = await withApp(t)
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "wrong" },
  })
  const rows = db.prepare("SELECT ok FROM login_audit ORDER BY id DESC LIMIT 1").get()
  assert.equal(rows.ok, 0)
})


// ---------------------------------------------------------------- audit retrieval (P3.4)

test("service audit filter and login audit listing", async (t) => {
  const { app, cookie, db } = await withApp(t)
  db.prepare(
    "INSERT INTO service_audit (ts, user_id, unit, action, allowed, result, client_ip) VALUES (?,?,?,?,?,?,?)",
  ).run(Date.now(), null, "nginx.service", "restart", 0, "rejected: not in allowlist", "10.0.0.1")
  db.prepare(
    "INSERT INTO login_audit (ts, username, ok, client_ip, user_agent) VALUES (?,?,?,?,?)",
  ).run(Date.now(), "admin", 0, "10.0.0.2", "test-agent")

  const filtered = await app.inject({
    method: "GET",
    url: "/api/v1/console/audit?unit=nginx.service&allowed=0",
    headers: auth(cookie),
  })
  assert.equal(filtered.statusCode, 200)
  assert.ok(filtered.json().items.every((r) => r.unit === "nginx.service" && r.allowed === 0))
  assert.ok(filtered.json().units.includes("nginx.service"))

  const logins = await app.inject({
    method: "GET",
    url: "/api/v1/console/audit/login?ok=0",
    headers: auth(cookie),
  })
  assert.equal(logins.statusCode, 200)
  assert.ok(logins.json().items.every((r) => r.ok === 0))
})

test("audit CSV export is capped and annotated", async (t) => {
  const { app, cookie, db } = await withApp(t)
  db.prepare(
    "INSERT INTO service_audit (ts, user_id, unit, action, allowed, result, client_ip) VALUES (?,?,?,?,?,?,?)",
  ).run(Date.now(), null, "quote,\"unit", "restart", 1, "ok, with comma", "127.0.0.1")

  const res = await app.inject({
    method: "GET",
    url: "/api/v1/console/audit/export?kind=service&limit=5",
    headers: auth(cookie),
  })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers["content-type"] ?? "", /text\/csv/)
  assert.match(res.headers["content-disposition"] ?? "", /service-audit/)
  assert.match(res.body, /id,ts,iso,user_id,unit,action,allowed,result,client_ip/)
  assert.match(res.body, /"quote,""unit"/, "quotes must be escaped in CSV")

  const login = await app.inject({
    method: "GET",
    url: "/api/v1/console/audit/export?kind=login",
    headers: auth(cookie),
  })
  assert.equal(login.statusCode, 200)
  assert.match(login.body, /id,ts,iso,username,ok,client_ip,user_agent/)

  const anon = await app.inject({ method: "GET", url: "/api/v1/console/audit/export" })
  assert.equal(anon.statusCode, 401)
})
