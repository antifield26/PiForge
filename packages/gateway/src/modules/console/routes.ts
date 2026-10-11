import type { FastifyPluginAsync, FastifyInstance } from "fastify"
import { requireAuth } from "../auth/routes.js"
import { queryMetrics, readSdHealth, readSnapshot, recordMetrics } from "./metrics.js"
import type { MetricKind, SystemSnapshot } from "@piforge/shared"
import { loadAllowlist } from "./allowlist.js"
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
}
