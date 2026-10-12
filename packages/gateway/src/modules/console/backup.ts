import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Db } from "../../db/index.js"

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 10 * 60 * 1000

export interface BackupRunResult {
  id: number
  status: "ok" | "partial" | "failed"
  target: string
  message: string
}

/**
 * Runs the backup script for a UI-triggered run. The script records its own
 * backup_runs row, so we pass PIFORGE_SKIP_RECORD=1 and let this route own the row —
 * that keeps one row per run for both the timer and the UI path.
 *
 * The gateway runs as piforge-gw, which cannot read /etc/piforge/opencode.env or the
 * OpenCode tree; the script reports that as PARTIAL instead of pretending it succeeded.
 */
export async function runBackup(db: Db, scriptPath: string): Promise<BackupRunResult> {
  const startedAt = Date.now()
  const target = process.env.BACKUP_TARGET ?? "local:/var/lib/piforge/backups/piforge"

  try {
    const { stdout } = await execFileAsync("bash", [scriptPath], {
      timeout: TIMEOUT_MS,
      env: { ...process.env, PIFORGE_SKIP_RECORD: "1" },
    })
    const lines = stdout.trim().split("\n")
    const message = lines.filter((l) => l.startsWith("[backup]")).slice(-1)[0] ?? "backup completed"
    const status = stdout.includes("[backup] PARTIAL") ? "partial" : "ok"
    return { id: recordRun(db, startedAt, status, target, message), status, target, message }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    const message = detail.slice(0, 400)
    return { id: recordRun(db, startedAt, "failed", target, message), status: "failed", target, message }
  }
}

function recordRun(
  db: Db,
  startedAt: number,
  status: "ok" | "partial" | "failed",
  target: string,
  message: string,
): number {
  const res = db
    .prepare("INSERT INTO backup_runs (started_at, finished_at, status, target, message) VALUES (?, ?, ?, ?, ?)")
    .run(startedAt, Date.now(), status, target, message)
  return Number(res.lastInsertRowid)
}
