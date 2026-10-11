import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { requireAuth } from "../auth/routes.js"
import { loadAllowlist } from "./allowlist.js"
import type { FastifyPluginAsync } from "fastify"

const execFileAsync = promisify(execFile)

export const logsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { unit?: string; since?: string; lines?: string } }>(
    "/logs",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
      const unit = req.query.unit?.trim()
      const since = req.query.since?.trim() || "-1h"
      const lines = Math.min(Number(req.query.lines || 100), 500)

      const allow = loadAllowlist().map((u) => u.name)
      if (unit && !allow.includes(unit)) {
        return reply
          .code(403)
          .send({ error: { code: "FORBIDDEN", message: "unit not in allowlist" } })
      }

      try {
        const args = ["-n", String(lines), "--no-pager", "-o", "short-iso"]
        if (since) args.push("--since", since)
        if (unit) args.push("-u", unit)
        const { stdout } = await execFileAsync("journalctl", args, { timeout: 10_000, maxBuffer: 2_000_000 })
        return {
          unit: unit || null,
          since,
          lines: stdout.split("\n").filter(Boolean),
        }
      } catch (e) {
        return reply.code(502).send({
          error: { code: "UPSTREAM_ERROR", message: e instanceof Error ? e.message : String(e) },
        })
      }
    },
  )

  app.get("/apt-check", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    try {
      // read-only: list upgradable packages without applying
      const { stdout } = await execFileAsync(
        "apt",
        ["list", "--upgradable"],
        { timeout: 20_000, maxBuffer: 1_000_000, env: { ...process.env, LC_ALL: "C" } },
      )
      const items = stdout
        .split("\n")
        .filter((l) => l.includes("/") && l.includes("["))
        .slice(0, 100)
      return {
        checkedAt: Date.now(),
        count: items.length,
        items,
        raw: stdout.split("\n").slice(0, 200),
      }
    } catch (e) {
      // apt list may exit non-zero if no lists; still try to parse
      return reply.code(502).send({
        error: { code: "UPSTREAM_ERROR", message: e instanceof Error ? e.message : String(e) },
      })
    }
  })
}
