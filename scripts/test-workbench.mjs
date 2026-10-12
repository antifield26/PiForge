#!/usr/bin/env node
// Credentials: $ADMIN_PASSWORD if exported, else gateway.env read directly (never sourced,
// never printed) so the password does not have to be inlined in the shell command.
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

const base = process.env.BASE || "http://127.0.0.1:8787"
const env = readGatewayEnv()
const user = process.env.ADMIN_USER || envGet(env, "ADMIN_USER") || "admin"
const pass = process.env.ADMIN_PASSWORD || envGet(env, "ADMIN_PASSWORD")
if (!pass) {
  console.error(`ADMIN_PASSWORD is not exported and not set in ${ENV_CANDIDATES.join(" or ")}`)
  process.exit(1)
}

const cookieJar = new Map()

function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
}

async function req(path, init = {}) {
  const headers = { "content-type": "application/json", cookie: cookieHeader(), ...(init.headers || {}) }
  const res = await fetch(base + path, { ...init, headers, redirect: "manual" })
  const sc = res.headers.getSetCookie?.() || []
  for (const c of sc) {
    const [kv] = c.split(";")
    const idx = kv.indexOf("=")
    if (idx > 0) cookieJar.set(kv.slice(0, idx).trim(), kv.slice(idx + 1).trim())
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

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`)
  return ok
}

const login = await req("/api/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ username: user, password: pass }),
})
check("login", login.status === 200)

const t1 = await req("/api/v1/todos", { method: "POST", body: JSON.stringify({ title: "买牛奶" }) })
check("create todo", t1.status === 201 && t1.json?.id, t1.json?.id)

const listT = await req("/api/v1/todos?q=牛奶")
check("search todos", listT.status === 200 && listT.json.items.length >= 1, `n=${listT.json?.items?.length}`)

const upd = await req(`/api/v1/todos/${t1.json.id}`, {
  method: "PATCH",
  body: JSON.stringify({ status: "done" }),
})
check("toggle todo", upd.status === 200 && upd.json.status === "done")

const n1 = await req("/api/v1/notes", {
  method: "POST",
  body: JSON.stringify({ title: "周会", body: "讨论 SD 写入", tags: ["pi", "ops"] }),
})
check("create note", n1.status === 201 && Array.isArray(n1.json.tags), n1.json?.id)

const listN = await req("/api/v1/notes?tag=ops")
check("tag filter notes", listN.status === 200 && listN.json.items.length >= 1, `n=${listN.json?.items?.length}`)

const delT = await req(`/api/v1/todos/${t1.json.id}`, { method: "DELETE" })
check("delete todo", delT.status === 204)

const delN = await req(`/api/v1/notes/${n1.json.id}`, { method: "DELETE" })
check("delete note", delN.status === 204)
