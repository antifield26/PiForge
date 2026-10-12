#!/usr/bin/env node
// PiForge live end-to-end verification against a running gateway.
//
//   sudo node scripts/verify-e2e.mjs [--base http://127.0.0.1:8787] [--env /etc/piforge/gateway.env]
//        [--db /var/lib/piforge/wb.db] [--with-service-restart]
//
// Run as root on the Pi: it reads the admin credential out of gateway.env (0640) and inspects
// wb.db directly. No secret is ever printed — only lengths, status codes and byte equality.
//
// Exits non-zero when any check fails, so it can gate a deployment.
import { existsSync, readFileSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const BASE = value("base", "http://127.0.0.1:8787")
const ENV_FILE = value("env", "/etc/piforge/gateway.env")
const DB_PATH = value("db", "/var/lib/piforge/wb.db")
const WITH_RESTART = flag("with-service-restart")

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail })
  process.stderr.write(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`)
}

function envValue(file, key) {
  if (!existsSync(file)) return ""
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.trim().startsWith(`${key}=`))
  return line ? line.slice(line.indexOf("=") + 1).trim() : ""
}

const username = envValue(ENV_FILE, "ADMIN_USER") || "admin"
const password = envValue(ENV_FILE, "ADMIN_PASSWORD")
if (!password) {
  check("admin credential available", false, `${ENV_FILE} has no ADMIN_PASSWORD`)
  report()
}
check("admin credential available", true, `${username}, password length ${password.length}`)

let cookie = ""
async function req(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  for (const c of setCookie) {
    const kv = c.split(";")[0]
    if (kv.startsWith("pf_session=")) cookie = kv
  }
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* binary or csv */
  }
  return { status: res.status, text, json, res }
}

// ---------------------------------------------------------------- auth
{
  const anon = await req("/api/v1/console/system")
  check("unauthenticated console access is rejected", anon.status === 401, `status ${anon.status}`)

  const bad = await req("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password: `${password}-wrong` }),
  })
  check("wrong password is rejected", bad.status === 401, `status ${bad.status}`)

  const login = await req("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ username, password }) })
  check("admin login succeeds", login.status === 200, `status ${login.status}`)
  const secure = (login.res.headers.getSetCookie?.() ?? []).join(";")
  check("session cookie is httpOnly", /HttpOnly/i.test(secure))
  check("session cookie is SameSite", /SameSite=Lax/i.test(secure))

  const me = await req("/api/v1/auth/me")
  check("session is usable", me.status === 200 && me.json?.username === username, `status ${me.status}`)

  // malformed JSON must be a 400 with the unified envelope, never a 500
  const malformed = await req("/api/v1/todos", { method: "POST", body: "{not json" })
  check(
    "malformed json returns 400 with the api error envelope",
    malformed.status === 400 && malformed.json?.error?.code === "BAD_REQUEST",
    `status ${malformed.status}`,
  )
}

// ---------------------------------------------------------------- console
{
  const system = await req("/api/v1/console/system")
  check("system snapshot responds", system.status === 200, `status ${system.status}`)
  if (system.json) {
    check(
      "temperature is plausible (0-100C)",
      system.json.tempC >= 0 && system.json.tempC <= 100,
      `tempC=${system.json.tempC}`,
    )
    check(
      "lifetime sd writes >= boot writes",
      Number(system.json.sdTotalWriteBytes) >= Number(system.json.sdBootWriteBytes),
      `lifetime=${system.json.sdTotalWriteBytes} boot=${system.json.sdBootWriteBytes}`,
    )
  }

  const services = await req("/api/v1/console/services")
  const items = services.json?.items ?? []
  check("service list responds", services.status === 200 && items.length > 0, `${items.length} units`)
  check("service list exposes active state", items.every((u) => u.active === true || u.active === false || u.active === null))

  const sd = await req("/api/v1/console/sd")
  check("sd health responds", sd.status === 200 && typeof sd.json?.model === "string", `model=${sd.json?.model}`)

  const audit = await req("/api/v1/console/audit?limit=5")
  check("audit log responds", audit.status === 200 && Array.isArray(audit.json?.items))

  const rejected = await req("/api/v1/console/services/ssh.service/restart", { method: "POST", body: "{}" })
  check(
    "allowlist rejects an unlisted unit with 403",
    rejected.status === 403 && Boolean(rejected.json?.auditId),
    `status ${rejected.status}`,
  )

  const confirm = await req("/api/v1/console/services/nginx.service/restart", { method: "POST", body: "{}" })
  check("dangerous action asks for confirmation", confirm.status === 202 && Boolean(confirm.json?.confirmToken))
  const forged = await req("/api/v1/console/services/nginx.service/restart", {
    method: "POST",
    body: JSON.stringify({ confirmToken: "1.deadbeefdeadbeefdeadbeef" }),
  })
  check("forged confirm token is refused", forged.status === 202, `status ${forged.status}`)

  if (WITH_RESTART && confirm.json?.confirmToken) {
    const done = await req("/api/v1/console/services/nginx.service/restart", {
      method: "POST",
      body: JSON.stringify({ confirmToken: confirm.json.confirmToken }),
    })
    const ok = done.status === 200 && done.json?.result === "ok"
    check("scoped sudoers rule lets the gateway restart an allowlisted unit", ok, `result=${done.json?.result ?? done.status}`)
  }
}

// ---------------------------------------------------------------- metrics write discipline
{
  const before = countMetrics()
  for (let i = 0; i < 4; i++) await req("/api/v1/console/system")
  const after = countMetrics()
  check(
    "polling the console does not write metric rows",
    before !== null && after !== null && after === before,
    `${before} -> ${after}`,
  )
}

function countMetrics() {
  if (!existsSync(DB_PATH)) return null
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const row = db.prepare("SELECT COUNT(*) AS n FROM metrics_points").get()
    db.close()
    return Number(row.n)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- cloud round trip
{
  const big = Buffer.alloc(3 * 1024 * 1024, 0x42)
  const created = await req("/api/v1/files", {
    method: "POST",
    body: JSON.stringify({ name: "verify-e2e.bin", contentBase64: big.toString("base64") }),
  })
  check("3MB upload is accepted (bodyLimit fix)", created.status === 201, `status ${created.status}`)
  const id = created.json?.id

  if (id) {
    const before = Buffer.from("VERSION-ONE")
    const after = Buffer.from("VERSION-TWO")
    await req("/api/v1/files", {
      method: "POST",
      body: JSON.stringify({ name: "verify-e2e.bin", contentBase64: before.toString("base64") }),
    })
    const overwritten = await req("/api/v1/files", {
      method: "POST",
      body: JSON.stringify({ name: "verify-e2e.bin", contentBase64: after.toString("base64") }),
    })
    check("overwrite is versioned", overwritten.status === 201 && overwritten.json?.versioned === true)

    const current = await req(`/api/v1/files/${id}`)
    check("current content is the newest bytes", current.text === "VERSION-TWO")

    const versions = await req(`/api/v1/files/${id}/versions`)
    const versionId = versions.json?.items?.[0]?.id
    check("version history has an entry", Boolean(versionId), `${versions.json?.items?.length ?? 0} versions`)

    if (versionId) {
      const old = await req(`/api/v1/files/${id}/versions/${versionId}`)
      check("the version holds the PREVIOUS bytes", old.text === "VERSION-ONE", `bytes=${old.text.length}`)
    }

    const removed = await req(`/api/v1/files/${id}`, { method: "DELETE" })
    check("delete removes the file", removed.status === 204)
    const gone = await req(`/api/v1/files/${id}`)
    check("deleted file is gone", gone.status === 404)
  }

  const badBookmark = await req("/api/v1/bookmarks", {
    method: "POST",
    body: JSON.stringify({ url: "javascript:alert(1)" }),
  })
  check("javascript: bookmark is rejected", badBookmark.status === 400)
}

// ---------------------------------------------------------------- workbench crud
{
  const created = await req("/api/v1/todos", {
    method: "POST",
    body: JSON.stringify({ title: `verify-e2e ${randomUUID().slice(0, 8)}` }),
  })
  check("todo create", created.status === 201, `status ${created.status}`)
  if (created.json?.id) {
    const patched = await req(`/api/v1/todos/${created.json.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    })
    check("todo update", patched.status === 200 && patched.json?.status === "done")
    const removed = await req(`/api/v1/todos/${created.json.id}`, { method: "DELETE" })
    check("todo delete", removed.status === 204)
  }
  const invalid = await req("/api/v1/todos", { method: "POST", body: JSON.stringify({ title: "x", status: "bogus" }) })
  check("invalid todo status is rejected", invalid.status === 400)
}

// ---------------------------------------------------------------- agent
{
  const info = await req("/api/v1/agent/info")
  check(
    "opencode is reachable through the adapter",
    info.status === 200 && typeof info.json?.version === "string",
    `version=${info.json?.version ?? info.status}`,
  )
  const sessions = await req("/api/v1/agent/sessions")
  check("agent session list responds", sessions.status === 200 && Array.isArray(sessions.json?.items))
  const projects = await req("/api/v1/agent/projects")
  const directory = projects.json?.items?.[0]?.directory
  check("agent workspace is isolated (not /)", projects.status === 200 && directory !== "/", `directory=${directory}`)
}

// ---------------------------------------------------------------- SSE
{
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(`${BASE}/api/v1/agent/events`, { headers: { cookie }, signal: controller.signal })
    const reader = res.body.getReader()
    let text = ""
    const started = Date.now()
    while (Date.now() - started < 17_000 && text.length < 4000) {
      const { done, value } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
      if (text.includes(": ping")) break
    }
    await reader.cancel()
    check("sse stream opens with a retry hint", /retry: \d+/.test(text), text.slice(0, 40).replace(/\n/g, "\\n"))
    check("sse stream sends heartbeats", text.includes(": ping"), `${Math.round((Date.now() - started) / 1000)}s`)
  } catch (e) {
    check("sse stream opens", false, e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- db facts
{
  if (existsSync(DB_PATH)) {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => String(r.name))
    db.close()
    check("wb.db has the sd_health table", tables.includes("sd_health"))
    check("wb.db no longer carries the unused agent_tasks table", !tables.includes("agent_tasks"))
    check("db file is not world-readable", (statSync(DB_PATH).mode & 0o077) === 0, `mode ${(statSync(DB_PATH).mode & 0o777).toString(8)}`)
  } else {
    check("wb.db present at the configured path", false, DB_PATH)
  }
}

report()

function report() {
  const failed = results.filter((r) => !r.ok)
  process.stdout.write(
    `${JSON.stringify({ base: BASE, passed: results.length - failed.length, failed: failed.length, results }, null, 2)}\n`,
  )
  process.exit(failed.length === 0 ? 0 : 1)
}
