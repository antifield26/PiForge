import { readFileSync } from "node:fs"

export interface AllowlistUnit {
  name: string
  label: string
  allow: string[]
  /** actions that require a one-time confirm token */
  confirm?: string[]
}

export const DEFAULT_ALLOWLIST_PATH = "/etc/piforge/services.allowlist.json"

let configuredPath: string | null = null

/** Bootstrap hands the resolved path in so route code never re-reads the environment. */
export function setAllowlistPath(path: string): void {
  configuredPath = path
}

export function allowlistPath(): string {
  return configuredPath ?? process.env.SERVICES_ALLOWLIST ?? DEFAULT_ALLOWLIST_PATH
}

export function loadAllowlist(): AllowlistUnit[] {
  try {
    const parsed = JSON.parse(readFileSync(allowlistPath(), "utf8")) as { units?: AllowlistUnit[] }
    return Array.isArray(parsed.units)
      ? parsed.units.filter((u) => typeof u?.name === "string" && Array.isArray(u?.allow))
      : []
  } catch {
    // Failing closed (empty allowlist) is intentional: no config means no control.
    return []
  }
}

export function findUnit(unit: string): AllowlistUnit | undefined {
  return loadAllowlist().find((u) => u.name === unit)
}

export function needsConfirm(unit: string, action: string): boolean {
  const u = findUnit(unit)
  return !!u?.confirm?.includes(action)
}
