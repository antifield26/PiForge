import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto"

const KEYLEN = 64
const COST = { N: 16384, r: 8, p: 1 }

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

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = Buffer.from(parts[4], "base64url")
  const expected = Buffer.from(parts[5], "base64url")
  const actual = await scrypt(password, salt, expected.length, { N, r, p })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url")
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url")
}
