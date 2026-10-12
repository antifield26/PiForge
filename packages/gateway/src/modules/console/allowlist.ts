import { readFileSync, statSync } from "node:fs"

export interface AllowlistUnit {
  name: string
  label: string
  allow: string[]
  /** actions that require a one-time confirm token */
  confirm?: string[]
}

export const DEFAULT_ALLOWLIST_PATH = "/etc/piforge/services.allowlist.json"

let configuredPath: string | null = null
/** Fingerprint of the file the current cache was parsed from. */
let cachedFingerprint: string | null = null
let cachedUnits: AllowlistUnit[] = []

/** Bootstrap hands the resolved path in so route code never re-reads the environment. */
export function setAllowlistPath(path: string): void {
  configuredPath = path
}

export function allowlistPath(): string {
  return configuredPath ?? process.env.SERVICES_ALLOWLIST ?? DEFAULT_ALLOWLIST_PATH
}

/**
 * Parsed allowlist, re-read whenever the file changes. Re-reading on every route call was the
 * original behaviour (a syscall per request), while a plain time-based cache would keep serving a
 * stale rule for up to its TTL after an operator edits the file.
 */
export function loadAllowlist(): AllowlistUnit[] {
  const path = allowlistPath()
  const fingerprint = fingerprintOf(path)
  if (fingerprint !== null && fingerprint === cachedFingerprint) return cachedUnits

  let units: AllowlistUnit[] = []
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { units?: AllowlistUnit[] }
    units = Array.isArray(parsed.units)
      ? parsed.units.filter((u) => typeof u?.name === "string" && Array.isArray(u?.allow))
      : []
  } catch {
    // Failing closed (empty allowlist) is intentional: no config means no control.
    units = []
  }
  cachedUnits = units
  cachedFingerprint = fingerprint
  return units
}

function fingerprintOf(path: string): string | null {
  try {
    const stat = statSync(path)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return null
  }
}

/** Test/ops hook: forget the cached parse so the next call re-reads the file. */
export function resetAllowlistCache(): void {
  cachedFingerprint = null
  cachedUnits = []
}
