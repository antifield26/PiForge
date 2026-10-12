# scripts/legacy — retired one-off probes (reference only)

Everything in this directory is **kept for historical reference only**. None of it is part
of the ops surface, nothing calls it, and it is not maintained: it may hardcode tunnel IDs,
absolute paths, `/tmp` scratch files and IP addresses that no longer apply. Do not run it
against the Pi to "check" something — use the canonical scripts instead.

They were moved here (with `git mv`, so history is intact) because the DNS/Cloudflare
work was exploratory: each file was one debugging step of the same investigation, several
of them duplicated each other, and keeping them in `scripts/` next to the maintained
tooling made it impossible to tell which one to trust.

## Canonical path

The supported, single-purpose tooling for Cloudflare DNS is:

| Script | Purpose |
|---|---|
| `scripts/cf-api-dns.sh` | Reads the tunnel credential from `/home/antifield/.cloudflared/cert.pem`, decodes the JWT payload, lists/creates the `cloud.antifield.work` CNAME via the Cloudflare API. |
| `scripts/cf-api-dns.mjs` | Same flow as a standalone Node script (usable without `sudo bash`). |
| `scripts/cf-dns-check.sh` | Read-only DNS/HTTP health check for the public hostname. |
| `scripts/wire-cloudflared.sh` | Writes `/etc/cloudflared/config.yml` and restarts the tunnel. |

## What each retired file did, and why it is superseded

| File | What it did | Why it is superseded |
|---|---|---|
| `cf-add-dns.sh` | `cloudflared tunnel route dns <tunnel> cloud.antifield.work`, then polled `getent hosts` and `curl`ed the health endpoint. | Created the record through the `cloudflared` CLI, which needs the interactive login credential and offered no idempotency or inspection. `cf-api-dns.sh` talks to the Cloudflare API directly, can list before creating, and reports the API's own error body. |
| `cf-dns-probe.sh` | Dumped `cloudflared --version`, `ls` of the cert/config dirs, the key names inside the tunnel credentials JSON, `cloudflared tunnel list` and `route dns --help`. | Pure reconnaissance of the CLI's behaviour; the questions it answered (tunnel id, credential file layout, the `route dns` flags) are settled and documented. It printed directory listings of secret-bearing paths, which is exactly the kind of output we no longer want in a repo script. |
| `cf-dns-retry.sh` | Re-ran `cloudflared tunnel route dns --overwrite-dns`, slept, then resolved the name through `/tmp/dns-lookup.mjs`. | A retry loop around the CLI call above, run from a scratch copy of `dns-lookup.mjs` in `/tmp`. Superseded by `cf-api-dns.sh` (create/list) plus `cf-dns-check.sh` (verify). |
| `cf-doh-check.sh` | Queried Cloudflare and Google DoH endpoints directly, resolved the `cfargotunnel.com` target, and tried `curl --doh-url`. | Separated "does DNS work" from "is the record right", and mixed the tunnel CNAME into the health check. `cf-dns-check.sh` covers the same ground with the system resolver and one coherent verdict. |
| `dns-deep.mjs` | Resolved three hostnames against five resolvers (system, the zone's authoritative NS, 1.1.1.1, AliDNS, DNSPod) to find where propagation stalled. | One-shot propagation triage. The finding (authoritative NS vs. public resolver lag) is recorded in `docs/RESEARCH.md`; keeping the resolver matrix in the repo implies it is a supported diagnostic. |
| `dns-lookup.mjs` | Small `node:dns/promises` helper: A/CNAME/NS lookups against 8.8.8.8 and a hardcoded local resolver. | It hardcoded a resolver IP (`59.67.225.34`) that only existed on one network, so it produced misleading "ERR" lines anywhere else. `cf-dns-check.sh` is the supported check. |
