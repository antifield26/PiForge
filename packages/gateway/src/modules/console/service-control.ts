import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ServiceAction } from "@piforge/shared"
import type { Db } from "../../db/index.js"
import { loadAllowlist, type AllowlistUnit } from "./allowlist.js"

const execFileAsync = promisify(execFile)

export interface ServiceControlResult {
  allowed: boolean
  unit: string
  action: ServiceAction
  active?: boolean
  result: string
  auditId?: number
}

export async function controlService(
  db: Db,
  unit: string,
  action: ServiceAction,
  userId: string | null,
  clientIp: string | null,
): Promise<ServiceControlResult> {
  const allowlist = loadAllowlist()
  const entry = findUnit(allowlist, unit)

  if (!entry) {
    const auditId = writeAudit(db, userId, unit, action, false, "rejected: not in allowlist", clientIp)
    return { allowed: false, unit, action, result: "rejected: not in allowlist", auditId }
  }

  if (!entry.allow.includes(action)) {
    const auditId = writeAudit(db, userId, unit, action, false, "rejected: action not allowed", clientIp)
    return { allowed: false, unit, action, result: "rejected: action not allowed", auditId }
  }

  try {
    if (action === "status") {
      const { stdout } = await execFileAsync("systemctl", ["is-active", unit])
      const active = stdout.trim() === "active"
      const auditId = writeAudit(db, userId, unit, action, true, `active=${active}`, clientIp)
      return { allowed: true, unit, action, active, result: `active=${active}`, auditId }
    }

    await execFileAsync("systemctl", [action, unit], { timeout: 15_000 })
    const auditId = writeAudit(db, userId, unit, action, true, "ok", clientIp)
    return { allowed: true, unit, action, result: "ok", auditId }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const auditId = writeAudit(db, userId, unit, action, true, `error: ${msg.slice(0, 200)}`, clientIp)
    return { allowed: true, unit, action, result: `error: ${msg.slice(0, 200)}`, auditId }
  }
}

export function listServiceStatus(db: Db) {
  return loadAllowlist().map((u) => ({ unit: u.name, label: u.label, allowedActions: u.allow }))
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

function findUnit(list: AllowlistUnit[], unit: string): AllowlistUnit | undefined {
  return list.find((u) => u.name === unit)
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
