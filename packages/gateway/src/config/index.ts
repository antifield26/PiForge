export interface GatewayConfig {
  host: string
  port: number
  sessionSecret: string
  openCodeUrl: string
  logLevel: string
  dbPath: string
  servicesAllowlistPath: string
}

export function loadConfig(): GatewayConfig {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 8787),
    sessionSecret: process.env.SESSION_SECRET ?? "dev-only-change-me",
    openCodeUrl: process.env.OPENCODE_URL ?? "http://127.0.0.1:4096",
    logLevel: process.env.LOG_LEVEL ?? "info",
    dbPath: process.env.DB_PATH ?? "./data/wb.db",
    servicesAllowlistPath: process.env.SERVICES_ALLOWLIST ?? "./config/services.allowlist.json",
  }
}
