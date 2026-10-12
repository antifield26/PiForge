import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFileSync } from "node:fs"
import type { MetricKind, MetricPoint, SdHealth, SystemSnapshot } from "@piforge/shared"
import { getSettingNumber, setSetting, type Db } from "../../db/index.js"

const execFileAsync = promisify(execFile)

const SD_DEVICE = process.env.SD_DEVICE ?? "mmcblk0"
/** Consumer 64GB-class cards are typically rated ~100 TBW; override per card when known. */
const RATED_TBW_BYTES = Number(process.env.SD_RATED_TBW_BYTES ?? 100 * 1024 ** 4)
const WRITE_SETTING_PERSIST_MS = 5 * 60 * 1000
/** Persist early when a lot has been written, so a reboot cannot lose much. */
const WRITE_SETTING_PERSIST_DELTA = 64 * 1024 * 1024
const MIN_RATE_WINDOW_MS = 10 * 60 * 1000
const ROTATE_WINDOW_MS = 24 * 3600 * 1000

let lastPersistAt = 0
/**
 * Day-write rate, kept in memory. The HTTP read paths (`/console/sd`, `/console/perf`) and the
 * 60s alert detector must not write to the SD card just to display a number, so only the 5-minute
 * flush recomputes and persists it. Until the first flush this is 0 rather than a DB read.
 */
let dayWriteCache = 0

export interface LifecycleInput {
  /** Bytes written since boot, straight from /proc/diskstats. */
  bootBytes: number
  /** Bytes/second right now; needs a previous sample, so it is 0 until the second read. */
  bps: number
}

/** Read-only view of the machine. Never writes to the database. */
export async function readSnapshot(_db: Db): Promise<SystemSnapshot> {
  const [tempC, load1, mem, disk, throttled, uptimeSec] = await Promise.all([
    readTemp(),
    readLoad(),
    readMem(),
    readDiskWrite(),
    readThrottled(),
    readUptime(),
  ])
  const { lifetime, boot } = accountWritesView(disk.bootBytes)
  return {
    tempC,
    load1,
    memTotalKb: mem.totalKb,
    memAvailableKb: mem.availableKb,
    diskWriteBps: disk.bps,
    sdTotalWriteBytes: lifetime,
    sdBootWriteBytes: boot,
    throttled,
    uptimeSec,
    capturedAt: Date.now(),
  }
}

/** Read-only SD view for the console; `dayWriteBytes` comes from the last flush. */
export async function readSdHealth(_db: Db): Promise<SdHealth> {
  const disk = await readDiskWrite()
  const { lifetime, boot } = accountWritesView(disk.bootBytes)
  const remaining = RATED_TBW_BYTES - lifetime
  return {
    model: sdModel(),
    totalWriteBytes: lifetime,
    bootWriteBytes: boot,
    dayWriteBytes: dayWriteCache,
    estimateDaysLeft: dayWriteCache > 0 && remaining > 0 ? Math.round(remaining / dayWriteCache) : null,
    ratedTbwBytes: RATED_TBW_BYTES,
  }
}

function sdModel(): string {
  try {
    return readFileSync(`/sys/block/${SD_DEVICE}/device/name`, "utf8").trim()
  } catch {
    return "unknown"
  }
}

/**
 * /proc/diskstats counters reset on every boot, so a raw read is NOT a lifetime figure.
 * We persist the boot counter and fold it into an accumulator when a reboot is detected.
 *
 * Split into a mutating persist step and a pure view: the sampler calls `accountWrites`
 * (which may write), while HTTP read paths call the returned lifetime figure only.
 */
export function accountWrites(db: Db, bootBytes: number, now = Date.now()): { lifetime: number; boot: number } {
  const accum = getSettingNumber(db, "sd_write_accum") ?? 0
  const last = getSettingNumber(db, "sd_write_boot")
  // Keep the read-path mirror in step with whatever this call decided, so a poll after a
  // reboot fold reports the folded total instead of a stale pre-fold one.
  persistedAccum = accum

  if (last === null || bootBytes < last) {
    const folded = last ?? 0
    const nextAccum = accum + folded
    setSetting(db, "sd_write_accum", String(nextAccum))
    setSetting(db, "sd_write_boot", String(bootBytes))
    persistedAccum = nextAccum
    lastPersistAt = now
    return { lifetime: nextAccum + bootBytes, boot: bootBytes }
  }

  if (now - lastPersistAt > WRITE_SETTING_PERSIST_MS || bootBytes - last > WRITE_SETTING_PERSIST_DELTA) {
    setSetting(db, "sd_write_boot", String(bootBytes))
    lastPersistAt = now
  }
  return { lifetime: accum + bootBytes, boot: bootBytes }
}

/** In-memory mirror of the fold, so a console poll does not have to touch the database. */
function accountWritesView(bootBytes: number): { lifetime: number; boot: number } {
  return { lifetime: persistedAccum + bootBytes, boot: bootBytes }
}

let persistedAccum = 0

/** Once at startup: load the accumulator so views are correct before the first flush. */
export function primeWriteAccumulator(db: Db): void {
  persistedAccum = getSettingNumber(db, "sd_write_accum") ?? 0
  dayWriteCache = getSettingNumber(db, "sd_rate_day") ?? 0
}

/**
 * The 5-minute flush path: fold the boot counter, refresh the day-write estimate and persist.
 * Returns the SD view so the caller can store an hourly history row without a second read.
 */
export async function persistWriteCounters(db: Db, now = Date.now()): Promise<SdHealth> {
  const disk = await readDiskWrite()
  const { lifetime } = accountWrites(db, disk.bootBytes, now)
  dayWriteCache = estimateDayWrite(db, lifetime, now)
  return readSdHealth(db)
}

/** Smoothed daily write rate from a persisted baseline (survives restarts). */
function estimateDayWrite(db: Db, lifetimeBytes: number, now = Date.now()): number {
  const baseTs = getSettingNumber(db, "sd_rate_ts")
  const baseTotal = getSettingNumber(db, "sd_rate_total")

  if (baseTs === null || baseTotal === null || lifetimeBytes < baseTotal) {
    setSetting(db, "sd_rate_ts", String(now))
    setSetting(db, "sd_rate_total", String(lifetimeBytes))
    return 0
  }

  const elapsed = now - baseTs
  if (elapsed < MIN_RATE_WINDOW_MS) {
    return getSettingNumber(db, "sd_rate_day") ?? 0
  }

  const perDay = ((lifetimeBytes - baseTotal) / elapsed) * 86_400_000
  setSetting(db, "sd_rate_day", String(perDay))
  if (elapsed >= ROTATE_WINDOW_MS) {
    setSetting(db, "sd_rate_ts", String(now))
    setSetting(db, "sd_rate_total", String(lifetimeBytes))
  }
  return perDay
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

/** One durable row per hour keeps SD health history without the write cost of per-sample rows. */
export function recordSdHealth(db: Db, sd: SdHealth, now = Date.now()): void {
  const bucket = Math.floor(now / 3600_000) * 3600_000
  db.prepare(
    "INSERT OR REPLACE INTO sd_health (ts, total_write_bytes, day_write_bytes, estimate_days_left) VALUES (?, ?, ?, ?)",
  ).run(bucket, Math.round(sd.totalWriteBytes), Math.round(sd.dayWriteBytes), sd.estimateDaysLeft)
}

export function queryMetrics(db: Db, kind: MetricKind, from: number, to: number, limit = 20_000): MetricPoint[] {
  const rows = db
    .prepare("SELECT ts, kind, value FROM metrics_points WHERE kind = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT ?")
    .all(kind, from, to, limit) as { ts: number; kind: string; value: number }[]
  return rows.map((r) => ({ ts: r.ts, kind: r.kind as MetricKind, value: r.value }))
}

/** Total rows in a window, ignoring the display limit, so callers can report truncation. */
export function countMetrics(db: Db, kind: MetricKind, from: number, to: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM metrics_points WHERE kind = ? AND ts >= ? AND ts <= ?")
    .get(kind, from, to) as { n: number }
  return Number(row.n)
}

async function readTemp(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("vcgencmd", ["measure_temp"], { timeout: 4000 })
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

let lastDisk: { sectors: number; at: number } | null = null

export async function readDiskWrite(): Promise<{ bps: number; bootBytes: number }> {
  try {
    const raw = readFileSync("/proc/diskstats", "utf8")
    // /proc/diskstats: field 10 (1-based) is sectors written for the device.
    let sectors = 0
    for (const line of raw.split("\n")) {
      const parts = line.trim().split(/\s+/)
      if (parts[2] === SD_DEVICE && parts.length >= 10) {
        sectors = Number(parts[9])
        break
      }
    }
    const bootBytes = sectors * 512
    const now = Date.now()
    let bps = 0
    if (lastDisk) {
      const dt = (now - lastDisk.at) / 1000
      if (dt > 0) bps = ((sectors - lastDisk.sectors) * 512) / dt
    }
    lastDisk = { sectors, at: now }
    return { bps: Math.max(0, bps), bootBytes }
  } catch {
    return { bps: 0, bootBytes: 0 }
  }
}

async function readThrottled(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("vcgencmd", ["get_throttled"], { timeout: 4000 })
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
