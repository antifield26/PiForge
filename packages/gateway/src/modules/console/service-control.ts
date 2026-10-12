import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto"
import type { ServiceAction, ServiceStatus } from "@piforge/shared"
import type { Db } from "../../db/index.js"
import { loadAllowlist, type AllowlistUnit } from "./allowlist.js"

const execFileAsync = promisify(execFile)

/**
 * Injectable exec for tests: unit tests must never run a real `sudo systemctl`.
 * Production keeps the real execFile; tests replace this via setServiceExec.
 */
export type ServiceExec = (cmd: string, args: string[]) => Promise<{ stdout: string }>
let serviceExec: ServiceExec = async (cmd, args) => execFileAsync(cmd, args, { timeout: 15_000 })
export function setServiceExec(fn: ServiceExec | null): void {
  serviceExec = fn ?? (async (cmd, args) => execFileAsync(cmd, args, { timeout: 15_000 }))
}

export interface ServiceControlResult {
  allowed: boolean
  requiresConfirm?: boolean
  confirmToken?: string
  unit: string
  action: ServiceAction
  active?: boolean
  result: string
  /** True when the command was authorized but the underlying systemctl call failed. */
  failed?: boolean
  auditId?: number
}

const CONFIRM_TTL_MS = 60_000
const STATUS_CACHE_MS = 10_000

let confirmSecretOverride: string | null = null
/** Allows the bootstrap code to hand the runtime secret to this module once. */
export function setConfirmSecret(secret: string): void {
  confirmSecretOverride = secret
}
const confirmSecret = () => confirmSecretOverride ?? process.env.SESSION_SECRET ?? "dev-only-change-me"

// One-time use: a confirm token is bound to unit+action+user and may only be consumed once.
// The jti is registered on verify and rejected on any later attempt.
const usedJtis = new Map<string, number>()
function pruneJtis(now = Date.now()): void {
  for (const [jti, exp] of usedJtis) {
    if (exp <= now) usedJtis.delete(jti)
  }
}

/** Bound to unit + action + user, and single-use (jti is consumed on verify). */
export function issueConfirmToken(unit: string, action: string, userId: string, now = Date.now()): string {
  const exp = now + CONFIRM_TTL_MS
  const jti = randomBytes(8).toString("hex")
  return `${exp}.${jti}.${signConfirm(unit, action, userId, exp, jti)}`
}

function signConfirm(unit: string, action: string, userId: string, exp: number, jti: string): string {
  const payload = `${unit}|${action}|${userId}|${exp}|${jti}`
  return createHmac("sha256", confirmSecret()).update(payload).digest("base64url").slice(0, 22)
}

export function verifyConfirmToken(
  unit: string,
  action: string,
  userId: string,
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (typeof token !== "string" || !token) return false
  const parts = token.split(".")
  if (parts.length !== 3) return false
  const [expStr, jti, sig] = parts
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < now || !jti || !sig) return false
  if (usedJtis.has(jti)) return false // already consumed — reject replay
  const expected = signConfirm(unit, action, userId, exp, jti)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  pruneJtis(now)
  usedJtis.set(jti, exp + 60_000) // keep the tombstone briefly past expiry
  return true
}

export async function controlService(
  db: Db,
  unit: string,
  action: ServiceAction,
  userId: string | null,
  clientIp: string | null,
  confirmToken?: string,
): Promise<ServiceControlResult> {
  const entry: AllowlistUnit | undefined = loadAllowlist().find((u) => u.name === unit)

  if (!entry) {
    const auditId = writeAudit(db, userId, unit, action, false, "rejected: not in allowlist", clientIp)
    return { allowed: false, unit, action, result: "rejected: not in allowlist", auditId }
  }

  if (!entry.allow.includes(action)) {
    const auditId = writeAudit(db, userId, unit, action, false, "rejected: action not allowed", clientIp)
    return { allowed: false, unit, action, result: "rejected: action not allowed", auditId }
  }

  if (action !== "status" && needsConfirm(entry, action)) {
    const token = typeof confirmToken === "string" ? confirmToken : undefined
    if (!userId || !verifyConfirmToken(unit, action, userId, token)) {
      const fresh = userId ? issueConfirmToken(unit, action, userId) : undefined
      const auditId = writeAudit(db, userId, unit, action, false, "needs confirm", clientIp)
      return {
        allowed: true,
        requiresConfirm: true,
        confirmToken: fresh,
        unit,
        action,
        result: "requires confirm",
        auditId,
      }
    }
  }

  try {
    if (action === "status") {
      const active = await isActive(unit)
      const auditId = writeAudit(db, userId, unit, action, true, `active=${active}`, clientIp)
      return { allowed: true, unit, action, active: active ?? undefined, result: `active=${active}`, auditId }
    }

    await serviceExec("sudo", ["systemctl", action, unit])
    const auditId = writeAudit(db, userId, unit, action, true, "ok", clientIp)
    return { allowed: true, unit, action, result: "ok", auditId }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const auditId = writeAudit(db, userId, unit, action, true, `error: ${msg.slice(0, 200)}`, clientIp)
    // Authorized but the command itself failed: the caller must see this in the HTTP
    // status, not just a 200 body that happens to say "error".
    return { allowed: true, unit, action, failed: true, result: `error: ${msg.slice(0, 200)}`, auditId }
  }
}

async function isActive(unit: string): Promise<boolean | null> {
  try {
    const { stdout } = await serviceExec("systemctl", ["is-active", unit])
    return stdout.trim() === "active"
  } catch (e) {
    const stdout = (e as { stdout?: string }).stdout
    if (typeof stdout === "string" && stdout.trim()) return stdout.trim() === "active"
    return null
  }
}

let statusCache: { at: number; items: ServiceStatus[] } | null = null

/** Allowlist + current state, cached briefly so the panel can poll cheaply. */
export async function listServiceStatus(now = Date.now()): Promise<ServiceStatus[]> {
  if (statusCache && now - statusCache.at < STATUS_CACHE_MS) return statusCache.items
  const units = loadAllowlist()
  const items = await Promise.all(
    units.map(async (u) => ({
      unit: u.name,
      label: u.label,
      active: await isActive(u.name),
      allowedActions: u.allow,
      confirmActions: u.confirm ?? [],
    })),
  )
  statusCache = { at: now, items }
  return items
}

export function listAudit(
  db: Db,
  opts: {
    limit?: number
    unit?: string
    action?: string
    allowed?: number
    from?: number
    to?: number
  } = {},
) {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), 500)
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.unit) {
    where.push("unit = ?")
    params.push(opts.unit)
  }
  if (opts.action) {
    where.push("action = ?")
    params.push(opts.action)
  }
  if (opts.allowed === 0 || opts.allowed === 1) {
    where.push("allowed = ?")
    params.push(opts.allowed)
  }
  if (typeof opts.from === "number") {
    where.push("ts >= ?")
    params.push(opts.from)
  }
  if (typeof opts.to === "number") {
    where.push("ts <= ?")
    params.push(opts.to)
  }
  const sql =
    "SELECT id, ts, user_id, unit, action, allowed, result, client_ip FROM service_audit" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY id DESC LIMIT ?"
  params.push(limit)
  return db.prepare(sql).all(...params) as {
    id: number
    ts: number
    user_id: string | null
    unit: string
    action: string
    allowed: number
    result: string | null
    client_ip: string | null
  }[]
}

export function listLoginAudit(
  db: Db,
  opts: { limit?: number; ok?: number; from?: number; to?: number } = {},
) {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), 500)
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.ok === 0 || opts.ok === 1) {
    where.push("ok = ?")
    params.push(opts.ok)
  }
  if (typeof opts.from === "number") {
    where.push("ts >= ?")
    params.push(opts.from)
  }
  if (typeof opts.to === "number") {
    where.push("ts <= ?")
    params.push(opts.to)
  }
  const sql =
    "SELECT id, ts, username, ok, client_ip, user_agent FROM login_audit" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY id DESC LIMIT ?"
  params.push(limit)
  return db.prepare(sql).all(...params) as {
    id: number
    ts: number
    username: string
    ok: number
    client_ip: string | null
    user_agent: string | null
  }[]
}

export function listAuditUnits(db: Db): string[] {
  const rows = db.prepare("SELECT DISTINCT unit FROM service_audit ORDER BY unit").all() as { unit: string }[]
  return rows.map((r) => r.unit)
}

function needsConfirm(entry: AllowlistUnit, action: string): boolean {
  return !!entry.confirm?.includes(action)
}

export function writeAudit(
  db: Db,
  userId: string | null,
  unit: string,
  action: string,
  allowed: boolean,
  result: string,
  clientIp: string | null,
): number {
  const res = db
    .prepare(
      "INSERT INTO service_audit (ts, user_id, unit, action, allowed, result, client_ip) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(Date.now(), userId, unit, action, allowed ? 1 : 0, result, clientIp)
  return Number(res.lastInsertRowid)
}
