#!/usr/bin/env node
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
  body: JSON.stringify({ username: process.env.ADMIN_USER || "admin", password: process.env.ADMIN_PASSWORD }),
})
check("login", login.status === 200)

const first = await req("/api/v1/console/services/nginx.service/restart", { method: "POST", body: "{}" })
check("restart needs confirm", first.status === 202 && first.json.requiresConfirm === true, JSON.stringify(first.json).slice(0, 80))

const token = first.json.confirmToken
const second = await req("/api/v1/console/services/nginx.service/restart", {
  method: "POST",
  body: JSON.stringify({ confirmToken: token }),
})
// on Windows systemctl missing -> result error is still allowed:true after confirm
check("restart with confirm executes", second.status === 200 && second.json.allowed === true, JSON.stringify(second.json).slice(0, 100))

const deny = await req("/api/v1/console/services/ssh.service/restart", { method: "POST", body: "{}" })
check("deny not in allowlist", deny.status === 403)
