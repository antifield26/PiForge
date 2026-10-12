import { randomBytes } from "node:crypto"

export interface RateLimitOptions {
  limit: number
  windowMs: number
  /** max tracked keys; oldest are evicted first */
  maxKeys?: number
}

export interface RateLimitVerdict {
  allowed: boolean
  retryAfterSec: number
  remaining: number
}

interface Bucket {
  hits: number[]
}

/**
 * In-memory sliding-window limiter. Single-process gateway, so no shared store is needed;
 * state resets on restart, which is acceptable for brute-force damping.
 */
export function createRateLimiter(opts: RateLimitOptions) {
  const maxKeys = opts.maxKeys ?? 5000
  const buckets = new Map<string, Bucket>()

  function prune(bucket: Bucket, now: number): void {
    const cutoff = now - opts.windowMs
    while (bucket.hits.length > 0 && bucket.hits[0] <= cutoff) bucket.hits.shift()
  }

  function check(key: string, now = Date.now()): RateLimitVerdict {
    const bucket = buckets.get(key)
    if (!bucket) return { allowed: true, retryAfterSec: 0, remaining: opts.limit }
    prune(bucket, now)
    if (bucket.hits.length < opts.limit) {
      return { allowed: true, retryAfterSec: 0, remaining: opts.limit - bucket.hits.length }
    }
    const retryAfterMs = bucket.hits[0] + opts.windowMs - now
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)), remaining: 0 }
  }

  function record(key: string, now = Date.now()): void {
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= maxKeys) {
        const oldest = buckets.keys().next()
        if (!oldest.done) buckets.delete(oldest.value)
      }
      bucket = { hits: [] }
      buckets.set(key, bucket)
    }
    prune(bucket, now)
    bucket.hits.push(now)
  }

  function reset(key: string): void {
    buckets.delete(key)
  }

  return { check, record, reset, size: () => buckets.size }
}

export type RateLimiter = ReturnType<typeof createRateLimiter>

/** per-IP and per-username limiters for the login endpoint */
export function createLoginLimiters(ipLimit = 10, userLimit = 5, windowMs = 5 * 60 * 1000) {
  return {
    ip: createRateLimiter({ limit: ipLimit, windowMs }),
    user: createRateLimiter({ limit: userLimit, windowMs }),
  }
}

export function randomKey(bytes = 6): string {
  return randomBytes(bytes).toString("hex")
}
