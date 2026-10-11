export interface SystemSnapshot {
  tempC: number
  load1: number
  memTotalKb: number
  memAvailableKb: number
  diskWriteBps: number
  sdTotalWriteBytes: number
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
  active: boolean
  allowedActions: string[]
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
  totalWriteBytes: number
  dayWriteBytes: number
  estimateDaysLeft: number | null
}
