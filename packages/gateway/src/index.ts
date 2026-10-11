import Fastify from "fastify"
import cookie from "@fastify/cookie"
import { authRoutes } from "./modules/auth/routes.js"
import { consoleRoutes } from "./modules/console/routes.js"
import { agentRoutes } from "./modules/agent/routes.js"
import { workbenchRoutes } from "./modules/workbench/routes.js"
import { loadConfig } from "./config/index.js"

async function main() {
  const config = loadConfig()
  const app = Fastify({ logger: { level: config.logLevel } })

  await app.register(cookie, { secret: config.sessionSecret })

  await app.register(authRoutes, { prefix: "/api/v1/auth" })
  await app.register(workbenchRoutes, { prefix: "/api/v1" })
  await app.register(consoleRoutes, { prefix: "/api/v1/console" })
  await app.register(agentRoutes, { prefix: "/api/v1/agent" })

  app.get("/api/v1/health", async () => ({ ok: true, ts: Date.now() }))

  await app.listen({ host: config.host, port: config.port })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
