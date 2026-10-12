import { buildApp } from "./app.js"
import { loadConfig } from "./config/index.js"
import { ensureAdminUser } from "./modules/auth/routes.js"
import { checkpoint, pragmaInfo } from "./db/index.js"

async function main() {
  const config = loadConfig()
  const { app, db } = await buildApp(config)

  const username = process.env.ADMIN_USER ?? "admin"
  const password = process.env.ADMIN_PASSWORD
  if (password) {
    await ensureAdminUser(db, username, password)
  } else {
    const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }
    if (Number(count.n) === 0) {
      throw new Error("ADMIN_PASSWORD is required to bootstrap the first user")
    }
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down")
    try {
      checkpoint(db)
      await app.close()
    } finally {
      process.exit(0)
    }
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))

  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    {
      host: config.host,
      port: config.port,
      db: config.dbPath,
      journal_mode: pragmaInfo(db, "journal_mode"),
      synchronous: pragmaInfo(db, "synchronous"),
      uploadLimitMb: Math.round(config.uploadBodyLimitBytes / 1024 / 1024),
    },
    "gateway ready",
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
