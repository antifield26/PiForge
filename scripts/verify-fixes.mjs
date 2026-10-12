// Live verification: exercise each fix against the running gateway on the Pi.
// One login is reused throughout — the login limiter is one of the things under test, so a second
// login inside the same window would trip it and mask the results.
import { readFileSync } from "node:fs"

const BASE = "http://127.0.0.1:8787"
const results = []
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail })
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`)
}

function envValue(file, key) {
  const raw = readFileSync(file, "utf8")
  for (const line of raw.split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line)
    if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "")
  }
  return null
}

const username = envValue("/etc/piforge/gateway.env", "ADMIN_USER") ?? "admin"
const password = envValue("/etc/piforge/gateway.env", "ADMIN_PASSWORD")
if (!password) {
  console.error("ADMIN_PASSWORD not found in /etc/piforge/gateway.env")
  process.exit(2)
}

const auth = { cookie: "" }
async function signIn() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`)
  auth.cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
  return res
}

await signIn()
record("baseline: a legitimate login succeeds", auth.cookie.length > 0)

// ---------------------------------------------------------------- 1. CSRF path encoding
{
  const evil = { origin: "https://evil.example", host: "127.0.0.1:8787", cookie: auth.cookie, "content-type": "application/json" }
  const plain = await fetch(`${BASE}/api/v1/todos`, { method: "POST", headers: evil, body: JSON.stringify({ title: "csrf-plain" }) })
  record("csrf: plain /api/ write is rejected cross-site", plain.status === 403, `status ${plain.status}`)

  const encoded = await fetch(`${BASE}/%61pi/v1/todos`, { method: "POST", headers: evil, body: JSON.stringify({ title: "csrf-encoded" }) })
  record("csrf: %61-encoded api write is rejected too (was 201 before)", encoded.status === 403, `status ${encoded.status}`)

  const encodedLogin = await fetch(`${BASE}/%61pi/v1/auth/login`, {
    method: "POST",
    headers: { origin: "https://evil.example", host: "127.0.0.1:8787", "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  record("csrf: %61-encoded login is rejected cross-site", encodedLogin.status === 403, `status ${encodedLogin.status}`)

  const same = await fetch(`${BASE}/api/v1/todos`, {
    method: "POST",
    headers: { origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787", cookie: auth.cookie, "content-type": "application/json" },
    body: JSON.stringify({ title: "ok-same-origin" }),
  })
  record("csrf: same-origin write still works", same.status === 201, `status ${same.status}`)
  if (same.status === 201) {
    const created = await same.json()
    await fetch(`${BASE}/api/v1/todos/${created.id}`, { method: "DELETE", headers: { cookie: auth.cookie } })
  }
}

// ---------------------------------------------------------------- 2. read paths stay read-only
{
  const sd = await fetch(`${BASE}/api/v1/console/sd`, { headers: { cookie: auth.cookie } })
  const sdBody = await sd.json()
  record(
    "console: /sd answers from memory without writing the database",
    sd.status === 200 && typeof sdBody.dayWriteBytes === "number",
    `dayWriteBytes=${sdBody.dayWriteBytes} model=${sdBody.model}`,
  )
  const perf = await fetch(`${BASE}/api/v1/console/perf`, { headers: { cookie: auth.cookie } })
  record("console: /perf answers", perf.status === 200, `status ${perf.status}`)
  const list = await fetch(`${BASE}/api/v1/console/alerts?limit=5`, { headers: { cookie: auth.cookie } })
  const body = await list.json()
  record(
    "alerts: response carries both table-wide and window unread counts",
    typeof body.unread === "number" && typeof body.unreadInWindow === "number",
    `unread=${body.unread} unreadInWindow=${body.unreadInWindow} items=${(body.items ?? []).length}`,
  )
}

// ---------------------------------------------------------------- 3. export truncation flag
{
  const to = Date.now()
  const from = to - 7 * 24 * 3600_000
  const exp = await fetch(`${BASE}/api/v1/console/metrics/export?kind=temp&from=${from}&to=${to}&limit=100`, {
    headers: { cookie: auth.cookie },
  })
  const body = await exp.json()
  record(
    "metrics: export reports total/truncated instead of silently clipping the window",
    exp.status === 200 && typeof body.total === "number" && body.truncated === true,
    `count=${body.count} total=${body.total} truncated=${body.truncated}`,
  )
}

// ---------------------------------------------------------------- 4. cloud uniqueness
{
  const name = `audit-unique-${Date.now()}.txt`
  const uploads = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      fetch(`${BASE}/api/v1/files`, {
        method: "POST",
        headers: { cookie: auth.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name, contentBase64: Buffer.from(`body-${i}`).toString("base64") }),
      }),
    ),
  )
  const codes = uploads.map((r) => r.status)
  const list = await fetch(`${BASE}/api/v1/files`, { headers: { cookie: auth.cookie } })
  const items = (await list.json()).items.filter((f) => f.name === name)
  record(
    "cloud: 6 concurrent uploads of one name yield exactly one row",
    items.length === 1,
    `statuses=${codes.join(",")} rows=${items.length}`,
  )
  if (items.length === 1) {
    const dl = await fetch(`${BASE}/api/v1/files/${items[0].id}`, { headers: { cookie: auth.cookie } })
    const text = await dl.text()
    record("cloud: the surviving row downloads real bytes", dl.status === 200 && text.startsWith("body-"), `status ${dl.status} body=${text.slice(0, 8)}`)
    await fetch(`${BASE}/api/v1/files/${items[0].id}`, { method: "DELETE", headers: { cookie: auth.cookie } })
  }
}

// ---------------------------------------------------------------- 5. health + lock
{
  const res = await fetch(`${BASE}/api/v1/health`)
  record("health: no-store cache header present", res.headers.get("cache-control") === "no-store", String(res.headers.get("cache-control")))
  const lock = readFileSync("/var/lib/piforge/gateway.lock", "utf8").split("\n")
  record("single instance: lock file held while the gateway is up", Number(lock[0]) > 0, `pid ${lock[0]}`)
}

// ---------------------------------------------------------------- 6. login limiter (last)
{
  const N = 24
  const responses = await Promise.all(
    Array.from({ length: N }, () =>
      fetch(`${BASE}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.201" },
        body: JSON.stringify({ username, password: "definitely-not-the-password" }),
      }),
    ),
  )
  const evaluated = responses.filter((r) => r.status === 401).length
  const throttled = responses.filter((r) => r.status === 429).length
  record(
    `login: at most 5 of ${N} concurrent guesses are evaluated (was ${N})`,
    evaluated <= 5,
    `${evaluated} attempts / ${throttled} throttled`,
  )
}

const failed = results.filter((r) => !r.ok)
console.log(`\n{"passed":${results.length - failed.length},"failed":${failed.length}}`)
process.exit(failed.length === 0 ? 0 : 1)
