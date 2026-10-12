import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { scrypt as scryptCb, randomBytes, randomUUID } from "node:crypto"

function scrypt(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, derived) =>
      err ? reject(err) : resolve(derived),
    )
  })
}

async function hashPassword(password) {
  const salt = randomBytes(16)
  const N = 16384, r = 8, p = 1
  const hash = await scrypt(password, salt, 64, { N, r, p })
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`
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

const [dbPath] = readFirst(DB_CANDIDATES)
if (!dbPath) {
  console.error(`wb.db not found (looked at ${DB_CANDIDATES.join(", ")})`)
  process.exit(1)
}

const hash = await hashPassword(password)
const db = new DatabaseSync(dbPath)
try {
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username)
  if (existing) {
    db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(hash, username)
    console.log("updated password for", username, "in", dbPath, `(len ${password.length})`)
  } else {
    db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)").run(
      randomUUID(),
      username,
      hash,
      Date.now(),
    )
    console.log("created user", username, "in", dbPath, `(len ${password.length})`)
  }
} finally {
  db.close()
}
