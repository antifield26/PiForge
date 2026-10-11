#!/usr/bin/env node
// smoke: read system snapshot on the Pi
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

function temp() {
  try {
    const out = execFileSync("vcgencmd", ["measure_temp"], { encoding: "utf8" })
    return Number(/([0-9.]+)/.exec(out)?.[1] ?? 0)
  } catch {
    return Number(readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim()) / 1000
  }
}

function load() {
  return Number(readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/)[0])
}

function mem() {
  const raw = readFileSync("/proc/meminfo", "utf8")
  return {
    totalKb: Number(/MemTotal:\s+(\d+)/.exec(raw)?.[1] ?? 0),
    availableKb: Number(/MemAvailable:\s+(\d+)/.exec(raw)?.[1] ?? 0),
  }
}

function disk() {
  const raw = readFileSync("/proc/diskstats", "utf8")
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts[2] === "mmcblk0" && parts.length >= 10) {
      return Number(parts[9]) * 512
    }
  }
  return 0
}

function throttled() {
  try {
    return execFileSync("vcgencmd", ["get_throttled"], { encoding: "utf8" }).trim()
  } catch {
    return "unknown"
  }
}

const m = mem()
const d1 = disk()
await new Promise((r) => setTimeout(r, 2000))
const d2 = disk()
const out = {
  tempC: temp(),
  load1: load(),
  memTotalKb: m.totalKb,
  memAvailableKb: m.availableKb,
  diskWriteBps: ((d2 - d1) / 2),
  sdTotalWriteBytes: d2,
  throttled: throttled(),
}
console.log(JSON.stringify(out, null, 2))
