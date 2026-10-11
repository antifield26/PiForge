import type { FastifyPluginAsync, FastifyInstance } from "fastify"
import { requireAuth } from "../auth/routes.js"
import { queryMetrics, readSdHealth, readSnapshot, recordMetrics } from "./metrics.js"
import type { MetricKind, ServiceAction, SystemSnapshot } from "@piforge/shared"
import { loadAllowlist } from "./allowlist.js"
import { controlService, listAudit } from "./service-control.js"
import type { Db } from "../../db/index.js"

const FLUSH_MS = 5 * 60 * 1000
const SAMPLE_MS = 5 * 1000

interface ConsoleApp extends FastifyInstance {
  db: Db
}

export const consoleRoutes: FastifyPluginAsync = async (app) => {
  const pending: SystemSnapshot[] = []
  let sampleTimer: ReturnType<typeof setInterval> | null = null
  let flushTimer: ReturnType<typeof setInterval> | null = null

  app.addHook("onReady", async () => {
    sampleTimer = setInterval(() => {
      void readSnapshot()
        .then((snap) => {
          pending.push(snap)
        })
        .catch(() => {
          /* ignore sample errors */
        })
    }, SAMPLE_MS)
    sampleTimer.unref()

    flushTimer = setInterval(() => {
      if (pending.length === 0) return
      const batch = pending.splice(0, pending.length)
      try {
        const db = (app as ConsoleApp).db
        for (const snap of batch) recordMetrics(db, snap)
      } catch {
        /* drop batch on error */
      }
    }, FLUSH_MS)
    flushTimer.unref()
  })

  app.addHook("onClose", async () => {
    if (sampleTimer) clearInterval(sampleTimer)
    if (flushTimer) clearInterval(flushTimer)
  })

  app.get("/system", async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const snap = await readSnapshot()
    // also persist immediately so charts have a sample without waiting for flush
    try {
      recordMetrics((app as ConsoleApp).db, snap)
    } catch {
      /* ignore */
    }
    return snap
  })

  app.get<{ Querystring: { kind?: string; from?: string; to?: string } }>("/metrics", async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const kind = (req.query.kind ?? "cpu") as MetricKind
    const to = Number(req.query.to ?? Date.now())
    const from = Number(req.query.from ?? to - 3600_000)
    return { items: queryMetrics((app as ConsoleApp).db, kind, from, to) }
  })

  app.get("/sd", async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    return readSdHealth()
  })

  app.get("/services", async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    return { items: loadAllowlist().map((u) => ({ unit: u.name, label: u.label, allowedActions: u.allow })) }
  })

  app.post<{ Params: { unit: string; action: string } }>(
    "/services/:unit/:action",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
      const action = req.params.action as ServiceAction
      if (!["start", "stop", "restart", "status"].includes(action)) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "invalid action" } })
      }
      const unit = decodeURIComponent(req.params.unit)
      const result = await controlService(
        (app as ConsoleApp).db,
        unit,
        action,
        auth.userId,
        req.ip,
      )
      if (!result.allowed) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: result.result }, auditId: result.auditId })
      }
      return result
    },
  )

  app.get("/audit", async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    return { items: listAudit((app as ConsoleApp).db) }
  })

  app.get("/backups", async (req, reply) => {
    if (!requireAuth(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as ConsoleApp).db
    const items = db
      .prepare(
        "SELECT id, started_at, finished_at, status, target, bytes, checksum, message FROM backup_runs ORDER BY id DESC LIMIT 20",
      )
      .all()
    return { items }
  })

  app.post("/backups/run", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as ConsoleApp).db
    const started = Date.now()
    const res = db
      .prepare("INSERT INTO backup_runs (started_at, status, target) VALUES (?,?,?)")
      .run(started, "running", "local:/home/antifield/backups/piforge")
    const id = Number(res.lastInsertRowid)
    try {
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const run = promisify(execFile)
      await run("bash", ["/home/antifield/piforge/scripts/backup.sh"], { timeout: 120_000 })
      db.prepare("UPDATE backup_runs SET finished_at=?, status=?, message=? WHERE id=?").run(
        Date.now(),
        "ok",
        "backup completed",
        id,
      )
      return reply.code(201).send({ id, status: "ok" })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      db.prepare("UPDATE backup_runs SET finished_at=?, status=?, message=? WHERE id=?").run(
        Date.now(),
        "failed",
        msg.slice(0, 300),
        id,
      )
      return reply.code(502).send({ id, status: "failed", message: msg.slice(0, 300) })
    }
  })
}
