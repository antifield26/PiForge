import type {
  AgentMessage,
  AgentSession,
  AgentStreamEvent,
  PermissionDecision,
  PermissionRequest,
} from "@piforge/shared"
import type {
  EventHandlers,
  OpenCodeAdapter,
  PermissionDecision as _PD,
  ProjectInfo,
  PromptReq,
  ServerInfo,
} from "./adapter.js"

export interface HttpAdapterOptions {
  baseUrl: string
  username?: string
  password: string
  fetchImpl?: typeof fetch
}

export function createHttpAdapter(opts: HttpAdapterOptions): OpenCodeAdapter {
  const base = opts.baseUrl.replace(/\/$/, "")
  const fetchFn = opts.fetchImpl ?? fetch
  const auth = "Basic " + Buffer.from(`${opts.username ?? "opencode"}:${opts.password}`).toString("base64")

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchFn(base + path, {
      ...init,
      headers: {
        authorization: auth,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new OpenCodeHttpError(res.status, body, path)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  return {
    async info() {
      return req<ServerInfo>("/api/info")
    },

    async listProjects() {
      const loc = await req<{ project?: ProjectInfo }>("/api/location")
      return loc.project ? [loc.project] : []
    },

    async createSession(title?: string) {
      const body: Record<string, unknown> = {}
      if (title) body.title = title
      const raw = await req<{ data: RawSession } | RawSession>("/api/session", {
        method: "POST",
        body: JSON.stringify(body),
      })
      return mapSession(unwrap(raw))
    },

    async listSessions() {
      const raw = await req<{ data: RawSession[] } | { data?: RawSession[] } | RawSession[]>("/api/session")
      const list = Array.isArray(raw) ? raw : ((raw as { data?: RawSession[] }).data ?? [])
      return list.map(mapSession)
    },

    async getSession(id: string) {
      try {
        const raw = await req<{ data: RawSession } | RawSession>(`/api/session/${encodeURIComponent(id)}`)
        return mapSession(unwrap(raw))
      } catch (e) {
        if (e instanceof OpenCodeHttpError && e.status === 404) return null
        throw e
      }
    },

    async deleteSession(id: string) {
      await req<void>(`/api/session/${encodeURIComponent(id)}`, { method: "DELETE" })
    },

    async prompt(id: string, body: PromptReq) {
      const payload: Record<string, unknown> = {
        parts: [{ type: "text", text: body.content }],
      }
      if (body.model) payload.model = body.model
      if (body.agent) payload.agent = body.agent
      await req<void>(`/api/session/${encodeURIComponent(id)}/prompt`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },

    async interrupt(id: string) {
      await req<void>(`/api/session/${encodeURIComponent(id)}/interrupt`, {
        method: "POST",
        body: JSON.stringify({}),
      })
    },

    async listMessages(id: string) {
      const raw = await req<{ data: RawMessage[] }>(`/api/session/${encodeURIComponent(id)}/message`)
      return (raw.data ?? []).map((m) => mapMessage(m, id))
    },

    async listPermissionRequests(id: string) {
      const raw = await req<{ data: RawPermission[] }>(
        `/api/session/${encodeURIComponent(id)}/permission`,
      )
      return (raw.data ?? []).map((p) => mapPermission(p, id))
    },

    async replyPermission(id: string, reqId: string, decision: PermissionDecision) {
      await req<void>(`/api/session/${encodeURIComponent(id)}/permission/${encodeURIComponent(reqId)}/reply`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      })
    },

    async listAgents() {
      const raw = await req<{ data: { id: string; name: string; description?: string }[] }>("/api/agent")
      return (raw.data ?? []).map((a) => ({ id: a.id, name: a.name, description: a.description }))
    },

    subscribe(handlers: EventHandlers) {
      const ac = new AbortController()
      let stopped = false

      void (async () => {
        while (!stopped) {
          try {
            const res = await fetchFn(base + "/api/event", {
              headers: { authorization: auth, accept: "text/event-stream" },
              signal: ac.signal,
            })
            if (!res.ok || !res.body) {
              throw new Error(`SSE failed: ${res.status}`)
            }
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buf = ""
            while (!stopped) {
              const { done, value } = await reader.read()
              if (done) break
              buf += decoder.decode(value, { stream: true })
              const frames = buf.split("\n\n")
              buf = frames.pop() ?? ""
              for (const frame of frames) {
                const evt = parseSseFrame(frame)
                if (evt && handlers.onEvent) handlers.onEvent(evt)
              }
            }
          } catch (e) {
            if (stopped || ac.signal.aborted) return
            handlers.onError?.(e instanceof Error ? e : new Error(String(e)))
          }
          if (!stopped) await new Promise((r) => setTimeout(r, 2000))
        }
      })()

      return () => {
        stopped = true
        ac.abort()
      }
    },
  }
}

export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`OpenCode HTTP ${status} on ${path}: ${body.slice(0, 200)}`)
    this.name = "OpenCodeHttpError"
  }
}

interface RawSession {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
  createdAt?: number
  updatedAt?: number
}

interface RawMessage {
  id: string
  role?: string
  parts?: { type?: string; text?: string }[]
  time?: { created?: number }
}

interface RawPermission {
  id?: string
  requestID?: string
  tool?: string
  description?: string
  time?: { created?: number }
}

function unwrap<T>(raw: { data: T } | T): T {
  if (raw && typeof raw === "object" && "data" in (raw as object)) {
    return (raw as { data: T }).data
  }
  return raw as T
}

function mapSession(raw: RawSession): AgentSession {
  return {
    id: raw.id,
    title: raw.title ?? "",
    createdAt: raw.time?.created ?? raw.createdAt ?? 0,
    updatedAt: raw.time?.updated ?? raw.updatedAt ?? 0,
  }
}

function mapMessage(raw: RawMessage, sessionId: string): AgentMessage {
  const text = (raw.parts ?? [])
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("")
  return {
    id: raw.id,
    sessionId,
    role: (raw.role as AgentMessage["role"]) ?? "assistant",
    content: text,
    createdAt: raw.time?.created ?? 0,
  }
}

function mapPermission(raw: RawPermission, sessionId: string): PermissionRequest {
  return {
    id: raw.id ?? raw.requestID ?? "",
    sessionId,
    tool: raw.tool ?? "unknown",
    description: raw.description ?? "",
    createdAt: raw.time?.created ?? 0,
  }
}

function parseSseFrame(frame: string): AgentStreamEvent | null {
  let eventType = ""
  let dataLine = ""
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLine += line.slice(5).trim()
  }
  if (!dataLine) return null
  try {
    const payload = JSON.parse(dataLine) as {
      type?: string
      data?: Record<string, unknown>
      created?: number
    }
    const t = eventType || payload.type || ""
    if (t === "session.updated" || t === "session.created") {
      return {
        type: "session.update",
        sessionId: String(payload.data?.id ?? payload.data?.sessionID ?? ""),
        title: payload.data?.title ? String(payload.data.title) : undefined,
      }
    }
    if (t.startsWith("message.") || t.includes("message")) {
      return {
        type: "message.update",
        sessionId: String(payload.data?.sessionID ?? ""),
        messageId: String(payload.data?.id ?? payload.data?.messageID ?? ""),
        content: "",
        done: t.endsWith("completed") || t.endsWith("updated"),
      }
    }
    if (t.includes("permission")) {
      const p = payload.data ?? {}
      return {
        type: "permission.request",
        request: {
          id: String(p.id ?? p.requestID ?? ""),
          sessionId: String(p.sessionID ?? ""),
          tool: String(p.tool ?? "unknown"),
          description: String(p.description ?? ""),
          createdAt: payload.created ?? Date.now(),
        },
      }
    }
    if (t === "server.connected") return null
  } catch {
    return null
  }
  return null
}
