import { createSignal, onCleanup, onMount } from "solid-js"
import type { SystemSnapshot } from "@piforge/shared"
import { api, errorText } from "./api"

const POLL_MS = 5000

export function ConsolePanel() {
  const [snap, setSnap] = createSignal<SystemSnapshot | null>(null)
  const [err, setErr] = createSignal("")

  async function refresh() {
    try {
      const data = await api<SystemSnapshot>("/api/v1/console/system")
      setSnap(data)
      setErr("")
    } catch (e) {
      setErr(errorText(e))
    }
  }

  onMount(() => {
    void refresh()
    // pause the 5s poll while the tab is in the background
    const timer = setInterval(() => {
      if (!document.hidden) void refresh()
    }, POLL_MS)
    const onVisibility = () => {
      if (!document.hidden) void refresh()
    }
    document.addEventListener("visibilitychange", onVisibility)
    onCleanup(() => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    })
  })

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex items-center justify-between">
        <h2 class="font-medium">树莓派控制台</h2>
        <button class="text-xs text-[var(--pf-blue-600)]" onClick={() => void refresh()}>
          刷新
        </button>
      </header>
      {err() ? (
        <p class="text-sm text-red-700" aria-live="polite">
          无法读取系统状态：{err()}
        </p>
      ) : snap() ? (
        <dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="温度" value={`${snap()!.tempC.toFixed(1)} °C`} />
          <Stat label="负载 1m" value={snap()!.load1.toFixed(2)} />
          <Stat
            label="可用内存"
            value={`${(snap()!.memAvailableKb / 1024 / 1024).toFixed(2)} GB`}
          />
          <Stat label="SD 写入" value={`${(snap()!.diskWriteBps / 1024).toFixed(1)} KB/s`} />
          <Stat label="SD 累计" value={`${(snap()!.sdTotalWriteBytes / 1024 ** 3).toFixed(2)} GB`} />
          <Stat label="降频" value={snap()!.throttled} />
          <Stat label="运行" value={`${Math.floor(snap()!.uptimeSec / 3600)}h`} />
        </dl>
      ) : (
        <p class="text-sm text-[var(--pf-grey-700)]">加载中…</p>
      )}
    </section>
  )
}

function Stat(props: { label: string; value: string }) {
  return (
    <div class="rounded-lg bg-[var(--pf-grey-100)] p-3">
      <dt class="text-[10px] uppercase tracking-wide text-[var(--pf-grey-700)]">{props.label}</dt>
      <dd class="mt-1 break-all font-medium tabular-nums">{props.value}</dd>
    </div>
  )
}
