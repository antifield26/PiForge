import { createSignal, For, onMount, Show } from "solid-js"

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  if (res.status === 204) return undefined as T
  return res.json()
}

export function OpsPanel() {
  const [sd, setSd] = createSignal<{
    model: string
    totalWriteBytes: number
    dayWriteBytes: number
    estimateDaysLeft: number | null
  } | null>(null)
  const [sessions, setSessions] = createSignal<{ id: string; title: string; createdAt: number }[]>([])
  const [backups, setBackups] = createSignal<
    { id: number; started_at: number; status: string; target: string; message: string | null }[]
  >([])
  const [err, setErr] = createSignal("")
  const [note, setNote] = createSignal("")

  async function refresh() {
    try {
      const [s, a, b] = await Promise.all([
        api<{ model: string; totalWriteBytes: number; dayWriteBytes: number; estimateDaysLeft: number | null }>(
          "/api/v1/console/sd",
        ),
        api<{ items: { id: string; title: string; createdAt: number }[] }>("/api/v1/agent/sessions"),
        api<{ items: { id: number; started_at: number; status: string; target: string; message: string | null }[] }>(
          "/api/v1/console/backups",
        ),
      ])
      setSd(s)
      setSessions(a.items || [])
      setBackups(b.items || [])
      setErr("")
    } catch (e) {
      setErr(String(e))
    }
  }

  onMount(() => void refresh())

  async function runBackup() {
    setNote("触发备份中…")
    try {
      await api("/api/v1/console/backups/run", { method: "POST" })
      setNote("备份已触发")
      await refresh()
    } catch (e) {
      setNote(`备份失败: ${e}`)
    }
  }

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex items-center justify-between">
        <h2 class="font-medium">SD 寿命 · Agent · 备份</h2>
        <button class="text-xs text-[var(--pf-blue-600)]" onClick={() => void refresh()}>
          刷新
        </button>
      </header>
      <Show when={err()}>
        <p class="mb-2 text-sm text-red-700">{err()}</p>
      </Show>
      <Show when={note()}>
        <p class="mb-2 text-sm text-[var(--pf-grey-700)]">{note()}</p>
      </Show>

      <div class="mb-4 grid gap-3 sm:grid-cols-3">
        <Show when={sd()} fallback={<p class="text-sm text-[var(--pf-grey-700)]">SD 数据加载中…</p>}>
          <div class="rounded-lg bg-[var(--pf-grey-100)] p-3">
            <div class="text-[10px] uppercase text-[var(--pf-grey-700)]">SD 型号</div>
            <div class="font-medium">{sd()!.model}</div>
          </div>
          <div class="rounded-lg bg-[var(--pf-grey-100)] p-3">
            <div class="text-[10px] uppercase text-[var(--pf-grey-700)]">日写入估算</div>
            <div class="font-medium">{(sd()!.dayWriteBytes / 1024 / 1024 / 1024).toFixed(2)} GB/天</div>
          </div>
          <div class="rounded-lg bg-[var(--pf-grey-100)] p-3">
            <div class="text-[10px] uppercase text-[var(--pf-grey-700)]">寿命估算</div>
            <div class="font-medium">
              {sd()!.estimateDaysLeft != null ? `${sd()!.estimateDaysLeft} 天` : "数据不足"}
            </div>
          </div>
        </Show>
      </div>

      <div class="mb-4">
        <h3 class="mb-2 text-sm font-medium">OpenCode 会话</h3>
        <ul class="max-h-40 space-y-1 overflow-auto">
          <For each={sessions()} fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无会话</li>}>
            {(s) => (
              <li class="flex justify-between rounded border border-black/5 px-2 py-1 text-sm">
                <span>{s.title || s.id.slice(0, 16)}</span>
                <span class="text-xs text-[var(--pf-grey-700)]">
                  {s.createdAt ? new Date(s.createdAt).toLocaleString() : ""}
                </span>
              </li>
            )}
          </For>
        </ul>
      </div>

      <div>
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-sm font-medium">备份历史</h3>
          <button class="rounded-lg bg-[var(--pf-blue-600)] px-3 py-1.5 text-xs text-white" onClick={() => void runBackup()}>
            手动备份
          </button>
        </div>
        <ul class="space-y-1">
          <For each={backups()} fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无记录</li>}>
            {(b) => (
              <li class="flex justify-between rounded border border-black/5 px-2 py-1 text-sm">
                <span>{b.status} · {b.target}</span>
                <span class="text-xs text-[var(--pf-grey-700)]">
                  {new Date(b.started_at).toLocaleString()}
                </span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </section>
  )
}
