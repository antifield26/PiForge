import { createSignal, onMount } from "solid-js"
import { AgentPanel } from "./AgentPanel"
import { AlertsPanel } from "./AlertsPanel"
import { ConsolePanel } from "./ConsolePanel"
import { WorkbenchPanel } from "./WorkbenchPanel"
import { CloudPanel } from "./CloudPanel"
import { LogsPanel } from "./LogsPanel"
import { OpsPanel } from "./OpsPanel"
import { LoginGate } from "./LoginGate"
import { ServicesPanel } from "./ServicesPanel"
import { api, errorText, setUnauthorizedHandler } from "./api"

export function App() {
  const [authed, setAuthed] = createSignal<boolean | null>(null)
  const [notice, setNotice] = createSignal("")
  const [loggingOut, setLoggingOut] = createSignal(false)

  setUnauthorizedHandler(() => {
    if (authed() === true) setNotice("登录已过期，请重新登录")
    setAuthed(false)
  })

  onMount(() => {
    void (async () => {
      try {
        await api("/api/v1/auth/me")
        setAuthed(true)
      } catch {
        setAuthed(false)
      }
    })()
  })

  function onAuthed(next: boolean) {
    if (next) setNotice("")
    setAuthed(next)
  }

  async function logout() {
    setLoggingOut(true)
    try {
      await api("/api/v1/auth/logout", { method: "POST", body: "{}" })
    } catch (e) {
      setNotice(`退出登录请求失败：${errorText(e)}`)
    } finally {
      setLoggingOut(false)
      setAuthed(false)
    }
  }

  async function revokeOthers() {
    try {
      await api("/api/v1/auth/sessions/revoke-all", { method: "POST", body: "{}" })
      setNotice("已登出其他会话")
    } catch (e) {
      setNotice(`登出其他会话失败：${errorText(e)}`)
    }
  }

  return (
    <LoginGate authed={authed()} notice={notice()} onAuthed={onAuthed}>
      <main class="mx-auto max-w-5xl px-6 py-10">
        <header class="mb-8 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h1 class="text-2xl font-semibold tracking-tight">PiForge</h1>
            <p class="mt-1 text-sm text-[var(--pf-grey-700)]">
              Pi 5 个人工作台 · 树莓派控制台 · Agent 平台
            </p>
          </div>
          <div class="flex shrink-0 gap-2">
            <button
              class="rounded-lg border border-black/10 bg-white px-3 py-1.5 text-xs text-[var(--pf-grey-700)]"
              onClick={() => void revokeOthers()}
            >
              登出其他会话
            </button>
            <button
              class="rounded-lg border border-black/10 bg-white px-3 py-1.5 text-xs text-[var(--pf-grey-700)] disabled:opacity-50"
              disabled={loggingOut()}
              onClick={() => void logout()}
            >
              {loggingOut() ? "退出中…" : "退出登录"}
            </button>
          </div>
        </header>
        <section class="mb-6 grid gap-4 sm:grid-cols-3">
          <NavCard title="个人工作台" desc="待办 / 笔记 / 书签 / 云盘" />
          <NavCard title="控制台" desc="温度 / 负载 / 服务 / SD" />
          <NavCard title="Agent" desc="OpenCode 会话与任务" />
        </section>
        <div class="grid gap-4">
          <AlertsPanel />
          <WorkbenchPanel />
          <CloudPanel />
          <ConsolePanel />
          <ServicesPanel />
          <LogsPanel />
          <OpsPanel />
          <AgentPanel />
        </div>
      </main>
    </LoginGate>
  )
}

function NavCard(props: { title: string; desc: string }) {
  return (
    <article class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <h2 class="font-medium">{props.title}</h2>
      <p class="mt-1 text-sm text-[var(--pf-grey-700)]">{props.desc}</p>
    </article>
  )
}
