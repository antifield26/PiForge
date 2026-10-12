import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type Db = DatabaseSync

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  migrate(db)
  return db
}

function migrate(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      due_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      folder TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cloud_files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT,
      storage_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cloud_file_versions (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      size INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metrics_points (
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      value REAL NOT NULL,
      PRIMARY KEY (ts, kind)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS service_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id TEXT,
      unit TEXT NOT NULL,
      action TEXT NOT NULL,
      allowed INTEGER NOT NULL,
      result TEXT,
      client_ip TEXT
    );

    CREATE TABLE IF NOT EXISTS backup_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      target TEXT NOT NULL,
      bytes INTEGER,
      checksum TEXT,
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS sd_health (
      ts INTEGER PRIMARY KEY,
      total_write_bytes INTEGER NOT NULL,
      day_write_bytes INTEGER NOT NULL,
      estimate_days_left REAL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON service_audit(ts);
    CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics_points(ts);
    CREATE INDEX IF NOT EXISTS idx_versions_file ON cloud_file_versions(file_id);
  `)

  dropUnusedTables(db)
}

/**
 * `agent_tasks` was created in P0 but no code path ever read or wrote it (the OpenCode session
 * list is the task view). Drop it from databases created before the fix — but only while empty,
 * so a manual insert can never be lost silently.
 */
function dropUnusedTables(db: Db) {
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM agent_tasks").get() as { n: number } | undefined
    if (row && Number(row.n) === 0) db.exec("DROP TABLE agent_tasks")
  } catch {
    /* table already gone */
  }
}

export function pragmaInfo(db: Db, name: string): string {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  if (!row) return ""
  const vals = Object.values(row)
  return String(vals[0] ?? "")
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  )
}

export function getSettingNumber(db: Db, key: string): number | null {
  const raw = getSetting(db, key)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Drop metric points older than the retention window; returns rows removed. */
export function pruneMetrics(db: Db, retentionDays: number, now = Date.now()): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0
  const cutoff = now - retentionDays * 24 * 3600_000
  const res = db.prepare("DELETE FROM metrics_points WHERE ts < ?").run(cutoff)
  return Number(res.changes)
}

/** Keep sd_health bounded: one row per hour, retention in days. */
export function pruneSdHealth(db: Db, retentionDays = 365, now = Date.now()): number {
  const cutoff = now - retentionDays * 24 * 3600_000
  const res = db.prepare("DELETE FROM sd_health WHERE ts < ?").run(cutoff)
  return Number(res.changes)
}

export function checkpoint(db: Db): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } catch {
    /* best effort on shutdown */
  }
}
