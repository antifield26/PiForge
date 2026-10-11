import type { FastifyPluginAsync } from "fastify"
import { createHttpAdapter, OpenCodeHttpError } from "./http-adapter.js"
import type { OpenCodeAdapter } from "./adapter.js"
import { requireAuth } from "../auth/routes.js"

declare module "fastify" {
  interface FastifyInstance {
    openCode: OpenCodeAdapter
  }
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/info", async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    try {
      return await app.openCode.info()
    } catch (e) {
      return mapErr(reply, e)
    }
  })

  app.get("/sessions", async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    try {
      const items = await app.openCode.listSessions()
      return { items }
    } catch (e) {
      return mapErr(reply, e)
    }
  })

  app.post<{ Body: { title?: string } }>("/sessions", async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    try {
      const session = await app.openCode.createSession(req.body?.title)
      return reply.code(201).send(session)
    } catch (e) {
      return mapErr(reply, e)
    }
  })

  app.post<{ Params: { id: string }; Body: { content?: string; model?: string; agent?: string } }>(
    "/sessions/:id/prompt",
    async (req, reply) => {
      if (!requireAuth(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
      const content = req.body?.content
      if (!content) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "content required" } })
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

  app.get("/events", async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    reply.raw.write(`event: ready\ndata: {}\n\n`)
    const unsubscribe = app.openCode.subscribe({
      onEvent: (evt) => {
        reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`)
      },
      onError: (err) => {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`)
      },
    })
    req.raw.on("close", () => {
      unsubscribe()
      reply.raw.end()
    })
  })
}

export function createAgentAdapter(opts: {
  baseUrl: string
  password: string
}): OpenCodeAdapter {
  return createHttpAdapter(opts)
}

function mapErr(reply: import("fastify").FastifyReply, e: unknown) {
  if (e instanceof OpenCodeHttpError) {
    const code = e.status === 404 ? "NOT_FOUND" : e.status === 401 ? "UPSTREAM_UNAUTHORIZED" : "UPSTREAM_ERROR"
    return reply.code(e.status === 401 ? 502 : e.status).send({ error: { code, message: e.message } })
  }
  return reply.code(502).send({
    error: { code: "UPSTREAM_ERROR", message: e instanceof Error ? e.message : String(e) },
  })
}
