import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto"

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

const env = readFileSync("/home/antifield/piforge/gateway.env", "utf8")
const get = (k) =>
  env
    .split("\n")
    .find((l) => l.startsWith(k + "="))
    ?.slice(k.length + 1)
    .trim()

const username = get("ADMIN_USER") || "admin"
const password = get("ADMIN_PASSWORD")
if (!password) {
  console.error("ADMIN_PASSWORD missing in gateway.env")
  process.exit(1)
}

const hash = await hashPassword(password)
const db = new DatabaseSync("/home/antifield/piforge/data/wb.db")
const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username)
if (existing) {
  db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(hash, username)
  console.log("updated password for", username)
} else {
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)").run(
    crypto.randomUUID(),
    username,
    hash,
    Date.now(),
  )
  console.log("created user", username)
}
db.close()
