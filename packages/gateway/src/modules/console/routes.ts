import type { FastifyPluginAsync } from "fastify"
import { requireAuth } from "../auth/routes.js"
import { queryMetrics, readSdHealth, readSnapshot, recordMetrics, recordSdHealth } from "./metrics.js"
import type { MetricKind } from "@piforge/shared"
import { controlService, listAudit, listServiceStatus } from "./service-control.js"
import { clientIp } from "../../util/net.js"
import { checkHeavy, createHeavyLimiter } from "../../auth/ratelimit.js"
import { clampInt, sendError } from "../../util/validate.js"
import { pruneMetrics, pruneSdHealth } from "../../db/index.js"
import { runBackup } from "./backup.js"

const FLUSH_MS = 5 * 60 * 1000
const SAMPLE_MS = 5 * 1000
const METRIC_KINDS: MetricKind[] = ["cpu", "mem", "temp", "disk_write"]
// backup.sh / systemctl are process-spawning and SD-heavy.
const heavy = createHeavyLimiter(10, 60_000)

export const consoleRoutes: FastifyPluginAsync = async (app) => {
  const pending: Awaited<ReturnType<typeof readSnapshot>>[] = []
  let sampleTimer: ReturnType<typeof setInterval> | null = null
  let flushTimer: ReturnType<typeof setInterval> | null = null

  app.addHook("onReady", async () => {
    sampleTimer = setInterval(() => {
      void readSnapshot(app.db)
        .then((snap) => {
          if (pending.length < 720) pending.push(snap)
        })
        .catch((err) => app.log.debug({ err }, "metrics sample failed"))
    }, SAMPLE_MS)
    sampleTimer.unref()

    flushTimer = setInterval(() => {
      if (pending.length === 0) return
      const batch = pending.splice(0, pending.length)
      try {
        for (const snap of batch) recordMetrics(app.db, snap)
        void readSdHealth(app.db)
          .then((sd) => recordSdHealth(app.db, sd))
          .catch(() => undefined)
        pruneMetrics(app.db, app.config.metricsRetentionDays)
        pruneSdHealth(app.db)
      } catch (err) {
        app.log.warn({ err }, "metrics flush failed")
      }
    }, FLUSH_MS)
    flushTimer.unref()
  })

  app.addHook("onClose", async () => {
    if (sampleTimer) clearInterval(sampleTimer)
    if (flushTimer) clearInterval(flushTimer)
  })

  app.get("/system", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    // Read-only: the 5s sampler owns persistence, so a panel poll does not write to the SD card.
    return readSnapshot(app.db)
  })

  app.get<{ Querystring: { kind?: string; from?: string; to?: string } }>("/metrics", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const kind = (req.query.kind ?? "cpu") as MetricKind
    if (!METRIC_KINDS.includes(kind)) {
      return sendError(reply, 400, "BAD_REQUEST", `kind must be one of ${METRIC_KINDS.join(", ")}`)
    }
    const to = clampInt(req.query.to, Date.now(), 0, Number.MAX_SAFE_INTEGER)
    const from = clampInt(req.query.from, to - 3600_000, 0, Number.MAX_SAFE_INTEGER)
    return { kind, from, to, items: queryMetrics(app.db, kind, from, to) }
  })

  app.get("/sd", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    return readSdHealth(app.db)
  })

  app.get("/services", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    return { items: await listServiceStatus() }
  })

  app.post<{ Params: { unit: string; action: string }; Body: { confirmToken?: unknown } }>(
    "/services/:unit/:action",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
      const action = req.params.action
      if (!["start", "stop", "restart", "status"].includes(action)) {
        return sendError(reply, 400, "BAD_REQUEST", "invalid action")
      }
      const unit = req.params.unit
      const confirmToken = typeof req.body?.confirmToken === "string" ? req.body.confirmToken : undefined
      const result = await controlService(
        app.db,
        unit,
        action as "start" | "stop" | "restart" | "status",
        auth.userId,
        clientIp(req),
        confirmToken,
      )
      if (!result.allowed) {
        return sendError(reply, 403, "FORBIDDEN", result.result, { auditId: result.auditId })
      }
      if (result.requiresConfirm) {
        return reply.code(202).send({
          requiresConfirm: true,
          confirmToken: result.confirmToken,
          unit,
          action,
          message: "confirm to proceed",
        })
      }
      if (result.failed) {
        // Authorized but systemctl itself failed: surface it as a gateway/upstream error
        // so clients and tests can tell success from failure by status code alone.
        return sendError(reply, 502, "SERVICE_CONTROL_FAILED", result.result, {
          auditId: result.auditId,
          unit,
          action,
        })
      }
      return result
    },
  )

  app.get<{ Querystring: { limit?: string } }>("/audit", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    return { items: listAudit(app.db, clampInt(req.query.limit, 50, 1, 500)) }
  })

  app.get("/backups", async (req, reply) => {
    if (!requireAuth(req)) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const items = app.db
      .prepare(
        "SELECT id, started_at, finished_at, status, target, bytes, checksum, message FROM backup_runs ORDER BY id DESC LIMIT 20",
      )
      .all()
    return { items }
  })

  app.post("/backups/run", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const budget = checkHeavy(heavy, auth.userId)
    if (!budget.allowed) {
      reply.header("retry-after", String(budget.retryAfterSec))
      return sendError(reply, 429, "RATE_LIMITED", `too many backup requests, retry in ${budget.retryAfterSec}s`)
    }
    const run = await runBackup(app.db, app.config.backupScript)
    if (run.status === "failed") {
      return reply.code(502).send({ error: { code: "BACKUP_FAILED", message: run.message }, ...run })
    }
    return reply.code(201).send(run)
  })
}
