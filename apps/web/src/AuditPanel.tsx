import { createSignal, For, onMount, Show } from "solid-js"
import type { AuditEntry } from "@piforge/shared"
import { api, errorText } from "./api"

type LoginAuditRow = {
  id: number
  ts: number
  username: string
  ok: number
  client_ip: string | null
  user_agent: string | null
}

type Tab = "service" | "login"

export function AuditPanel() {
  const [tab, setTab] = createSignal<Tab>("service")
  const [service, setService] = createSignal<AuditEntry[]>([])
  const [login, setLogin] = createSignal<LoginAuditRow[]>([])
  const [units, setUnits] = createSignal<string[]>([])
  const [unit, setUnit] = createSignal("")
  const [action, setAction] = createSignal("")
  const [resultFilter, setResultFilter] = createSignal<"" | "0" | "1">("")
  const [err, setErr] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  async function load() {
    setErr("")
    setBusy(true)
    try {
      if (tab() === "service") {
        const qs = new URLSearchParams({ limit: "100" })
        if (unit()) qs.set("unit", unit())
        if (action()) qs.set("action", action())
        if (resultFilter()) qs.set("allowed", resultFilter())
        const res = await api<{ items: AuditEntry[]; units: string[] }>(`/api/v1/console/audit?${qs}`)
        setService(res.items)
        setUnits(res.units)
      } else {
        const qs = new URLSearchParams({ limit: "100" })
        if (resultFilter()) qs.set("ok", resultFilter())
        const res = await api<{ items: LoginAuditRow[] }>(`/api/v1/console/audit/login?${qs}`)
        setLogin(res.items)
      }
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function exportCsv() {
    const qs = new URLSearchParams({ kind: tab() === "login" ? "login" : "service", limit: "2000" })
    if (tab() === "service" && unit()) qs.set("unit", unit())
    if (tab() === "service" && action()) qs.set("action", action())
    try {
      const res = await fetch(`/api/v1/console/audit/export?${qs}`, { credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `audit-${tab()}-${Date.now()}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(`导出失败：${errorText(e)}`)
    }
  }

  onMount(() => void load())

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-medium">审计</h2>
        <div class="flex flex-wrap gap-2">
          <div class="flex rounded-lg border border-black/10 text-xs">
            <button
              class={`px-2 py-1 ${tab() === "service" ? "bg-black/10 font-medium" : ""}`}
              onClick={() => {
                setTab("service")
                void load()
              }}
            >
              服务控制
            </button>
            <button
              class={`px-2 py-1 ${tab() === "login" ? "bg-black/10 font-medium" : ""}`}
              onClick={() => {
                setTab("login")
                void load()
              }}
            >
              登录
            </button>
          </div>
          <button class="rounded-lg border border-black/10 px-2 py-1 text-xs" disabled={busy()} onClick={() => void load()}>
            刷新
          </button>
          <button class="rounded-lg border border-black/10 px-2 py-1 text-xs" onClick={exportCsv}>
            导出 CSV
          </button>
        </div>
      </header>

      <div class="mb-3 flex flex-wrap gap-2 text-xs">
        <Show when={tab() === "service"}>
          <label class="flex items-center gap-1">
            <span class="text-[var(--pf-grey-700)]">单元</span>
            <select
              class="rounded-lg border border-black/10 px-2 py-1"
              value={unit()}
              onChange={(e) => {
                setUnit(e.currentTarget.value)
                void load()
              }}
            >
              <option value="">全部</option>
              <For each={units()}>{(u) => <option value={u}>{u}</option>}</For>
            </select>
          </label>
          <label class="flex items-center gap-1">
            <span class="text-[var(--pf-grey-700)]">动作</span>
            <select
              class="rounded-lg border border-black/10 px-2 py-1"
              value={action()}
              onChange={(e) => {
                setAction(e.currentTarget.value)
                void load()
              }}
            >
              <option value="">全部</option>
              <option value="start">start</option>
              <option value="stop">stop</option>
              <option value="restart">restart</option>
              <option value="status">status</option>
            </select>
          </label>
        </Show>
        <label class="flex items-center gap-1">
          <span class="text-[var(--pf-grey-700)]">{tab() === "login" ? "结果" : "允许"}</span>
          <select
            class="rounded-lg border border-black/10 px-2 py-1"
            value={resultFilter()}
            onChange={(e) => {
              setResultFilter(e.currentTarget.value as "" | "0" | "1")
              void load()
            }}
          >
            <option value="">全部</option>
            <option value="1">{tab() === "login" ? "成功" : "允许"}</option>
            <option value="0">{tab() === "login" ? "失败" : "拒绝"}</option>
          </select>
        </label>
      </div>

      <Show when={err()}>
        <p class="mb-2 text-sm text-red-700">{err()}</p>
      </Show>

      <div class="overflow-x-auto">
        <Show when={tab() === "service"} fallback={<LoginTable rows={login()} />}>
          <ServiceTable rows={service()} />
        </Show>
      </div>
    </section>
  )
}

function ServiceTable(props: { rows: AuditEntry[] }) {
  return (
    <Show when={props.rows.length > 0} fallback={<p class="text-sm text-[var(--pf-grey-700)]">无记录</p>}>
      <table class="w-full text-left text-xs">
        <thead class="border-b border-black/10 text-[var(--pf-grey-700)]">
          <tr>
            <th class="py-1 pr-2">时间</th>
            <th class="py-1 pr-2">单元</th>
            <th class="py-1 pr-2">动作</th>
            <th class="py-1 pr-2">结果</th>
            <th class="py-1 pr-2">详情</th>
            <th class="py-1">IP</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(r) => (
              <tr class="border-b border-black/5">
                <td class="py-1 pr-2 whitespace-nowrap">{new Date(r.ts).toLocaleString()}</td>
                <td class="py-1 pr-2">{r.unit}</td>
                <td class="py-1 pr-2">{r.action}</td>
                <td class="py-1 pr-2">
                  <span class={r.allowed ? "text-green-700" : "text-red-700"}>{r.allowed ? "允许" : "拒绝"}</span>
                </td>
                <td class="py-1 pr-2 max-w-xs truncate">{r.result}</td>
                <td class="py-1">{r.client_ip ?? ""}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  )
}

function LoginTable(props: { rows: LoginAuditRow[] }) {
  return (
    <Show when={props.rows.length > 0} fallback={<p class="text-sm text-[var(--pf-grey-700)]">无记录</p>}>
      <table class="w-full text-left text-xs">
        <thead class="border-b border-black/10 text-[var(--pf-grey-700)]">
          <tr>
            <th class="py-1 pr-2">时间</th>
            <th class="py-1 pr-2">用户</th>
            <th class="py-1 pr-2">结果</th>
            <th class="py-1 pr-2">IP</th>
            <th class="py-1">UA</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(r) => (
              <tr class="border-b border-black/5">
                <td class="py-1 pr-2 whitespace-nowrap">{new Date(r.ts).toLocaleString()}</td>
                <td class="py-1 pr-2">{r.username}</td>
                <td class="py-1 pr-2">
                  <span class={r.ok ? "text-green-700" : "text-red-700"}>{r.ok ? "成功" : "失败"}</span>
                </td>
                <td class="py-1 pr-2">{r.client_ip ?? ""}</td>
                <td class="py-1 max-w-xs truncate">{r.user_agent ?? ""}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  )
}
