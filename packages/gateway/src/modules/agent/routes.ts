import type { FastifyPluginAsync } from "fastify"
import { createHttpAdapter, OpenCodeHttpError } from "./http-adapter.js"
import type { OpenCodeAdapter } from "./adapter.js"
import { requireAuth } from "../auth/routes.js"
import { checkHeavy, createHeavyLimiter } from "../../auth/ratelimit.js"
import { sendError } from "../../util/validate.js"

const HEARTBEAT_MS = 15_000
// Prompting launches model work and can spawn tools; keep a stolen session bounded.
const heavy = createHeavyLimiter(15, 60_000)
// Session create / interrupt / permission reply are cheaper than a prompt but still upstream
// writes; a stolen cookie must not be able to mint sessions or interrupt unbounded.
const writeHeavy = createHeavyLimiter(20, 60_000)
/**
 * `/events` takes the socket over, so every connection pins a handler, a 15s timer and a file
 * descriptor. Without a ceiling an authenticated caller can walk the process into EMFILE, at
 * which point accept() fails for the whole gateway.
 */
const MAX_SSE_PER_USER = 4
const MAX_SSE_TOTAL = 64
const sseConnections = new Map<string, number>()
let sseTotal = 0

function acquireSseSlot(userId: string): boolean {
  const current = sseConnections.get(userId) ?? 0
  if (current >= MAX_SSE_PER_USER || sseTotal >= MAX_SSE_TOTAL) return false
  sseConnections.set(userId, current + 1)
  sseTotal += 1
  return true
}

function releaseSseSlot(userId: string): void {
  const current = sseConnections.get(userId) ?? 0
  if (current <= 1) sseConnections.delete(userId)
  else sseConnections.set(userId, current - 1)
  sseTotal = Math.max(0, sseTotal - 1)
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/info", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return await app.openCode.info()
    } catch (e) {
      return mapErr(reply, req, e)
    }
  })

  app.get("/projects", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return { items: await app.openCode.listProjects() }
    } catch (e) {
      return mapErr(reply, req, e)
    }
  })

  app.get("/agents", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return { items: await app.openCode.listAgents() }
    } catch (e) {
      return mapErr(reply, req, e)
    }
  })

  app.get("/sessions", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return { items: await app.openCode.listSessions() }
    } catch (e) {
      return mapErr(reply, req, e)
    }
  })

  app.post<{ Body: { title?: string } }>("/sessions", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const budget = checkHeavy(writeHeavy, auth.userId)
    if (!budget.allowed) {
      reply.header("retry-after", String(budget.retryAfterSec))
      return sendError(reply, 429, "RATE_LIMITED", `too many session creates, retry in ${budget.retryAfterSec}s`)
    }
    try {
      return reply.code(201).send(await app.openCode.createSession(req.body?.title))
    } catch (e) {
      return mapErr(reply, req, e)
    }
  })

  app.post<{ Params: { id: string }; Body: { content?: string; model?: string; agent?: string } }>(
    "/sessions/:id/prompt",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
      const budget = checkHeavy(heavy, auth.userId)
      if (!budget.allowed) {
        reply.header("retry-after", String(budget.retryAfterSec))
        return sendError(reply, 429, "RATE_LIMITED", `too many prompts, retry in ${budget.retryAfterSec}s`)
      }
      const content = req.body?.content
      if (typeof content !== "string" || !content.trim()) {
        return sendError(reply, 400, "BAD_REQUEST", "content required")
      }
      try {
        await app.openCode.prompt(req.params.id, {
          content,
          model: req.body?.model,
          agent: req.body?.agent,
        })
        return reply.code(202).send({ ok: true })
      } catch (e) {
        return mapErr(reply, req, e)
      }
    },
  )

  app.post<{ Params: { id: string } }>("/sessions/:id/interrupt", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const budget = checkHeavy(writeHeavy, auth.userId)
    if (!budget.allowed) {
      reply.header("retry-after", String(budget.retryAfterSec))
      return sendError(reply, 429, "RATE_LIMITED", `too many interrupts, retry in ${budget.retryAfterSec}s`)
    }
    try {
      await app.openCode.interrupt(req.params.id)
      return { ok: true }
    } catch (e) {
      return mapErr(reply, req, e)
    }
  })

  app.get<{ Params: { id: string } }>("/sessions/:id/messages", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return { items: await app.openCode.listMessages(req.params.id) }
    } catch (e) {
      return mapErr(reply, req, e)
    }
  })

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    "/sessions/:id/diff",
    async (req, reply) => {
      if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
      try {
        return await app.openCode.getDiff(req.params.id, { from: req.query.from, to: req.query.to })
      } catch (e) {
        return mapErr(reply, req, e)
      }
    },
  )

  app.get<{ Params: { id: string } }>("/sessions/:id/permissions", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return { items: await app.openCode.listPermissionRequests(req.params.id) }
    } catch (e) {
      return mapErr(reply, req, e)
    }
  })

  app.post<{ Params: { id: string; reqId: string }; Body: { decision?: string } }>(
    "/sessions/:id/permissions/:reqId/reply",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
      const decision = req.body?.decision
      if (decision !== "allow" && decision !== "deny" && decision !== "always") {
        return sendError(reply, 400, "BAD_REQUEST", "decision must be allow|deny|always")
      }
      const budget = checkHeavy(writeHeavy, auth.userId)
      if (!budget.allowed) {
        reply.header("retry-after", String(budget.retryAfterSec))
        return sendError(reply, 429, "RATE_LIMITED", `too many permission replies, retry in ${budget.retryAfterSec}s`)
      }
      try {
        await app.openCode.replyPermission(req.params.id, req.params.reqId, decision)
        return { ok: true }
      } catch (e) {
        return mapErr(reply, req, e)
      }
    },
  )

  app.get("/events", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    if (!acquireSseSlot(auth.userId)) {
      reply.header("retry-after", "5")
      return sendError(reply, 503, "TOO_MANY_STREAMS", "too many concurrent event streams")
    }
    let slotHeld = true
    const releaseSlot = () => {
      if (!slotHeld) return
      slotHeld = false
      releaseSseSlot(auth.userId)
    }

    // Take over the socket: SSE frames are written directly and must not go through
    // Fastify's serializer (which would end the response as soon as the handler returns).
    reply.hijack()
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      // SSE bypasses the onSend hook (hijack), so set the security headers here too.
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "permissions-policy": "geolocation=(), microphone=(), camera=()",
    })
    reply.raw.write("retry: 3000\n\n")

    const send = (payload: unknown) => {
      if (reply.raw.writableEnded) return
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded) return
      reply.raw.write(": ping\n\n")
    }, HEARTBEAT_MS)
    heartbeat.unref()

    let closed = false
    const unsubscribe = app.openCode.subscribe({
      onEvent: (evt) => send(evt),
      onError: (err) => send({ type: "error", message: err.message }),
    })

    const close = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
      releaseSlot()
      if (!reply.raw.writableEnded) reply.raw.end()
    }
    req.raw.on("close", close)
    req.raw.on("error", close)
  })
}

export function createAgentAdapter(opts: {
  baseUrl: string
  username?: string
  password: string
}): OpenCodeAdapter {
  return createHttpAdapter(opts)
}

function mapErr(reply: import("fastify").FastifyReply, req: import("fastify").FastifyRequest, e: unknown) {
  // Never forward the upstream body: OpenCodeHttpError.message embeds up to 200 chars of
  // the OpenCode response, which can contain internals the caller should not see.
  // The detail is logged server-side; the client gets a stable, generic message.
  req.log.warn({ err: e }, "opencode upstream call failed")
  if (e instanceof OpenCodeHttpError) {
    const code = e.status === 404 ? "NOT_FOUND" : e.status === 401 ? "UPSTREAM_UNAUTHORIZED" : "UPSTREAM_ERROR"
    const status = e.status === 401 ? 502 : e.status === 404 ? 404 : 502
    return sendError(reply, status, code, "OpenCode upstream request failed")
  }
  return sendError(reply, 502, "UPSTREAM_ERROR", "OpenCode upstream request failed")
}
