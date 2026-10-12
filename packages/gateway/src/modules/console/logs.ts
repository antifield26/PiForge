import type { FastifyPluginAsync } from "fastify"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { requireAuth } from "../auth/routes.js"
import { loadAllowlist } from "./allowlist.js"
import { checkHeavy, createHeavyLimiter } from "../../auth/ratelimit.js"
import { clampInt, sendError } from "../../util/validate.js"

const execFileAsync = promisify(execFile)
const SINCE_PATTERN = /^(-?\d+[smhdw]|\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?|[a-z]+( \d+ (hour|day|minute)s? ago)?)$/i
// journalctl/apt are process-spawning and SD-touching; keep a stolen session from hammering them.
const heavy = createHeavyLimiter(20, 60_000)

export const logsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { unit?: string; since?: string; lines?: string } }>("/logs", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const budget = checkHeavy(heavy, auth.userId)
    if (!budget.allowed) {
      reply.header("retry-after", String(budget.retryAfterSec))
      return sendError(reply, 429, "RATE_LIMITED", `too many log requests, retry in ${budget.retryAfterSec}s`)
    }
    const unit = req.query.unit?.trim()
    const since = req.query.since?.trim() || "-1h"
    const lines = clampInt(req.query.lines, 100, 1, 500)

    if (unit && !loadAllowlist().some((u) => u.name === unit)) {
      return sendError(reply, 403, "FORBIDDEN", "unit not in allowlist")
    }
    if (!SINCE_PATTERN.test(since)) {
      return sendError(reply, 400, "BAD_REQUEST", "invalid since value")
    }

    try {
      const args = ["-n", String(lines), "--no-pager", "-o", "short-iso", "--since", since]
      if (unit) args.push("-u", unit)
      const { stdout } = await execFileAsync("journalctl", args, { timeout: 10_000, maxBuffer: 2_000_000 })
      return {
        unit: unit || null,
        since,
        lines: stdout.split("\n").filter(Boolean),
      }
    } catch (e) {
      // Do not forward exec error details (they can contain local paths/commands).
      req.log.warn({ err: e }, "journalctl failed")
      return sendError(reply, 502, "UPSTREAM_ERROR", "failed to read system logs")
    }
  })

  app.get("/apt-check", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const budget = checkHeavy(heavy, auth.userId)
    if (!budget.allowed) {
      reply.header("retry-after", String(budget.retryAfterSec))
      return sendError(reply, 429, "RATE_LIMITED", `too many requests, retry in ${budget.retryAfterSec}s`)
    }
    try {
      // read-only: list upgradable packages without applying
      const { stdout } = await execFileAsync("apt", ["list", "--upgradable"], {
        timeout: 20_000,
        maxBuffer: 1_000_000,
        env: { ...process.env, LC_ALL: "C" },
      })
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
      req.log.warn({ err: e }, "apt list failed")
      return sendError(reply, 502, "UPSTREAM_ERROR", "failed to check package updates")
    }
  })
}
