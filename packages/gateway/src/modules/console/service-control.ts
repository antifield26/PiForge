import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto"
import type { ServiceAction, ServiceStatus } from "@piforge/shared"
import type { Db } from "../../db/index.js"
import { loadAllowlist, type AllowlistUnit } from "./allowlist.js"

const execFileAsync = promisify(execFile)

export interface ServiceControlResult {
  allowed: boolean
  requiresConfirm?: boolean
  confirmToken?: string
  unit: string
  action: ServiceAction
  active?: boolean
  result: string
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

/** Bound to unit + action + user, so a token cannot be replayed by another session. */
export function issueConfirmToken(unit: string, action: string, userId: string, now = Date.now()): string {
  const exp = now + CONFIRM_TTL_MS
  return `${exp}.${signConfirm(unit, action, userId, exp)}`
}

function signConfirm(unit: string, action: string, userId: string, exp: number): string {
  const payload = `${unit}|${action}|${userId}|${exp}`
  return createHmac("sha256", confirmSecret()).update(payload).digest("base64url").slice(0, 22)
}

export function verifyConfirmToken(
  unit: string,
  action: string,
  userId: string,
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token) return false
  const [expStr, sig] = token.split(".")
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < now || !sig) return false
  const expected = signConfirm(unit, action, userId, exp)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  return a.length === b.length && timingSafeEqual(a, b)
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
    if (!userId || !verifyConfirmToken(unit, action, userId, confirmToken)) {
      const token = userId ? issueConfirmToken(unit, action, userId) : undefined
      const auditId = writeAudit(db, userId, unit, action, false, "needs confirm", clientIp)
      return {
        allowed: true,
        requiresConfirm: true,
        confirmToken: token,
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

    await execFileAsync("sudo", ["systemctl", action, unit], { timeout: 15_000 })
    const auditId = writeAudit(db, userId, unit, action, true, "ok", clientIp)
    return { allowed: true, unit, action, result: "ok", auditId }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const auditId = writeAudit(db, userId, unit, action, true, `error: ${msg.slice(0, 200)}`, clientIp)
    return { allowed: true, unit, action, result: `error: ${msg.slice(0, 200)}`, auditId }
  }
}

async function isActive(unit: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["is-active", unit], { timeout: 5000 })
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

export function listAudit(db: Db, limit = 50) {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 500)
  return db
    .prepare(
      "SELECT id, ts, user_id, unit, action, allowed, result, client_ip FROM service_audit ORDER BY id DESC LIMIT ?",
    )
    .all(capped) as {
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

export function newConfirmSecret(): string {
  return randomBytes(32).toString("base64url")
}
