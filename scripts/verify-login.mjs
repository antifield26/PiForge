import { readFileSync } from "node:fs"
import { scrypt as scryptCb, timingSafeEqual, randomBytes } from "node:crypto"

function scrypt(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, d) => (err ? reject(err) : resolve(d)))
  })
}

const env = readFileSync("/home/antifield/piforge/gateway.env", "utf8")
const get = (k) =>
  env
    .split("\n")
    .find((l) => l.startsWith(k + "="))
    ?.slice(k.length + 1)
    .trim()

const username = get("ADMIN_USER") || "admin"
const password = get("ADMIN_PASSWORD")
console.log("username", username)
console.log("password_len", password?.length, "password_preview", password ? password.slice(0, 3) + "..." : "")

const res = await fetch("http://127.0.0.1:8787/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
})
console.log("login_status", res.status, await res.text())

// Also verify hash matches what's in DB
const { DatabaseSync } = await import("node:sqlite")
const db = new DatabaseSync("/home/antifield/piforge/data/wb.db")
const row = db.prepare("SELECT password_hash FROM users WHERE username = ?").get(username)
db.close()
const stored = row.password_hash
const parts = stored.split("$")
if (parts[0] !== "scrypt") {
  console.log("hash_format_bad", stored.slice(0, 30))
} else {
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3])
  const salt = Buffer.from(parts[4], "base64url")
  const expected = Buffer.from(parts[5], "base64url")
  const actual = await scrypt(password, salt, expected.length, { N, r, p })
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected)
  console.log("db_hash_matches_env", ok)
}
