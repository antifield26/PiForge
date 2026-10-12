import type { FastifyPluginAsync } from "fastify"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { createReadStream, existsSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { requireAuth } from "../auth/routes.js"
import { asOptionalString, asTrimmedString, isHttpUrl, sendError } from "../../util/validate.js"
import type { Db } from "../../db/index.js"

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_VERSIONS_PER_FILE = 10

export const cloudRoutes: FastifyPluginAsync = async (app) => {
  const storageRoot = () => app.config.cloudStorageDir

  // ---- Bookmarks ----
  app.get<{ Querystring: { q?: string; folder?: string } }>("/bookmarks", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const q = asTrimmedString(req.query.q, 200)
    const folder = asTrimmedString(req.query.folder, 120)
    let sql = "SELECT id, url, title, folder, created_at FROM bookmarks WHERE user_id = ?"
    const params: (string | number)[] = [auth.userId]
    if (q) {
      sql += " AND (url LIKE ? OR title LIKE ?)"
      params.push(`%${q}%`, `%${q}%`)
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
      const name = asTrimmedString(req.body?.name, 120)
      const contentBase64 = req.body?.contentBase64
      if (!name || typeof contentBase64 !== "string" || !contentBase64) {
        return sendError(reply, 400, "BAD_REQUEST", "name and contentBase64 required")
      }
      const buf = Buffer.from(contentBase64, "base64")
      if (buf.length === 0) return sendError(reply, 400, "BAD_REQUEST", "empty file")
      if (buf.length > MAX_UPLOAD_BYTES) {
        return sendError(reply, 400, "BAD_REQUEST", "file too large (max 20MB)")
      }
      const mime = asOptionalString(req.body?.mime, 120)
      const safe = safeName(name)
      const ts = Date.now()
      const root = storageRoot()

      const existing = app.db
        .prepare("SELECT id, storage_key, size FROM cloud_files WHERE user_id = ? AND path = ?")
        .get(auth.userId, safe) as { id: string; storage_key: string; size: number } | undefined

      if (existing) {
        // Preserve the CURRENT bytes as a version before overwriting them.
        const versionId = randomUUID()
        const versionKey = `${existing.storage_key}.v${versionId}`
        const currentPath = join(root, existing.storage_key)
        try {
          const previous = await readFile(currentPath)
          await writeFile(join(root, versionKey), previous, { mode: 0o600 })
          app.db
            .prepare(
              "INSERT INTO cloud_file_versions (id, file_id, user_id, size, storage_key, created_at) VALUES (?,?,?,?,?,?)",
            )
            .run(versionId, existing.id, auth.userId, previous.length, versionKey, ts)
        } catch {
          // Missing current file: nothing to preserve, keep the overwrite going.
        }

        await writeFile(currentPath, buf, { mode: 0o600 })
        app.db
          .prepare("UPDATE cloud_files SET size = ?, mime = ?, created_at = ? WHERE id = ?")
          .run(buf.length, mime, ts, existing.id)
        await pruneVersions(app.db, root, existing.id)
        return reply.code(201).send({ id: existing.id, name: safe, size: buf.length, mime, createdAt: ts, versioned: true })
      }

      const id = randomUUID()
      const key = fileKey(auth.userId, id, safe)
      await mkdir(join(root, auth.userId), { recursive: true })
      await writeFile(join(root, key), buf, { mode: 0o600 })
      app.db
        .prepare("INSERT INTO cloud_files (id, user_id, path, size, mime, storage_key, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, auth.userId, safe, buf.length, mime, key, ts)
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
    reply.header("content-disposition", `attachment; filename="${encodeURIComponent(`v-${row.path}`)}"`)
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
    reply.header("content-disposition", `attachment; filename="${encodeURIComponent(row.path)}"`)
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

function fileKey(userId: string, id: string, safeNameValue: string): string {
  return `${userId}/${id}${extname(safeNameValue)}`
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

/** Bound version history so an overwrite loop cannot fill the SD card. */
async function pruneVersions(db: Db, root: string, fileId: string): Promise<void> {
  const rows = db
    .prepare("SELECT id, storage_key FROM cloud_file_versions WHERE file_id = ? ORDER BY created_at DESC")
    .all(fileId) as { id: string; storage_key: string }[]
  for (const stale of rows.slice(MAX_VERSIONS_PER_FILE)) {
    await removeQuietly(join(root, stale.storage_key))
    db.prepare("DELETE FROM cloud_file_versions WHERE id = ?").run(stale.id)
  }
}

export const cloudInternals = { safeName, fileKey, MAX_UPLOAD_BYTES, MAX_VERSIONS_PER_FILE }
