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

export function revokeSessionById(db: Db, id: string, userId: string): boolean {
  return Number(db.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0
}

export function revokeAllSessions(db: Db, userId: string, exceptId?: string): number {
  if (exceptId) {
    return Number(
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, exceptId).changes,
    )
  }
  return Number(db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes)
}

export interface SessionSummary {
  id: string
  createdAt: number
  expiresAt: number
  current: boolean
}

export function listSessions(db: Db, userId: string, currentSessionId: string, now = Date.now()): SessionSummary[] {
  const rows = db
    .prepare("SELECT id, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC")
    .all(userId, now) as { id: string; created_at: number; expires_at: number }[]
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    current: r.id === currentSessionId,
  }))
}

export function purgeExpiredSessions(db: Db): number {
  const res = db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now())
  return Number(res.changes)
}

function randomId(): string {
  return randomUUID()
}
