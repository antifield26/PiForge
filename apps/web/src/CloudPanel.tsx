import { createSignal, For, onMount, Show } from "solid-js"
import type { Bookmark, CloudFile } from "@piforge/shared"
import { MAX_UPLOAD_BYTES } from "@piforge/shared"
import { api, errorText } from "./api"

/** A 20 MB upload over a slow link is legitimately slow, but it must not hang forever. */
const UPLOAD_TIMEOUT_MS = 120_000

type PendingDelete = { kind: "file" | "bookmark"; id: string; label: string }

const BASE64_CHUNK = 8 * 1024

/** `btoa(String.fromCharCode(...bytes))` blows the argument limit above ~122KB. */
function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  }
  return btoa(binary)
}

/** Only http(s) links are rendered as links, so a stored `javascript:` URL cannot run. */
function httpUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

export function CloudPanel() {
  const [tab, setTab] = createSignal<"bookmarks" | "files">("bookmarks")
  const [bookmarks, setBookmarks] = createSignal<Bookmark[]>([])
  const [files, setFiles] = createSignal<CloudFile[]>([])
  const [bmUrl, setBmUrl] = createSignal("")
  const [bmTitle, setBmTitle] = createSignal("")
  const [bmFolder, setBmFolder] = createSignal("")
  const [err, setErr] = createSignal("")
  const [uploading, setUploading] = createSignal<string | null>(null)
  let uploadAbort: AbortController | null = null
  const [pendingDelete, setPendingDelete] = createSignal<PendingDelete | null>(null)
  const [deleting, setDeleting] = createSignal(false)

  async function refresh() {
    try {
      if (tab() === "bookmarks") {
        const d = await api<{ items: Bookmark[] }>("/api/v1/bookmarks")
        setBookmarks(d.items ?? [])
      } else {
        const d = await api<{ items: CloudFile[] }>("/api/v1/files")
        setFiles(d.items ?? [])
      }
      setErr("")
    } catch (e) {
      setErr(`加载失败：${errorText(e)}`)
    }
  }

  onMount(() => void refresh())

  function switchTab(next: "bookmarks" | "files") {
    setTab(next)
    setPendingDelete(null)
    void refresh()
  }

  async function addBookmark() {
    const raw = bmUrl().trim()
    if (!raw) return
    const url = httpUrl(raw)
    if (!url) {
      setErr("仅支持 http/https 链接")
      return
    }
    setErr("")
    try {
      await api("/api/v1/bookmarks", {
        method: "POST",
        body: JSON.stringify({ url, title: bmTitle() || null, folder: bmFolder() || null }),
      })
      setBmUrl("")
      setBmTitle("")
      await refresh()
    } catch (e) {
      setErr(`添加书签失败：${errorText(e)}`)
    }
  }

  async function uploadFile(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setErr(
        `「${file.name}」${(file.size / 1024 / 1024).toFixed(1)} MB，超过 20 MB 上限，未上传`,
      )
      return
    }
    setUploading(file.name)
    setErr("")
    // A stalled request used to pin `uploading` forever and leave the file input disabled with no
    // way back, so bound the request and keep a handle to abort it from the UI.
    const controller = new AbortController()
    uploadAbort = controller
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      await api("/api/v1/files", {
        method: "POST",
        body: JSON.stringify({ name: file.name, contentBase64: toBase64(bytes), mime: file.type || null }),
        signal: controller.signal,
      })
      await refresh()
    } catch (e) {
      if (controller.signal.aborted) {
        setErr(`上传「${file.name}」已取消或超时（${UPLOAD_TIMEOUT_MS / 1000}s），可重试`)
      } else {
        setErr(`上传失败：${errorText(e)}`)
      }
    } finally {
      clearTimeout(timeout)
      if (uploadAbort === controller) uploadAbort = null
      setUploading(null)
    }
  }

  async function confirmDelete() {
    const target = pendingDelete()
    if (!target) return
    setDeleting(true)
    setErr("")
    try {
      const base = target.kind === "file" ? "files" : "bookmarks"
      await api(`/api/v1/${base}/${encodeURIComponent(target.id)}`, { method: "DELETE" })
      setPendingDelete(null)
      await refresh()
    } catch (e) {
      setErr(`删除失败：${errorText(e)}`)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section class="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
      <header class="mb-3 flex gap-2">
        <button
          class={`rounded-lg px-3 py-1.5 text-sm ${tab() === "bookmarks" ? "bg-[var(--pf-blue-600)] text-white" : "bg-[var(--pf-grey-100)]"}`}
          onClick={() => switchTab("bookmarks")}
        >
          书签
        </button>
        <button
          class={`rounded-lg px-3 py-1.5 text-sm ${tab() === "files" ? "bg-[var(--pf-blue-600)] text-white" : "bg-[var(--pf-grey-100)]"}`}
          onClick={() => switchTab("files")}
        >
          云盘
        </button>
      </header>
      <Show when={err()}>
        <p class="mb-2 text-sm text-red-700" aria-live="polite">
          {err()}
        </p>
      </Show>
      <Show when={pendingDelete()}>
        <div class="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          确认删除{pendingDelete()!.kind === "file" ? "文件" : "书签"}{" "}
          <b class="break-all">{pendingDelete()!.label}</b>？
          <div class="mt-2 flex gap-2">
            <button
              class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              disabled={deleting()}
              onClick={() => void confirmDelete()}
            >
              确认删除
            </button>
            <button
              class="rounded-lg bg-[var(--pf-grey-100)] px-3 py-1.5 text-xs"
              onClick={() => setPendingDelete(null)}
            >
              取消
            </button>
          </div>
        </div>
      </Show>
      <Show
        when={tab() === "bookmarks"}
        fallback={
          <div>
            <label class="mb-3 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-black/20 p-4 text-center text-sm text-[var(--pf-grey-700)]">
              {uploading() ? `上传中：${uploading()}…` : "点击选择文件上传（≤20MB）"}
              <input
                type="file"
                class="hidden"
                disabled={uploading() != null}
                onChange={(e) => {
                  const input = e.currentTarget
                  const f = input.files?.[0]
                  if (!f) return
                  void uploadFile(f).finally(() => {
                    input.value = ""
                  })
                }}
              />
            </label>
            <p class="sr-only" aria-live="polite">
              {uploading() ? "文件上传中" : ""}
            </p>
            <Show when={uploading() != null}>
              <button
                class="mb-3 rounded-lg border border-black/10 px-2 py-1 text-xs text-[var(--pf-grey-700)]"
                onClick={() => uploadAbort?.abort()}
              >
                取消上传
              </button>
            </Show>
            <ul class="space-y-2">
              <For each={files()} fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无文件</li>}>
                {(f) => (
                  <li class="flex items-center justify-between gap-2 rounded-lg border border-black/10 p-3 text-sm">
                    <div class="min-w-0">
                      <div class="break-all font-medium">{f.name}</div>
                      <div class="text-xs text-[var(--pf-grey-700)]">{(f.size / 1024).toFixed(1)} KB</div>
                    </div>
                    <div class="flex shrink-0 gap-2">
                      <a class="text-xs text-[var(--pf-blue-600)]" href={`/api/v1/files/${f.id}`}>
                        下载
                      </a>
                      <button
                        class="text-xs text-red-700"
                        onClick={() => setPendingDelete({ kind: "file", id: f.id, label: f.name })}
                      >
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
          <label class="sr-only" for="pf-bm-url">
            书签 URL
          </label>
          <input
            id="pf-bm-url"
            class="rounded-lg border border-black/10 px-3 py-2 text-sm"
            placeholder="URL"
            value={bmUrl()}
            onInput={(e) => setBmUrl(e.currentTarget.value)}
          />
          <div class="flex gap-2">
            <label class="sr-only" for="pf-bm-title">
              书签标题
            </label>
            <input
              id="pf-bm-title"
              class="min-w-0 flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm"
              placeholder="标题"
              value={bmTitle()}
              onInput={(e) => setBmTitle(e.currentTarget.value)}
            />
            <label class="sr-only" for="pf-bm-folder">
              书签文件夹
            </label>
            <input
              id="pf-bm-folder"
              class="w-28 rounded-lg border border-black/10 px-3 py-2 text-sm"
              placeholder="夹"
              value={bmFolder()}
              onInput={(e) => setBmFolder(e.currentTarget.value)}
            />
            <button
              class="shrink-0 rounded-lg bg-[var(--pf-blue-600)] px-4 py-2 text-sm text-white"
              onClick={() => void addBookmark()}
            >
              添加
            </button>
          </div>
        </div>
        <ul class="space-y-2">
          <For each={bookmarks()} fallback={<li class="text-sm text-[var(--pf-grey-700)]">暂无书签</li>}>
            {(b) => {
              const href = () => httpUrl(b.url)
              return (
                <li class="flex items-center justify-between gap-2 rounded-lg border border-black/10 p-3 text-sm">
                  <div class="min-w-0">
                    <Show
                      when={href()}
                      fallback={<span class="break-all text-[var(--pf-grey-700)]">{b.title || b.url}</span>}
                    >
                      {(safe) => (
                        <a
                          class="break-all text-[var(--pf-blue-600)]"
                          href={safe()}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {b.title || b.url}
                        </a>
                      )}
                    </Show>
                    <div class="break-all text-xs text-[var(--pf-grey-700)]">{b.url}</div>
                  </div>
                  <button
                    class="shrink-0 text-xs text-red-700"
                    onClick={() => setPendingDelete({ kind: "bookmark", id: b.id, label: b.title || b.url })}
                  >
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
