import type { FastifyPluginAsync } from "fastify"
import { requireAuth } from "../auth/routes.js"
import { readResourceLimits, readSdHealth, readSnapshot, readWriteAttribution } from "./metrics.js"
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
    const attribution = await readWriteAttribution(app.db)
    const limits = readResourceLimits()
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
      writeAttribution: {
        gatewayMb: attribution.gatewayWriteBytes == null ? null : Number((attribution.gatewayWriteBytes / 1024 ** 2).toFixed(1)),
        openCodeMb: attribution.openCodeWriteBytes == null ? null : Number((attribution.openCodeWriteBytes / 1024 ** 2).toFixed(1)),
        lastBackupMb: attribution.lastBackupBytes == null ? null : Number((attribution.lastBackupBytes / 1024 ** 2).toFixed(1)),
        attributedMb: Number((attribution.attributedBytes / 1024 ** 2).toFixed(1)),
        residualDayGb: Number((attribution.residualDayWriteBytes / 1024 ** 3).toFixed(2)),
        deviceDayGb: Number((attribution.deviceDayWriteBytes / 1024 ** 3).toFixed(2)),
      },
      limits: {
        openCodeMemoryMaxMb:
          limits.openCodeMemoryMaxBytes == null ? null : Math.round(limits.openCodeMemoryMaxBytes / 1024 / 1024),
        openCodeMemoryLimitEffective: limits.openCodeMemoryLimitEffective,
        note: limits.note,
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
