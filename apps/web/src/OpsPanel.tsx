import { createSignal, For, onMount, Show } from "solid-js"
import type { AgentSession, SdHealth } from "@piforge/shared"
import { api, errorText } from "./api"

type BackupRun = {
  id: number
  started_at: number
  status: string
  target: string
  message: string | null
}

const BACKUP_STATUS_LABELS: Record<string, string> = {
  ok: "成功",
  partial: "不完整",
  failed: "失败",
  running: "进行中",
}

function backupStatus(status: string): string {
  return BACKUP_STATUS_LABELS[status] ?? status
}

export function OpsPanel() {
  const [sd, setSd] = createSignal<SdHealth | null>(null)
  const [sessions, setSessions] = createSignal<AgentSession[]>([])
  const [backups, setBackups] = createSignal<BackupRun[]>([])
  const [err, setErr] = createSignal("")
  const [note, setNote] = createSignal("")
  const [confirming, setConfirming] = createSignal(false)
  const [backupBusy, setBackupBusy] = createSignal(false)

  async function refresh() {
    const [s, a, b] = await Promise.allSettled([
      api<SdHealth>("/api/v1/console/sd"),
      api<{ items: AgentSession[] }>("/api/v1/agent/sessions"),
      api<{ items: BackupRun[] }>("/api/v1/console/backups"),
    ])

    const problems: string[] = []
    if (s.status === "fulfilled") setSd(s.value)
    else problems.push(`SD：${errorText(s.reason)}`)
    if (a.status === "fulfilled") setSessions(a.value.items ?? [])
    else problems.push(`会话：${errorText(a.reason)}`)
    if (b.status === "fulfilled") setBackups(b.value.items ?? [])
    else problems.push(`备份：${errorText(b.reason)}`)
    setErr(problems.join("；"))
  }

  onMount(() => void refresh())

  async function runBackup() {
    setConfirming(false)
    setBackupBusy(true)
    setNote("触发备份中…")
    try {
      await api("/api/v1/console/backups/run", { method: "POST", body: "{}" })
      setNote("备份已触发")
      await refresh()
    } catch (e) {
      setNote(`备份失败：${errorText(e)}`)
    } finally {
      setBackupBusy(false)
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
        <p class="mb-2 text-sm text-red-700" aria-live="polite">
          {err()}
        </p>
      </Show>
      <Show when={note()}>
        <p class="mb-2 text-sm text-[var(--pf-grey-700)]" aria-live="polite">
          {note()}
        </p>
      </Show>

      <div class="mb-4 grid gap-3 sm:grid-cols-3">
        <Show when={sd()} fallback={<p class="text-sm text-[var(--pf-grey-700)]">SD 数据不可用</p>}>
          <div class="rounded-lg bg-[var(--pf-grey-100)] p-3">
            <div class="text-[10px] uppercase text-[var(--pf-grey-700)]">SD 型号</div>
            <div class="break-all font-medium">{sd()!.model}</div>
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
              <li class="flex justify-between gap-2 rounded border border-black/5 px-2 py-1 text-sm">
                <span class="min-w-0 break-all">{s.title || s.id.slice(0, 16)}</span>
                <span class="shrink-0 text-xs text-[var(--pf-grey-700)]">
                  {s.createdAt ? new Date(s.createdAt).toLocaleString() : ""}
                </span>
              </li>
            )}
          </For>
        </ul>
      </div>

      <div class="mb-4">
        <div class="mb-2 flex items-center justify-between gap-2">
          <h3 class="text-sm font-medium">监控历史</h3>
          <span class="flex shrink-0 gap-2 text-xs">
            <For each={["temp", "cpu", "mem", "disk_write"] as const}>
              {(kind) => (
                <a
                  class="rounded border border-black/10 px-2 py-1 text-[var(--pf-grey-700)] hover:bg-[var(--pf-grey-100)]"
                  href={`/api/v1/console/metrics/export?kind=${kind}&format=csv&from=${Date.now() - 7 * 86400_000}&to=${Date.now()}`}
                  download=""
                >
                  {kind} CSV
                </a>
              )}
            </For>
          </span>
        </div>
        <p class="text-xs text-[var(--pf-grey-700)]">导出最近 7 天原始采样点（CSV）。</p>
      </div>

      <div>
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-sm font-medium">备份历史</h3>
          <button
            class="rounded-lg bg-[var(--pf-blue-600)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
            disabled={backupBusy()}
            onClick={() => setConfirming(true)}
          >
            {backupBusy() ? "备份中…" : "手动备份"}
          </button>
        </div>
        <Show when={confirming()}>
          <div class="mb-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
            确认执行 <b>手动备份</b>？备份脚本运行期间可能产生较多磁盘写入。
            <div class="mt-2 flex gap-2">
              <button
                class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                disabled={backupBusy()}
                onClick={() => void runBackup()}
              >
                确认执行
              </button>
              <button
                class="rounded-lg bg-[var(--pf-grey-100)] px-3 py-1.5 text-xs"
                onClick={() => setConfirming(false)}
              >
                取消
              </button>
            </div>
          </div>
        </Show>
        <ul class="space-y-1">
          <For each={backups()} fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无记录</li>}>
            {(b) => (
              <li class="flex justify-between gap-2 rounded border border-black/5 px-2 py-1 text-sm">
                <span class="min-w-0 break-all">
                  {backupStatus(b.status)} · {b.target}
                </span>
                <span class="shrink-0 text-xs text-[var(--pf-grey-700)]">
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
