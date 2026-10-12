#!/usr/bin/env node
/**
 * Console service-control confirmation flow: 202 + confirmToken, then the real execution.
 *
 * DANGER: the second call restarts the LIVE nginx.service on the machine the gateway runs
 * on. It is therefore opt-in: without I_MEAN_IT=1 the confirmed restart is skipped and the
 * script only checks the challenge/deny paths.
 *
 *   I_MEAN_IT=1 node scripts/test-confirm.mjs
 *
 * Credentials come from $ADMIN_PASSWORD or, if that is not exported, from gateway.env read
 * directly (never sourced, never echoed) — so the password does not have to be inlined in a
 * shell command where it would land in the process list and the shell history.
 */
import { readFileSync } from "node:fs"

const ENV_CANDIDATES = ["/etc/piforge/gateway.env", "/home/antifield/piforge/gateway.env"]

function envGet(env, key) {
  const line = env.split("\n").find((l) => l.trimStart().startsWith(key + "="))
  if (line === undefined) return ""
  let value = line.slice(line.indexOf("=") + 1).replace(/\r$/, "")
  for (const quote of ['"', "'"]) {
    if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) {
      value = value.slice(1, -1)
    }
  }
  return value
}

function readGatewayEnv() {
  for (const file of ENV_CANDIDATES) {
    try {
      return readFileSync(file, "utf8")
    } catch {
      // try the next candidate
    }
  }
  return ""
}

const env = readGatewayEnv()
const user = process.env.ADMIN_USER || envGet(env, "ADMIN_USER") || "admin"
const pass = process.env.ADMIN_PASSWORD || envGet(env, "ADMIN_PASSWORD")
if (!pass) {
  console.error(
    `ADMIN_PASSWORD is not exported and not set in ${ENV_CANDIDATES.join(" or ")}`,
  )
  process.exit(1)
}
const iMeanIt = process.env.I_MEAN_IT === "1"

const base = process.env.BASE || "http://127.0.0.1:8787"
const cookieJar = new Map()
function cookies() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
}
async function req(path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", cookie: cookies(), ...(init.headers || {}) },
  })
  for (const c of res.headers.getSetCookie?.() || []) {
    const [kv] = c.split(";")
    const i = kv.indexOf("=")
    if (i > 0) cookieJar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim())
  }
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json }
}
function check(n, ok, d = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`)
}

const login = await req("/api/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ username: user, password: pass }),
})
check("login", login.status === 200)

const first = await req("/api/v1/console/services/nginx.service/restart", { method: "POST", body: "{}" })
check("restart needs confirm", first.status === 202 && first.json.requiresConfirm === true, JSON.stringify(first.json).slice(0, 80))

const token = first.json?.confirmToken
if (!iMeanIt) {
  console.warn(
    "WARNING: skipping the confirmed restart of nginx.service on the live host — " +
      "re-run with I_MEAN_IT=1 to actually execute it",
  )
} else {
  const second = await req("/api/v1/console/services/nginx.service/restart", {
    method: "POST",
    body: JSON.stringify({ confirmToken: token }),
  })
  // on Windows systemctl missing -> result error is still allowed:true after confirm
  check("restart with confirm executes", second.status === 200 && second.json.allowed === true, JSON.stringify(second.json).slice(0, 100))
}

const deny = await req("/api/v1/console/services/ssh.service/restart", { method: "POST", body: "{}" })
check("deny not in allowlist", deny.status === 403)
