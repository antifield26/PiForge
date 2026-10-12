import { DatabaseSync } from "node:sqlite"

// Scratch schema for the workbench test instance (/home/antifield/piforge-test).
// It seeds a placeholder, non-functional hash on purpose: this DB must never hold a real
// credential. Override the path with DB_PATH=... (the deploy-pi.sh test instance uses the
// default). Prints only the path — nothing secret is read or written here.
const DB_PATH = process.env.DB_PATH || process.argv[2] || "/home/antifield/piforge-test/wb.db"

const db = new DatabaseSync(DB_PATH)
try {
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA synchronous=NORMAL")
  db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS service_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT,
  unit TEXT NOT NULL, action TEXT NOT NULL, allowed INTEGER NOT NULL,
  result TEXT, client_ip TEXT)`)
  // Placeholder hash: not a usable credential for any account.
  db.prepare(`INSERT OR REPLACE INTO users VALUES (?,?,?,?)`).run("u1", "admin", "scrypt$placeholder", 1)
  db.prepare(
    `INSERT INTO service_audit (ts,user_id,unit,action,allowed,result,client_ip) VALUES (?,?,?,?,?,?,?)`,
  ).run(1, "u1", "nginx.service", "restart", 1, "ok", "127.0.0.1")
  console.log("schema ready", DB_PATH)
} finally {
  db.close()
}
