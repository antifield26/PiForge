import { createSignal, Show } from "solid-js"

export function LoginGate(props: { children: any }) {
  const [authed, setAuthed] = createSignal<boolean | null>(null)
  const [username, setUsername] = createSignal("admin")
  const [password, setPassword] = createSignal("")
  const [err, setErr] = createSignal("")

  async function check() {
    try {
      const res = await fetch("/api/v1/auth/me", { credentials: "include" })
      setAuthed(res.ok)
    } catch {
      setAuthed(false)
    }
  }

  void check()

  async function login() {
    setErr("")
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: username(), password: password() }),
    })
    if (res.ok) {
      setAuthed(true)
    } else {
      const t = await res.text()
      setErr(t || "登录失败")
    }
  }

  return (
    <Show when={authed() === true} fallback={
      <Show when={authed() === false} fallback={<p class="p-8 text-sm text-[var(--pf-grey-700)]">检查登录状态…</p>}>
        <div class="mx-auto mt-24 max-w-sm rounded-xl border border-black/10 bg-white p-6 shadow-sm">
          <h1 class="mb-4 text-lg font-semibold">PiForge 登录</h1>
          <label class="mb-2 block text-sm">用户名</label>
          <input
            class="mb-3 w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
            value={username()}
            onInput={(e) => setUsername(e.currentTarget.value)}
          />
          <label class="mb-2 block text-sm">密码</label>
          <input
            type="password"
            class="mb-4 w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void login()
            }}
          />
          <button
            class="w-full rounded-lg bg-[var(--pf-blue-600)] px-4 py-2 text-sm text-white"
            onClick={() => void login()}
          >
            登录
          </button>
          <Show when={err()}>
            <p class="mt-3 text-sm text-red-700">{err()}</p>
          </Show>
        </div>
      </Show>
    }>
      {props.children}
    </Show>
  )
}
