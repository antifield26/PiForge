import { readFileSync } from "node:fs"
import { scrypt as scryptCb, timingSafeEqual } from "node:crypto"

function scrypt(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, d) => (err ? reject(err) : resolve(d)))
  })
}

// Same lookup order as scripts/lib/env.sh (post-migration first, legacy fallback).
const ENV_CANDIDATES = ["/etc/piforge/gateway.env", "/home/antifield/piforge/gateway.env"]
const DB_CANDIDATES = [
  process.env.DB_PATH,
  "/var/lib/piforge/wb.db",
  "/home/antifield/piforge/data/wb.db",
].filter(Boolean)

function readFirst(candidates) {
  for (const file of candidates) {
    try {
      return [file, readFileSync(file, "utf8")]
    } catch {
      // try the next candidate
    }
  }
  return [null, ""]
}

// Mirrors piforge_env_get: first KEY= line, strip CR, strip one layer of quotes.
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

const [envPath, env] = readFirst(ENV_CANDIDATES)
if (!envPath) {
  console.error(`gateway.env not found (looked at ${ENV_CANDIDATES.join(", ")})`)
  process.exit(1)
}

const username = envGet(env, "ADMIN_USER") || "admin"
const password = envGet(env, "ADMIN_PASSWORD")
if (!password) {
  console.error(`ADMIN_PASSWORD is not set in ${envPath}`)
  process.exit(1)
}
// Never print the password or any part of it, and never print stored hash material:
// lengths and booleans only.
console.log("env_file", envPath)
console.log("username", username)
console.log("password_len", password.length)

const res = await fetch("http://127.0.0.1:8787/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
})
console.log("login_status", res.status, await res.text())

// Also verify the stored hash matches what gateway.env says.
const [dbPath] = readFirst(DB_CANDIDATES)
if (!dbPath) {
  console.log("db_not_found", DB_CANDIDATES.join(", "))
  process.exit(0)
}
const { DatabaseSync } = await import("node:sqlite")
const db = new DatabaseSync(dbPath)
const row = db.prepare("SELECT password_hash FROM users WHERE username = ?").get(username)
db.close()
if (!row) {
  console.log("db_user_found false")
  process.exit(0)
}
const stored = String(row.password_hash ?? "")
const parts = stored.split("$")
if (parts[0] !== "scrypt" || parts.length < 6) {
  // Report the format name only — never a slice of the hash.
  console.log("db_hash_format", parts[0] || "(empty)", "unsupported")
  process.exit(0)
}
const N = Number(parts[1]),
  r = Number(parts[2]),
  p = Number(parts[3])
const salt = Buffer.from(parts[4], "base64url")
const expected = Buffer.from(parts[5], "base64url")
const actual = await scrypt(password, salt, expected.length, { N, r, p })
const ok = actual.length === expected.length && timingSafeEqual(actual, expected)
console.log("db_hash_matches_env", ok)
