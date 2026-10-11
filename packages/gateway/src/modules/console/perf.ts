import type { FastifyPluginAsync } from "fastify"
import { requireAuth } from "../auth/routes.js"
import { readSdHealth, readSnapshot } from "./metrics.js"

export const perfRoutes: FastifyPluginAsync = async (app) => {
  app.get("/perf", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const snap = await readSnapshot()
    const sd = await readSdHealth()
    const mem = process.memoryUsage()
    // poll opencode RSS
    let openCodeRssMb = null as number | null
    try {
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const run = promisify(execFile)
      const { stdout } = await run("ps", ["-o", "rss=", "-C", "opencode"])
      const rssKb = Number(stdout.trim().split(/\s+/)[0] || 0)
      openCodeRssMb = Math.round(rssKb / 1024)
    } catch {
      /* not running or ps unavailable */
    }
    return {
      capturedAt: Date.now(),
      gatewayRssMb: Math.round(mem.rss / 1024 / 1024),
      gatewayHeapMb: Math.round(mem.heapUsed / 1024 / 1024),
      openCodeRssMb,
      system: {
        tempC: snap.tempC,
        load1: snap.load1,
        memUsedMb: Math.round((snap.memTotalKb - snap.memAvailableKb) / 1024),
        memTotalMb: Math.round(snap.memTotalKb / 1024),
        diskWriteBps: snap.diskWriteBps,
      },
      sd: {
        model: sd.model,
        totalWriteGb: Number((sd.totalWriteBytes / 1024 ** 3).toFixed(2)),
        dayWriteGb: Number((sd.dayWriteBytes / 1024 ** 3).toFixed(2)),
        estimateDaysLeft: sd.estimateDaysLeft,
      },
      targets: {
        gatewayRssMb: 300,
        openCodeRssMb: 1000,
        dayWriteGb: 1.5,
      },
    }
  })
}
