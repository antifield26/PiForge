import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Alert, AlertThresholds } from "@piforge/shared"
import { api, errorText } from "./api"

export function AlertsPanel() {
  const [items, setItems] = createSignal<Alert[]>([])
  const [unread, setUnread] = createSignal(0)
  const [open, setOpen] = createSignal(false)
  const [thresholds, setThresholds] = createSignal<AlertThresholds | null>(null)
  const [err, setErr] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  async function load() {
    setErr("")
    try {
      const res = await api<{ items: Alert[]; unread: number }>("/api/v1/console/alerts?limit=30")
      setItems(res.items)
      setUnread(res.unread)
    } catch (e) {
      setErr(errorText(e))
    }
  }

  async function loadThresholds() {
    try {
      setThresholds(await api<AlertThresholds>("/api/v1/console/alerts/thresholds"))
    } catch {
      /* optional */
    }
  }

  async function markAllRead() {
    setBusy(true)
    try {
      await api("/api/v1/console/alerts/read", { method: "POST", body: JSON.stringify({ ids: "all" }) })
      await load()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveThresholds(e: SubmitEvent) {
    e.preventDefault()
    const t = thresholds()
    if (!t) return
    setBusy(true)
    setErr("")
    try {
      const next = await api<AlertThresholds>("/api/v1/console/alerts/thresholds", {
        method: "POST",
        body: JSON.stringify({
          sdDayWriteBytes: Number(t.sdDayWriteBytes),
          memAvailableMb: Number(t.memAvailableMb),
          cooldownMinutes: Number(t.cooldownMinutes),
        }),
      })
      setThresholds(next)
    } catch (ex) {
      setErr(errorText(ex))
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    void load()
    void loadThresholds()
    // Solid discards onMount's return value, so the interval has to be cleared in an onCleanup
    // hook: returning a disposer kept the 60s poll running after the panel unmounted (e.g. after
    // logout) for the lifetime of the tab.
    const timer = setInterval(() => void load(), 60_000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="flex items-center gap-2 font-medium">
          通知
          <Show when={unread() > 0}>
            <span class="rounded-full bg-red-600 px-2 py-0.5 text-xs text-white">{unread()}</span>
          </Show>
        </h2>
        <div class="flex gap-2">
          <button
            class="rounded-lg border border-black/10 px-2 py-1 text-xs disabled:opacity-50"
            disabled={busy()}
            onClick={() => {
              setOpen(!open())
              if (!open()) void loadThresholds()
            }}
          >
            {open() ? "收起设置" : "阈值设置"}
          </button>
          <button
            class="rounded-lg border border-black/10 px-2 py-1 text-xs disabled:opacity-50"
            disabled={busy() || unread() === 0}
            onClick={() => void markAllRead()}
          >
            全部已读
          </button>
        </div>
      </header>

      <Show when={err()}>
        <p class="mb-2 text-sm text-red-700">{err()}</p>
      </Show>

      <Show when={open() && thresholds()}>
        <form class="mb-3 grid gap-2 rounded-lg border border-black/10 p-3 text-sm sm:grid-cols-3" onSubmit={(e) => void saveThresholds(e)}>
          <label class="block">
            <span class="text-xs text-[var(--pf-grey-700)]">SD 日写入阈值 (MB)</span>
            <input
              class="mt-1 w-full rounded-lg border border-black/10 px-2 py-1"
              type="number"
              min="1"
              value={Math.round((thresholds()?.sdDayWriteBytes ?? 0) / 1024 / 1024)}
              onInput={(e) => {
                const t = thresholds()
                if (t) setThresholds({ ...t, sdDayWriteBytes: Number(e.currentTarget.value) * 1024 * 1024 })
              }}
            />
          </label>
          <label class="block">
            <span class="text-xs text-[var(--pf-grey-700)]">可用内存阈值 (MB)</span>
            <input
              class="mt-1 w-full rounded-lg border border-black/10 px-2 py-1"
              type="number"
              min="1"
              value={thresholds()?.memAvailableMb ?? 0}
              onInput={(e) => {
                const t = thresholds()
                if (t) setThresholds({ ...t, memAvailableMb: Number(e.currentTarget.value) })
              }}
            />
          </label>
          <label class="block">
            <span class="text-xs text-[var(--pf-grey-700)]">冷却（分钟）</span>
            <input
              class="mt-1 w-full rounded-lg border border-black/10 px-2 py-1"
              type="number"
              min="1"
              value={thresholds()?.cooldownMinutes ?? 0}
              onInput={(e) => {
                const t = thresholds()
                if (t) setThresholds({ ...t, cooldownMinutes: Number(e.currentTarget.value) })
              }}
            />
          </label>
          <button class="rounded-lg bg-[var(--pf-blue-600,#3b5cf6)] px-3 py-1.5 text-xs text-white sm:col-span-3" disabled={busy()}>
            保存阈值
          </button>
        </form>
      </Show>

      <Show when={items().length > 0} fallback={<p class="text-sm text-[var(--pf-grey-700)]">暂无通知</p>}>
        <ul class="space-y-2">
          <For each={items()}>
            {(a) => (
              <li
                class={`rounded-lg border px-3 py-2 text-sm ${
                  a.readAt == null ? "border-red-200 bg-red-50" : "border-black/10 bg-white"
                }`}
              >
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class={`rounded px-1.5 py-0.5 text-xs ${
                      a.severity === "critical"
                        ? "bg-red-700 text-white"
                        : a.severity === "warning"
                          ? "bg-amber-600 text-white"
                          : "bg-black/10 text-[var(--pf-grey-700)]"
                    }`}
                  >
                    {a.severity}
                  </span>
                  <span class="font-medium">{a.title}</span>
                  <span class="text-xs text-[var(--pf-grey-700)]">{new Date(a.createdAt).toLocaleString()}</span>
                </div>
                <p class="mt-1 text-[var(--pf-grey-700)]">{a.message}</p>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
