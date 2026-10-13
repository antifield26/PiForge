import Fastify, { type FastifyInstance } from "fastify"
import cookie from "@fastify/cookie"
import fastifyStatic from "@fastify/static"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { authRoutes } from "./modules/auth/routes.js"
import { consoleRoutes } from "./modules/console/routes.js"
import { logsRoutes } from "./modules/console/logs.js"
import { historyRoutes } from "./modules/console/history.js"
import { perfRoutes } from "./modules/console/perf.js"
import { agentRoutes, createAgentAdapter } from "./modules/agent/routes.js"
import { workbenchRoutes } from "./modules/workbench/routes.js"
import { cloudRoutes } from "./modules/workbench/cloud.js"
import { setConfirmSecret } from "./modules/console/service-control.js"
import { setAllowlistPath } from "./modules/console/allowlist.js"
import type { GatewayConfig } from "./config/index.js"
import { openDb, pragmaInfo, type Db } from "./db/index.js"
import type { OpenCodeAdapter } from "./modules/agent/adapter.js"

declare module "fastify" {
  interface FastifyInstance {
    db: Db
    config: GatewayConfig
    openCode: OpenCodeAdapter
  }
  interface FastifyRequest {
    db: Db
    userId?: string
  }
}

export interface BuildOptions {
  logger?: boolean | object
  openCode?: OpenCodeAdapter
}

export interface BuiltApp {
  app: FastifyInstance
  db: Db
}

export async function buildApp(config: GatewayConfig, options: BuildOptions = {}): Promise<BuiltApp> {
  const db = openDb(config.dbPath)
  setConfirmSecret(config.sessionSecret)
  setAllowlistPath(config.servicesAllowlistPath)

  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    bodyLimit: config.jsonBodyLimitBytes,
  })

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body || body === "") return done(null, {})
    try {
      done(null, JSON.parse(body as string))
    } catch {
      done(badRequest("invalid json body"))
    }
  })

  await app.register(cookie, { secret: config.sessionSecret })

  app.decorate("db", db)
  app.decorate("config", config)
  app.decorateRequest("db", { getter: () => db })

  const openCode = options.openCode ?? createAdapterFromConfig(config)
  app.decorate("openCode", openCode)

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff")
    reply.header("referrer-policy", "no-referrer")
    reply.header("x-frame-options", "DENY")
    reply.header("permissions-policy", "geolocation=(), microphone=(), camera=()")
    if (!reply.getHeader("content-security-policy")) {
      reply.header(
        "content-security-policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      )
    }
    return payload
  })

  app.addHook("onRequest", async (req, reply) => {
    // SameSite=Lax already blocks cross-site cookie sends; this rejects the request outright
    // when a browser tells us it came from another origin.
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return
    if (!looksLikeApiUrl(req.url)) return
    const origin = req.headers.origin
    if (!origin) return
    const host = req.headers.host
    try {
      if (host && new URL(origin).host === host) return
    } catch {
      /* malformed origin -> reject below */
    }
    // The API is same-origin only; anything else is a cross-site attempt.
    return reply.code(403).send({ error: { code: "FORBIDDEN", message: "cross-site request rejected" } })
  })

  app.setErrorHandler((err: unknown, req, reply) => {
    const status = statusOf(err)
    if (status >= 500) req.log.error({ err }, "request failed")
    return reply.code(status).send({ error: { code: errorCode(status, err), message: publicMessage(status, err) } })
  })

  await app.register(authRoutes, { prefix: "/api/v1/auth" })
  await app.register(workbenchRoutes, { prefix: "/api/v1" })
  await app.register(cloudRoutes, { prefix: "/api/v1" })
  await app.register(consoleRoutes, { prefix: "/api/v1/console" })
  await app.register(logsRoutes, { prefix: "/api/v1/console" })
  await app.register(historyRoutes, { prefix: "/api/v1/console" })
  await app.register(perfRoutes, { prefix: "/api/v1/console" })
  await app.register(agentRoutes, { prefix: "/api/v1/agent" })

  app.get("/api/v1/health", async (_req, reply) => {
    // Unauthenticated, so it must not be cached by an intermediary or the browser.
    reply.header("cache-control", "no-store")
    return {
      ok: true,
      ts: Date.now(),
      db: {
        journal_mode: pragmaInfo(db, "journal_mode"),
        synchronous: pragmaInfo(db, "synchronous"),
      },
    }
  })

  const webDist = resolve(config.webDist)
  const webIndex = existsSync(join(webDist, "index.html"))

  app.setNotFoundHandler((req, reply) => {
    // Same decode rule as the cross-site check: the router matches decoded paths, so a raw
    // prefix test would send `/%61pi/...` to the SPA shell instead of a JSON 404.
    if (looksLikeApiUrl(req.url)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "route not found" } })
    }
    if (webIndex) return reply.sendFile("index.html")
    return reply.code(404).send({ error: { code: "NOT_FOUND", message: "not found" } })
  })

  if (webIndex) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/", index: ["index.html"], wildcard: false })
  } else {
    // Do not echo the absolute webDist path: it is local filesystem layout.
    app.get("/", async () => ({ ok: true, message: "PiForge API up; web dist not found" }))
  }

  app.addHook("onClose", async () => {
    db.close()
  })

  return { app, db }
}

/**
 * True when a request targets the JSON API.
 *
 * `req.url` is the raw, still percent-encoded target, but the router matches on the decoded
 * path, so `/%61pi/v1/todos` reaches the API while a naive prefix test on the raw string says
 * otherwise. Decode first, and treat a malformed escape as API traffic so a broken URL cannot
 * be used to slip past the cross-site check.
 */
function looksLikeApiUrl(rawUrl: string): boolean {
  const path = rawUrl.split("?")[0] ?? ""
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return true
  }
  return decoded.startsWith("/api/") || path.startsWith("/api/")
}

function createAdapterFromConfig(config: GatewayConfig): OpenCodeAdapter {
  return createAgentAdapter({
    baseUrl: config.openCodeUrl,
    username: config.openCodeUser,
    password: config.openCodePassword,
  })
}

function badRequest(message: string): Error & { statusCode: number; code: string } {
  const err = new Error(message) as Error & { statusCode: number; code: string }
  err.statusCode = 400
  err.code = "BAD_REQUEST"
  return err
}

function statusOf(err: unknown): number {
  const status = (err as { statusCode?: unknown })?.statusCode
  return typeof status === "number" && status >= 400 ? status : 500
}

function errorCode(status: number, err: unknown): string {
  if (status === 400) return "BAD_REQUEST"
  if (status === 401) return "UNAUTHORIZED"
  if (status === 403) return "FORBIDDEN"
  if (status === 404) return "NOT_FOUND"
  if (status === 413) return "PAYLOAD_TOO_LARGE"
  if (status === 415) return "UNSUPPORTED_MEDIA_TYPE"
  if (status === 429) return "RATE_LIMITED"
  if (status >= 500) return "INTERNAL_ERROR"
  const code = (err as { code?: unknown })?.code
  return typeof code === "string" ? code : "ERROR"
}

function publicMessage(status: number, err: unknown): string {
  if (status === 413) return "request body too large"
  if (status === 415) return "unsupported media type"
  if (status >= 500) return "internal error"
  // Only our own typed 400s carry a safe, intentional message. Fastify internals and other
  // thrown errors must not be echoed: their text can include paths, plugin names, or parse
  // fragments that belong in the server log, not the client.
  if (status === 400) {
    const code = (err as { code?: unknown })?.code
    if (code === "BAD_REQUEST" && err instanceof Error) return err.message
    return "bad request"
  }
  return "request failed"
}
