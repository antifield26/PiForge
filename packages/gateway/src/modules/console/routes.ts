import type { FastifyPluginAsync } from "fastify"

export const consoleRoutes: FastifyPluginAsync = async (app) => {
  app.get("/system", async (req, reply) => {
    // P0.5: read vcgencmd + /proc
    return reply.code(501).send({ error: { code: "NOT_IMPLEMENTED", message: "metrics pending P0.5" } })
  })

  app.get("/services", async () => ({ items: [] }))
  app.post("/services/:unit/:action", async (req, reply) => {
    // P0.6: whitelist + audit
    return reply.code(501).send({ error: { code: "NOT_IMPLEMENTED", message: "service control pending P0.6" } })
  })
}
