import type { FastifyRequest } from "fastify"

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

/**
 * Real client address for rate limiting and audit.
 *
 * The gateway only ever listens on loopback; Cloudflare Tunnel and nginx connect from
 * loopback and forward the original address. Those headers are therefore trusted only when
 * the direct peer is loopback — a remote peer can never spoof them.
 */
export function clientIp(req: FastifyRequest): string {
  const peer = req.socket?.remoteAddress ?? req.ip ?? "unknown"
  if (!LOOPBACK.has(peer)) return normalize(peer)
  const cf = firstHeader(req.headers["cf-connecting-ip"])
  if (cf) return normalize(cf)
  const xff = firstHeader(req.headers["x-forwarded-for"])
  if (xff) return normalize(xff)
  return normalize(peer)
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (!value) return null
  const raw = Array.isArray(value) ? value[0] : value.split(",")[0]
  const trimmed = raw?.trim()
  return trimmed ? trimmed : null
}

function normalize(value: string): string {
  const v = value.trim()
  return v.startsWith("::ffff:") ? v.slice(7) : v
}
