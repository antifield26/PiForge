import { createSignal, For, onMount, Show } from "solid-js"
import type { ServiceStatus } from "@piforge/shared"
import { api, errorText } from "./api"

// `active` may arrive as null/undefined when the unit state cannot be read.
type ServiceUnit = Omit<ServiceStatus, "active" | "confirmActions"> & {
  active: boolean | null
  confirmActions: string[]
}

const ACTION_LABELS: Record<string, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
  status: "状态",
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}

function activeBadge(active: boolean | null | undefined): { text: string; cls: string } {
  if (active === true) {
    return { text: "运行中", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" }
  }
  if (active === false) {
    return { text: "已停止", cls: "border-black/10 bg-[var(--pf-grey-100)] text-[var(--pf-grey-700)]" }
  }
  return { text: "状态未知", cls: "border-amber-200 bg-amber-50 text-amber-800" }
}

/** The list endpoint caches state briefly, so reflect a confirmed action right away. */
function activeAfter(action: string, result: string | undefined): boolean | null {
  if (result !== "ok") return null
  if (action === "start" || action === "restart") return true
  if (action === "stop") return false
  return null
}

export function ServicesPanel() {
  const [units, setUnits] = createSignal<ServiceUnit[]>([])
  const [pending, setPending] = createSignal<{ unit: string; action: string; token: string } | null>(null)
  const [msg, setMsg] = createSignal("")
  const [err, setErr] = createSignal("")
  const [busy, setBusy] = createSignal<string | null>(null)

  async function refresh() {
    try {
      const d = await api<{ items: ServiceUnit[] }>("/api/v1/console/services")
      setUnits(d.items ?? [])
      setErr("")
    } catch (e) {
      setErr(`服务列表加载失败：${errorText(e)}`)
    }
  }

  onMount(() => void refresh())

  async function act(unit: string, action: string, confirmToken?: string) {
    setBusy(`${unit}:${action}`)
    setMsg("")
    setErr("")
    let confirmed: boolean | null = null
    try {
      const body = await api<{ requiresConfirm?: boolean; confirmToken?: string; result?: string }>(
        `/api/v1/console/services/${encodeURIComponent(unit)}/${encodeURIComponent(action)}`,
        { method: "POST", body: JSON.stringify(confirmToken ? { confirmToken } : {}) },
      )
      if (body?.requiresConfirm && body.confirmToken) {
        setPending({ unit, action, token: body.confirmToken })
        setMsg(`${actionLabel(action)} ${unit} 需要确认`)
        return
      }
      setPending(null)
      setMsg(`${actionLabel(action)} ${unit}：${body?.result || "ok"}`)
      confirmed = activeAfter(action, body?.result)
    } catch (e) {
      setPending(null)
      setErr(`操作失败：${errorText(e)}`)
    } finally {
      setBusy(null)
      await refresh()
      // re-apply after the refetch: the list endpoint may still serve its cached state
      if (confirmed != null) {
        setUnits((prev) => prev.map((u) => (u.unit === unit ? { ...u, active: confirmed } : u)))
      }
    }
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
        <p class="mb-2 text-sm text-red-700" aria-live="polite">
          {err()}
        </p>
      </Show>
      <Show when={msg()}>
        <p class="mb-2 text-sm text-[var(--pf-grey-700)]" aria-live="polite">
          {msg()}
        </p>
      </Show>
      <Show when={pending()}>
        <div class="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          确认执行 <b>{actionLabel(pending()!.action)}</b> · {pending()!.unit}？
          <div class="mt-2 flex gap-2">
            <button
              class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              disabled={busy() != null}
              onClick={() => void act(pending()!.unit, pending()!.action, pending()!.token)}
            >
              确认执行
            </button>
            <button
              class="rounded-lg bg-[var(--pf-grey-100)] px-3 py-1.5 text-xs"
              onClick={() => setPending(null)}
            >
              取消
            </button>
          </div>
        </div>
      </Show>
      <ul class="space-y-2">
        <For each={units()}>
          {(u) => {
            const badge = () => activeBadge(u.active)
            return (
              <li class="flex flex-wrap items-center gap-2 rounded-lg border border-black/10 p-3">
                <div class="min-w-40 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="min-w-0 break-all font-medium">{u.label}</span>
                    <span class={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${badge().cls}`}>
                      {badge().text}
                    </span>
                  </div>
                  <div class="break-all text-xs text-[var(--pf-grey-700)]">{u.unit}</div>
                </div>
                <For each={u.allowedActions.filter((a) => a !== "status")}>
                  {(a) => (
                    <button
                      class="rounded-lg bg-[var(--pf-grey-100)] px-2.5 py-1 text-xs disabled:opacity-50"
                      disabled={busy() != null}
                      onClick={() => void act(u.unit, a)}
                    >
                      {actionLabel(a)}
                      {u.confirmActions.includes(a) ? " ⚠" : ""}
                    </button>
                  )}
                </For>
                <button
                  class="rounded-lg border border-black/10 px-2.5 py-1 text-xs disabled:opacity-50"
                  disabled={busy() != null}
                  onClick={() => void act(u.unit, "status")}
                >
                  {actionLabel("status")}
                </button>
              </li>
            )
          }}
        </For>
      </ul>
    </section>
  )
}
