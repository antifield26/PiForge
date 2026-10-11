import type { FastifyPluginAsync } from "fastify"

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/login", async (req, reply) => {
    // P0.2: verify password hash, create session
    return reply.code(501).send({ error: { code: "NOT_IMPLEMENTED", message: "login pending P0.2" } })
  })

  app.post("/logout", async () => {
    return { ok: true }
  })

  app.get("/me", async (req, reply) => {
    return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
  })
}
