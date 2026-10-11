import type { FastifyPluginAsync, FastifyRequest } from "fastify"
import { randomUUID } from "node:crypto"
import { hashPassword, verifyPassword } from "../../auth/password.js"
import {
  createSession,
  findSession,
  revokeSession,
  SESSION_COOKIE,
} from "../../auth/session.js"
import type { Db } from "../../db/index.js"

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { username?: string; password?: string } }>("/login", async (req, reply) => {
    const username = req.body?.username?.trim()
    const password = req.body?.password
    if (!username || !password) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "username and password required" } })
    }

    const user = req.db
      .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
      .get(username) as { id: string; username: string; password_hash: string } | undefined

    if (!user) {
      await hashPassword(password) // equalize timing
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "invalid credentials" } })
    }

    const ok = await verifyPassword(password, user.password_hash)
    if (!ok) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "invalid credentials" } })
    }

    const { token, expiresAt } = createSession(req.db, user.id)
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(expiresAt),
    })
    return { user: { id: user.id, username: user.username }, expiresAt }
  })

  app.post("/logout", async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE]
    if (token) revokeSession(req.db, token)
    reply.clearCookie(SESSION_COOKIE, { path: "/" })
    return { ok: true }
  })

  app.get("/me", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    }
    const user = req.db.prepare("SELECT id, username, created_at FROM users WHERE id = ?").get(auth.userId) as
      | { id: string; username: string; created_at: number }
      | undefined
    if (!user) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    }
    return { id: user.id, username: user.username, createdAt: user.created_at }
  })
}

export function requireAuth(req: FastifyRequest): { userId: string; sessionId: string } | null {
  const token = req.cookies?.[SESSION_COOKIE]
  if (!token) return null
  const session = findSession(req.db, token)
  if (!session) return null
  req.userId = session.userId
  return { userId: session.userId, sessionId: session.id }
}

export async function ensureAdminUser(db: Db, username: string, password: string): Promise<void> {
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
    | { id: string }
    | undefined
  const hash = await hashPassword(password)
  if (existing) {
    // rotate password on each start when ADMIN_PASSWORD is provided
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, existing.id)
    return
  }
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
    randomUUID(),
    username,
    hash,
    Date.now(),
  )
}
