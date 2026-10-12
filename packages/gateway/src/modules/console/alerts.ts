import type { Alert, AlertKind, AlertSeverity, AlertThresholds } from "@piforge/shared"
import type { Db } from "../../db/index.js"
import { getSetting, setSetting } from "../../db/index.js"
import { listServiceStatus } from "./service-control.js"

const DEFAULT_THRESHOLDS: AlertThresholds = {
  // ~1.5 GB/day is well under the measured ~1.2 GB/day whole-box baseline; alert when
  // the workbench's own SD write budget is clearly blown.
  sdDayWriteBytes: 500 * 1024 * 1024,
  memAvailableMb: 256,
  cooldownMinutes: 30,
}

const THRESHOLD_SETTINGS = {
  sdDayWriteBytes: "alerts.sd_day_write_bytes",
  memAvailableMb: "alerts.mem_available_mb",
  cooldownMinutes: "alerts.cooldown_minutes",
} as const

export function getThresholds(db: Db): AlertThresholds {
  return {
    sdDayWriteBytes: numSetting(db, THRESHOLD_SETTINGS.sdDayWriteBytes, DEFAULT_THRESHOLDS.sdDayWriteBytes),
    memAvailableMb: numSetting(db, THRESHOLD_SETTINGS.memAvailableMb, DEFAULT_THRESHOLDS.memAvailableMb),
    cooldownMinutes: numSetting(db, THRESHOLD_SETTINGS.cooldownMinutes, DEFAULT_THRESHOLDS.cooldownMinutes),
  }
}

export function setThresholds(db: Db, input: Partial<AlertThresholds>): AlertThresholds {
  const current = getThresholds(db)
  const next: AlertThresholds = { ...current }
  if (input.sdDayWriteBytes !== undefined) {
    if (!Number.isFinite(input.sdDayWriteBytes) || input.sdDayWriteBytes <= 0) {
      throw new Error("sdDayWriteBytes must be a positive number")
    }
    next.sdDayWriteBytes = Math.trunc(input.sdDayWriteBytes)
    setSetting(db, THRESHOLD_SETTINGS.sdDayWriteBytes, String(next.sdDayWriteBytes))
  }
  if (input.memAvailableMb !== undefined) {
    if (!Number.isFinite(input.memAvailableMb) || input.memAvailableMb <= 0) {
      throw new Error("memAvailableMb must be a positive number")
    }
    next.memAvailableMb = Math.trunc(input.memAvailableMb)
    setSetting(db, THRESHOLD_SETTINGS.memAvailableMb, String(next.memAvailableMb))
  }
  if (input.cooldownMinutes !== undefined) {
    if (!Number.isFinite(input.cooldownMinutes) || input.cooldownMinutes < 1) {
      throw new Error("cooldownMinutes must be >= 1")
    }
    next.cooldownMinutes = Math.trunc(input.cooldownMinutes)
    setSetting(db, THRESHOLD_SETTINGS.cooldownMinutes, String(next.cooldownMinutes))
  }
  return next
}

function numSetting(db: Db, key: string, fallback: number): number {
  const raw = getSetting(db, key)
  if (raw == null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface RaiseAlertInput {
  kind: AlertKind
  severity: AlertSeverity
  title: string
  message: string
  dedupeKey: string
  now?: number
}

/**
 * Insert an alert unless the same dedupeKey already fired inside the cooldown window.
 * Returns the new row id, or null when suppressed.
 */
export function raiseAlert(db: Db, input: RaiseAlertInput): number | null {
  const now = input.now ?? Date.now()
  const cooldownMs = getThresholds(db).cooldownMinutes * 60_000
  const recent = db
    .prepare("SELECT id FROM alerts WHERE dedupe_key = ? AND created_at > ? ORDER BY id DESC LIMIT 1")
    .get(input.dedupeKey, now - cooldownMs) as { id: number } | undefined
  if (recent) return null
  const res = db
    .prepare(
      `INSERT INTO alerts (kind, severity, title, message, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.kind, input.severity, input.title, input.message, input.dedupeKey, now)
  return Number(res.lastInsertRowid)
}

export function listAlerts(db: Db, opts: { limit?: number; unreadOnly?: boolean } = {}): Alert[] {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), 200)
  const sql = opts.unreadOnly
    ? `SELECT id, kind, severity, title, message, dedupe_key AS dedupeKey, created_at AS createdAt,
              resolved_at AS resolvedAt, read_at AS readAt
       FROM alerts WHERE read_at IS NULL ORDER BY id DESC LIMIT ?`
    : `SELECT id, kind, severity, title, message, dedupe_key AS dedupeKey, created_at AS createdAt,
              resolved_at AS resolvedAt, read_at AS readAt
       FROM alerts ORDER BY id DESC LIMIT ?`
  return db.prepare(sql).all(limit) as unknown as Alert[]
}

export function countUnreadAlerts(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE read_at IS NULL").get() as { n: number }
  return Number(row.n)
}

export function markAlertsRead(db: Db, ids: number[] | "all", now = Date.now()): number {
  if (ids === "all") {
    return Number(db.prepare("UPDATE alerts SET read_at = ? WHERE read_at IS NULL").run(now).changes)
  }
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => "?").join(",")
  return Number(
    db
      .prepare(`UPDATE alerts SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders})`)
      .run(now, ...ids).changes,
  )
}

export function resolveAlert(db: Db, id: number, now = Date.now()): boolean {
  return Number(db.prepare("UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL").run(now, id).changes) > 0
}

/** Webhook is optional and configured only via environment (never stored in the DB). */
export function webhookUrl(): string | null {
  const url = process.env.ALERT_WEBHOOK_URL?.trim()
  return url ? url : null
}

export async function deliverAlert(alert: { title: string; message: string; severity: string }): Promise<void> {
  const url = webhookUrl()
  if (!url) return
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "piforge",
        title: alert.title,
        message: alert.message,
        severity: alert.severity,
        ts: Date.now(),
      }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // One retry, then give up: the workbench notification is the source of truth.
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "piforge", title: alert.title, message: alert.message, severity: alert.severity, ts: Date.now() }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      /* leave a trail in the caller's log if they care */
    }
  }
}

export interface DetectionInput {
  /** latest backup status: ok | partial | failed | running | null when never ran */
  lastBackupStatus: string | null
  /** latest sd_health day write bytes */
  sdDayWriteBytes: number
  /** mem available in MB */
  memAvailableMb: number
  now?: number
}

export interface DetectionResult {
  raised: number[]
  serviceDown: string[]
}

/**
 * Evaluate the rule set and raise deduped alerts. Safe to call on a timer.
 */
export async function runDetectors(db: Db, input: DetectionInput): Promise<DetectionResult> {
  const now = input.now ?? Date.now()
  const thresholds = getThresholds(db)
  const raised: number[] = []
  const serviceDown: string[] = []

  if (input.lastBackupStatus === "failed" || input.lastBackupStatus === "partial") {
    const id = raiseAlert(db, {
      kind: "backup_failed",
      severity: input.lastBackupStatus === "failed" ? "critical" : "warning",
      title: input.lastBackupStatus === "failed" ? "备份失败" : "备份不完整",
      message:
        input.lastBackupStatus === "failed"
          ? "最近一次备份失败，请检查 piforge-backup.service 与磁盘空间。"
          : "最近一次备份为 partial：部分数据源不可读，不能当作完整备份。",
      dedupeKey: `backup:${input.lastBackupStatus}`,
      now,
    })
    if (id != null) raised.push(id)
  }

  try {
    const services = await listServiceStatus()
    for (const s of services) {
      if (s.active === false) {
        serviceDown.push(s.unit)
        const id = raiseAlert(db, {
          kind: "service_down",
          severity: "critical",
          title: `服务未运行：${s.label || s.unit}`,
          message: `单元 ${s.unit} 当前不是 active 状态。`,
          dedupeKey: `service:${s.unit}`,
          now,
        })
        if (id != null) raised.push(id)
      }
    }
  } catch {
    /* status collection failed; skip rather than alert on the collector itself */
  }

  if (input.sdDayWriteBytes > thresholds.sdDayWriteBytes) {
    const id = raiseAlert(db, {
      kind: "sd_write_high",
      severity: "warning",
      title: "SD 日写入超阈值",
      message: `当前日写入约 ${Math.round(input.sdDayWriteBytes / 1024 / 1024)} MB，阈值 ${Math.round(thresholds.sdDayWriteBytes / 1024 / 1024)} MB。`,
      dedupeKey: "sd:day_write",
      now,
    })
    if (id != null) raised.push(id)
  }

  if (input.memAvailableMb < thresholds.memAvailableMb) {
    const id = raiseAlert(db, {
      kind: "mem_low",
      severity: "warning",
      title: "可用内存不足",
      message: `当前可用约 ${Math.round(input.memAvailableMb)} MB，阈值 ${thresholds.memAvailableMb} MB。`,
      dedupeKey: "mem:low",
      now,
    })
    if (id != null) raised.push(id)
  }

  return { raised, serviceDown }
}
