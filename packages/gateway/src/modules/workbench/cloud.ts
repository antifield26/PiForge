import type { FastifyPluginAsync } from "fastify"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { createReadStream, existsSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { requireAuth } from "../auth/routes.js"
import { createRateLimiter } from "../../auth/ratelimit.js"
import { asOptionalString, asTrimmedString, isHttpUrl, likeContains, sendError } from "../../util/validate.js"
import { clientIp } from "../../util/net.js"
import type { Db } from "../../db/index.js"

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_VERSIONS_PER_FILE = 10
/** Base64 inflates by 4/3; reject on the wire size before allocating the decoded buffer. */
const MAX_BASE64_CHARS = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4
const LIST_LIMIT = 200

export const cloudRoutes: FastifyPluginAsync = async (app) => {
  const storageRoot = () => app.config.cloudStorageDir
  // Authenticated but unbounded: each upload decodes up to 20 MiB and writes it to the SD card.
  const uploadLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 })

  // ---- Bookmarks ----
  app.get<{ Querystring: { q?: string; folder?: string } }>("/bookmarks", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const q = asTrimmedString(req.query.q, 200)
    const folder = asTrimmedString(req.query.folder, 120)
    let sql = "SELECT id, url, title, folder, created_at FROM bookmarks WHERE user_id = ?"
    const params: (string | number)[] = [auth.userId]
    if (q) {
      sql += " AND (url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')"
      params.push(likeContains(q), likeContains(q))
    }
    if (folder) {
      sql += " AND folder = ?"
      params.push(folder)
    }
    sql += " ORDER BY created_at DESC LIMIT 200"
    const rows = app.db.prepare(sql).all(...params) as {
      id: string
      url: string
      title: string | null
      folder: string | null
      created_at: number
    }[]
    return {
      items: rows.map((r) => ({
        id: r.id,
        url: r.url,
        title: r.title,
        folder: r.folder,
        createdAt: r.created_at,
      })),
    }
  })

  app.post<{ Body: { url?: string; title?: string; folder?: string } }>("/bookmarks", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const url = asTrimmedString(req.body?.url, 2000)
    if (!url) return sendError(reply, 400, "BAD_REQUEST", "url required")
    if (!isHttpUrl(url)) return sendError(reply, 400, "BAD_REQUEST", "only http/https urls are allowed")
    const title = asTrimmedString(req.body?.title, 300)
    const folder = asTrimmedString(req.body?.folder, 120)
    const id = randomUUID()
    const ts = Date.now()
    app.db
      .prepare("INSERT INTO bookmarks (id, user_id, url, title, folder, created_at) VALUES (?,?,?,?,?,?)")
      .run(id, auth.userId, url, title, folder, ts)
    return reply.code(201).send({ id, url, title, folder, createdAt: ts })
  })

  app.delete<{ Params: { id: string } }>("/bookmarks/:id", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const res = app.db.prepare("DELETE FROM bookmarks WHERE id = ? AND user_id = ?").run(req.params.id, auth.userId)
    if (Number(res.changes) === 0) return sendError(reply, 404, "NOT_FOUND", "not found")
    return reply.code(204).send()
  })

  // ---- Cloud files ----
  app.get("/files", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const rows = app.db
      .prepare(
        `SELECT f.id, f.path, f.size, f.mime, f.created_at,
                (SELECT COUNT(*) FROM cloud_file_versions v WHERE v.file_id = f.id) AS versions
         FROM cloud_files f WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 200`,
      )
      .all(auth.userId) as {
      id: string
      path: string
      size: number
      mime: string | null
      created_at: number
      versions: number
    }[]
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.path,
        size: r.size,
        mime: r.mime,
        versions: Number(r.versions),
        createdAt: r.created_at,
      })),
    }
  })

  app.post<{ Body: { name?: string; contentBase64?: string; mime?: string } }>(
    "/files",
    { bodyLimit: app.config.uploadBodyLimitBytes },
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
      const budget = uploadLimiter.consume(auth.userId)
      if (!budget.allowed) {
        reply.header("retry-after", String(budget.retryAfterSec))
        return sendError(reply, 429, "RATE_LIMITED", `too many uploads, retry in ${budget.retryAfterSec}s`)
      }
      const name = asTrimmedString(req.body?.name, 120)
      const contentBase64 = req.body?.contentBase64
      if (!name || typeof contentBase64 !== "string" || !contentBase64) {
        return sendError(reply, 400, "BAD_REQUEST", "name and contentBase64 required")
      }
      // Size is checked on the encoded length BEFORE decoding: a 1 GiB body must not be turned
      // into a 750 MiB Buffer just to be rejected afterwards.
      if (contentBase64.length > MAX_BASE64_CHARS) {
        return sendError(reply, 400, "BAD_REQUEST", "file too large (max 20MB)")
      }
      const mime = asOptionalString(req.body?.mime, 120)
      const safe = safeName(name)
      const ts = Date.now()
      const root = storageRoot()
      const id = randomUUID()
      // Always write the incoming bytes to a fresh key first. Concurrent uploads of the same name
      // used to race on SELECT-then-INSERT and each create their own row; the unique index added
      // in schema v1 now makes the loser of that race overwrite the winner's row instead.
      const key = fileKey(auth.userId, id, safe)
      await mkdir(join(root, auth.userId), { recursive: true })
      const buf = Buffer.from(contentBase64, "base64")
      if (buf.length === 0) return sendError(reply, 400, "BAD_REQUEST", "empty file")
      if (buf.length > MAX_UPLOAD_BYTES) {
        return sendError(reply, 400, "BAD_REQUEST", "file too large (max 20MB)")
      }
      await writeAtomic(join(root, key), buf)

      const existing = findFile(app.db, auth.userId, safe)

      if (existing) {
        await replaceFile(app.db, root, existing.id, existing.storage_key, auth.userId, key, buf, mime, ts)
        return reply.code(201).send({ id: existing.id, name: safe, size: buf.length, mime, createdAt: ts, versioned: true })
      }

      try {
        app.db
          .prepare("INSERT INTO cloud_files (id, user_id, path, size, mime, storage_key, created_at) VALUES (?,?,?,?,?,?,?)")
          .run(id, auth.userId, safe, buf.length, mime, key, ts)
      } catch (err) {
        // Lost the race against a concurrent upload of the same name: the unique index means the
        // row exists now, so treat this as the overwrite case instead of failing the request.
        await removeQuietly(join(root, key))
        const winner = findFile(app.db, auth.userId, safe)
        if (!winner) throw err
        const retryKey = fileKey(auth.userId, randomUUID(), safe)
        await writeAtomic(join(root, retryKey), buf)
        await replaceFile(app.db, root, winner.id, winner.storage_key, auth.userId, retryKey, buf, mime, ts)
        return reply.code(201).send({ id: winner.id, name: safe, size: buf.length, mime, createdAt: ts, versioned: true })
      }
      return reply.code(201).send({ id, name: safe, size: buf.length, mime, createdAt: ts })
    },
  )

  app.get<{ Params: { id: string } }>("/files/:id/versions", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const rows = app.db
      .prepare(
        "SELECT id, size, created_at FROM cloud_file_versions WHERE file_id = ? AND user_id = ? ORDER BY created_at DESC",
      )
      .all(req.params.id, auth.userId) as { id: string; size: number; created_at: number }[]
    return { items: rows.map((r) => ({ id: r.id, size: r.size, createdAt: r.created_at })) }
  })

  app.get<{ Params: { id: string; vid: string } }>("/files/:id/versions/:vid", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const row = app.db
      .prepare(
        `SELECT v.storage_key, v.size, f.path FROM cloud_file_versions v
         JOIN cloud_files f ON f.id = v.file_id
         WHERE v.id = ? AND v.file_id = ? AND v.user_id = ?`,
      )
      .get(req.params.vid, req.params.id, auth.userId) as { storage_key: string; size: number; path: string } | undefined
    if (!row) return sendError(reply, 404, "NOT_FOUND", "version not found")
    const full = join(storageRoot(), row.storage_key)
    if (!existsSync(full)) return sendError(reply, 404, "NOT_FOUND", "version missing on disk")
    reply.header("content-type", "application/octet-stream")
    reply.header("content-disposition", contentDisposition(`v-${row.path}`))
    return reply.send(createReadStream(full))
  })

  app.get<{ Params: { id: string } }>("/files/:id", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const row = app.db
      .prepare("SELECT storage_key, path, mime FROM cloud_files WHERE id = ? AND user_id = ?")
      .get(req.params.id, auth.userId) as { storage_key: string; path: string; mime: string | null } | undefined
    if (!row) return sendError(reply, 404, "NOT_FOUND", "file not found")
    const full = join(storageRoot(), row.storage_key)
    if (!existsSync(full)) return sendError(reply, 404, "NOT_FOUND", "missing on disk")
    reply.header("content-type", row.mime || "application/octet-stream")
    reply.header("content-disposition", contentDisposition(row.path))
    return reply.send(createReadStream(full))
  })

  app.delete<{ Params: { id: string } }>("/files/:id", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const row = app.db
      .prepare("SELECT storage_key FROM cloud_files WHERE id = ? AND user_id = ?")
      .get(req.params.id, auth.userId) as { storage_key: string } | undefined
    if (!row) return sendError(reply, 404, "NOT_FOUND", "file not found")
    const versions = app.db
      .prepare("SELECT storage_key FROM cloud_file_versions WHERE file_id = ? AND user_id = ?")
      .all(req.params.id, auth.userId) as { storage_key: string }[]
    for (const v of [...versions, row]) await removeQuietly(join(storageRoot(), v.storage_key))
    app.db.prepare("DELETE FROM cloud_file_versions WHERE file_id = ? AND user_id = ?").run(req.params.id, auth.userId)
    app.db.prepare("DELETE FROM cloud_files WHERE id = ? AND user_id = ?").run(req.params.id, auth.userId)
    return reply.code(204).send()
  })
}

function findFile(db: Db, userId: string, path: string): { id: string; storage_key: string } | undefined {
  return db
    .prepare("SELECT id, storage_key FROM cloud_files WHERE user_id = ? AND path = ?")
    .get(userId, path) as { id: string; storage_key: string } | undefined
}

/**
 * Point an existing row at freshly written bytes, keeping the replaced bytes as a version.
 * The caller has already written `newKey`, so a failure here can leave the object unreferenced
 * (wasted space) but never loses the file the user had.
 */
async function replaceFile(
  db: Db,
  root: string,
  fileId: string,
  oldKey: string,
  userId: string,
  newKey: string,
  buf: Buffer,
  mime: string | null,
  ts: number,
): Promise<void> {
  const versionId = randomUUID()
  const versionKey = `${oldKey}.v${versionId}`
  try {
    const previous = await readFile(join(root, oldKey))
    await writeFile(join(root, versionKey), previous, { mode: 0o600 })
    db.prepare(
      "INSERT INTO cloud_file_versions (id, file_id, user_id, size, storage_key, created_at) VALUES (?,?,?,?,?,?)",
    ).run(versionId, fileId, userId, previous.length, versionKey, ts)
  } catch {
    // Missing current file: nothing to preserve, keep the overwrite going.
  }
  db.prepare("UPDATE cloud_files SET storage_key = ?, size = ?, mime = ?, created_at = ? WHERE id = ?").run(
    newKey,
    buf.length,
    mime,
    ts,
    fileId,
  )
  await pruneVersions(db, root, fileId)
}

/** `encodeURIComponent` output is inert for a quoted header, but CR/LF must never reach it. */
function contentDisposition(filename: string): string {
  const safe = encodeURIComponent(filename).replace(/[\r\n]/g, "")
  return `attachment; filename="${safe}"`
}

function fileKey(userId: string, id: string, safeNameValue: string): string {
  return `${userId}/${id}${extname(safeNameValue)}`
}

/** Write via tmp + rename so a crash cannot leave a truncated file behind. */
async function writeAtomic(path: string, buf: Buffer): Promise<void> {
  const tmp = `${path}.tmp-${randomUUID()}`
  await writeFile(tmp, buf, { mode: 0o600 })
  await rename(tmp, path)
}

function safeName(name: string): string {
  return basename(name).replace(/[^\w.\-一-鿿]+/g, "_").slice(0, 120) || "file"
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    /* already gone */
  }
}

/**
 * Bound version history so an overwrite loop cannot fill the SD card.
 *
 * `created_at` is a millisecond timestamp, so an overwrite burst can produce rows that all share
 * one value. Ordering by it alone is then decided by scan order, and the tail slice removed the
 * NEWEST versions while keeping the oldest. `rowid` is the deterministic insert order.
 */
async function pruneVersions(db: Db, root: string, fileId: string): Promise<void> {
  const rows = db
    .prepare("SELECT id, storage_key FROM cloud_file_versions WHERE file_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(fileId) as { id: string; storage_key: string }[]
  for (const stale of rows.slice(MAX_VERSIONS_PER_FILE)) {
    await removeQuietly(join(root, stale.storage_key))
    db.prepare("DELETE FROM cloud_file_versions WHERE id = ?").run(stale.id)
  }
}

export const cloudInternals = { safeName, fileKey, MAX_UPLOAD_BYTES, MAX_VERSIONS_PER_FILE }
