import type { FastifyPluginAsync } from "fastify"

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/sessions", async () => ({ items: [] }))
  app.post("/sessions", async (req, reply) => {
    // P0.3/P0.4: OpenCodeAdapter.createSession
    return reply.code(501).send({ error: { code: "NOT_IMPLEMENTED", message: "agent sessions pending P0.3" } })
  })

  app.get("/events", async (req, reply) => {
    // P0.4: SSE bridge from OpenCode /api/event
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    reply.raw.write(`event: ready\ndata: {}\n\n`)
    req.raw.on("close", () => {
      reply.raw.end()
    })
  })
}
