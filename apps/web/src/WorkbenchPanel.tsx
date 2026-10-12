import { createSignal, For, onMount, Show } from "solid-js"
import type { Note, Todo } from "@piforge/shared"
import { api, errorText } from "./api"

export function WorkbenchPanel() {
  const [tab, setTab] = createSignal<"todos" | "notes">("todos")
  const [todos, setTodos] = createSignal<Todo[]>([])
  const [notes, setNotes] = createSignal<Note[]>([])
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
        setTodos(data.items ?? [])
      } else {
        const data = await api<{ items: Note[] }>(`/api/v1/notes${query}`)
        setNotes(data.items ?? [])
      }
      setErr("")
    } catch (e) {
      setErr(`加载失败：${errorText(e)}`)
    }
  }

  onMount(() => void refresh())

  function switchTab(next: "todos" | "notes") {
    setTab(next)
    void refresh()
  }

  async function addTodo() {
    const title = todoTitle().trim()
    if (!title) return
    setErr("")
    try {
      await api("/api/v1/todos", { method: "POST", body: JSON.stringify({ title }) })
      setTodoTitle("")
      await refresh()
    } catch (e) {
      setErr(`新建待办失败：${errorText(e)}`)
    }
  }

  async function toggleTodo(t: Todo) {
    setErr("")
    try {
      await api(`/api/v1/todos/${encodeURIComponent(t.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: t.status === "done" ? "open" : "done" }),
      })
      await refresh()
    } catch (e) {
      setErr(`更新待办失败：${errorText(e)}`)
    }
  }

  async function removeTodo(id: string) {
    setErr("")
    try {
      await api(`/api/v1/todos/${encodeURIComponent(id)}`, { method: "DELETE" })
      await refresh()
    } catch (e) {
      setErr(`删除待办失败：${errorText(e)}`)
    }
  }

  async function addNote() {
    const title = noteTitle().trim()
    if (!title) return
    const tags = noteTags()
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    setErr("")
    try {
      await api("/api/v1/notes", {
        method: "POST",
        body: JSON.stringify({ title, body: noteBody(), tags }),
      })
      setNoteTitle("")
      setNoteBody("")
      setNoteTags("")
      await refresh()
    } catch (e) {
      setErr(`新建笔记失败：${errorText(e)}`)
    }
  }

  async function removeNote(id: string) {
    setErr("")
    try {
      await api(`/api/v1/notes/${encodeURIComponent(id)}`, { method: "DELETE" })
      await refresh()
    } catch (e) {
      setErr(`删除笔记失败：${errorText(e)}`)
    }
  }

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex items-center justify-between gap-2">
        <div class="flex gap-2">
          <button
            class={`rounded-lg px-3 py-1.5 text-sm ${tab() === "todos" ? "bg-[var(--pf-blue-600)] text-white" : "bg-[var(--pf-grey-100)]"}`}
            onClick={() => switchTab("todos")}
          >
            待办
          </button>
          <button
            class={`rounded-lg px-3 py-1.5 text-sm ${tab() === "notes" ? "bg-[var(--pf-blue-600)] text-white" : "bg-[var(--pf-grey-100)]"}`}
            onClick={() => switchTab("notes")}
          >
            笔记
          </button>
        </div>
        <input
          class="min-w-0 w-40 rounded-lg border border-black/10 px-2 py-1.5 text-sm"
          placeholder="搜索…"
          aria-label="搜索待办或笔记"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void refresh()
          }}
        />
      </header>

      <Show when={err()}>
        <p class="mb-2 text-sm text-red-700" aria-live="polite">
          {err()}
        </p>
      </Show>

      <Show
        when={tab() === "todos"}
        fallback={
          <div>
            <div class="mb-3 grid gap-2">
              <label class="sr-only" for="pf-note-title">
                笔记标题
              </label>
              <input
                id="pf-note-title"
                class="rounded-lg border border-black/10 px-3 py-2 text-sm"
                placeholder="笔记标题"
                value={noteTitle()}
                onInput={(e) => setNoteTitle(e.currentTarget.value)}
              />
              <label class="sr-only" for="pf-note-body">
                笔记正文
              </label>
              <textarea
                id="pf-note-body"
                class="rounded-lg border border-black/10 px-3 py-2 text-sm"
                rows={3}
                placeholder="正文"
                value={noteBody()}
                onInput={(e) => setNoteBody(e.currentTarget.value)}
              />
              <div class="flex gap-2">
                <label class="sr-only" for="pf-note-tags">
                  笔记标签
                </label>
                <input
                  id="pf-note-tags"
                  class="min-w-0 flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm"
                  placeholder="标签，逗号分隔"
                  value={noteTags()}
                  onInput={(e) => setNoteTags(e.currentTarget.value)}
                />
                <button
                  class="shrink-0 rounded-lg bg-[var(--pf-blue-600)] px-4 py-2 text-sm text-white"
                  onClick={() => void addNote()}
                >
                  新建
                </button>
              </div>
            </div>
            <ul class="space-y-2">
              <For each={notes()} fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无笔记</li>}>
                {(n) => (
                  <li class="rounded-lg border border-black/10 p-3">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0">
                        <div class="break-all font-medium">{n.title}</div>
                        <p class="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--pf-grey-700)]">
                          {n.body}
                        </p>
                        <div class="mt-2 flex flex-wrap gap-1">
                          <For each={n.tags}>
                            {(t) => (
                              <span class="rounded bg-[var(--pf-grey-100)] px-2 py-0.5 text-xs">{t}</span>
                            )}
                          </For>
                        </div>
                      </div>
                      <button class="shrink-0 text-xs text-red-700" onClick={() => void removeNote(n.id)}>
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
          <label class="sr-only" for="pf-todo-title">
            新待办
          </label>
          <input
            id="pf-todo-title"
            class="min-w-0 flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm"
            placeholder="新待办…"
            value={todoTitle()}
            onInput={(e) => setTodoTitle(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addTodo()
            }}
          />
          <button
            class="shrink-0 rounded-lg bg-[var(--pf-blue-600)] px-4 py-2 text-sm text-white"
            onClick={() => void addTodo()}
          >
            添加
          </button>
        </div>
        <ul class="space-y-2">
          <For each={todos()} fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无待办</li>}>
            {(t) => {
              const boxId = `pf-todo-${t.id}`
              return (
                <li class="flex items-center gap-3 rounded-lg border border-black/10 p-3">
                  <input
                    id={boxId}
                    type="checkbox"
                    class="shrink-0"
                    checked={t.status === "done"}
                    onChange={() => void toggleTodo(t)}
                  />
                  <div class="min-w-0 flex-1">
                    <label
                      for={boxId}
                      class={
                        t.status === "done"
                          ? "block cursor-pointer break-all text-sm text-[var(--pf-grey-700)] line-through"
                          : "block cursor-pointer break-all text-sm"
                      }
                    >
                      {t.title}
                    </label>
                    <Show when={t.notes}>
                      <div class="break-all text-xs text-[var(--pf-grey-700)]">{t.notes}</div>
                    </Show>
                  </div>
                  <button class="shrink-0 text-xs text-red-700" onClick={() => void removeTodo(t.id)}>
                    删除
                  </button>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    </section>
  )
}
