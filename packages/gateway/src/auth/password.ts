import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto"

const KEYLEN = 64
const COST = { N: 16384, r: 8, p: 1 }
/** Accepted range for parameters read back out of the stored hash. */
const MAX_N = 1 << 20
const MAX_R = 32
const MAX_P = 16

function scrypt(password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, KEYLEN, COST)
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`
}

/**
 * The cost parameters come from the database, not from the request, but an absurd value (a
 * corrupted row, or a manually inserted one) would otherwise make scrypt allocate gigabytes and
 * take the process down on the next login attempt.
 */
function plausibleCost(N: number, r: number, p: number): boolean {
  return (
    Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0 && N <= MAX_N &&
    Number.isInteger(r) && r > 0 && r <= MAX_R &&
    Number.isInteger(p) && p > 0 && p <= MAX_P
  )
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!plausibleCost(N, r, p)) return false
  const salt = Buffer.from(parts[4], "base64url")
  const expected = Buffer.from(parts[5], "base64url")
  if (expected.length === 0) return false
  const actual = await scrypt(password, salt, expected.length, { N, r, p })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url")
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url")
}
