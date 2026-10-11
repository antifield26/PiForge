import type { FastifyPluginAsync } from "fastify"
import { requireAuth } from "../auth/routes.js"
import { queryMetrics } from "./metrics.js"
import type { MetricKind } from "@piforge/shared"
import type { Db } from "../../db/index.js"

interface AppWithDb {
  db: Db
}

export const historyRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { kind?: string; from?: string; to?: string; format?: string } }>(
    "/metrics/export",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
      const kind = (req.query.kind ?? "temp") as MetricKind
      const to = Number(req.query.to ?? Date.now())
      const from = Number(req.query.from ?? to - 7 * 86400_000)
      const format = req.query.format === "csv" ? "csv" : "json"
      const items = queryMetrics((app as unknown as AppWithDb).db, kind, from, to)

      if (format === "csv") {
        const lines = ["ts,kind,value,iso", ...items.map((i) => `${i.ts},${i.kind},${i.value},${new Date(i.ts).toISOString()}`)]
        reply.header("content-type", "text/csv; charset=utf-8")
        reply.header("content-disposition", `attachment; filename="metrics-${kind}-${from}-${to}.csv"`)
        return reply.send(lines.join("\n"))
      }
      return { kind, from, to, items }
    },
  )

  app.get<{ Querystring: { from?: string; to?: string } }>("/metrics/summary", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const to = Number(req.query.to ?? Date.now())
    const from = Number(req.query.from ?? to - 24 * 3600_000)
    const db = (app as unknown as AppWithDb).db
    const kinds: MetricKind[] = ["cpu", "mem", "temp", "disk_write"]
    const summary = kinds.map((k) => {
      const items = queryMetrics(db, k, from, to)
      if (items.length === 0) return { kind: k, count: 0 }
      const vals = items.map((i) => i.value)
      return {
        kind: k,
        count: items.length,
        min: Math.min(...vals),
        max: Math.max(...vals),
        avg: vals.reduce((a, b) => a + b, 0) / vals.length,
        last: vals[vals.length - 1],
      }
    })
    return { from, to, summary }
  })
}
