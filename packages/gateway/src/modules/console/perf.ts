import type { FastifyPluginAsync } from "fastify"
import { requireAuth } from "../auth/routes.js"
import { readSdHealth, readSnapshot } from "./metrics.js"
import { sendError } from "../../util/validate.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const perfRoutes: FastifyPluginAsync = async (app) => {
  app.get("/perf", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const snap = await readSnapshot(app.db)
    const sd = await readSdHealth(app.db)
    const mem = process.memoryUsage()
    const openCodeRssMb = await readOpenCodeRss()
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
        uptimeSec: snap.uptimeSec,
      },
      sd: {
        model: sd.model,
        totalWriteGb: Number((sd.totalWriteBytes / 1024 ** 3).toFixed(2)),
        bootWriteGb: Number((sd.bootWriteBytes / 1024 ** 3).toFixed(2)),
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

async function readOpenCodeRss(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-C", "opencode"], { timeout: 5000 })
    const rssKb = Number(stdout.trim().split(/\s+/)[0] || 0)
    return rssKb > 0 ? Math.round(rssKb / 1024) : null
  } catch {
    return null
  }
}
