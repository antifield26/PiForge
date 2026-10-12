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
  unit: string
  action: ServiceAction
  allowed: boolean
  result: string
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
