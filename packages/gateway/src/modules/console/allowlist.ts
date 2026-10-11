import { readFileSync } from "node:fs"

export interface AllowlistUnit {
  name: string
  label: string
  allow: string[]
  /** actions that require a one-time confirm token */
  confirm?: string[]
}

export function loadAllowlist(): AllowlistUnit[] {
  const path = process.env.SERVICES_ALLOWLIST ?? "./config/services.allowlist.json"
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { units?: AllowlistUnit[] }
    return parsed.units ?? []
  } catch {
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
