import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto"
import type { ServiceAction } from "@piforge/shared"
import type { Db } from "../../db/index.js"
import { loadAllowlist, needsConfirm, type AllowlistUnit } from "./allowlist.js"

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

const confirmSecret = () => process.env.SESSION_SECRET || "dev-only-change-me"
const CONFIRM_TTL_MS = 60_000

export function issueConfirmToken(unit: string, action: string): string {
  const exp = Date.now() + CONFIRM_TTL_MS
  const payload = `${unit}|${action}|${exp}`
  const sig = createHmac("sha256", confirmSecret()).update(payload).digest("base64url").slice(0, 16)
  return `${exp}.${sig}`
}

function verifyConfirmToken(unit: string, action: string, token: string | undefined): boolean {
  if (!token) return false
  const [expStr, sig] = token.split(".")
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const payload = `${unit}|${action}|${exp}`
  const expected = createHmac("sha256", confirmSecret()).update(payload).digest("base64url").slice(0, 16)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig ?? "")
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
  const allowlist = loadAllowlist()
  const entry: AllowlistUnit | undefined = allowlist.find((u) => u.name === unit)

  if (!entry) {
    const auditId = writeAudit(db, userId, unit, action, false, "rejected: not in allowlist", clientIp)
    return { allowed: false, unit, action, result: "rejected: not in allowlist", auditId }
  }

  if (!entry.allow.includes(action)) {
    const auditId = writeAudit(db, userId, unit, action, false, "rejected: action not allowed", clientIp)
    return { allowed: false, unit, action, result: "rejected: action not allowed", auditId }
  }

  if (needsConfirm(unit, action) && action !== "status") {
    if (!verifyConfirmToken(unit, action, confirmToken)) {
      const token = issueConfirmToken(unit, action)
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
      const { stdout } = await execFileAsync("systemctl", ["is-active", unit])
      const active = stdout.trim() === "active"
      const auditId = writeAudit(db, userId, unit, action, true, `active=${active}`, clientIp)
      return { allowed: true, unit, action, active, result: `active=${active}`, auditId }
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

export function listServiceStatus() {
  return loadAllowlist().map((u) => ({
    unit: u.name,
    label: u.label,
    allowedActions: u.allow,
    confirmActions: u.confirm ?? [],
  }))
}

export function listAudit(db: Db, limit = 50) {
  return db
    .prepare(
      "SELECT id, ts, user_id, unit, action, allowed, result, client_ip FROM service_audit ORDER BY id DESC LIMIT ?",
    )
    .all(limit) as {
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

function writeAudit(
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
