import { createSignal, For, onMount, Show } from "solid-js"

type Todo = {
  id: string
  title: string
  notes: string | null
  status: string
  dueAt: number | null
  createdAt: number
  updatedAt: number
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status} ${body}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export function WorkbenchPanel() {
  const [tab, setTab] = createSignal<"todos" | "notes">("todos")
  const [todos, setTodos] = createSignal<Todo[]>([])
  const [notes, setNotes] = createSignal<
    { id: string; title: string; body: string; tags: string[]; updatedAt: number }[]
  >([])
  const [q, setQ] = createSignal("")
  const [todoTitle, setTodoTitle] = createSignal("")
  const [noteTitle, setNoteTitle] = createSignal("")
  const [noteBody, setNoteBody] = createSignal("")
  const [noteTags, setNoteTags] = createSignal("")
  const [err, setErr] = createSignal("")

  async function refresh() {
    try {
      const query = q().trim() ? `?q=${encodeURIComponent(q().trim())}` : ""
      if (tab() === "todos") {
        const data = await api<{ items: Todo[] }>(`/api/v1/todos${query}`)
        setTodos(data.items)
      } else {
        const data = await api<{ items: typeof notes extends () => infer T ? T : never }>(
          `/api/v1/notes${query}`,
        )
        setNotes(data.items)
      }
      setErr("")
    } catch (e) {
      setErr(String(e))
    }
  }

  onMount(() => void refresh())

  async function addTodo() {
    const title = todoTitle().trim()
    if (!title) return
    await api("/api/v1/todos", { method: "POST", body: JSON.stringify({ title }) })
    setTodoTitle("")
    await refresh()
  }

  async function toggleTodo(t: Todo) {
    await api(`/api/v1/todos/${t.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: t.status === "done" ? "open" : "done" }),
    })
    await refresh()
  }

  async function removeTodo(id: string) {
    await api(`/api/v1/todos/${id}`, { method: "DELETE" })
    await refresh()
  }

  async function addNote() {
    const title = noteTitle().trim()
    if (!title) return
    const tags = noteTags()
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    await api("/api/v1/notes", {
      method: "POST",
      body: JSON.stringify({ title, body: noteBody(), tags }),
    })
    setNoteTitle("")
    setNoteBody("")
    setNoteTags("")
    await refresh()
  }

  async function removeNote(id: string) {
    await api(`/api/v1/notes/${id}`, { method: "DELETE" })
    await refresh()
  }

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex items-center justify-between gap-2">
        <div class="flex gap-2">
          <button
            class={`rounded-lg px-3 py-1.5 text-sm ${tab() === "todos" ? "bg-[var(--pf-blue-600)] text-white" : "bg-[var(--pf-grey-100)]"}`}
            onClick={() => {
              setTab("todos")
              setTimeout(() => void refresh(), 0)
            }}
          >
            待办
          </button>
          <button
            class={`rounded-lg px-3 py-1.5 text-sm ${tab() === "notes" ? "bg-[var(--pf-blue-600)] text-white" : "bg-[var(--pf-grey-100)]"}`}
            onClick={() => {
              setTab("notes")
              setTimeout(() => void refresh(), 0)
            }}
          >
            笔记
          </button>
        </div>
        <input
          class="w-40 rounded-lg border border-black/10 px-2 py-1.5 text-sm"
          placeholder="搜索…"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void refresh()
          }}
        />
      </header>

      <Show when={err()}>
        <p class="mb-2 text-sm text-red-700">{err()}</p>
      </Show>

      <Show
        when={tab() === "todos"}
        fallback={
          <div>
            <div class="mb-3 grid gap-2">
              <input
                class="rounded-lg border border-black/10 px-3 py-2 text-sm"
                placeholder="笔记标题"
                value={noteTitle()}
                onInput={(e) => setNoteTitle(e.currentTarget.value)}
              />
              <textarea
                class="rounded-lg border border-black/10 px-3 py-2 text-sm"
                rows={3}
                placeholder="正文"
                value={noteBody()}
                onInput={(e) => setNoteBody(e.currentTarget.value)}
              />
              <div class="flex gap-2">
                <input
                  class="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm"
                  placeholder="标签，逗号分隔"
                  value={noteTags()}
                  onInput={(e) => setNoteTags(e.currentTarget.value)}
                />
                <button class="rounded-lg bg-[var(--pf-blue-600)] px-4 py-2 text-sm text-white" onClick={() => void addNote()}>
                  新建
                </button>
              </div>
            </div>
            <ul class="space-y-2">
              <For
                each={notes()}
                fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无笔记</li>}
              >
                {(n) => (
                  <li class="rounded-lg border border-black/10 p-3">
                    <div class="flex items-start justify-between gap-2">
                      <div>
                        <div class="font-medium">{n.title}</div>
                        <p class="mt-1 whitespace-pre-wrap text-sm text-[var(--pf-grey-700)]">{n.body}</p>
                        <div class="mt-2 flex flex-wrap gap-1">
                          <For each={n.tags}>
                            {(t) => (
                              <span class="rounded bg-[var(--pf-grey-100)] px-2 py-0.5 text-xs">{t}</span>
                            )}
                          </For>
                        </div>
                      </div>
                      <button class="text-xs text-red-700" onClick={() => void removeNote(n.id)}>
                        删除
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </div>
        }
      >
        <div class="mb-3 flex gap-2">
          <input
            class="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm"
            placeholder="新待办…"
            value={todoTitle()}
            onInput={(e) => setTodoTitle(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addTodo()
            }}
          />
          <button class="rounded-lg bg-[var(--pf-blue-600)] px-4 py-2 text-sm text-white" onClick={() => void addTodo()}>
            添加
          </button>
        </div>
        <ul class="space-y-2">
          <For each={todos()} fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无待办</li>}>
            {(t) => (
              <li class="flex items-center gap-3 rounded-lg border border-black/10 p-3">
                <input type="checkbox" checked={t.status === "done"} onChange={() => void toggleTodo(t)} />
                <div class="flex-1">
                  <div class={t.status === "done" ? "text-sm text-[var(--pf-grey-700)] line-through" : "text-sm"}>
                    {t.title}
                  </div>
                  <Show when={t.notes}>
                    <div class="text-xs text-[var(--pf-grey-700)]">{t.notes}</div>
                  </Show>
                </div>
                <button class="text-xs text-red-700" onClick={() => void removeTodo(t.id)}>
                  删除
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
