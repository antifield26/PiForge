import type { FastifyPluginAsync, FastifyRequest } from "fastify"
import { randomUUID } from "node:crypto"
import { hashPassword, verifyPassword } from "../../auth/password.js"
import { createSession, findSession, purgeExpiredSessions, revokeSession, SESSION_COOKIE } from "../../auth/session.js"
import { createLoginLimiters } from "../../auth/ratelimit.js"
import type { Db } from "../../db/index.js"
import { clientIp } from "../../util/net.js"
import { sendError } from "../../util/validate.js"

export const authRoutes: FastifyPluginAsync = async (app) => {
  const limiters = createLoginLimiters()
  let purgeTimer: ReturnType<typeof setInterval> | null = null

  app.addHook("onReady", async () => {
    purgeTimer = setInterval(() => {
      try {
        purgeExpiredSessions(app.db)
      } catch (err) {
        app.log.warn({ err }, "session purge failed")
      }
    }, app.config.sessionPurgeIntervalMs)
    purgeTimer.unref()
  })

  app.addHook("onClose", async () => {
    if (purgeTimer) clearInterval(purgeTimer)
  })

  app.post<{ Body: { username?: unknown; password?: unknown } }>("/login", async (req, reply) => {
    // Type-guard first: a non-string username/password must be a 400, not a TypeError/500.
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : ""
    const password = typeof req.body?.password === "string" ? req.body.password : ""
    if (!username || !password) {
      return sendError(reply, 400, "BAD_REQUEST", "username and password required")
    }

    const ip = clientIp(req)
    const retryAfter = Math.max(limiters.ip.check(ip).retryAfterSec, limiters.user.check(username).retryAfterSec)
    if (retryAfter > 0) {
      reply.header("retry-after", String(retryAfter))
      return sendError(reply, 429, "RATE_LIMITED", `too many attempts, retry in ${retryAfter}s`)
    }

    const user = app.db
      .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
      .get(username) as { id: string; username: string; password_hash: string } | undefined

    if (!user) {
      await hashPassword(password) // equalize timing with the known-user path
      limiters.ip.record(ip)
      limiters.user.record(username)
      return sendError(reply, 401, "UNAUTHORIZED", "invalid credentials")
    }

    const ok = await verifyPassword(password, user.password_hash)
    if (!ok) {
      limiters.ip.record(ip)
      limiters.user.record(username)
      return sendError(reply, 401, "UNAUTHORIZED", "invalid credentials")
    }

    limiters.user.reset(username)
    const { token, expiresAt } = createSession(app.db, user.id)
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
    if (token) revokeSession(app.db, token)
    reply.clearCookie(SESSION_COOKIE, { path: "/" })
    return { ok: true }
  })

  app.get("/me", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const user = app.db.prepare("SELECT id, username, created_at FROM users WHERE id = ?").get(auth.userId) as
      | { id: string; username: string; created_at: number }
      | undefined
    if (!user) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
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
  const existing = db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(username) as
    | { id: string; password_hash: string }
    | undefined
  if (existing) {
    // Only rotate when the configured password actually changed; avoids a DB write on every start.
    if (await verifyPassword(password, existing.password_hash)) return
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(password), existing.id)
    return
  }
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
    randomUUID(),
    username,
    await hashPassword(password),
    Date.now(),
  )
}
