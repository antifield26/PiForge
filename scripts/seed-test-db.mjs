import { DatabaseSync } from "node:sqlite"

const db = new DatabaseSync("/home/antifield/piforge-test/wb.db")
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
db.prepare(`INSERT OR REPLACE INTO users VALUES (?,?,?,?)`).run("u1", "admin", "scrypt$x", 1)
db.prepare(
  `INSERT INTO service_audit (ts,user_id,unit,action,allowed,result,client_ip) VALUES (?,?,?,?,?,?,?)`,
).run(1, "u1", "nginx.service", "restart", 1, "ok", "127.0.0.1")
db.close()
console.log("schema ready")
