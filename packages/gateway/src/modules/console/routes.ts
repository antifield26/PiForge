import type { FastifyPluginAsync } from "fastify"
import { requireAuth } from "../auth/routes.js"
import { queryMetrics, readSdHealth, readSnapshot, recordMetrics, recordSdHealth } from "./metrics.js"
import type { MetricKind } from "@piforge/shared"
import { controlService, listAudit, listAuditUnits, listLoginAudit, listServiceStatus } from "./service-control.js"
import {
  countUnreadAlerts,
  deliverAlert,
  getThresholds,
  listAlerts,
  markAlertsRead,
  raiseAlert,
  runDetectors,
  setThresholds,
} from "./alerts.js"
import { clientIp } from "../../util/net.js"
import { checkHeavy, createHeavyLimiter } from "../../auth/ratelimit.js"
import { clampInt, sendError } from "../../util/validate.js"
import { pruneMetrics, pruneSdHealth } from "../../db/index.js"
import { runBackup } from "./backup.js"

const FLUSH_MS = 5 * 60 * 1000
const SAMPLE_MS = 5 * 1000
const DETECT_MS = 60 * 1000
const METRIC_KINDS: MetricKind[] = ["cpu", "mem", "temp", "disk_write"]
// backup.sh / systemctl are process-spawning and SD-heavy.
const heavy = createHeavyLimiter(10, 60_000)

export const consoleRoutes: FastifyPluginAsync = async (app) => {
  const pending: Awaited<ReturnType<typeof readSnapshot>>[] = []
  let sampleTimer: ReturnType<typeof setInterval> | null = null
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let detectTimer: ReturnType<typeof setInterval> | null = null

  async function detectOnce(): Promise<void> {
    try {
      const [snap, sd] = await Promise.all([readSnapshot(app.db), readSdHealth(app.db)])
      const backup = app.db
        .prepare("SELECT status FROM backup_runs ORDER BY id DESC LIMIT 1")
        .get() as { status: string } | undefined
      const result = await runDetectors(app.db, {
        lastBackupStatus: backup?.status ?? null,
        sdDayWriteBytes: Math.max(0, sd.dayWriteBytes),
        memAvailableMb: Math.round(snap.memAvailableKb / 1024),
      })
      for (const id of result.raised) {
        const row = app.db
          .prepare("SELECT title, message, severity FROM alerts WHERE id = ?")
          .get(id) as { title: string; message: string; severity: string } | undefined
        if (row) {
          void deliverAlert(row).catch((err) => app.log.debug({ err }, "alert webhook failed"))
        }
      }
    } catch (err) {
      app.log.debug({ err }, "alert detector failed")
    }
  }

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

    detectTimer = setInterval(() => void detectOnce(), DETECT_MS)
    detectTimer.unref()
  })

  app.addHook("onClose", async () => {
    if (sampleTimer) clearInterval(sampleTimer)
    if (flushTimer) clearInterval(flushTimer)
    if (detectTimer) clearInterval(detectTimer)
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

  app.get<{
    Querystring: { limit?: string; unit?: string; action?: string; allowed?: string; from?: string; to?: string }
  }>("/audit", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const allowedRaw = req.query.allowed
    const allowed = allowedRaw === "0" ? 0 : allowedRaw === "1" ? 1 : undefined
    return {
      items: listAudit(app.db, {
        limit: clampInt(req.query.limit, 50, 1, 500),
        unit: typeof req.query.unit === "string" && req.query.unit ? req.query.unit : undefined,
        action: typeof req.query.action === "string" && req.query.action ? req.query.action : undefined,
        allowed,
        from: req.query.from ? clampInt(req.query.from, 0, 0, Number.MAX_SAFE_INTEGER) : undefined,
        to: req.query.to ? clampInt(req.query.to, 0, 0, Number.MAX_SAFE_INTEGER) : undefined,
      }),
      units: listAuditUnits(app.db),
    }
  })

  app.get<{ Querystring: { limit?: string; ok?: string; from?: string; to?: string } }>("/audit/login", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const okRaw = req.query.ok
    const ok = okRaw === "0" ? 0 : okRaw === "1" ? 1 : undefined
    return {
      items: listLoginAudit(app.db, {
        limit: clampInt(req.query.limit, 50, 1, 500),
        ok,
        from: req.query.from ? clampInt(req.query.from, 0, 0, Number.MAX_SAFE_INTEGER) : undefined,
        to: req.query.to ? clampInt(req.query.to, 0, 0, Number.MAX_SAFE_INTEGER) : undefined,
      }),
    }
  })

  app.get<{ Querystring: { kind?: string; limit?: string; unit?: string; action?: string } }>(
    "/audit/export",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
      const kind = req.query.kind === "login" ? "login" : "service"
      const limit = clampInt(req.query.limit, 500, 1, 5000)
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")
      if (kind === "login") {
        const rows = listLoginAudit(app.db, { limit })
        const lines = ["id,ts,iso,username,ok,client_ip,user_agent"]
        for (const r of rows) {
          lines.push(
            [r.id, r.ts, new Date(r.ts).toISOString(), r.username, r.ok, r.client_ip ?? "", r.user_agent ?? ""]
              .map(csvCell)
              .join(","),
          )
        }
        reply.header("content-type", "text/csv; charset=utf-8")
        reply.header("content-disposition", `attachment; filename="login-audit-${stamp}.csv"`)
        return reply.send(lines.join("\n"))
      }
      const rows = listAudit(app.db, {
        limit,
        unit: typeof req.query.unit === "string" && req.query.unit ? req.query.unit : undefined,
        action: typeof req.query.action === "string" && req.query.action ? req.query.action : undefined,
      })
      const lines = ["id,ts,iso,user_id,unit,action,allowed,result,client_ip"]
      for (const r of rows) {
        lines.push(
          [r.id, r.ts, new Date(r.ts).toISOString(), r.user_id ?? "", r.unit, r.action, r.allowed, r.result ?? "", r.client_ip ?? ""]
            .map(csvCell)
            .join(","),
        )
      }
      reply.header("content-type", "text/csv; charset=utf-8")
      reply.header("content-disposition", `attachment; filename="service-audit-${stamp}.csv"`)
      return reply.send(lines.join("\n"))
    },
  )

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
      // Surface a durable alert, not just an HTTP error.
      const id = raiseAlert(app.db, {
        kind: "backup_failed",
        severity: "critical",
        title: "备份失败",
        message: run.message ?? "手动备份失败",
        dedupeKey: `backup:failed:manual:${run.id}`,
      })
      if (id != null) {
        void deliverAlert({ title: "备份失败", message: run.message ?? "手动备份失败", severity: "critical" }).catch(
          () => undefined,
        )
      }
      return reply.code(502).send({ error: { code: "BACKUP_FAILED", message: run.message }, ...run })
    }
    return reply.code(201).send(run)
  })

  // ---- Alerts (P3.2) ----
  app.get<{ Querystring: { limit?: string; unread?: string } }>("/alerts", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    return {
      items: listAlerts(app.db, {
        limit: clampInt(req.query.limit, 50, 1, 200),
        unreadOnly: req.query.unread === "1" || req.query.unread === "true",
      }),
      unread: countUnreadAlerts(app.db),
    }
  })

  app.post<{ Body: { ids?: unknown } }>("/alerts/read", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const body = req.body as { ids?: unknown } | undefined
    let ids: number[] | "all" = "all"
    if (Array.isArray(body?.ids)) {
      ids = body.ids.filter((x): x is number => typeof x === "number" && Number.isInteger(x)).slice(0, 200)
    }
    const changed = markAlertsRead(app.db, ids)
    return { ok: true, changed, unread: countUnreadAlerts(app.db) }
  })

  app.get("/alerts/thresholds", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    return getThresholds(app.db)
  })

  app.post<{ Body: Record<string, unknown> }>("/alerts/thresholds", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const next = setThresholds(app.db, {
        sdDayWriteBytes: typeof body.sdDayWriteBytes === "number" ? body.sdDayWriteBytes : undefined,
        memAvailableMb: typeof body.memAvailableMb === "number" ? body.memAvailableMb : undefined,
        cooldownMinutes: typeof body.cooldownMinutes === "number" ? body.cooldownMinutes : undefined,
      })
      return next
    } catch (e) {
      return sendError(reply, 400, "BAD_REQUEST", e instanceof Error ? e.message : "invalid thresholds")
    }
  })
}

function csvCell(value: string | number | null): string {
  const s = value == null ? "" : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
