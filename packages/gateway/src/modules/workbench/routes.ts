import type { FastifyPluginAsync } from "fastify"

export const workbenchRoutes: FastifyPluginAsync = async (app) => {
  app.get("/todos", async () => ({ items: [] }))
  app.get("/notes", async () => ({ items: [] }))
  app.get("/bookmarks", async () => ({ items: [] }))
}
