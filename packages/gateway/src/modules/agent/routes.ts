import type { FastifyPluginAsync } from "fastify"
import { createHttpAdapter, OpenCodeHttpError } from "./http-adapter.js"
import type { OpenCodeAdapter } from "./adapter.js"
import { requireAuth } from "../auth/routes.js"
import { sendError } from "../../util/validate.js"

const HEARTBEAT_MS = 15_000

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/info", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return await app.openCode.info()
    } catch (e) {
      return mapErr(reply, e)
    }
  })

  app.get("/projects", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return { items: await app.openCode.listProjects() }
    } catch (e) {
      return mapErr(reply, e)
    }
  })

  app.get("/agents", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return { items: await app.openCode.listAgents() }
    } catch (e) {
      return mapErr(reply, e)
    }
  })

  app.get("/sessions", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return { items: await app.openCode.listSessions() }
    } catch (e) {
      return mapErr(reply, e)
    }
  })

  app.post<{ Body: { title?: string } }>("/sessions", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return reply.code(201).send(await app.openCode.createSession(req.body?.title))
    } catch (e) {
      return mapErr(reply, e)
    }
  })

  app.post<{ Params: { id: string }; Body: { content?: string; model?: string; agent?: string } }>(
    "/sessions/:id/prompt",
    async (req, reply) => {
      if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
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
        return mapErr(reply, e)
      }
    },
  )

  app.post<{ Params: { id: string } }>("/sessions/:id/interrupt", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      await app.openCode.interrupt(req.params.id)
      return { ok: true }
    } catch (e) {
      return mapErr(reply, e)
    }
  })

  app.get<{ Params: { id: string } }>("/sessions/:id/messages", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return { items: await app.openCode.listMessages(req.params.id) }
    } catch (e) {
      return mapErr(reply, e)
    }
  })

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    "/sessions/:id/diff",
    async (req, reply) => {
      if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
      try {
        return await app.openCode.getDiff(req.params.id, { from: req.query.from, to: req.query.to })
      } catch (e) {
        return mapErr(reply, e)
      }
    },
  )

  app.get<{ Params: { id: string } }>("/sessions/:id/permissions", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      return { items: await app.openCode.listPermissionRequests(req.params.id) }
    } catch (e) {
      return mapErr(reply, e)
    }
  })

  app.post<{ Params: { id: string; reqId: string }; Body: { decision?: string } }>(
    "/sessions/:id/permissions/:reqId/reply",
    async (req, reply) => {
      if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
      const decision = req.body?.decision
      if (decision !== "allow" && decision !== "deny" && decision !== "always") {
        return sendError(reply, 400, "BAD_REQUEST", "decision must be allow|deny|always")
      }
      try {
        await app.openCode.replyPermission(req.params.id, req.params.reqId, decision)
        return { ok: true }
      } catch (e) {
        return mapErr(reply, e)
      }
    },
  )

  app.get("/events", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")

    // Take over the socket: SSE frames are written directly and must not go through
    // Fastify's serializer (which would end the response as soon as the handler returns).
    reply.hijack()
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
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

function mapErr(reply: import("fastify").FastifyReply, e: unknown) {
  if (e instanceof OpenCodeHttpError) {
    const code = e.status === 404 ? "NOT_FOUND" : e.status === 401 ? "UPSTREAM_UNAUTHORIZED" : "UPSTREAM_ERROR"
    return sendError(reply, e.status === 401 ? 502 : e.status, code, e.message)
  }
  return sendError(reply, 502, "UPSTREAM_ERROR", e instanceof Error ? e.message : String(e))
}
