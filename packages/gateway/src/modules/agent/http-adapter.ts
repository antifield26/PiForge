import type {
  AgentMessage,
  AgentSession,
  AgentStreamEvent,
  PermissionDecision,
  PermissionRequest,
} from "@piforge/shared"
import type {
  DiffRange,
  EventHandlers,
  OpenCodeAdapter,
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
      // model/agent are switched via dedicated endpoints, not the prompt payload
      if (body.model) {
        const modelRef = body.model.includes("/")
          ? body.model.split("/")
          : ["opencode", body.model]
        await req<void>(`/api/session/${encodeURIComponent(id)}/model`, {
          method: "POST",
          body: JSON.stringify({
            model: { id: modelRef[1] ?? modelRef[0], providerID: modelRef.length > 1 ? modelRef[0] : "opencode" },
          }),
        })
      }
      if (body.agent) {
        await req<void>(`/api/session/${encodeURIComponent(id)}/agent`, {
          method: "POST",
          body: JSON.stringify({ agent: body.agent }),
        })
      }
      await req<void>(`/api/session/${encodeURIComponent(id)}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text: body.content }),
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

    async getDiff(id: string, range?: DiffRange) {
      const query = new URLSearchParams()
      if (range?.from) query.set("from", range.from)
      if (range?.to) query.set("to", range.to)
      const suffix = query.size > 0 ? `?${query.toString()}` : ""
      return req<unknown>(`/api/session/${encodeURIComponent(id)}/diff${suffix}`)
    },

    subscribe(handlers: EventHandlers) {
      subscribers.add(handlers)
      ensureUpstream()
      return () => {
        subscribers.delete(handlers)
        if (subscribers.size === 0) stopUpstream()
      }
    },
  }

  // One upstream SSE connection shared by all browser clients: the Pi should not open
  // a separate OpenCode event stream per panel/tab.
  const subscribers = new Set<EventHandlers>()
  let controller: AbortController | null = null

  function broadcast(event: AgentStreamEvent): void {
    for (const subscriber of subscribers) {
      try {
        subscriber.onEvent?.(event)
      } catch {
        /* a broken client must not kill the stream */
      }
    }
  }

  function broadcastError(err: Error): void {
    for (const subscriber of subscribers) {
      try {
        subscriber.onError?.(err)
      } catch {
        /* ignore */
      }
    }
  }

  function ensureUpstream(): void {
    if (controller) return
    const ac = new AbortController()
    controller = ac
    void (async () => {
      while (!ac.signal.aborted) {
        try {
          const res = await fetchFn(base + "/api/event", {
            headers: { authorization: auth, accept: "text/event-stream" },
            signal: ac.signal,
          })
          if (!res.ok || !res.body) throw new Error(`SSE failed: ${res.status}`)
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ""
          while (!ac.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const frames = buf.split("\n\n")
            buf = frames.pop() ?? ""
            for (const frame of frames) {
              const evt = parseSseFrame(frame)
              if (evt) broadcast(evt)
            }
          }
        } catch (e) {
          if (ac.signal.aborted) return
          broadcastError(e instanceof Error ? e : new Error(String(e)))
        }
        if (!ac.signal.aborted) await new Promise((r) => setTimeout(r, 2000))
      }
    })()
  }

  function stopUpstream(): void {
    controller?.abort()
    controller = null
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
  type?: string
  text?: string
  content?: { type?: string; text?: string }[]
  role?: string
  parts?: { type?: string; text?: string }[]
  agent?: string
  time?: { created?: number; completed?: number }
  finish?: string
  error?: { message?: string }
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
  let text = ""
  if (Array.isArray(raw.content) && raw.content.length > 0) {
    text = raw.content
      .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
      .join("")
      .trim()
  }
  if (!text && typeof raw.text === "string" && raw.text) {
    text = raw.text
  }
  if (!text && Array.isArray(raw.parts)) {
    text = raw.parts
      .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
      .join("")
      .trim()
  }
  const type = raw.type ?? raw.role ?? "assistant"
  const role: AgentMessage["role"] =
    type === "user"
      ? "user"
      : type === "system" || type === "idle" || type === "model-switched"
        ? "system"
        : "assistant"
  return {
    id: raw.id,
    sessionId,
    role,
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

/** Exported for contract tests. */
export function parseSseFrame(frame: string): AgentStreamEvent | null {
  let eventType = ""
  let dataLine = ""
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLine += line.slice(5).trim()
  }
  if (!dataLine) return null
  try {
    const payload = JSON.parse(dataLine) as {
      id?: string
      type?: string
      data?: Record<string, unknown>
      created?: number
    }
    const t = eventType || payload.type || ""
    const d = payload.data ?? {}

    if (t === "session.updated" || t === "session.created") {
      return {
        type: "session.update",
        sessionId: String(d.id ?? d.sessionID ?? ""),
        title: d.title ? String(d.title) : undefined,
      }
    }
    if (t.startsWith("message.") || t.includes("message.part") || t === "message.updated") {
      return {
        type: "message.update",
        sessionId: String(d.sessionID ?? ""),
        messageId: String(d.messageID ?? d.id ?? ""),
        content: typeof d.text === "string" ? d.text : "",
        done: t.endsWith("completed") || t.endsWith("updated"),
      }
    }
    if (t.startsWith("session.step.") || t.startsWith("session.execution.")) {
      return {
        type: "message.update",
        sessionId: String(d.sessionID ?? ""),
        messageId: String(d.assistantMessageID ?? d.messageID ?? ""),
        content: t.endsWith("failed") ? String((d.error as { message?: string })?.message ?? "failed") : "",
        done: t.endsWith("completed") || t.endsWith("failed"),
      }
    }
    if (t.includes("permission")) {
      return {
        type: "permission.request",
        request: {
          id: String(d.id ?? d.requestID ?? ""),
          sessionId: String(d.sessionID ?? ""),
          tool: String(d.tool ?? "unknown"),
          description: String(d.description ?? d.message ?? ""),
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
