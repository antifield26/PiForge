import { createSignal, For, onMount, Show } from "solid-js"

type Bookmark = { id: string; url: string; title: string | null; folder: string | null }
type CloudFile = { id: string; name: string; size: number; createdAt: number }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  if (res.status === 204) return undefined as T
  return res.json()
}

export function CloudPanel() {
  const [tab, setTab] = createSignal<"bookmarks" | "files">("bookmarks")
  const [bookmarks, setBookmarks] = createSignal<Bookmark[]>([])
  const [files, setFiles] = createSignal<CloudFile[]>([])
  const [bmUrl, setBmUrl] = createSignal("")
  const [bmTitle, setBmTitle] = createSignal("")
  const [bmFolder, setBmFolder] = createSignal("")
  const [err, setErr] = createSignal("")

  async function refresh() {
    try {
      if (tab() === "bookmarks") {
        const d = await api<{ items: Bookmark[] }>("/api/v1/bookmarks")
        setBookmarks(d.items)
      } else {
        const d = await api<{ items: CloudFile[] }>("/api/v1/files")
        setFiles(d.items)
      }
      setErr("")
    } catch (e) {
      setErr(String(e))
    }
  }

  onMount(() => void refresh())

  async function addBookmark() {
    const url = bmUrl().trim()
    if (!url) return
    await api("/api/v1/bookmarks", {
      method: "POST",
      body: JSON.stringify({ url, title: bmTitle() || null, folder: bmFolder() || null }),
    })
    setBmUrl("")
    setBmTitle("")
    await refresh()
  }

  async function removeBookmark(id: string) {
    await api(`/api/v1/bookmarks/${id}`, { method: "DELETE" })
    await refresh()
  }

  async function uploadFile(file: File) {
    const buf = await file.arrayBuffer()
    const contentBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
    await api("/api/v1/files", {
      method: "POST",
      body: JSON.stringify({ name: file.name, contentBase64, mime: file.type || null }),
    })
    await refresh()
  }

  async function removeFile(id: string) {
    await api(`/api/v1/files/${id}`, { method: "DELETE" })
    await refresh()
  }

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex gap-2">
        <button
          class={`rounded-lg px-3 py-1.5 text-sm ${tab() === "bookmarks" ? "bg-[var(--pf-blue-600)] text-white" : "bg-[var(--pf-grey-100)]"}`}
          onClick={() => {
            setTab("bookmarks")
            setTimeout(() => void refresh(), 0)
          }}
        >
          书签
        </button>
        <button
          class={`rounded-lg px-3 py-1.5 text-sm ${tab() === "files" ? "bg-[var(--pf-blue-600)] text-white" : "bg-[var(--pf-grey-100)]"}`}
          onClick={() => {
            setTab("files")
            setTimeout(() => void refresh(), 0)
          }}
        >
          云盘
        </button>
      </header>
      <Show when={err()}>
        <p class="mb-2 text-sm text-red-700">{err()}</p>
      </Show>
      <Show
        when={tab() === "bookmarks"}
        fallback={
          <div>
            <label class="mb-3 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-black/20 p-4 text-sm text-[var(--pf-grey-700)]">
              点击选择文件上传（≤20MB）
              <input
                type="file"
                class="hidden"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0]
                  if (f) void uploadFile(f)
                }}
              />
            </label>
            <ul class="space-y-2">
              <For each={files()} fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无文件</li>}>
                {(f) => (
                  <li class="flex items-center justify-between rounded-lg border border-black/10 p-3 text-sm">
                    <div>
                      <div class="font-medium">{f.name}</div>
                      <div class="text-xs text-[var(--pf-grey-700)]">{(f.size / 1024).toFixed(1)} KB</div>
                    </div>
                    <div class="flex gap-2">
                      <a class="text-xs text-[var(--pf-blue-600)]" href={`/api/v1/files/${f.id}`}>
                        下载
                      </a>
                      <button class="text-xs text-red-700" onClick={() => void removeFile(f.id)}>
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
        <div class="mb-3 grid gap-2">
          <input
            class="rounded-lg border border-black/10 px-3 py-2 text-sm"
            placeholder="URL"
            value={bmUrl()}
            onInput={(e) => setBmUrl(e.currentTarget.value)}
          />
          <div class="flex gap-2">
            <input
              class="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm"
              placeholder="标题"
              value={bmTitle()}
              onInput={(e) => setBmTitle(e.currentTarget.value)}
            />
            <input
              class="w-28 rounded-lg border border-black/10 px-3 py-2 text-sm"
              placeholder="夹"
              value={bmFolder()}
              onInput={(e) => setBmFolder(e.currentTarget.value)}
            />
            <button class="rounded-lg bg-[var(--pf-blue-600)] px-4 py-2 text-sm text-white" onClick={() => void addBookmark()}>
              添加
            </button>
          </div>
        </div>
        <ul class="space-y-2">
          <For each={bookmarks()} fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无书签</li>}>
            {(b) => (
              <li class="flex items-center justify-between rounded-lg border border-black/10 p-3 text-sm">
                <div>
                  <a class="text-[var(--pf-blue-600)]" href={b.url} target="_blank" rel="noreferrer">
                    {b.title || b.url}
                  </a>
                  <div class="text-xs text-[var(--pf-grey-700)]">{b.url}</div>
                </div>
                <button class="text-xs text-red-700" onClick={() => void removeBookmark(b.id)}>
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
