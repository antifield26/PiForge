import { DatabaseSync } from "node:sqlite"

const path = process.argv[2]
if (!path) {
  console.error("usage: node verify-restore.mjs <wb.db>")
  process.exit(1)
}
const db = new DatabaseSync(path)
const jm = db.prepare("PRAGMA journal_mode").get()
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = ?")
  .all("table")
  .map((r) => String(r.name))
const count = (t) => {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n)
  } catch {
    return -1
  }
}
console.log(
  JSON.stringify({
    journal_mode: jm.journal_mode,
    tables,
    users: count("users"),
    sessions: count("sessions"),
    audit: count("service_audit"),
  }),
)
db.close()
