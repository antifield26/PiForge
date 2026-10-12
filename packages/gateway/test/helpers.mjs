import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../dist/config/index.js"
import { buildApp } from "../dist/app.js"

export async function tempDir(prefix = "piforge-test-") {
  return mkdtemp(join(tmpdir(), prefix))
}

export function testConfig(dir, overrides = {}) {
  return loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DB_PATH: join(dir, "wb.db"),
    CLOUD_STORAGE_DIR: join(dir, "cloud"),
    SERVICES_ALLOWLIST: overrides.allowlistPath ?? join(dir, "services.allowlist.json"),
    WEB_DIST: join(dir, "no-web-dist"),
    LOG_LEVEL: "silent",
    ...overrides.env,
  })
}

export async function startApp(dir, options = {}) {
  const config = testConfig(dir, options)
  const built = await buildApp(config, { logger: false, openCode: options.openCode })
  return { ...built, config }
}

export function stubAdapter(overrides = {}) {
  const events = []
  const calls = []
  return {
    events,
    calls,
    async info() {
      return { version: "test", pid: 1, urls: ["http://127.0.0.1:4096"] }
    },
    async listProjects() {
      return [{ id: "p", directory: "/workspace" }]
    },
    async createSession(title) {
      return { id: "ses_1", title: title ?? "", createdAt: 1, updatedAt: 1 }
    },
    async listSessions() {
      return [{ id: "ses_1", title: "s", createdAt: 1, updatedAt: 2 }]
    },
    async getSession(id) {
      return { id, title: "s", createdAt: 1, updatedAt: 2 }
    },
    async deleteSession() {},
    async prompt(id, req) {
      calls.push({ kind: "prompt", id, req })
    },
    async interrupt(id) {
      calls.push({ kind: "interrupt", id })
    },
    async listMessages() {
      return [{ id: "m1", sessionId: "ses_1", role: "assistant", content: "hi", createdAt: 1 }]
    },
    async listPermissionRequests() {
      return [{ id: "perm_1", sessionId: "ses_1", tool: "bash", description: "run", createdAt: 1 }]
    },
    async replyPermission(id, reqId, decision) {
      calls.push({ kind: "reply", id, reqId, decision })
    },
    async listAgents() {
      return [{ id: "build", name: "build" }]
    },
    async getDiff() {
      return { files: [] }
    },
    subscribe(handlers) {
      handlers.onEvent?.({ type: "session.update", sessionId: "ses_1", title: "hello" })
      return () => {}
    },
    ...overrides,
  }
}

export async function login(app, username = "admin", password = "test-password-123") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  })
  const cookie = res.headers["set-cookie"]
  return { res, cookie: Array.isArray(cookie) ? cookie[0] : (cookie ?? "") }
}

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true })
}

export function base64Of(bytes) {
  return Buffer.alloc(bytes, 0x41).toString("base64")
}
