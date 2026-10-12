import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

// Prints usernames, hash *lengths* and timestamps only — never hash material.
// Same lookup order as scripts/lib/env.sh:piforge_wb_db.
const DB_CANDIDATES = [
  process.env.DB_PATH,
  "/var/lib/piforge/wb.db",
  "/home/antifield/piforge/data/wb.db",
].filter(Boolean)

const dbPath = DB_CANDIDATES.find((candidate) => existsSync(candidate))
if (!dbPath) {
  console.error(`wb.db not found (looked at ${DB_CANDIDATES.join(", ")})`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
try {
  console.log("db", dbPath)
  console.log(
    db.prepare("SELECT username, length(password_hash) AS hlen, created_at FROM users").all(),
  )
} finally {
  db.close()
}
