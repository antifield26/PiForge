export interface GatewayConfig {
  host: string
  port: number
  sessionSecret: string
  openCodeUrl: string
  openCodeUser: string
  openCodePassword: string
  logLevel: string
  dbPath: string
  cloudStorageDir: string
  servicesAllowlistPath: string
  backupScript: string
  jsonBodyLimitBytes: number
  uploadBodyLimitBytes: number
  metricsRetentionDays: number
  auditRetentionDays: number
  sessionPurgeIntervalMs: number
  webDist: string
}

const DEV_SECRET = "dev-only-change-me"
/** 20 MiB of binary data, base64-encoded (4/3) plus JSON overhead. */
const UPLOAD_LIMIT_BYTES = 32 * 1024 * 1024

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const production = env.NODE_ENV === "production"
  const sessionSecret = env.SESSION_SECRET?.trim()
  if (production && (!sessionSecret || sessionSecret === DEV_SECRET)) {
    throw new Error("SESSION_SECRET must be set to a unique value in production")
  }
  if (production && !env.OPENCODE_PASSWORD) {
    throw new Error("OPENCODE_PASSWORD must be set in production")
  }

  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8787),
    sessionSecret: sessionSecret || DEV_SECRET,
    openCodeUrl: env.OPENCODE_URL ?? "http://127.0.0.1:4096",
    openCodeUser: env.OPENCODE_USER ?? "opencode",
    openCodePassword: env.OPENCODE_PASSWORD ?? "",
    logLevel: env.LOG_LEVEL ?? "info",
    dbPath: env.DB_PATH ?? "./data/wb.db",
    cloudStorageDir: env.CLOUD_STORAGE_DIR ?? "./data/cloud",
    servicesAllowlistPath: env.SERVICES_ALLOWLIST ?? "./config/services.allowlist.json",
    backupScript: env.BACKUP_SCRIPT ?? "/home/antifield/piforge/scripts/backup.sh",
    jsonBodyLimitBytes: Number(env.JSON_BODY_LIMIT ?? 1024 * 1024),
    uploadBodyLimitBytes: Number(env.UPLOAD_BODY_LIMIT ?? UPLOAD_LIMIT_BYTES),
    metricsRetentionDays: Number(env.METRICS_RETENTION_DAYS ?? 30),
    auditRetentionDays: Number(env.AUDIT_RETENTION_DAYS ?? 180),
    sessionPurgeIntervalMs: 60 * 60 * 1000,
    webDist: env.WEB_DIST ?? "apps/web/dist",
  }
}
