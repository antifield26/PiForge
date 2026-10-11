import { randomUUID } from "node:crypto"
import type { Db } from "../db/index.js"
import { hashToken, newSessionToken } from "./password.js"

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_COOKIE = "pf_session"

export interface SessionRow {
  id: string
  user_id: string
  token_hash: string
  expires_at: number
  created_at: number
}

export function createSession(db: Db, userId: string): { token: string; expiresAt: number } {
  const token = newSessionToken()
  const id = randomId()
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  db.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, userId, hashToken(token), expiresAt, now)
  return { token, expiresAt }
}

export function findSession(db: Db, token: string): { id: string; userId: string; expiresAt: number } | null {
  const row = db
    .prepare("SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .get(hashToken(token), Date.now()) as { id: string; user_id: string; expires_at: number } | undefined
  if (!row) return null
  return { id: row.id, userId: row.user_id, expiresAt: row.expires_at }
}

export function revokeSession(db: Db, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token))
}

export function purgeExpiredSessions(db: Db): number {
  const res = db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now())
  return Number(res.changes)
}

function randomId(): string {
  return randomUUID()
}
