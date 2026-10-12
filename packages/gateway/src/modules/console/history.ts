import type { FastifyPluginAsync } from "fastify"
import { requireAuth } from "../auth/routes.js"
import { countMetrics, queryMetrics } from "./metrics.js"
import type { MetricKind, MetricsSummary } from "@piforge/shared"
import { clampInt, sendError } from "../../util/validate.js"

const KINDS: MetricKind[] = ["cpu", "mem", "temp", "disk_write"]

export const historyRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { kind?: string; from?: string; to?: string; format?: string; limit?: string } }>(
    "/metrics/export",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
      const kind = (req.query.kind ?? "temp") as MetricKind
      if (!KINDS.includes(kind)) {
        return sendError(reply, 400, "BAD_REQUEST", `kind must be one of ${KINDS.join(", ")}`)
      }
      const to = clampInt(req.query.to, Date.now(), 0, Number.MAX_SAFE_INTEGER)
      const from = clampInt(req.query.from, to - 7 * 86400_000, 0, Number.MAX_SAFE_INTEGER)
      const limit = clampInt(req.query.limit, 50_000, 1, 100_000)
      const items = queryMetrics(app.db, kind, from, to, limit)
      // A 7-day window at 5s sampling is ~121k points, well past the export cap. Returning the
      // true count lets the UI say so instead of silently presenting a truncated series as the
      // whole range.
      const total = countMetrics(app.db, kind, from, to)

      if (req.query.format === "csv") {
        const lines = [
          "ts,kind,value,iso",
          ...items.map((i) => `${i.ts},${i.kind},${i.value},${new Date(i.ts).toISOString()}`),
        ]
        reply.header("content-type", "text/csv; charset=utf-8")
        reply.header("content-disposition", `attachment; filename="metrics-${kind}-${from}-${to}.csv"`)
        if (total > items.length) reply.header("x-piforge-truncated", `${total - items.length}`)
        return reply.send(lines.join("\n"))
      }
      return { kind, from, to, count: items.length, total, truncated: total > items.length, items }
    },
  )

  app.get<{ Querystring: { from?: string; to?: string } }>("/metrics/summary", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const to = clampInt(req.query.to, Date.now(), 0, Number.MAX_SAFE_INTEGER)
    const from = clampInt(req.query.from, to - 24 * 3600_000, 0, Number.MAX_SAFE_INTEGER)
    const summary: MetricsSummary[] = KINDS.map((kind) => {
      const items = queryMetrics(app.db, kind, from, to)
      if (items.length === 0) return { kind, count: 0 }
      const vals = items.map((i) => i.value)
      return {
        kind,
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
