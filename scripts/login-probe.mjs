import { readFileSync } from "node:fs"

// Same lookup order as scripts/lib/env.sh; never sourced, never printed.
const ENV_CANDIDATES = ["/etc/piforge/gateway.env", "/home/antifield/piforge/gateway.env"]

function readGatewayEnv() {
  for (const file of ENV_CANDIDATES) {
    try {
      return [file, readFileSync(file, "utf8")]
    } catch {
      // try the next candidate
    }
  }
  return [null, ""]
}

function envGet(env, key) {
  const line = env.split("\n").find((l) => l.trimStart().startsWith(key + "="))
  if (line === undefined) return ""
  let value = line.slice(line.indexOf("=") + 1).replace(/\r$/, "")
  for (const quote of ['"', "'"]) {
    if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) {
      value = value.slice(1, -1)
    }
  }
  return value
}

const [envPath, env] = readGatewayEnv()
if (!envPath) {
  console.error(`gateway.env not found (looked at ${ENV_CANDIDATES.join(", ")})`)
  process.exit(1)
}

const username = envGet(env, "ADMIN_USER") || "admin"
const password = envGet(env, "ADMIN_PASSWORD")
if (!password) {
  console.error(`ADMIN_PASSWORD is not set in ${envPath}`)
  process.exit(1)
}

const base = process.env.BASE || "http://127.0.0.1:8787"
const res = await fetch(`${base}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  // The password goes in the request body, never in a command line or a temp file.
  body: JSON.stringify({ username, password }),
})
console.log("env_file", envPath)
console.log("username", username, "password_len", password.length)
console.log(res.status, await res.text())
