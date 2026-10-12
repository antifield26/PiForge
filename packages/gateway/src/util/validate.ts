import type { FastifyReply } from "fastify"

export interface ApiErrorBody {
  error: { code: string; message: string }
}

export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } }
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return reply.code(status).send({ ...errorBody(code, message), ...(extra ?? {}) })
}

export function asTrimmedString(value: unknown, maxLength = 2000): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

export function asOptionalString(value: unknown, maxLength = 20_000): string | null {
  if (typeof value !== "string") return null
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

export function asStringArray(value: unknown, maxItems = 50, maxLength = 64): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value.slice(0, maxItems)) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (trimmed) out.push(trimmed.slice(0, maxLength))
  }
  return [...new Set(out)]
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = asFiniteNumber(value)
  if (n === null) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

export function isTodoStatus(value: string): value is "open" | "done" | "archived" {
  return value === "open" || value === "done" || value === "archived"
}

/** Escape `%`/`_`/`\` so user input cannot widen a LIKE search. Pair with `ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/** Escape and wrap in `%…%` for a substring search. Pair with `ESCAPE '\'`. */
export function likeContains(value: string): string {
  return `%${escapeLike(value)}%`
}

/** Require a real string body field; anything else is a 400, never a TypeError. */
export function requireString(value: unknown, field: string, maxLength = 2000): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}
