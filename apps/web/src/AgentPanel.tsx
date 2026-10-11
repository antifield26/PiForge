import { createSignal, For, onCleanup, onMount } from "solid-js"

type TimelineItem = {
  id: string
  kind: "user" | "assistant" | "system" | "status"
  text: string
  at: number
}

export function AgentPanel() {
  const [sessionId, setSessionId] = createSignal<string | null>(null)
  const [items, setItems] = createSignal<TimelineItem[]>([])
  const [input, setInput] = createSignal("Reply with exactly: PONG")
  const [status, setStatus] = createSignal("未连接")
  const [busy, setBusy] = createSignal(false)

  let es: EventSource | null = null

  async function api(path: string, init?: RequestInit) {
    const res = await fetch(path, {
      credentials: "include",
      headers: { "content-type": "application/json" },
      ...init,
    })
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json()
  }

  async function ensureSession() {
    if (sessionId()) return sessionId()!
    const created = await api("/api/v1/agent/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "PiForge task" }),
    })
    const id = created.id
    setSessionId(id)
    return id as string
  }

  async function send() {
    const text = input().trim()
    if (!text) return
    setBusy(true)
    try {
      const id = await ensureSession()
      setItems((prev) => [
        ...prev,
        { id: crypto.randomUUID(), kind: "user", text, at: Date.now() },
      ])
      await api(`/api/v1/agent/sessions/${id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ content: text }),
      })
      setStatus("生成中…")
    } catch (e) {
      setStatus(`错误: ${e}`)
      setBusy(false)
    }
  }

  async function refreshMessages() {
    const id = sessionId()
    if (!id) return
    try {
      const data = await api(`/api/v1/agent/sessions/${id}/messages`)
      const list = data.items ?? []
      setItems(
        list.map((m: { id: string; role: string; content: string; createdAt: number }) => ({
          id: m.id,
          kind: (m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant") as TimelineItem["kind"],
          text: m.content || "…",
          at: m.createdAt,
        })),
      )
    } catch {
      /* ignore */
    }
  }

  onMount(() => {
    es = new EventSource("/api/v1/agent/events", { withCredentials: true })
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (data.type === "message.update") {
          void refreshMessages()
        }
        if (data.type === "permission.request") {
          setStatus(`权限请求: ${data.request?.tool ?? "?"} — ${data.request?.description ?? ""}`)
        }
        if (data.type === "session.update") {
          void refreshMessages()
        }
      } catch {
        /* ignore */
      }
    }
    es.onerror = () => setStatus("事件流断开，重连中…")
  })

  onCleanup(() => {
    es?.close()
  })

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex items-center justify-between">
        <h2 class="font-medium">Agent · OpenCode</h2>
        <span class="text-xs text-[var(--pf-grey-700)]">{status()}</span>
      </header>
      <ol class="mb-3 max-h-80 space-y-2 overflow-y-auto rounded-lg bg-[var(--pf-grey-100)] p-3">
        <For
          each={items()}
          fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无消息</li>}
        >
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
                {item.kind}
              </div>
              <div class="whitespace-pre-wrap">{item.text}</div>
            </li>
          )}
        </For>
      </ol>
      <div class="flex gap-2">
        <input
          class="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-[var(--pf-blue-600)]"
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy()) void send()
          }}
          placeholder="给 Agent 下发任务…"
        />
        <button
          class="rounded-lg bg-[var(--pf-blue-600)] px-4 py-2 text-sm text-white disabled:opacity-50"
          disabled={busy()}
          onClick={() => {
            void send().finally(() => setTimeout(() => setBusy(false), 1500))
          }}
        >
          发送
        </button>
      </div>
    </section>
  )
}
