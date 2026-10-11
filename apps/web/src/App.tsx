import { AgentPanel } from "./AgentPanel"
import { ConsolePanel } from "./ConsolePanel"
import { WorkbenchPanel } from "./WorkbenchPanel"
import { CloudPanel } from "./CloudPanel"
import { LogsPanel } from "./LogsPanel"
import { OpsPanel } from "./OpsPanel"
import { LoginGate } from "./LoginGate"
import { ServicesPanel } from "./ServicesPanel"

export function App() {
  return (
    <LoginGate>
      <main class="mx-auto max-w-5xl px-6 py-10">
        <header class="mb-8">
          <h1 class="text-2xl font-semibold tracking-tight">PiForge</h1>
          <p class="mt-1 text-sm text-[var(--pf-grey-700)]">
            Pi 5 个人工作台 · 树莓派控制台 · Agent 平台
          </p>
        </header>
        <section class="mb-6 grid gap-4 sm:grid-cols-3">
          <NavCard title="个人工作台" desc="待办 / 笔记 / 书签 / 云盘" />
          <NavCard title="控制台" desc="温度 / 负载 / 服务 / SD" />
          <NavCard title="Agent" desc="OpenCode 会话与任务" />
        </section>
        <div class="grid gap-4">
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
