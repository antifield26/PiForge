import { createSignal, For, onMount, Show } from "solid-js"

type Unit = {
  unit: string
  label: string
  allowedActions: string[]
  confirmActions: string[]
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, body: json } as T
}

export function ServicesPanel() {
  const [units, setUnits] = createSignal<Unit[]>([])
  const [pending, setPending] = createSignal<{ unit: string; action: string; token: string } | null>(null)
  const [msg, setMsg] = createSignal("")
  const [err, setErr] = createSignal("")

  async function refresh() {
    try {
      const res = await fetch("/api/v1/console/services", { credentials: "include" })
      const d = await res.json()
      setUnits(d.items || [])
      setErr("")
    } catch (e) {
      setErr(String(e))
    }
  }

  onMount(() => void refresh())

  async function act(unit: string, action: string, confirmToken?: string) {
    const res = await fetch(`/api/v1/console/services/${encodeURIComponent(unit)}/${action}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(confirmToken ? { confirmToken } : {}),
    })
    const body = await res.json()
    if (res.status === 202 && body.requiresConfirm) {
      setPending({ unit, action, token: body.confirmToken })
      setMsg(`${action} ${unit} 需要确认`)
      return
    }
    if (!res.ok) {
      setMsg(`失败: ${body?.error?.message || res.status}`)
    } else {
      setMsg(`${action} ${unit}: ${body.result || "ok"}`)
    }
    setPending(null)
    await refresh()
  }

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex items-center justify-between">
        <h2 class="font-medium">服务控制（白名单）</h2>
        <button class="text-xs text-[var(--pf-blue-600)]" onClick={() => void refresh()}>
          刷新
        </button>
      </header>
      <Show when={err()}>
        <p class="mb-2 text-sm text-red-700">{err()}</p>
      </Show>
      <Show when={msg()}>
        <p class="mb-2 text-sm text-[var(--pf-grey-700)]">{msg()}</p>
      </Show>
      <Show when={pending()}>
        <div class="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          确认执行 <b>{pending()!.action}</b> · {pending()!.unit}？
          <div class="mt-2 flex gap-2">
            <button
              class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs text-white"
              onClick={() => void act(pending()!.unit, pending()!.action, pending()!.token)}
            >
              确认执行
            </button>
            <button class="rounded-lg bg-[var(--pf-grey-100)] px-3 py-1.5 text-xs" onClick={() => setPending(null)}>
              取消
            </button>
          </div>
        </div>
      </Show>
      <ul class="space-y-2">
        <For each={units()}>
          {(u) => (
            <li class="flex flex-wrap items-center gap-2 rounded-lg border border-black/10 p-3">
              <div class="min-w-40 flex-1">
                <div class="font-medium">{u.label}</div>
                <div class="text-xs text-[var(--pf-grey-700)]">{u.unit}</div>
              </div>
              <For each={u.allowedActions.filter((a) => a !== "status")}>
                {(a) => (
                  <button
                    class="rounded-lg bg-[var(--pf-grey-100)] px-2.5 py-1 text-xs"
                    onClick={() => void act(u.unit, a)}
                  >
                    {a}
                    {u.confirmActions.includes(a) ? " ⚠" : ""}
                  </button>
                )}
              </For>
              <button
                class="rounded-lg border border-black/10 px-2.5 py-1 text-xs"
                onClick={() => void act(u.unit, "status")}
              >
                status
              </button>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}
