import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type {
  AgentMessage,
  AgentSession,
  AgentStreamEvent,
  PermissionDecision,
  PermissionRequest,
} from "@piforge/shared"
import { ApiError, api, errorText, randomId } from "./api"
import { readStoredSession, storeSession } from "./agentSession"

type TimelineItem = {
  id: string
  kind: AgentMessage["role"]
  text: string
  at: number
}

const KIND_LABELS: Record<TimelineItem["kind"], string> = {
  user: "我",
  assistant: "Agent",
  system: "系统",
}

const REFRESH_DEBOUNCE_MS = 300

export function AgentPanel() {
  const [sessionId, setSessionId] = createSignal<string | null>(null)
  const [sessions, setSessions] = createSignal<AgentSession[]>([])
  const [items, setItems] = createSignal<TimelineItem[]>([])
  const [permissions, setPermissions] = createSignal<PermissionRequest[]>([])
  const [input, setInput] = createSignal("")
  const [status, setStatus] = createSignal("未连接")
  const [err, setErr] = createSignal("")
  const [permMsg, setPermMsg] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [replyingTo, setReplyingTo] = createSignal<string | null>(null)

  let es: EventSource | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleRefresh() {
    if (refreshTimer != null) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refreshMessages()
    }, REFRESH_DEBOUNCE_MS)
  }

  async function loadSessions() {
    try {
      const d = await api<{ items: AgentSession[] }>("/api/v1/agent/sessions")
      setSessions(d.items ?? [])
    } catch (e) {
      setErr(`会话列表加载失败：${errorText(e)}`)
    }
  }

  async function refreshMessages(id: string | null = sessionId()) {
    if (!id) return
    try {
      const data = await api<{ items: AgentMessage[] }>(
        `/api/v1/agent/sessions/${encodeURIComponent(id)}/messages`,
      )
      // The user may have switched sessions while this was in flight; dropping the late response
      // stops the previous session's timeline from being rendered under the new one.
      if (id !== sessionId()) return
      setItems(
        (data.items ?? []).map((m) => ({
          id: m.id,
          kind: m.role,
          text: m.content || "…",
          at: m.createdAt,
        })),
      )
    } catch (e) {
      setErr(`消息加载失败：${errorText(e)}`)
    }
  }

  async function loadPermissions(id: string) {
    try {
      const d = await api<{ items: PermissionRequest[] }>(
        `/api/v1/agent/sessions/${encodeURIComponent(id)}/permissions`,
      )
      const serverItems = d.items ?? []
      // never drop a request that arrived over SSE while this fetch was in flight
      setPermissions((prev) => {
        const known = new Set(serverItems.map((p) => p.id))
        return [...serverItems, ...prev.filter((p) => !known.has(p.id))]
      })
    } catch (e) {
      // endpoint may not be deployed yet; anything else is worth surfacing
      if (e instanceof ApiError && e.status === 404) return
      setPermMsg(`权限请求加载失败：${errorText(e)}`)
    }
  }

  async function selectSession(id: string) {
    const next = id || null
    setSessionId(next)
    setItems([])
    setPermissions([])
    setPermMsg("")
    setErr("")
    storeSession(next)
    if (!next) return
    await Promise.all([refreshMessages(next), loadPermissions(next)])
  }

  async function ensureSession(): Promise<string> {
    const current = sessionId()
    if (current) return current
    const created = await api<AgentSession>("/api/v1/agent/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "PiForge task" }),
    })
    setSessionId(created.id)
    storeSession(created.id)
    setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)])
    void loadSessions()
    return created.id
  }

  async function send() {
    const text = input().trim()
    if (!text || busy()) return
    setBusy(true)
    setErr("")
    try {
      const id = await ensureSession()
      await api(`/api/v1/agent/sessions/${encodeURIComponent(id)}/prompt`, {
        method: "POST",
        body: JSON.stringify({ content: text }),
      })
      setItems((prev) => [...prev, { id: randomId(), kind: "user", text, at: Date.now() }])
      setInput("")
      setStatus("生成中…")
    } catch (e) {
      setErr(`发送失败：${errorText(e)}`)
      setStatus("发送失败")
    } finally {
      setBusy(false)
    }
  }

  async function replyPermission(requestId: string, decision: PermissionDecision) {
    const id = sessionId()
    if (!id) return
    setReplyingTo(requestId)
    setPermMsg("")
    try {
      await api(
        `/api/v1/agent/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}/reply`,
        { method: "POST", body: JSON.stringify({ decision }) },
      )
      setPermissions((prev) => prev.filter((p) => p.id !== requestId))
      setPermMsg(
        decision === "deny" ? "已拒绝该权限请求" : decision === "always" ? "已允许（始终允许）" : "已允许该权限请求",
      )
    } catch (e) {
      setPermMsg(`权限回复失败：${errorText(e)}`)
    } finally {
      setReplyingTo(null)
    }
  }

  function handleEvent(raw: string) {
    let event: AgentStreamEvent
    try {
      event = JSON.parse(raw) as AgentStreamEvent
    } catch {
      return
    }
    if (!event || typeof event !== "object") return

    if (event.type === "error") {
      setStatus(`事件流出错：${event.message}`)
      return
    }

    if (event.type === "permission.request") {
      const request = event.request
      if (!request) return
      const current = sessionId()
      if (current && request.sessionId && request.sessionId !== current) {
        setStatus("其他会话有待处理的权限请求")
        return
      }
      if (!current && request.sessionId) {
        // fresh tab / after reload: follow the session that needs approval
        void selectSession(request.sessionId)
      }
      setPermissions((prev) => (prev.some((p) => p.id === request.id) ? prev : [...prev, request]))
      setStatus(`权限请求：${request.tool}`)
      return
    }

    if (event.type === "message.update") {
      if (event.sessionId && event.sessionId !== sessionId()) return
      scheduleRefresh()
      return
    }

    if (event.type === "session.update") {
      void loadSessions()
      if (event.sessionId && event.sessionId !== sessionId()) return
      scheduleRefresh()
    }
  }

  onMount(() => {
    void (async () => {
      await loadSessions()
      const remembered = readStoredSession()
      if (remembered && sessions().some((s) => s.id === remembered)) await selectSession(remembered)
    })()

    es = new EventSource("/api/v1/agent/events", { withCredentials: true })
    es.onopen = () => setStatus("已连接")
    es.onmessage = (ev) => handleEvent(ev.data)
    es.onerror = () => {
      // EventSource fires ErrorEvent (not MessageEvent) here — there is no .data.
      // A dropped stream is usually an expired session (401 on reconnect) or network blip.
      // EventSource retries every 3s forever, so probe the session and stop for good when the
      // server says we are logged out: otherwise a signed-out tab keeps reopening the stream.
      setStatus("事件流断开，重连中…")
      void probeSession()
    }
  })

  let probing = false
  async function probeSession() {
    if (probing) return
    probing = true
    try {
      await api("/api/v1/auth/me")
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        storeSession(null)
        setStatus("会话已过期")
        es?.close()
      }
    } finally {
      probing = false
    }
  }

  onCleanup(() => {
    if (refreshTimer != null) clearTimeout(refreshTimer)
    es?.close()
  })

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex flex-wrap items-center gap-2">
        <h2 class="font-medium">Agent · OpenCode</h2>
        <label class="sr-only" for="pf-agent-session">
          选择会话
        </label>
        <select
          id="pf-agent-session"
          class="min-w-0 max-w-48 rounded-lg border border-black/10 px-2 py-1 text-xs"
          onChange={(e) => void selectSession(e.currentTarget.value)}
        >
          <option value="" selected={sessionId() == null}>
            （新会话）
          </option>
          <For each={sessions()}>
            {(s) => (
              <option value={s.id} selected={s.id === sessionId()}>
                {s.title || s.id.slice(0, 8)}
              </option>
            )}
          </For>
        </select>
        <span class="ml-auto text-xs text-[var(--pf-grey-700)]" aria-live="polite">
          {status()}
        </span>
      </header>

      <Show when={err()}>
        <p class="mb-2 text-sm text-red-700" aria-live="polite">
          {err()}
        </p>
      </Show>

      <Show when={permissions().length > 0}>
        <div class="mb-3 space-y-2">
          <For each={permissions()}>
            {(p) => (
              <div class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                <div class="font-medium">权限请求 · {p.tool}</div>
                <p class="mt-1 whitespace-pre-wrap break-words text-[var(--pf-grey-700)]">{p.description}</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  <button
                    class="rounded-lg bg-[var(--pf-blue-600)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
                    disabled={replyingTo() === p.id}
                    onClick={() => void replyPermission(p.id, "allow")}
                  >
                    允许
                  </button>
                  <button
                    class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                    disabled={replyingTo() === p.id}
                    onClick={() => void replyPermission(p.id, "always")}
                  >
                    总是允许
                  </button>
                  <button
                    class="rounded-lg bg-[var(--pf-grey-100)] px-3 py-1.5 text-xs disabled:opacity-50"
                    disabled={replyingTo() === p.id}
                    onClick={() => void replyPermission(p.id, "deny")}
                  >
                    拒绝
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={permMsg()}>
        <p class="mb-2 text-sm text-[var(--pf-grey-700)]" aria-live="polite">
          {permMsg()}
        </p>
      </Show>

      <ol class="mb-3 max-h-80 space-y-2 overflow-y-auto rounded-lg bg-[var(--pf-grey-100)] p-3">
        <For each={items()} fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无消息</li>}>
          {(item) => (
            <li
              class={
                item.kind === "user"
                  ? "rounded-lg bg-white p-2 text-sm"
                  : item.kind === "system"
                    ? "rounded-lg border border-black/10 p-2 font-mono text-xs text-[var(--pf-grey-700)]"
                    : "rounded-lg border border-blue-200 bg-blue-50/50 p-2 text-sm"
              }
            >
              <div class="mb-1 text-[10px] uppercase tracking-wide text-[var(--pf-grey-700)]">
                {KIND_LABELS[item.kind] ?? item.kind}
              </div>
              <div class="whitespace-pre-wrap break-words">{item.text}</div>
            </li>
          )}
        </For>
      </ol>

      <div class="flex gap-2">
        <label class="sr-only" for="pf-agent-prompt">
          给 Agent 下发任务
        </label>
        <input
          id="pf-agent-prompt"
          class="min-w-0 flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-[var(--pf-blue-600)]"
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy()) void send()
          }}
          placeholder="给 Agent 下发任务…"
        />
        <button
          class="shrink-0 rounded-lg bg-[var(--pf-blue-600)] px-4 py-2 text-sm text-white disabled:opacity-50"
          disabled={busy()}
          onClick={() => void send()}
        >
          发送
        </button>
      </div>
    </section>
  )
}
