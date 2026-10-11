import type { FastifyPluginAsync } from "fastify"
import { randomUUID } from "node:crypto"
import type { SQLInputValue } from "node:sqlite"
import { requireAuth } from "../auth/routes.js"
import type { Db } from "../../db/index.js"

interface WbApp {
  db: Db
}

type Param = SQLInputValue

function now() {
  return Date.now()
}

function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export const workbenchRoutes: FastifyPluginAsync = async (app) => {
  // ---- Todos ----
  app.get<{ Querystring: { q?: string; status?: string } }>("/todos", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as unknown as WbApp).db
    const q = req.query.q?.trim()
    const status = req.query.status
    let sql = "SELECT id, title, notes, status, due_at, created_at, updated_at FROM todos WHERE user_id = ?"
    const params: Param[] = [auth.userId]
    if (status) {
      sql += " AND status = ?"
      params.push(status)
    }
    if (q) {
      sql += " AND (title LIKE ? OR notes LIKE ?)"
      params.push(`%${q}%`, `%${q}%`)
    }
    sql += " ORDER BY updated_at DESC LIMIT 200"
    const rows = db.prepare(sql).all(...params) as {
      id: string
      title: string
      notes: string | null
      status: string
      due_at: number | null
      created_at: number
      updated_at: number
    }[]
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        notes: r.notes,
        status: r.status,
        dueAt: r.due_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    }
  })

  app.post<{ Body: { title?: string; notes?: string; status?: string; dueAt?: number } }>(
    "/todos",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
      const title = req.body?.title?.trim()
      if (!title) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "title required" } })
      const db = (app as unknown as WbApp).db
      const id = randomUUID()
      const ts = now()
      db.prepare(
        "INSERT INTO todos (id, user_id, title, notes, status, due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(id, auth.userId, title, req.body?.notes ?? null, req.body?.status ?? "open", req.body?.dueAt ?? null, ts, ts)
      return reply.code(201).send({
        id,
        title,
        notes: req.body?.notes ?? null,
        status: req.body?.status ?? "open",
        dueAt: req.body?.dueAt ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
    },
  )

  app.patch<{ Params: { id: string }; Body: { title?: string; notes?: string; status?: string; dueAt?: number | null } }>(
    "/todos/:id",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
      const db = (app as unknown as WbApp).db
      const existing = db
        .prepare("SELECT id FROM todos WHERE id = ? AND user_id = ?")
        .get(req.params.id, auth.userId) as { id: string } | undefined
      if (!existing) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "todo not found" } })

      const fields: string[] = []
      const params: Param[] = []
      if (req.body?.title !== undefined) {
        fields.push("title = ?")
        params.push(req.body.title)
      }
      if (req.body?.notes !== undefined) {
        fields.push("notes = ?")
        params.push(req.body.notes)
      }
      if (req.body?.status !== undefined) {
        fields.push("status = ?")
        params.push(req.body.status)
      }
      if (req.body?.dueAt !== undefined) {
        fields.push("due_at = ?")
        params.push(req.body.dueAt)
      }
      fields.push("updated_at = ?")
      params.push(now())
      params.push(req.params.id, auth.userId)
      db.prepare(`UPDATE todos SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...params)

      const row = db
        .prepare("SELECT id, title, notes, status, due_at, created_at, updated_at FROM todos WHERE id = ?")
        .get(req.params.id) as {
        id: string
        title: string
        notes: string | null
        status: string
        due_at: number | null
        created_at: number
        updated_at: number
      }
      return {
        id: row.id,
        title: row.title,
        notes: row.notes,
        status: row.status,
        dueAt: row.due_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    },
  )

  app.delete<{ Params: { id: string } }>("/todos/:id", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as unknown as WbApp).db
    const res = db.prepare("DELETE FROM todos WHERE id = ? AND user_id = ?").run(req.params.id, auth.userId)
    if (Number(res.changes) === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "todo not found" } })
    return reply.code(204).send()
  })

  // ---- Notes ----
  app.get<{ Querystring: { q?: string; tag?: string } }>("/notes", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as unknown as WbApp).db
    const q = req.query.q?.trim()
    const tag = req.query.tag?.trim()
    let sql = "SELECT id, title, body, tags, created_at, updated_at FROM notes WHERE user_id = ?"
    const params: Param[] = [auth.userId]
    if (q) {
      sql += " AND (title LIKE ? OR body LIKE ?)"
      params.push(`%${q}%`, `%${q}%`)
    }
    sql += " ORDER BY updated_at DESC LIMIT 200"
    const rows = db.prepare(sql).all(...params) as {
      id: string
      title: string
      body: string
      tags: string | null
      created_at: number
      updated_at: number
    }[]
    let items = rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      tags: parseTags(r.tags),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
    if (tag) items = items.filter((n) => n.tags.includes(tag))
    return { items }
  })

  app.post<{ Body: { title?: string; body?: string; tags?: string[] } }>("/notes", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const title = req.body?.title?.trim()
    const body = req.body?.body ?? ""
    if (!title) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "title required" } })
    const db = (app as unknown as WbApp).db
    const id = randomUUID()
    const ts = now()
    const tags = JSON.stringify(req.body?.tags ?? [])
    db.prepare("INSERT INTO notes (id, user_id, title, body, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
      id,
      auth.userId,
      title,
      body,
      tags,
      ts,
      ts,
    )
    return reply.code(201).send({
      id,
      title,
      body,
      tags: req.body?.tags ?? [],
      createdAt: ts,
      updatedAt: ts,
    })
  })

  app.patch<{ Params: { id: string }; Body: { title?: string; body?: string; tags?: string[] } }>(
    "/notes/:id",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
      const db = (app as unknown as WbApp).db
      const existing = db.prepare("SELECT id FROM notes WHERE id = ? AND user_id = ?").get(req.params.id, auth.userId) as
        | { id: string }
        | undefined
      if (!existing) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "note not found" } })

      const fields: string[] = []
      const params: Param[] = []
      if (req.body?.title !== undefined) {
        fields.push("title = ?")
        params.push(req.body.title)
      }
      if (req.body?.body !== undefined) {
        fields.push("body = ?")
        params.push(req.body.body)
      }
      if (req.body?.tags !== undefined) {
        fields.push("tags = ?")
        params.push(JSON.stringify(req.body.tags))
      }
      fields.push("updated_at = ?")
      params.push(now())
      params.push(req.params.id, auth.userId)
      db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...params)

      const row = db
        .prepare("SELECT id, title, body, tags, created_at, updated_at FROM notes WHERE id = ?")
        .get(req.params.id) as {
        id: string
        title: string
        body: string
        tags: string | null
        created_at: number
        updated_at: number
      }
      return {
        id: row.id,
        title: row.title,
        body: row.body,
        tags: parseTags(row.tags),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    },
  )

  app.delete<{ Params: { id: string } }>("/notes/:id", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "not logged in" } })
    const db = (app as unknown as WbApp).db
    const res = db.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").run(req.params.id, auth.userId)
    if (Number(res.changes) === 0) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "note not found" } })
    return reply.code(204).send()
  })
}
