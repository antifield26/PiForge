#!/usr/bin/env node
const base = process.env.BASE || "http://127.0.0.1:8787"
const cookieJar = new Map()

function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
}

async function req(path, init = {}) {
  const headers = { "content-type": "application/json", cookie: cookieHeader(), ...(init.headers || {}) }
  const res = await fetch(base + path, { ...init, headers, redirect: "manual" })
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
  return { status: res.status, json, text, headers: res.headers }
}

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`)
  return ok
}

const login = await req("/api/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ username: process.env.ADMIN_USER || "admin", password: process.env.ADMIN_PASSWORD }),
})
check("login", login.status === 200)

const b1 = await req("/api/v1/bookmarks", {
  method: "POST",
  body: JSON.stringify({ url: "https://opencode.ai", title: "OpenCode", folder: "ai" }),
})
check("create bookmark", b1.status === 201, b1.json?.id)

const bl = await req("/api/v1/bookmarks?folder=ai")
check("list bookmarks", bl.status === 200 && bl.json.items.length >= 1)

const content = Buffer.from("hello piforge cloud").toString("base64")
const f1 = await req("/api/v1/files", {
  method: "POST",
  body: JSON.stringify({ name: "hello.txt", contentBase64: content, mime: "text/plain" }),
})
check("upload file", f1.status === 201, f1.json?.id)

const fl = await req("/api/v1/files")
check("list files", fl.status === 200 && fl.json.items.length >= 1)

const dl = await fetch(`${base}/api/v1/files/${f1.json.id}`, {
  headers: { cookie: cookieHeader() },
})
const dlText = await dl.text()
check("download file", dl.status === 200 && dlText === "hello piforge cloud", dlText)

const delB = await req(`/api/v1/bookmarks/${b1.json.id}`, { method: "DELETE" })
check("delete bookmark", delB.status === 204)

const delF = await req(`/api/v1/files/${f1.json.id}`, { method: "DELETE" })
check("delete file", delF.status === 204)
