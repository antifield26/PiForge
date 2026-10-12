import type { FastifyPluginAsync } from "fastify"
import { randomUUID } from "node:crypto"
import { requireAuth } from "../auth/routes.js"
import { asFiniteNumber, asOptionalString, asStringArray, asTrimmedString, escapeLike, isTodoStatus, likeContains, sendError } from "../../util/validate.js"

const MAX_TITLE = 300
const MAX_NOTES = 20_000
const MAX_BODY = 200_000

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
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const q = asTrimmedString(req.query.q, 200)
    const status = req.query.status
    let sql = "SELECT id, title, notes, status, due_at, created_at, updated_at FROM todos WHERE user_id = ?"
    const params: (string | number)[] = [auth.userId]
    if (status) {
      if (!isTodoStatus(status)) return sendError(reply, 400, "BAD_REQUEST", "invalid status filter")
      sql += " AND status = ?"
      params.push(status)
    }
    if (q) {
      sql += " AND (title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')"
      params.push(likeContains(q), likeContains(q))
    }
    sql += " ORDER BY updated_at DESC LIMIT 200"
    const rows = app.db.prepare(sql).all(...params) as {
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

  app.post<{ Body: { title?: string; notes?: string; status?: string; dueAt?: number } }>("/todos", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const title = asTrimmedString(req.body?.title, MAX_TITLE)
    if (!title) return sendError(reply, 400, "BAD_REQUEST", "title required")
    const status = req.body?.status ?? "open"
    if (!isTodoStatus(status)) return sendError(reply, 400, "BAD_REQUEST", "invalid status")
    const notes = asOptionalString(req.body?.notes, MAX_NOTES)
    const dueAt = req.body?.dueAt === undefined || req.body?.dueAt === null ? null : asFiniteNumber(req.body.dueAt)
    if (req.body?.dueAt !== undefined && req.body?.dueAt !== null && dueAt === null) {
      return sendError(reply, 400, "BAD_REQUEST", "dueAt must be a number")
    }
    const id = randomUUID()
    const ts = Date.now()
    app.db
      .prepare("INSERT INTO todos (id, user_id, title, notes, status, due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, auth.userId, title, notes, status, dueAt, ts, ts)
    return reply.code(201).send({ id, title, notes, status, dueAt, createdAt: ts, updatedAt: ts })
  })

  app.patch<{ Params: { id: string }; Body: { title?: string; notes?: string; status?: string; dueAt?: number | null } }>(
    "/todos/:id",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
      const existing = app.db
        .prepare("SELECT id FROM todos WHERE id = ? AND user_id = ?")
        .get(req.params.id, auth.userId) as { id: string } | undefined
      if (!existing) return sendError(reply, 404, "NOT_FOUND", "todo not found")

      const fields: string[] = []
      const params: (string | number | null)[] = []
      if (req.body?.title !== undefined) {
        const title = asTrimmedString(req.body.title, MAX_TITLE)
        if (!title) return sendError(reply, 400, "BAD_REQUEST", "title cannot be empty")
        fields.push("title = ?")
        params.push(title)
      }
      if (req.body?.notes !== undefined) {
        fields.push("notes = ?")
        params.push(asOptionalString(req.body.notes, MAX_NOTES))
      }
      if (req.body?.status !== undefined) {
        if (!isTodoStatus(req.body.status)) return sendError(reply, 400, "BAD_REQUEST", "invalid status")
        fields.push("status = ?")
        params.push(req.body.status)
      }
      if (req.body?.dueAt !== undefined) {
        const dueAt = req.body.dueAt === null ? null : asFiniteNumber(req.body.dueAt)
        if (req.body.dueAt !== null && dueAt === null) return sendError(reply, 400, "BAD_REQUEST", "dueAt must be a number")
        fields.push("due_at = ?")
        params.push(dueAt)
      }
      fields.push("updated_at = ?")
      params.push(Date.now())
      params.push(req.params.id, auth.userId)
      app.db.prepare(`UPDATE todos SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...params)

      const row = app.db
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
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const res = app.db.prepare("DELETE FROM todos WHERE id = ? AND user_id = ?").run(req.params.id, auth.userId)
    if (Number(res.changes) === 0) return sendError(reply, 404, "NOT_FOUND", "todo not found")
    return reply.code(204).send()
  })

  // ---- Notes ----
  app.get<{ Querystring: { q?: string; tag?: string } }>("/notes", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const q = asTrimmedString(req.query.q, 200)
    const tag = asTrimmedString(req.query.tag, 64)
    let sql = "SELECT id, title, body, tags, created_at, updated_at FROM notes WHERE user_id = ?"
    const params: (string | number)[] = [auth.userId]
    if (q) {
      sql += " AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')"
      params.push(likeContains(q), likeContains(q))
    }
    if (tag) {
      // Filter in SQL: doing it after LIMIT 200 meant a tag used by an older note vanished as soon
      // as the user had more than 200 notes. Tags are stored as a JSON array, so match the quoted
      // element.
      sql += " AND tags LIKE ? ESCAPE '\\'"
      params.push(`%"${escapeLike(tag)}"%`)
    }
    sql += " ORDER BY updated_at DESC LIMIT 200"
    const rows = app.db.prepare(sql).all(...params) as {
      id: string
      title: string
      body: string
      tags: string | null
      created_at: number
      updated_at: number
    }[]
    const items = rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      tags: parseTags(r.tags),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
    return { items }
  })

  app.post<{ Body: { title?: string; body?: string; tags?: string[] } }>("/notes", async (req, reply) => {
    const auth = requireAuth(req)
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const title = asTrimmedString(req.body?.title, MAX_TITLE)
    if (!title) return sendError(reply, 400, "BAD_REQUEST", "title required")
    const body = asOptionalString(req.body?.body, MAX_BODY) ?? ""
    const tags = asStringArray(req.body?.tags) ?? []
    const id = randomUUID()
    const ts = Date.now()
    app.db
      .prepare("INSERT INTO notes (id, user_id, title, body, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, auth.userId, title, body, JSON.stringify(tags), ts, ts)
    return reply.code(201).send({ id, title, body, tags, createdAt: ts, updatedAt: ts })
  })

  app.patch<{ Params: { id: string }; Body: { title?: string; body?: string; tags?: string[] } }>(
    "/notes/:id",
    async (req, reply) => {
      const auth = requireAuth(req)
      if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
      const existing = app.db.prepare("SELECT id FROM notes WHERE id = ? AND user_id = ?").get(req.params.id, auth.userId) as
        | { id: string }
        | undefined
      if (!existing) return sendError(reply, 404, "NOT_FOUND", "note not found")

      const fields: string[] = []
      const params: (string | number | null)[] = []
      if (req.body?.title !== undefined) {
        const title = asTrimmedString(req.body.title, MAX_TITLE)
        if (!title) return sendError(reply, 400, "BAD_REQUEST", "title cannot be empty")
        fields.push("title = ?")
        params.push(title)
      }
      if (req.body?.body !== undefined) {
        fields.push("body = ?")
        params.push(asOptionalString(req.body.body, MAX_BODY) ?? "")
      }
      if (req.body?.tags !== undefined) {
        fields.push("tags = ?")
        params.push(JSON.stringify(asStringArray(req.body.tags) ?? []))
      }
      fields.push("updated_at = ?")
      params.push(Date.now())
      params.push(req.params.id, auth.userId)
      app.db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...params)

      const row = app.db
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
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "not logged in")
    const res = app.db.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").run(req.params.id, auth.userId)
    if (Number(res.changes) === 0) return sendError(reply, 404, "NOT_FOUND", "note not found")
    return reply.code(204).send()
  })
}
