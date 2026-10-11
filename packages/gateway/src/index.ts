import Fastify from "fastify"
import cookie from "@fastify/cookie"
import { authRoutes, ensureAdminUser } from "./modules/auth/routes.js"
import { consoleRoutes } from "./modules/console/routes.js"
import { agentRoutes } from "./modules/agent/routes.js"
import { workbenchRoutes } from "./modules/workbench/routes.js"
import { loadConfig } from "./config/index.js"
import { openDb, pragmaInfo, type Db } from "./db/index.js"

declare module "fastify" {
  interface FastifyRequest {
    db: Db
    userId?: string
  }
}

async function main() {
  const config = loadConfig()
  const db: Db = openDb(config.dbPath)

  const user = process.env.ADMIN_USER ?? "admin"
  const pass = process.env.ADMIN_PASSWORD
  if (pass) {
    await ensureAdminUser(db, user, pass)
  } else {
    const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }
    if (Number(count.n) === 0) {
      throw new Error("ADMIN_PASSWORD is required to bootstrap the first user")
    }
  }

  const app = Fastify({ logger: { level: config.logLevel } })
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body || body === "") return done(null, {})
    try {
      done(null, JSON.parse(body as string))
    } catch {
      done(new Error("invalid json"), undefined)
    }
  })
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    done(null, body ? {} : {})
  })

  await app.register(cookie, { secret: config.sessionSecret })

  app.decorateRequest("db", { getter: () => db })

  await app.register(authRoutes, { prefix: "/api/v1/auth" })
  await app.register(workbenchRoutes, { prefix: "/api/v1" })
  await app.register(consoleRoutes, { prefix: "/api/v1/console" })
  await app.register(agentRoutes, { prefix: "/api/v1/agent" })

  app.get("/api/v1/health", async () => ({
    ok: true,
    ts: Date.now(),
    db: {
      journal_mode: pragmaInfo(db, "journal_mode"),
      synchronous: pragmaInfo(db, "synchronous"),
    },
  }))

  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    { journal_mode: pragmaInfo(db, "journal_mode"), synchronous: pragmaInfo(db, "synchronous") },
    "database pragmas",
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
