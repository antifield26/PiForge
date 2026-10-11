import { createSignal, For, Show } from "solid-js"

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

export function LogsPanel() {
  const [unit, setUnit] = createSignal("wb-gateway.service")
  const [lines, setLines] = createSignal<string[]>([])
  const [apt, setApt] = createSignal<{ count: number; items: string[] } | null>(null)
  const [err, setErr] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  async function loadLogs() {
    setBusy(true)
    try {
      const d = await api<{ lines: string[] }>(
        `/api/v1/console/logs?unit=${encodeURIComponent(unit())}&lines=80`,
      )
      setLines(d.lines)
      setErr("")
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function loadApt() {
    try {
      const d = await api<{ count: number; items: string[] }>("/api/v1/console/apt-check")
      setApt(d)
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex flex-wrap items-center gap-2">
        <h2 class="font-medium">日志与更新</h2>
        <select
          class="rounded-lg border border-black/10 px-2 py-1.5 text-sm"
          value={unit()}
          onChange={(e) => setUnit(e.currentTarget.value)}
        >
          <option value="wb-gateway.service">wb-gateway</option>
          <option value="opencode-serve.service">opencode-serve</option>
          <option value="cloudflared.service">cloudflared</option>
          <option value="nginx.service">nginx</option>
        </select>
        <button
          class="rounded-lg bg-[var(--pf-blue-600)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={busy()}
          onClick={() => void loadLogs()}
        >
          读取日志
        </button>
        <button
          class="rounded-lg bg-[var(--pf-grey-100)] px-3 py-1.5 text-sm"
          onClick={() => void loadApt()}
        >
          检查 apt 更新
        </button>
      </header>
      <Show when={err()}>
        <p class="mb-2 text-sm text-red-700">{err()}</p>
      </Show>
      <Show when={apt()}>
        <p class="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          可更新软件包：{apt()!.count}
          <For each={apt()!.items.slice(0, 8)}>
            {(item) => (
              <span class="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs">{item.split("/")[0]}</span>
            )}
          </For>
        </p>
      </Show>
      <pre class="max-h-72 overflow-auto rounded-lg bg-[var(--pf-grey-1100)] p-3 font-mono text-xs text-[var(--pf-grey-200)]">
        {lines().join("\n") || "（暂无日志）"}
      </pre>
    </section>
  )
}
