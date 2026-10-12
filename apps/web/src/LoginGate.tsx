import { createSignal, Show, type JSX } from "solid-js"
import { api, errorText } from "./api"

export function LoginGate(props: {
  authed: boolean | null
  notice: string
  onAuthed: (authed: boolean) => void
  children: JSX.Element
}) {
  // Leave blank: prefilling "admin" helps credential stuffing and user enumeration.
  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [err, setErr] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  async function login() {
    setErr("")
    setBusy(true)
    try {
      await api("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username(), password: password() }),
      })
      setPassword("")
      props.onAuthed(true)
    } catch (e) {
      setErr(`登录失败：${errorText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show
      when={props.authed === true}
      fallback={
        <Show
          when={props.authed === false}
          fallback={<p class="p-8 text-sm text-[var(--pf-grey-700)]">检查登录状态…</p>}
        >
          <div class="mx-auto mt-24 max-w-sm rounded-xl border border-black/10 bg-white p-6 shadow-sm">
            <h1 class="mb-4 text-lg font-semibold">PiForge 登录</h1>
            <Show when={props.notice}>
              <p class="mb-3 text-sm text-amber-800" aria-live="polite">
                {props.notice}
              </p>
            </Show>
            <label class="mb-2 block text-sm" for="pf-login-username">
              用户名
            </label>
            <input
              id="pf-login-username"
              name="username"
              autocomplete="username"
              class="mb-3 w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
            />
            <label class="mb-2 block text-sm" for="pf-login-password">
              密码
            </label>
            <input
              id="pf-login-password"
              name="password"
              type="password"
              autocomplete="current-password"
              class="mb-4 w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy()) void login()
              }}
            />
            <button
              class="w-full rounded-lg bg-[var(--pf-blue-600)] px-4 py-2 text-sm text-white disabled:opacity-50"
              disabled={busy()}
              onClick={() => void login()}
            >
              {busy() ? "登录中…" : "登录"}
            </button>
            <Show when={err()}>
              <p class="mt-3 text-sm text-red-700" aria-live="polite">
                {err()}
              </p>
            </Show>
          </div>
        </Show>
      }
    >
      {props.children}
    </Show>
  )
}
