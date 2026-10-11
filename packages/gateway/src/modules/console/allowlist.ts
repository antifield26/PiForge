import { readFileSync } from "node:fs"

export interface AllowlistUnit {
  name: string
  label: string
  allow: string[]
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
