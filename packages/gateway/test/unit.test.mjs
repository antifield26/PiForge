import test from "node:test"
import assert from "node:assert/strict"
import { createRateLimiter, createLoginLimiters } from "../dist/auth/ratelimit.js"
import { hashPassword, verifyPassword, hashToken } from "../dist/auth/password.js"
import { verifyConfirmToken, issueConfirmToken, setConfirmSecret } from "../dist/modules/console/service-control.js"
import { parseSseFrame } from "../dist/modules/agent/http-adapter.js"
import { cloudInternals } from "../dist/modules/workbench/cloud.js"
import { accountWrites } from "../dist/modules/console/metrics.js"
import { openDb, getSettingNumber, setSetting } from "../dist/db/index.js"
import { isHttpUrl, clampInt, asStringArray } from "../dist/util/validate.js"
import { clientIp } from "../dist/util/net.js"

// ---------------------------------------------------------------- rate limiter

test("rate limiter allows up to the limit then blocks with a retry hint", () => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000 })
  const t0 = 10_000
  assert.equal(limiter.check("k", t0).allowed, true)
  limiter.record("k", t0)
  limiter.record("k", t0 + 1)
  limiter.record("k", t0 + 2)
  const blocked = limiter.check("k", t0 + 3)
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfterSec >= 1)
  assert.equal(limiter.check("k", t0 + 1001).allowed, true, "window must slide")
  assert.equal(limiter.check("other", t0 + 3).allowed, true, "keys are independent")
})

test("login limiters separate ip and username budgets", () => {
  const limiters = createLoginLimiters(2, 1, 1000)
  limiters.user.record("admin")
  assert.equal(limiters.user.check("admin").allowed, false)
  assert.equal(limiters.ip.check("1.2.3.4").allowed, true)
  limiters.ip.record("1.2.3.4")
  limiters.ip.record("1.2.3.4")
  assert.equal(limiters.ip.check("1.2.3.4").allowed, false)
})

// ---------------------------------------------------------------- password

test("scrypt hashes verify and reject tampered input", async () => {
  const stored = await hashPassword("correct horse battery staple")
  assert.match(stored, /^scrypt\$16384\$8\$1\$/)
  assert.equal(await verifyPassword("correct horse battery staple", stored), true)
  assert.equal(await verifyPassword("wrong", stored), false)
  assert.equal(await verifyPassword("x", "not-a-hash"), false)
  assert.equal(await verifyPassword("x", "scrypt$1$2$3$4"), false)
})

test("session tokens are hashed, never stored raw", () => {
  assert.notEqual(hashToken("abc"), "abc")
  assert.equal(hashToken("abc"), hashToken("abc"))
})

// ---------------------------------------------------------------- confirm tokens

test("confirm token is bound to unit, action and user", () => {
  setConfirmSecret("unit-test-secret")
  const now = 1_000_000
  const token = issueConfirmToken("nginx.service", "restart", "user-a", now)
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-a", token, now + 1000), true)
  assert.equal(verifyConfirmToken("nginx.service", "stop", "user-a", token, now + 1000), false)
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-b", token, now + 1000), false)
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-a", token, now + 120_000), false, "expires")
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-a", `${now + 5000}.deadbeef`, now), false)
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-a", undefined, now), false)
})

test("confirm token is single-use (jti cannot be replayed)", () => {
  setConfirmSecret("unit-test-secret")
  const now = 2_000_000
  const token = issueConfirmToken("nginx.service", "restart", "user-a", now)
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-a", token, now + 100), true)
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-a", token, now + 200), false, "replay must fail")
  const fresh = issueConfirmToken("nginx.service", "restart", "user-a", now + 300)
  assert.equal(verifyConfirmToken("nginx.service", "restart", "user-a", fresh, now + 400), true, "a new token still works")
})

// ---------------------------------------------------------------- SSE mapping

test("SSE frames map to stream events and unknown frames are dropped", () => {
  const update = parseSseFrame(
    'event: session.updated\ndata: {"type":"session.updated","data":{"id":"ses_1","title":"hi"}}',
  )
  assert.deepEqual(update, { type: "session.update", sessionId: "ses_1", title: "hi" })

  const permission = parseSseFrame(
    'data: {"type":"permission.updated","data":{"id":"p1","sessionID":"ses_1","tool":"bash"}}',
  )
  assert.equal(permission?.type, "permission.request")
  assert.equal(permission.request.id, "p1")

  assert.equal(parseSseFrame(": heartbeat"), null)
  assert.equal(parseSseFrame('data: {"type":"server.connected","data":{}}'), null)
  assert.equal(parseSseFrame("data: {not json}"), null)
})

// ---------------------------------------------------------------- storage names

test("cloud file names cannot escape the storage root", () => {
  assert.equal(cloudInternals.safeName("../../etc/passwd"), "passwd", "basename strips any directory part")
  assert.equal(cloudInternals.safeName("..\\..\\windows\\system32\\cmd.exe"), "cmd.exe")
  assert.equal(cloudInternals.safeName(""), "file")
  assert.equal(cloudInternals.safeName("报告 v2.md"), "报告_v2.md")
  assert.ok(!cloudInternals.safeName("a".repeat(400)).includes("/"))
  assert.equal(cloudInternals.fileKey("u1", "id1", "x.txt"), "u1/id1.txt")
})

// ---------------------------------------------------------------- sd wear accounting

test("sd write counters fold across reboots instead of resetting", () => {
  const db = openDb(":memory:")
  const t = 1_000_000

  // first ever observation during boot A
  let r = accountWrites(db, 1000, t)
  assert.equal(r.lifetime, 1000)
  // same boot, counter grows: lifetime = accum(0) + boot
  r = accountWrites(db, 5000, t + 1000)
  assert.equal(r.lifetime, 5000)
  // the boot counter is persisted at most every 5 minutes, or after a large delta
  r = accountWrites(db, 70_000_000, t + 2000)
  assert.equal(getSettingNumber(db, "sd_write_boot"), 70_000_000, "a large delta forces a persist")

  // reboot: counter went backwards -> previous boot's final value is folded in
  r = accountWrites(db, 200, t + 3000)
  assert.equal(getSettingNumber(db, "sd_write_accum"), 70_000_000)
  assert.equal(r.lifetime, 70_000_200)

  // a gateway restart inside the same boot must not double count
  r = accountWrites(db, 900, t + 4000)
  assert.equal(r.lifetime, 70_000_900)
  assert.equal(getSettingNumber(db, "sd_write_accum"), 70_000_000, "accumulator only moves on a reboot")
  db.close()
})

// ---------------------------------------------------------------- validation helpers

test("url validation only accepts http and https", () => {
  assert.equal(isHttpUrl("https://example.com/x"), true)
  assert.equal(isHttpUrl("http://127.0.0.1:8787"), true)
  assert.equal(isHttpUrl("javascript:alert(1)"), false)
  assert.equal(isHttpUrl("data:text/html,<script>"), false)
  assert.equal(isHttpUrl("not a url"), false)
})

test("clampInt bounds untrusted numeric query values", () => {
  assert.equal(clampInt("50", 10, 1, 100), 50)
  assert.equal(clampInt("9999", 10, 1, 100), 100)
  assert.equal(clampInt("-5", 10, 1, 100), 1)
  assert.equal(clampInt("abc", 10, 1, 100), 10)
  assert.equal(clampInt(undefined, 10, 1, 100), 10)
})

test("tag arrays are trimmed, capped and de-duplicated", () => {
  assert.deepEqual(asStringArray([" a ", "b", "a", 42, ""]), ["a", "b"])
  assert.deepEqual(asStringArray("nope"), null)
})

// ---------------------------------------------------------------- client ip

test("client ip trusts forwarding headers only from loopback peers", () => {
  const make = (remoteAddress, headers) => ({ socket: { remoteAddress }, ip: remoteAddress, headers })
  assert.equal(clientIp(make("127.0.0.1", { "cf-connecting-ip": "203.0.113.9" })), "203.0.113.9")
  assert.equal(clientIp(make("::1", { "x-forwarded-for": "198.51.100.4, 10.0.0.1" })), "198.51.100.4")
  assert.equal(
    clientIp(make("10.0.0.5", { "cf-connecting-ip": "203.0.113.9" })),
    "10.0.0.5",
    "a remote peer must not be able to spoof its address",
  )
  assert.equal(clientIp(make("::ffff:127.0.0.1", {})), "127.0.0.1")
})


// ---------------------------------------------------------------- alert thresholds

test("alert thresholds round-trip and reject garbage", async () => {
  const { openDb, getSetting } = await import("../dist/db/index.js")
  const { getThresholds, setThresholds, raiseAlert } = await import("../dist/modules/console/alerts.js")
  const db = openDb(":memory:")
  const defaults = getThresholds(db)
  assert.ok(defaults.cooldownMinutes >= 1)
  assert.throws(() => setThresholds(db, { cooldownMinutes: 0 }))
  const next = setThresholds(db, { memAvailableMb: 512 })
  assert.equal(next.memAvailableMb, 512)
  assert.equal(getThresholds(db).memAvailableMb, 512)

  const id1 = raiseAlert(db, {
    kind: "mem_low",
    severity: "warning",
    title: "t",
    message: "m",
    dedupeKey: "mem:low",
    now: 1_000,
  })
  const id2 = raiseAlert(db, {
    kind: "mem_low",
    severity: "warning",
    title: "t",
    message: "m",
    dedupeKey: "mem:low",
    now: 1_500,
  })
  assert.ok(id1 != null)
  assert.equal(id2, null, "cooldown suppresses the repeat")
  db.close()
})
