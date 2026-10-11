import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFileSync } from "node:fs"
import type { MetricKind, MetricPoint, SdHealth, SystemSnapshot } from "@piforge/shared"
import type { Db } from "../../db/index.js"

const execFileAsync = promisify(execFile)

let lastDisk: { sectors: number; at: number } | null = null

export async function readSnapshot(): Promise<SystemSnapshot> {
  const [tempC, load1, mem, disk, throttled, uptimeSec] = await Promise.all([
    readTemp(),
    readLoad(),
    readMem(),
    readDiskWrite(),
    readThrottled(),
    readUptime(),
  ])
  return {
    tempC,
    load1,
    memTotalKb: mem.totalKb,
    memAvailableKb: mem.availableKb,
    diskWriteBps: disk.bps,
    sdTotalWriteBytes: disk.totalBytes,
    throttled,
    uptimeSec,
    capturedAt: Date.now(),
  }
}

export async function readSdHealth(): Promise<SdHealth> {
  let model = "unknown"
  try {
    model = readFileSync("/sys/block/mmcblk0/device/name", "utf8").trim()
  } catch {
    /* non-linux or missing */
  }
  const disk = await readDiskWrite()
  // Rough estimate: assume current daily rate continues; SD consumer cards often rated ~100 TBW for 64GB class
  const dayWriteBytes = estimateDayWrite(disk.totalBytes)
  const ratedTbW = 100 * 1024 ** 4
  const estimateDaysLeft = dayWriteBytes > 0 ? (ratedTbW - disk.totalBytes) / dayWriteBytes : null
  return {
    model,
    totalWriteBytes: disk.totalBytes,
    dayWriteBytes,
    estimateDaysLeft: estimateDaysLeft && estimateDaysLeft > 0 ? Math.round(estimateDaysLeft) : null,
  }
}

const dayWriteSamples: { at: number; total: number }[] = []

function estimateDayWrite(totalBytes: number): number {
  const now = Date.now()
  dayWriteSamples.push({ at: now, total: totalBytes })
  // keep 24h of samples
  while (dayWriteSamples.length > 2 && now - dayWriteSamples[0].at > 86400_000) {
    dayWriteSamples.shift()
  }
  if (dayWriteSamples.length < 2) return 0
  const first = dayWriteSamples[0]
  const last = dayWriteSamples[dayWriteSamples.length - 1]
  const dtMs = last.at - first.at
  if (dtMs <= 0) return 0
  return ((last.total - first.total) / dtMs) * 86400_000
}

export function recordMetrics(db: Db, snap: SystemSnapshot): void {
  const rows: MetricPoint[] = [
    { ts: snap.capturedAt, kind: "cpu", value: snap.load1 },
    {
      ts: snap.capturedAt,
      kind: "mem",
      value: 1 - snap.memAvailableKb / Math.max(snap.memTotalKb, 1),
    },
    { ts: snap.capturedAt, kind: "temp", value: snap.tempC },
    { ts: snap.capturedAt, kind: "disk_write", value: snap.diskWriteBps },
  ]
  const stmt = db.prepare("INSERT OR REPLACE INTO metrics_points (ts, kind, value) VALUES (?, ?, ?)")
  for (const r of rows) stmt.run(r.ts, r.kind, r.value)
}

export function queryMetrics(db: Db, kind: MetricKind, from: number, to: number): MetricPoint[] {
  const rows = db
    .prepare("SELECT ts, kind, value FROM metrics_points WHERE kind = ? AND ts >= ? AND ts <= ? ORDER BY ts")
    .all(kind, from, to) as { ts: number; kind: string; value: number }[]
  return rows.map((r) => ({ ts: r.ts, kind: r.kind as MetricKind, value: r.value }))
}

async function readTemp(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("vcgencmd", ["measure_temp"])
    const m = stdout.match(/([0-9.]+)/)
    return m ? Number(m[1]) : 0
  } catch {
    try {
      const raw = readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8")
      return Number(raw.trim()) / 1000
    } catch {
      return 0
    }
  }
}

async function readLoad(): Promise<number> {
  try {
    const raw = readFileSync("/proc/loadavg", "utf8")
    return Number(raw.trim().split(/\s+/)[0] ?? 0)
  } catch {
    return 0
  }
}

async function readMem(): Promise<{ totalKb: number; availableKb: number }> {
  try {
    const raw = readFileSync("/proc/meminfo", "utf8")
    const total = /MemTotal:\s+(\d+)/.exec(raw)?.[1]
    const avail = /MemAvailable:\s+(\d+)/.exec(raw)?.[1]
    return { totalKb: Number(total ?? 0), availableKb: Number(avail ?? 0) }
  } catch {
    return { totalKb: 0, availableKb: 0 }
  }
}

async function readDiskWrite(): Promise<{ bps: number; totalBytes: number }> {
  try {
    const raw = readFileSync("/proc/diskstats", "utf8")
    // field 10 (1-based) is sectors written for the device
    let sectors = 0
    for (const line of raw.split("\n")) {
      const parts = line.trim().split(/\s+/)
      if (parts[2] === "mmcblk0" && parts.length >= 10) {
        sectors = Number(parts[9])
        break
      }
    }
    const totalBytes = sectors * 512
    const now = Date.now()
    let bps = 0
    if (lastDisk) {
      const dt = (now - lastDisk.at) / 1000
      if (dt > 0) bps = ((sectors - lastDisk.sectors) * 512) / dt
    }
    lastDisk = { sectors, at: now }
    return { bps: Math.max(0, bps), totalBytes }
  } catch {
    return { bps: 0, totalBytes: 0 }
  }
}

async function readThrottled(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("vcgencmd", ["get_throttled"])
    return stdout.trim().split("=")[1] ?? "0x0"
  } catch {
    return "unknown"
  }
}

async function readUptime(): Promise<number> {
  try {
    const raw = readFileSync("/proc/uptime", "utf8")
    return Math.floor(Number(raw.trim().split(/\s+/)[0] ?? 0))
  } catch {
    return 0
  }
}
