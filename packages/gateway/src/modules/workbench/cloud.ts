import type { FastifyPluginAsync } from "fastify"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, stat, unlink, writeFile, readFile } from "node:fs/promises"
import { createReadStream, existsSync } from "node:fs"
import { join, basename, extname } from "node:path"
import type { SQLInputValue } from "node:sqlite"
import { requireAuth } from "../auth/routes.js"
import type { Db } from "../../db/index.js"

interface WbApp {
  db: Db
}

type Param = SQLInputValue

function storageRoot() {
  return process.env.CLOUD_STORAGE_DIR || "./data/cloud"
}

function safeName(name: string) {
  return basename(name).replace(/[^\w.\-一-鿿]+/g, "_").slice(0, 120) || "file"
}

export const cloudRoutes: FastifyPluginAsync = async (app) => {
  // ---- Bookmarks ----
  app.get<{ Querystring: { q?: string; folder?: string } }>("/bookmarks", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as unknown as WbApp).db
    const q = req.query.q?.trim()
    const folder = req.query.folder?.trim()
    let sql = "SELECT id, url, title, folder, created_at FROM bookmarks WHERE user_id = ?"
    const params: Param[] = [auth.userId]
    if (q) {
      sql += " AND (url LIKE ? OR title LIKE ?)"
      params.push(`%${q}%`, `%${q}%`)
    }
    if (folder) {
      sql += " AND folder = ?"
      params.push(folder)
    }
    sql += " ORDER BY created_at DESC LIMIT 200"
    const rows = db.prepare(sql).all(...params) as {
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
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const url = req.body?.url?.trim()
    if (!url) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "url required" } })
    const db = (app as unknown as WbApp).db
    const id = randomUUID()
    const ts = Date.now()
    db.prepare("INSERT INTO bookmarks (id, user_id, url, title, folder, created_at) VALUES (?,?,?,?,?,?)").run(
      id,
      auth.userId,
      url,
      req.body?.title ?? null,
      req.body?.folder ?? null,
      ts,
    )
    return reply.code(201).send({
      id,
      url,
      title: req.body?.title ?? null,
      folder: req.body?.folder ?? null,
      createdAt: ts,
    })
  })

  app.delete<{ Params: { id: string } }>("/bookmarks/:id", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as unknown as WbApp).db
    const res = db.prepare("DELETE FROM bookmarks WHERE id = ? AND user_id = ?").run(req.params.id, auth.userId)
    if (Number(res.changes) === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "not found" } })
    return reply.code(204).send()
  })

  // ---- Cloud files ----
  app.get("/files", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as unknown as WbApp).db
    const rows = db
      .prepare(
        "SELECT id, path, size, mime, storage_key, created_at FROM cloud_files WHERE user_id = ? ORDER BY created_at DESC LIMIT 200",
      )
      .all(auth.userId) as {
      id: string
      path: string
      size: number
      mime: string | null
      storage_key: string
      created_at: number
    }[]
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.path,
        size: r.size,
        mime: r.mime,
        createdAt: r.created_at,
      })),
    }
  })

  app.post("/files", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const body = req.body as { name?: string; contentBase64?: string; mime?: string } | undefined
    const name = body?.name?.trim()
    const contentBase64 = body?.contentBase64
    if (!name || !contentBase64) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "name and contentBase64 required" } })
    }
    const buf = Buffer.from(contentBase64, "base64")
    if (buf.length > 20 * 1024 * 1024) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "file too large (max 20MB)" } })
    }
    const db = (app as unknown as WbApp).db
    const safe = safeName(name)
    const ts = Date.now()

    // version existing file with same name
    const existing = db
      .prepare("SELECT id, storage_key, size FROM cloud_files WHERE user_id = ? AND path = ?")
      .get(auth.userId, safe) as { id: string; storage_key: string; size: number } | undefined

    if (existing) {
      const vid = randomUUID()
      db.prepare(
        "INSERT INTO cloud_file_versions (id, file_id, user_id, size, storage_key, created_at) VALUES (?,?,?,?,?,?)",
      ).run(vid, existing.id, auth.userId, existing.size, existing.storage_key, ts)
      await writeFile(join(storageRoot(), existing.storage_key + ".v" + vid.slice(0, 8)), buf)
      // keep new content in current key
      await writeFile(join(storageRoot(), existing.storage_key), buf)
      db.prepare("UPDATE cloud_files SET size = ?, mime = ?, created_at = ? WHERE id = ?").run(
        buf.length,
        body?.mime ?? null,
        ts,
        existing.id,
      )
      return reply.code(201).send({
        id: existing.id,
        name: safe,
        size: buf.length,
        mime: body?.mime ?? null,
        createdAt: ts,
        versioned: true,
      })
    }

    const id = randomUUID()
    const key = `${auth.userId}/${id}${extname(safe)}`
    const root = storageRoot()
    await mkdir(join(root, auth.userId), { recursive: true })
    await writeFile(join(root, key), buf)
    db.prepare(
      "INSERT INTO cloud_files (id, user_id, path, size, mime, storage_key, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, auth.userId, safe, buf.length, body?.mime ?? null, key, ts)
    return reply.code(201).send({ id, name: safe, size: buf.length, mime: body?.mime ?? null, createdAt: ts })
  })

  app.get<{ Params: { id: string } }>("/files/:id/versions", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as unknown as WbApp).db
    const rows = db
      .prepare(
        "SELECT id, size, created_at FROM cloud_file_versions WHERE file_id = ? AND user_id = ? ORDER BY created_at DESC",
      )
      .all(req.params.id, auth.userId) as { id: string; size: number; created_at: number }[]
    return {
      items: rows.map((r) => ({ id: r.id, size: r.size, createdAt: r.created_at })),
    }
  })

  app.get<{ Params: { id: string } }>("/files/:id", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as unknown as WbApp).db
    const row = db
      .prepare("SELECT storage_key, path, mime FROM cloud_files WHERE id = ? AND user_id = ?")
      .get(req.params.id, auth.userId) as { storage_key: string; path: string; mime: string | null } | undefined
    if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "file not found" } })
    const full = join(storageRoot(), row.storage_key)
    if (!existsSync(full)) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "missing on disk" } })
    reply.header("content-type", row.mime || "application/octet-stream")
    reply.header("content-disposition", `attachment; filename="${encodeURIComponent(row.path)}"`)
    return reply.send(createReadStream(full))
  })

  app.delete<{ Params: { id: string } }>("/files/:id", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as unknown as WbApp).db
    const row = db
      .prepare("SELECT storage_key FROM cloud_files WHERE id = ? AND user_id = ?")
      .get(req.params.id, auth.userId) as { storage_key: string } | undefined
    if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "file not found" } })
    try {
      await unlink(join(storageRoot(), row.storage_key))
    } catch {
      /* ignore */
    }
    db.prepare("DELETE FROM cloud_files WHERE id = ? AND user_id = ?").run(req.params.id, auth.userId)
    return reply.code(204).send()
  })
}
