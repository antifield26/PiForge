#!/usr/bin/env node
// Record one PiForge backup run in wb.db (table backup_runs).
//
//   node scripts/backup-record.mjs --db /var/lib/piforge/wb.db --status ok \
//     --target /var/lib/piforge/backups/piforge/backup-20260101-031500 \
//     --bytes 123456 --checksum <sha256> --message "ok" [--started-at <epoch-ms>]
//
// Exits non-zero when the row could not be written. scripts/backup.sh treats that as
// non-fatal: an unrecorded backup is still a valid backup.
import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

const STATUSES = new Set(["ok", "partial", "failed"])

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  process.stderr.write(`backup-record: ${message}\n`)
  process.exit(1)
}

const dbPath = arg("db") ?? process.env.DB_PATH ?? "/var/lib/piforge/wb.db"
const status = arg("status") ?? "ok"
const target = arg("target") ?? ""
const message = arg("message") ?? ""
const checksum = arg("checksum") ?? null
const bytes = Number.parseInt(arg("bytes") ?? "", 10)
const startedAt = Number.parseInt(arg("started-at") ?? "", 10)

if (!STATUSES.has(status)) fail(`--status must be one of ${[...STATUSES].join(", ")} (got ${JSON.stringify(status)})`)
if (!existsSync(dbPath)) fail(`database not found: ${dbPath}`)

const finishedAt = Date.now()
const db = new DatabaseSync(dbPath)
try {
  db.exec("PRAGMA busy_timeout = 5000")
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backup_runs'").get()
  if (table === undefined) fail(`${dbPath} has no backup_runs table`)
  const result = db
    .prepare(
      "INSERT INTO backup_runs (started_at, finished_at, status, target, bytes, checksum, message) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      Number.isFinite(startedAt) ? startedAt : finishedAt,
      finishedAt,
      status,
      target,
      Number.isFinite(bytes) ? bytes : null,
      checksum === "" ? null : checksum,
      message === "" ? null : message,
    )
  process.stdout.write(
    `${JSON.stringify({ recorded: true, id: Number(result.lastInsertRowid), status, target, bytes: Number.isFinite(bytes) ? bytes : null })}\n`,
  )
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  db.close()
}
