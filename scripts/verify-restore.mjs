#!/usr/bin/env node
// Verify a PiForge wb.db, typically a restored copy: PRAGMA integrity_check plus the
// expected core tables. Every value is bound or compared in JS — no SQL string
// interpolation. Prints one JSON object and exits 1 on any failure.
//
//   node scripts/verify-restore.mjs <wb.db>
import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

// Tables every backup must contain (present since P0).
const REQUIRED_TABLES = [
  "users",
  "sessions",
  "todos",
  "notes",
  "bookmarks",
  "cloud_files",
  "metrics_points",
  "service_audit",
  "backup_runs",
]

// Tables added later. A backup taken before the change legitimately lacks them, and the gateway
// migrates on start, so a missing one is reported but is not a drill failure.
const ADVISORY_TABLES = ["cloud_file_versions", "sd_health", "settings"]

function report(result, code) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(code)
}

const dbPath = process.argv[2]
if (dbPath === undefined) {
  process.stderr.write("usage: node verify-restore.mjs <wb.db>\n")
  process.exit(1)
}

if (!existsSync(dbPath)) {
  report({ ok: false, db: dbPath, error: "file not found" }, 1)
}

let db
try {
  db = new DatabaseSync(dbPath, { readOnly: true })
} catch (error) {
  report({ ok: false, db: dbPath, error: `cannot open: ${error instanceof Error ? error.message : String(error)}` }, 1)
}

let integrity = "unknown"
let journalMode = "unknown"
let tables = []
try {
  const integrityRow = db.prepare("PRAGMA integrity_check").get()
  integrity = String(integrityRow?.integrity_check ?? "unknown")
  const journalRow = db.prepare("PRAGMA journal_mode").get()
  journalMode = String(journalRow?.journal_mode ?? "unknown")
  tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name))
} catch (error) {
  db.close()
  report({ ok: false, db: dbPath, error: `query failed: ${error instanceof Error ? error.message : String(error)}` }, 1)
}
db.close()

const missing = REQUIRED_TABLES.filter((name) => !tables.includes(name))
const missingAdvisory = ADVISORY_TABLES.filter((name) => !tables.includes(name))
const ok = integrity === "ok" && missing.length === 0
report(
  {
    ok,
    db: dbPath,
    integrity_check: integrity,
    journal_mode: journalMode,
    required_tables: REQUIRED_TABLES,
    missing_tables: missing,
    missing_advisory_tables: missingAdvisory,
    tables,
  },
  ok ? 0 : 1,
)
