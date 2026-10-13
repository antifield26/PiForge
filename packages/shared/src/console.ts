export interface SystemSnapshot {
  tempC: number
  load1: number
  memTotalKb: number
  memAvailableKb: number
  diskWriteBps: number
  /** lifetime SD writes, persisted across reboots (see docs/ARCHITECTURE.md §5) */
  sdTotalWriteBytes: number
  /** writes since the current boot, from /proc/diskstats */
  sdBootWriteBytes: number
  throttled: string
  uptimeSec: number
  capturedAt: number
}

export type MetricKind = "cpu" | "mem" | "temp" | "disk_write"

export interface MetricPoint {
  ts: number
  kind: MetricKind
  value: number
}

export interface ServiceStatus {
  unit: string
  label: string
  /** null when the state could not be determined */
  active: boolean | null
  allowedActions: string[]
  confirmActions: string[]
}

export type ServiceAction = "start" | "stop" | "restart" | "status"

export interface AuditEntry {
  id: number
  ts: number
  user_id: string | null
  unit: string
  action: string
  /** 0 = rejected, 1 = allowed (matches service_audit.allowed) */
  allowed: number
  result: string | null
  client_ip: string | null
}

export interface SdHealth {
  model: string
  /** lifetime estimate, persisted across reboots */
  totalWriteBytes: number
  /** writes since the current boot */
  bootWriteBytes: number
  dayWriteBytes: number
  estimateDaysLeft: number | null
  ratedTbwBytes: number
}

export interface MetricsSummary {
  kind: MetricKind
  count: number
  min?: number
  max?: number
  avg?: number
  last?: number
}

export type AlertKind = "backup_failed" | "service_down" | "sd_write_high" | "mem_low" | "limit_ineffective"

export type AlertSeverity = "info" | "warning" | "critical"

export interface Alert {
  id: number
  kind: AlertKind
  severity: AlertSeverity
  title: string
  message: string
  /** dedupe key: same key is not re-raised within the cooldown window */
  dedupeKey: string
  createdAt: number
  resolvedAt: number | null
  readAt: number | null
}

export interface AlertThresholds {
  /** SD writes per day (bytes) before sd_write_high fires */
  sdDayWriteBytes: number
  /** free memory (MB) before mem_low fires */
  memAvailableMb: number
  /** minutes to suppress repeat alerts with the same dedupeKey */
  cooldownMinutes: number
}

/** Best-effort SD write split between PiForge processes and the rest of the box (P4.1). */
export interface WriteAttribution {
  /** /proc/self/io write_bytes of the gateway; null when unreadable */
  gatewayWriteBytes: number | null
  /** /proc/<opencode-pid>/io write_bytes; null when no process or unreadable */
  openCodeWriteBytes: number | null
  /** last successful backup archive size */
  lastBackupBytes: number | null
  attributedBytes: number
  /** device-level day rate from the SD sampler */
  deviceDayWriteBytes: number
  /** device day rate minus attributedBytes (Minecraft/nginx/live here) */
  residualDayWriteBytes: number
  capturedAt: number
}

/** Whether systemd MemoryMax on opencode-serve is actually enforced (P4.3). */
export interface ResourceLimits {
  openCodeMemoryMaxBytes: number | null
  openCodeMemoryLimitEffective: boolean
  note: string
}
