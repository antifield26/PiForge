// LEGACY (reference only). Superseded by scripts/cf-dns-check.sh (see scripts/legacy/README.md).
// One-shot propagation triage: three hostnames x five resolvers. Do not run against the Pi.
import { Resolver } from "node:dns/promises"

const hosts = ["cloud.antifield.work", "antifield.work", "cfargotunnel.com"]

const resolvers = [
  ["system", undefined],
  ["jeremy.ns.cloudflare.com", ["173.245.58.167", "108.162.192.167", "172.64.32.167"]],
  ["1.1.1.1", ["1.1.1.1"]],
  ["223.5.5.5", ["223.5.5.5"]],
  ["119.29.29.29", ["119.29.29.29"]],
]

for (const [label, servers] of resolvers) {
  const r = new Resolver()
  if (servers) r.setServers(servers)
  for (const h of hosts) {
    try {
      const addrs = await r.resolve4(h)
      console.log(label, h, addrs)
    } catch (e) {
      console.log(label, h, e.code || e.message)
    }
  }
}
