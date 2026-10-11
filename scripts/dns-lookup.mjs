import { resolve4, resolveCname, resolveNs, setServers } from "node:dns/promises"

const host = process.argv[2] || "cloud.antifield.work"

async function q(label, fn) {
  try {
    setServers(["8.8.8.8"])
    console.log(label, await fn())
  } catch (e) {
    console.log(label, "ERR", e.code || e.message)
  }
}

await q("A google", () => resolve4(host))
await q("CNAME google", () => resolveCname(host))
await q("NS antifield.work", () => resolveNs("antifield.work"))
try {
  setServers(["59.67.225.34"])
  console.log("A local", await resolve4(host))
} catch (e) {
  console.log("A local", "ERR", e.code || e.message)
}
