import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { dirname, resolve } from "node:path"

/**
 * Refuse to run a second gateway against the same database.
 *
 * Background work (the 5s metrics sampler, the hourly SD row, the alert detector, the session
 * purge) is per-process, so a stray instance silently doubles the SD write rate. A `systemd-run`
 * copy left over from a manual test did that for hours on the Pi because nothing stopped it.
 *
 * The lock is advisory and based on a pidfile: a crash cannot release it, so a stale file whose
 * pid is no longer alive is reclaimed. Returns a function that removes the lock.
 */
export function acquireSingleInstanceLock(dbPath: string): () => void {
  const lockPath = resolve(dirname(dbPath), "gateway.lock")
  const existing = readLock(lockPath)
  if (existing !== null && isAlive(existing.pid)) {
    throw new Error(
      `another gateway is already running against ${dbPath} (pid ${existing.pid}); ` +
        `stop it first — two instances double the SD write rate`,
    )
  }

  const fd = openSync(lockPath, "w", 0o600)
  try {
    writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n${dbPath}\n`)
  } finally {
    closeSync(fd)
  }

  let released = false
  const release = () => {
    if (released) return
    released = true
    try {
      const current = readLock(lockPath)
      if (current === null || current.pid === process.pid) unlinkSync(lockPath)
    } catch {
      /* best effort: a missing lock file is already the desired state */
    }
  }
  process.on("exit", release)
  return release
}

function readLock(path: string): { pid: number } | null {
  if (!existsSync(path)) return null
  try {
    const pid = Number(readFileSync(path, "utf8").split("\n")[0]?.trim())
    return Number.isInteger(pid) && pid > 0 ? { pid } : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  if (pid === process.pid) return true // a lock bearing our own pid is one we still hold
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as { code?: string })?.code === "EPERM"
  }
}

/** Exported for tests. */
export const instanceLockInternals = { readLock, isAlive }
