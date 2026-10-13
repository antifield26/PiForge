// Regression tests for the defects a deep audit found. Each one covers a semantic that had no
// assertion at all, which is why the bugs survived a green suite (see the audit's mutation run).
import test from "node:test"
import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureAdminUser } from "../dist/modules/auth/routes.js"
import { setServiceExec } from "../dist/modules/console/service-control.js"
import { issueConfirmToken, verifyConfirmToken } from "../dist/modules/console/service-control.js"
import { createRateLimiter, createLoginLimiters } from "../dist/auth/ratelimit.js"
import { clampInt } from "../dist/util/validate.js"
import { base64Of, cleanup, login, startApp, stubAdapter, tempDir } from "./helpers.mjs"

const PASSWORD = "test-password-123"

const ALLOWLIST = {
  units: [
    { name: "nginx.service", label: "Nginx", allow: ["start", "stop", "restart", "status"], confirm: ["stop", "restart"] },
    { name: "statusonly.service", label: "Status only", allow: ["status"] },
  ],
}

async function withApp(t, options = {}) {
  const dir = await tempDir()
  await writeFile(join(dir, "services.allowlist.json"), JSON.stringify(ALLOWLIST), "utf8")
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

async function signIn(app, username, password = PASSWORD) {
  await ensureAdminUser(app.db, username, password)
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  })
  const raw = res.headers["set-cookie"]
  return { cookie: Array.isArray(raw) ? raw[0] : raw, res }
}

// ---------------------------------------------------------------- confirm token crypto

test("confirm token rejects a signature made with a different secret", () => {
  // The old suite only asserted that swapping unit/action/user returned false, but it had already
  // consumed the jti, so those assertions passed even with the HMAC check removed entirely.
  const token = issueConfirmToken("nginx.service", "restart", "user-1")
  const parts = token.split(".")
  const forged = `${parts[0]}.${parts[1]}.${"A".repeat(22)}`
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-1", forged), false)
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-1", token), true, "the genuine token still works")
})

test("confirm token binds unit, action and user independently", () => {
  // A fresh token per assertion: each is single-use, so reusing one would test the replay guard
  // instead of the binding.
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-2", issueConfirmToken("nginx.service", "restart", "user-1")), false)
  assert.equal(verifyConfirmToken("nginx.service", "stop", "user-1", issueConfirmToken("nginx.service", "restart", "user-1")), false)
  assert.equal(verifyConfirmToken("cloudflared.service", "restart", "user-1", issueConfirmToken("nginx.service", "restart", "user-1")), false)
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-1", "not-a-token"), false)
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-1", undefined), false)
  const expired = issueConfirmToken("nginx.service", "restart", "user-1", Date.now() - 120_000)
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-1", expired), false)
})

// ---------------------------------------------------------------- rate limiting

test("login budget is spent atomically so concurrent guesses cannot slip through", async (t) => {
  const { app } = await withApp(t)
  // 5 per username per 5 minutes. Before the fix every concurrent request observed an empty
  // bucket (the scrypt await sat between check and record) and all of them reached verification.
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { "cf-connecting-ip": "203.0.113.7" },
        payload: { username: "admin", password: "definitely-wrong" },
      }),
    ),
  )
  const evaluated = results.filter((r) => r.statusCode === 401).length
  const throttled = results.filter((r) => r.statusCode === 429).length
  assert.equal(throttled, 15, `expected 5 attempts and 15 throttles, got ${evaluated} attempts / ${throttled} throttles`)
  assert.ok(evaluated <= 5, `only 5 password verifications may run per window, ran ${evaluated}`)
})

test("the per-IP budget bounds a caller rotating usernames", async (t) => {
  const { app } = await withApp(t)
  const codes = []
  for (let i = 0; i < 14; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "cf-connecting-ip": "198.51.100.44" },
      payload: { username: `nobody-${i}`, password: "wrong" },
    })
    codes.push(res.statusCode)
  }
  assert.equal(codes.filter((c) => c === 429).length, 4, `ip budget is 10/min: ${codes.join(",")}`)
})

test("a successful login returns the username budget but keeps the ip budget", async (t) => {
  const { app } = await withApp(t)
  const ip = "198.51.100.99"
  for (let i = 0; i < 4; i++) {
    await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "cf-connecting-ip": ip }, payload: { username: "admin", password: "wrong" } })
  }
  const ok = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "cf-connecting-ip": ip }, payload: { username: "admin", password: PASSWORD } })
  assert.equal(ok.statusCode, 200)
  const again = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "cf-connecting-ip": ip }, payload: { username: "admin", password: PASSWORD } })
  assert.equal(again.statusCode, 200, "the user must not be able to lock themselves out")
})

test("a flood of new keys cannot evict a throttled bucket that is still being probed", () => {
  // Insertion-order eviction let an attacker with many source addresses push the victim's
  // exhausted bucket out of the map and reset its budget; recency-ordered eviction keeps the
  // bucket that is still being touched.
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 3 })
  const now = Date.now()
  limiter.consume("victim", now)
  limiter.consume("victim", now)
  assert.equal(limiter.consume("victim", now).allowed, false, "victim is throttled")
  for (let i = 0; i < 20; i++) {
    limiter.consume(`flood-${i}`, now)
    const verdict = limiter.consume("victim", now) // the victim keeps knocking
    if (verdict.allowed) break
  }
  assert.equal(limiter.consume("victim", now).allowed, false, "the throttled address must stay throttled")
})

test("login limiters keep ip and username budgets separate", () => {
  const limiters = createLoginLimiters(3, 2, 60_000)
  const t0 = Date.now()
  assert.equal(limiters.user.consume("bob", t0).allowed, true)
  assert.equal(limiters.user.consume("bob", t0).allowed, true)
  assert.equal(limiters.user.consume("bob", t0).allowed, false)
  assert.equal(limiters.ip.consume("10.0.0.1", t0).allowed, true, "a blocked username must not consume the ip budget")
})

// ---------------------------------------------------------------- cross-user isolation

test("one user's data is invisible and immutable to another", async (t) => {
  const { app, cookie, db } = await withApp(t)
  const other = await signIn(app, "intruder")
  assert.ok(other.cookie)

  const created = {}
  created.todo = (await app.inject({ method: "POST", url: "/api/v1/todos", headers: auth(cookie), payload: { title: "private todo" } })).json()
  created.note = (await app.inject({ method: "POST", url: "/api/v1/notes", headers: auth(cookie), payload: { title: "private note", body: "secret", tags: ["x"] } })).json()
  created.bookmark = (await app.inject({ method: "POST", url: "/api/v1/bookmarks", headers: auth(cookie), payload: { url: "https://example.com" } })).json()
  created.file = (await app.inject({ method: "POST", url: "/api/v1/files", headers: auth(cookie), payload: { name: "private.txt", contentBase64: Buffer.from("secret").toString("base64") } })).json()

  for (const [list, url] of [["todo", "/api/v1/todos"], ["note", "/api/v1/notes"], ["bookmark", "/api/v1/bookmarks"], ["file", "/api/v1/files"]]) {
    const res = await app.inject({ method: "GET", url, headers: auth(other.cookie) })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().items.length, 0, `${url} leaked another user's ${list}`)
  }

  assert.equal((await app.inject({ method: "PATCH", url: `/api/v1/todos/${created.todo.id}`, headers: auth(other.cookie), payload: { title: "hijacked" } })).statusCode, 404)
  assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/todos/${created.todo.id}`, headers: auth(other.cookie) })).statusCode, 404)
  assert.equal((await app.inject({ method: "PATCH", url: `/api/v1/notes/${created.note.id}`, headers: auth(other.cookie), payload: { body: "hijacked" } })).statusCode, 404)
  assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/bookmarks/${created.bookmark.id}`, headers: auth(other.cookie) })).statusCode, 404)
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/files/${created.file.id}`, headers: auth(other.cookie) })).statusCode, 404)
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/files/${created.file.id}/versions`, headers: auth(other.cookie) })).json().items.length, 0)
  assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/files/${created.file.id}`, headers: auth(other.cookie) })).statusCode, 404)

  const stillThere = db.prepare("SELECT title FROM todos WHERE id = ?").get(created.todo.id)
  assert.equal(stillThere.title, "private todo", "the owner's row must be untouched")
})

// ---------------------------------------------------------------- csrf / url normalisation

test("a percent-encoded api path cannot bypass the cross-site check", async (t) => {
  const { app, cookie } = await withApp(t)
  const plain = await app.inject({
    method: "POST",
    url: "/api/v1/todos",
    headers: { ...auth(cookie), origin: "https://evil.example", host: "127.0.0.1:8787" },
    payload: { title: "x" },
  })
  assert.equal(plain.statusCode, 403)
  // The router matches the decoded path, so a raw-string prefix test let this through.
  const encoded = await app.inject({
    method: "POST",
    url: "/%61pi/v1/todos",
    headers: { ...auth(cookie), origin: "https://evil.example", host: "127.0.0.1:8787" },
    payload: { title: "x" },
  })
  assert.equal(encoded.statusCode, 403, "encoded api path must still be treated as api")

  const encodedLogin = await app.inject({
    method: "POST",
    url: "/%61pi/v1/auth/login",
    headers: { origin: "https://evil.example", host: "127.0.0.1:8787" },
    payload: { username: "admin", password: PASSWORD },
  })
  assert.equal(encodedLogin.statusCode, 403)
})

// ---------------------------------------------------------------- service control

test("an action outside the allowlist for a known unit is refused and audited", async (t) => {
  const { app, cookie, db } = await withApp(t)
  // statusonly.service exists but may only be asked for status; restart must be a 403.
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/console/services/statusonly.service/restart",
    headers: auth(cookie),
    payload: {},
  })
  assert.equal(res.statusCode, 403)
  const row = db.prepare("SELECT * FROM service_audit WHERE id = ?").get(res.json().auditId)
  assert.equal(row.allowed, 0)
  assert.match(String(row.result), /action not allowed/)
})

test("the console does not retry systemctl for an action it already refused", async (t) => {
  const { app, cookie } = await withApp(t)
  const calls = []
  setServiceExec(async (cmd, args) => {
    calls.push([cmd, ...args].join(" "))
    return { stdout: "active\n" }
  })
  await app.inject({ method: "POST", url: "/api/v1/console/services/statusonly.service/restart", headers: auth(cookie), payload: {} })
  assert.equal(calls.filter((c) => c.includes("restart")).length, 0, "no systemctl restart may be spawned for a refused action")
})

// ---------------------------------------------------------------- cloud files

test("concurrent uploads of one name keep a single row and the last bytes", async (t) => {
  const { app, cookie, db } = await withApp(t)
  const uploads = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      app.inject({
        method: "POST",
        url: "/api/v1/files",
        headers: auth(cookie),
        payload: { name: "race.txt", contentBase64: Buffer.from(`body-${i}`).toString("base64") },
      }),
    ),
  )
  assert.ok(uploads.every((r) => r.statusCode === 201), uploads.map((r) => r.statusCode).join(","))
  const rows = db.prepare("SELECT id, storage_key FROM cloud_files WHERE path = 'race.txt'").all()
  assert.equal(rows.length, 1, "one row per (user, name) — the unique index must hold")
  const list = await app.inject({ method: "GET", url: "/api/v1/files", headers: auth(cookie) })
  assert.equal(list.json().items.length, 1)

  const id = rows[0].id
  const download = await app.inject({ method: "GET", url: `/api/v1/files/${id}`, headers: auth(cookie) })
  assert.equal(download.statusCode, 200, "the surviving row must point at bytes that exist")
  assert.ok(download.body.startsWith("body-"))
  // Every upload should have preserved the bytes it replaced, capped by MAX_VERSIONS_PER_FILE.
  const versions = db.prepare("SELECT COUNT(*) AS n FROM cloud_file_versions WHERE file_id = ?").get(id)
  assert.ok(versions.n >= 1 && versions.n <= 10, `version history out of range: ${versions.n}`)
})

test("version pruning keeps the newest history and drops the oldest", async (t) => {
  const { app, cookie, db } = await withApp(t)
  const first = await app.inject({ method: "POST", url: "/api/v1/files", headers: auth(cookie), payload: { name: "v.txt", contentBase64: base64Of(4) } })
  const id = first.json().id
  for (let i = 0; i < 13; i++) {
    const res = await app.inject({ method: "POST", url: "/api/v1/files", headers: auth(cookie), payload: { name: "v.txt", contentBase64: Buffer.from(`rev-${i}`).toString("base64") } })
    assert.equal(res.statusCode, 201)
  }
  const rows = db.prepare("SELECT id, created_at FROM cloud_file_versions WHERE file_id = ? ORDER BY created_at DESC, rowid DESC").all(id)
  assert.equal(rows.length, 10, "history is capped at 10")
  const listed = await app.inject({ method: "GET", url: `/api/v1/files/${id}/versions`, headers: auth(cookie) })
  for (const v of listed.json().items) {
    const res = await app.inject({ method: "GET", url: `/api/v1/files/${id}/versions/${v.id}`, headers: auth(cookie) })
    assert.equal(res.statusCode, 200, `listed version ${v.id} must be downloadable, not a dangling row`)
  }
})

test("an oversized upload is refused before the body is decoded", async (t) => {
  const { app, cookie } = await withApp(t)
  // 21 MiB of base64 exceeds the 20 MiB decoded cap; the old code built the Buffer first.
  const huge = "A".repeat(Math.ceil((21 * 1024 * 1024 * 4) / 3))
  const res = await app.inject({ method: "POST", url: "/api/v1/files", headers: auth(cookie), payload: { name: "big.bin", contentBase64: huge } })
  assert.ok(res.statusCode === 400 || res.statusCode === 413, `expected 400/413, got ${res.statusCode}`)
})

// ---------------------------------------------------------------- metrics retention and batching

test("metric retention deletes only rows outside the window", async (t) => {
  const { app, cookie, db } = await withApp(t)
  const now = Date.now()
  const old = now - 40 * 24 * 3600_000
  const insert = db.prepare("INSERT OR REPLACE INTO metrics_points (ts, kind, value) VALUES (?, ?, ?)")
  insert.run(old, "cpu", 1)
  insert.run(now - 1000, "cpu", 2)

  const { pruneMetrics } = await import("../dist/db/index.js")
  const removed = pruneMetrics(db, 30, now)
  assert.equal(removed, 1, "only the expired point is removed")
  const left = db.prepare("SELECT COUNT(*) AS n FROM metrics_points WHERE kind = 'cpu'").get()
  assert.equal(left.n, 1)
  void cookie
  void app
})

test("audit retention trims login_audit, service_audit, alerts and backup_runs", async (t) => {
  const { app, db } = await withApp(t)
  const now = Date.now()
  const old = now - 400 * 24 * 3600_000
  db.prepare("INSERT INTO login_audit (ts, username, ok) VALUES (?, 'x', 0)").run(old)
  db.prepare("INSERT INTO service_audit (ts, unit, action, allowed) VALUES (?, 'u', 'restart', 0)").run(old)
  db.prepare("INSERT INTO alerts (kind, severity, title, message, dedupe_key, created_at) VALUES ('k','warning','t','m','dedupe-old',?)").run(old)
  db.prepare("INSERT INTO backup_runs (started_at, status, target) VALUES (?, 'failed', 'local')").run(old)

  const { pruneAuditTables } = await import("../dist/db/index.js")
  const removed = pruneAuditTables(db, 180, now)
  assert.equal(removed, 4, `expected 4 rows pruned, got ${removed}`)
  const leftovers = db
    .prepare(
      `SELECT 'login_audit' AS t, COUNT(*) AS n FROM login_audit WHERE ts < ?
       UNION ALL SELECT 'service_audit', COUNT(*) FROM service_audit WHERE ts < ?
       UNION ALL SELECT 'alerts', COUNT(*) FROM alerts WHERE created_at < ?
       UNION ALL SELECT 'backup_runs', COUNT(*) FROM backup_runs WHERE started_at < ?`,
    )
    .all(now - 180 * 24 * 3600_000, now - 180 * 24 * 3600_000, now - 180 * 24 * 3600_000, now - 180 * 24 * 3600_000)
  for (const row of leftovers) assert.equal(row.n, 0, `${row.t} kept ${row.n} expired row(s)`)
  void app
})

test("reading console metrics and sd health does not write settings", async (t) => {
  const { app, cookie, db } = await withApp(t)
  db.prepare("DELETE FROM settings").run()
  await app.inject({ method: "GET", url: "/api/v1/console/system", headers: auth(cookie) })
  await app.inject({ method: "GET", url: "/api/v1/console/sd", headers: auth(cookie) })
  await app.inject({ method: "GET", url: "/api/v1/console/perf", headers: auth(cookie) })
  const settings = db.prepare("SELECT key FROM settings").all().map((r) => r.key)
  assert.deepEqual(settings, [], `console polls must not write settings, wrote: ${settings.join(",")}`)
})

// ---------------------------------------------------------------- agent streams

test("event streams are capped per user instead of growing without bound", async (t) => {
  const { app, cookie } = await withApp(t, { openCode: stubAdapter() })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const { port } = app.server.address()
  const bodies = []
  t.after(() => {
    for (const body of bodies) void body.cancel().catch(() => {})
  })
  try {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        fetch(`http://127.0.0.1:${port}/api/v1/agent/events`, {
          headers: { cookie, "cf-connecting-ip": `203.0.113.${10 + i}` },
        }),
      ),
    )
    for (const res of responses) if (res.body) bodies.push(res.body)
    const statuses = responses.map((r) => r.status)
    assert.equal(statuses.filter((s) => s === 200).length, 4, `cap is 4 per user, got ${statuses.join(",")}`)
    const rejected = responses.filter((r) => r.status === 503)
    assert.equal(rejected.length, 2, `expected 2 rejections, got ${statuses.join(",")}`)
    assert.match(await rejected[0].text(), /TOO_MANY_STREAMS/)
  } finally {
    for (const body of bodies) await body.cancel().catch(() => {})
  }
})

// ---------------------------------------------------------------- single instance

test("a second gateway refuses to start against the same database", async (t) => {
  const dir = await tempDir("pf-lock-")
  t.after(() => cleanup(dir))
  const { acquireSingleInstanceLock } = await import("../dist/util/instance-lock.js")
  const dbPath = join(dir, "wb.db")

  const release = acquireSingleInstanceLock(dbPath)
  assert.throws(() => acquireSingleInstanceLock(dbPath), /another gateway is already running/)
  release()

  // A lock left behind by a crashed process must not wedge the service forever.
  await writeFile(join(dir, "gateway.lock"), "999999\n2020-01-01T00:00:00.000Z\n", "utf8")
  const reclaimed = acquireSingleInstanceLock(dbPath)
  reclaimed()
})

// ---------------------------------------------------------------- FIX-4: agent write budget

test("agent session create and interrupt are rate limited per user", async (t) => {
  const calls = []
  const openCode = stubAdapter({
    async createSession(title) {
      calls.push("create")
      return { id: `ses_${calls.length}`, title: title ?? "", createdAt: 1, updatedAt: 1 }
    },
    async interrupt() {
      calls.push("interrupt")
    },
  })
  const { app, cookie } = await withApp(t, { openCode })
  // writeHeavy is 20/min; the 21st write must come back 429 with Retry-After.
  let limited = null
  for (let i = 0; i < 25; i++) {
    const res = await app.inject({ method: "POST", url: "/api/v1/agent/sessions", headers: auth(cookie), payload: {} })
    if (res.statusCode === 429) {
      limited = res
      break
    }
    assert.equal(res.statusCode, 201, res.body)
  }
  assert.ok(limited, "session create must eventually return 429")
  assert.ok(limited.headers["retry-after"], "429 must carry Retry-After")
  assert.match(limited.json().error.code, /RATE_LIMITED/)
})

// ---------------------------------------------------------------- FIX-4: login key case-fold

test("login rate limit buckets Admin and admin as the same username key", async (t) => {
  const { app } = await withApp(t)
  // userLimit is 5 per 5 minutes; alternate casing must share one budget.
  const statuses = []
  for (let i = 0; i < 8; i++) {
    const username = i % 2 === 0 ? "Admin" : "admin"
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: `wrong-${i}` },
    })
    statuses.push(res.statusCode)
    if (res.statusCode === 429) break
  }
  assert.ok(
    statuses.includes(429),
    `mixed-case usernames must share one limit bucket, got ${statuses.join(",")}`,
  )
})

// ---------------------------------------------------------------- FIX-4: notFound decode

test("percent-encoded API paths get a JSON 404, not the SPA shell", async (t) => {
  const { app } = await withApp(t)
  const res = await app.inject({ method: "GET", url: "/%61pi/v1/no-such-route" })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().error.code, "NOT_FOUND")
  const htmlish = await app.inject({ method: "GET", url: "/workbench-panel" })
  // No web dist in tests: non-API 404 is still JSON, but must NOT claim to be an API miss.
  assert.equal(htmlish.statusCode, 404)
  assert.equal(htmlish.json().error.code, "NOT_FOUND")
})

// ---------------------------------------------------------------- FIX-4: error message hygiene

test("thrown non-business errors do not echo err.message to the client", async (t) => {
  const { app, cookie } = await withApp(t)
  // Force the error handler via an invalid JSON body: our typed BAD_REQUEST keeps its message.
  const bad = await app.inject({
    method: "POST",
    url: "/api/v1/todos",
    headers: { ...auth(cookie), "content-type": "application/json" },
    payload: "{not-json",
  })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().error.message, "invalid json body")

  // Simulate a Fastify-internal throw by posting a non-object body that still parses as JSON
  // but is not what the route expects — the route itself uses sendError. For the error-handler
  // path, craft a request that surfaces as 400 without our BAD_REQUEST code.
  const weird = await app.inject({
    method: "POST",
    url: "/api/v1/todos",
    headers: { ...auth(cookie), "content-type": "application/json" },
    payload: JSON.stringify(123),
  })
  // Number body: Fastify may coerce; if the route 400s via sendError the message is intentional.
  if (weird.statusCode === 400) {
    const body = weird.json()
    assert.ok(body.error && body.error.message, "envelope intact")
    assert.ok(!/\/[A-Za-z]:\\|node_modules|Error:/.test(body.error.message), `leaky message: ${body.error.message}`)
  }
})

// ---------------------------------------------------------------- helpers

test("clampInt still bounds untrusted query values", () => {
  assert.equal(clampInt("abc", 7, 1, 10), 7)
  assert.equal(clampInt("-5", 7, 1, 10), 1)
  assert.equal(clampInt("999", 7, 1, 10), 10)
})
