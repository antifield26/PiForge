import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type Db = DatabaseSync

/** Bump when `MIGRATIONS` gains an entry. Recorded in `PRAGMA user_version`. */
const SCHEMA_VERSION = 1

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // busy_timeout must precede journal_mode: switching to WAL takes a write lock, and without a
  // timeout a concurrent writer makes the very first statement fail with "database is locked".
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA foreign_keys = ON")
  migrate(db)
  return db
}

function migrate(db: Db) {
  const from = currentVersion(db)
  if (from > SCHEMA_VERSION) {
    throw new Error(`database schema v${from} is newer than this build understands (v${SCHEMA_VERSION})`)
  }
  db.exec(BASE_SCHEMA)
  for (let version = from; version < SCHEMA_VERSION; version += 1) {
    MIGRATIONS[version]?.(db)
    db.exec(`PRAGMA user_version = ${version + 1}`)
  }
  // After the migrations: this drops a table that no longer exists in BASE_SCHEMA, so it must not
  // run before the versioned steps (nothing depends on it, but the ordering is the contract).
  dropUnusedTables(db)
}

function currentVersion(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined
  const value = Number(row ? Object.values(row)[0] : 0)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

/**
 * Ordered, idempotent migrations. Index N moves user_version from N to N+1.
 * Never edit a shipped entry: append a new one.
 */
const MIGRATIONS: Record<number, (db: Db) => void> = {
  // v1: one row per (user, file name). The upload path is check-then-insert, so concurrent
  // requests for the same name used to create duplicate rows (each pointing at its own bytes).
  0: (db) => {
    dedupeCloudFiles(db)
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_files_user_path ON cloud_files(user_id, path)")
  },
}

/**
 * Collapse duplicate (user_id, path) rows before the unique index is built. The last inserted
 * row holds the youngest bytes, so its storage_key becomes authoritative; losing rows and the
 * superseded objects are left on disk rather than deleted, because a half-finished migration
 * that removes files is unrecoverable while orphaned bytes only cost space.
 */
function dedupeCloudFiles(db: Db) {
  const groups = db
    .prepare("SELECT user_id, path, COUNT(*) AS n FROM cloud_files GROUP BY user_id, path HAVING n > 1")
    .all() as { user_id: string; path: string; n: number }[]
  for (const group of groups) {
    const rows = db
      .prepare("SELECT id, storage_key FROM cloud_files WHERE user_id = ? AND path = ? ORDER BY created_at, rowid")
      .all(group.user_id, group.path) as { id: string; storage_key: string }[]
    const survivor = rows[rows.length - 1]
    const losers = rows.slice(0, -1)
    if (!survivor) continue
    for (const loser of losers) {
      db.prepare("UPDATE cloud_file_versions SET file_id = ? WHERE file_id = ?").run(survivor.id, loser.id)
      db.prepare("DELETE FROM cloud_files WHERE id = ?").run(loser.id)
    }
  }
}

const BASE_SCHEMA = `
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

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      read_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS login_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      username TEXT NOT NULL,
      ok INTEGER NOT NULL,
      client_ip TEXT,
      user_agent TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON service_audit(ts);
    CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics_points(ts);
    CREATE INDEX IF NOT EXISTS idx_versions_file ON cloud_file_versions(file_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(dedupe_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_login_audit_ts ON login_audit(ts);
`

/**
 * `agent_tasks` was created in P0 but no code path ever read or wrote it (the OpenCode session
 * list is the task view). Drop it from databases created before the fix — but only while empty,
 * so a manual insert can never be lost silently.
 *
 * The existence check goes through sqlite_master and the whole thing runs in one transaction:
 * a bare SELECT COUNT(*) against a missing table throws, which is indistinguishable from a real
 * error, and counting then dropping outside a transaction could swallow a concurrent insert.
 */
function dropUnusedTables(db: Db) {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_tasks'")
    .get() as { name: string } | undefined
  if (!exists) return
  db.exec("BEGIN IMMEDIATE")
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM agent_tasks").get() as { n: number }
    if (Number(row.n) === 0) db.exec("DROP TABLE agent_tasks")
    db.exec("COMMIT")
  } catch (err) {
    try {
      db.exec("ROLLBACK")
    } catch {
      /* already rolled back */
    }
    throw err
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

/**
 * Bounded retention for the append-only tables that nothing used to clean up. `login_audit` and
 * `service_audit` are attacker-reachable without a session (failed logins are recorded for any
 * username), so without this they grow forever at someone else's choosing.
 */
export function pruneAuditTables(db: Db, retentionDays: number, now = Date.now()): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0
  const cutoff = now - retentionDays * 24 * 3600_000
  let removed = 0
  removed += Number(db.prepare("DELETE FROM login_audit WHERE ts < ?").run(cutoff).changes)
  removed += Number(db.prepare("DELETE FROM service_audit WHERE ts < ?").run(cutoff).changes)
  removed += Number(db.prepare("DELETE FROM alerts WHERE created_at < ?").run(cutoff).changes)
  removed += Number(db.prepare("DELETE FROM backup_runs WHERE started_at < ?").run(cutoff).changes)
  return removed
}

export function checkpoint(db: Db): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } catch {
    /* best effort on shutdown */
  }
}
