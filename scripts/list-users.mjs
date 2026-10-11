import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync("/home/antifield/piforge/data/wb.db")
console.log(db.prepare("SELECT username, length(password_hash) AS hlen, created_at FROM users").all())
db.close()
