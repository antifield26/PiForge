#!/usr/bin/env node
/**
 * OpenCode adapter contract smoke — run ON the host where opencode serve is listening.
 *
 * Usage: node oc-contract.mjs [baseUrl]
 *
 * Password lookup (same order as scripts/lib/env.sh:piforge_opencode_password):
 *   1. $OPENCODE_PASSWORD, if already exported;
 *   2. the local OpenCode service registration files below.
 * It is deliberately NOT read from /tmp/oc-pw.txt any more: that file was a world-readable
 * credential cache. To supply it by hand without leaking it into the process list or the
 * shell history, use:  read -r -s -p 'opencode password: ' OPENCODE_PASSWORD; export OPENCODE_PASSWORD
 */
import { readFileSync } from "node:fs"

const SERVICE_JSON_CANDIDATES = [
  "/var/lib/piforge-oc/.config/opencode/service.json",
  "/var/lib/piforge-oc/.local/state/opencode/service.json",
  "/home/antifield/.config/opencode/service.json",
  "/home/antifield/.local/state/opencode/service.json",
]

function readOpencodePassword() {
  if (process.env.OPENCODE_PASSWORD) return process.env.OPENCODE_PASSWORD
  for (const file of SERVICE_JSON_CANDIDATES) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"))
      if (typeof parsed.password === "string" && parsed.password) return parsed.password
    } catch {
      // unreadable or not JSON: try the next candidate
    }
  }
  return null
}

const base = (process.argv[2] ?? "http://127.0.0.1:4096").replace(/\/$/, "")
const password = readOpencodePassword()
if (!password) {
  console.error("OPENCODE_PASSWORD required: export it, or make one of these readable:")
  for (const file of SERVICE_JSON_CANDIDATES) console.error(`  ${file}`)
  process.exit(1)
}
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`)
}

const info = await req("GET", "/api/info")
check("GET /api/info", info.status === 200 && !!info.json?.version, JSON.stringify(info.json)?.slice(0, 120))

const loc = await req("GET", "/api/location")
check("GET /api/location", loc.status === 200 && !!loc.json?.directory, JSON.stringify(loc.json)?.slice(0, 120))

const agents = await req("GET", "/api/agent")
check("GET /api/agent", agents.status === 200 && Array.isArray(agents.json?.data), `agents=${agents.json?.data?.length}`)

const sessions = await req("GET", "/api/session")
check("GET /api/session", sessions.status === 200 && Array.isArray(sessions.json?.data), `sessions=${sessions.json?.data?.length}`)

const created = await req("POST", "/api/session", {})
const createdObj = created.json?.data ?? created.json
check("POST /api/session", created.status === 200 || created.status === 201, `id=${createdObj?.id}`)
const sid = createdObj?.id

if (sid) {
  const one = await req("GET", `/api/session/${sid}`)
  const oneObj = one.json?.data ?? one.json
  check("GET /api/session/:id", one.status === 200 && oneObj?.id === sid)

  const msgs = await req("GET", `/api/session/${sid}/message`)
  const msgList = msgs.json?.data ?? []
  check("GET /api/session/:id/message", msgs.status === 200 && Array.isArray(msgList), `msgs=${msgList.length}`)

  const del = await req("DELETE", `/api/session/${sid}`)
  check("DELETE /api/session/:id", del.status === 200 || del.status === 204, `status=${del.status}`)
}

// SSE subscribe for 1s
const ac = new AbortController()
setTimeout(() => ac.abort(), 1000)
try {
  const res = await fetch(base + "/api/event", {
    headers: { authorization: auth, accept: "text/event-stream" },
    signal: ac.signal,
  })
  const reader = res.body.getReader()
  const { value } = await reader.read()
  const text = new TextDecoder().decode(value ?? new Uint8Array())
  check("GET /api/event SSE", res.status === 200 && text.includes("data:"), text.slice(0, 80).replace(/\n/g, " "))
} catch (e) {
  // abort is expected
  check("GET /api/event SSE", String(e).includes("abort") || String(e).includes("Abort"), String(e).slice(0, 80))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
