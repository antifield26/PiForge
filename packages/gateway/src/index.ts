import { buildApp } from "./app.js"
import { loadConfig } from "./config/index.js"
import { ensureAdminUser } from "./modules/auth/routes.js"
import { checkpoint, pragmaInfo } from "./db/index.js"
import { primeWriteAccumulator } from "./modules/console/metrics.js"
import { acquireSingleInstanceLock } from "./util/instance-lock.js"

async function main() {
  const config = loadConfig()

  // Two gateways sharing one wb.db each run the 5s sampler, the hourly SD row and the alert
  // detector, which silently doubles SD writes. A transient `systemd-run` instance left over
  // from a manual test did exactly that for hours, so refuse to start a second copy.
  const releaseLock = acquireSingleInstanceLock(config.dbPath)
  const { app, db } = await buildApp(config)
  primeWriteAccumulator(db)

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
      releaseLock()
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
