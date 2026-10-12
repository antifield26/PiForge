import type { ApiError as ApiErrorEnvelope } from "@piforge/shared"

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

let unauthorizedHandler: (() => void) | null = null

/** Wired once by App so any 401 can drop the UI back to the login gate. */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler
}

function errorFrom(status: number, text: string): ApiError {
  let body: (ApiErrorEnvelope & { message?: string }) | null = null
  try {
    body = text ? (JSON.parse(text) as ApiErrorEnvelope & { message?: string }) : null
  } catch {
    body = null
  }
  const code = body?.error?.code ?? "HTTP_ERROR"
  const message = body?.error?.message ?? body?.message ?? `请求失败（HTTP ${status}）`
  return new ApiError(status, code, message)
}

/**
 * Single fetch wrapper for the gateway API: sends the session cookie, unwraps the
 * `{error:{code,message}}` envelope and reports 401 (expired session) upwards.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json")

  const res = await fetch(path, { credentials: "include", ...init, headers })
  const text = res.status === 204 ? "" : await res.text()

  if (res.status === 401) {
    unauthorizedHandler?.()
    throw errorFrom(401, text)
  }
  if (!res.ok) throw errorFrom(res.status, text)
  if (!text) return undefined as T

  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(res.status, "INVALID_JSON", "响应不是合法的 JSON")
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** `crypto.randomUUID` is missing on plain-HTTP origins (LAN access), so fall back. */
export function randomId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID()
    } catch {
      /* not available on this origin */
    }
  }

  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
