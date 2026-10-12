#!/usr/bin/env bash
# Snapshot OpenCode binary + config/metadata before an upgrade. Idempotent.
#
#   sudo bash /opt/piforge/scripts/oc-snapshot.sh [outdir]
#
# Default outdir: /var/lib/piforge/backups/piforge/opencode-snap-<stamp>
set -euo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
OC_HOME=/var/lib/piforge-oc
OUT="${1:-/var/lib/piforge/backups/piforge/opencode-snap-$STAMP}"

log() { printf '[oc-snap] %s\n' "$*"; }
die() { printf '[oc-snap] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -d "$OC_HOME" ]] || die "missing $OC_HOME"

mkdir -p "$OUT/bin" "$OUT/config"
chmod 0750 "$OUT"

BIN="$OC_HOME/.opencode/bin/opencode"
if [[ -x "$BIN" ]]; then
  cp -a "$BIN" "$OUT/bin/opencode"
  chmod 0600 "$OUT/bin/opencode" || true
  "$BIN" --version >"$OUT/bin/version.txt" 2>/dev/null || true
  log "binary copied ($(tr -d '\n' <"$OUT/bin/version.txt" 2>/dev/null || echo unknown))"
else
  log "WARN: $BIN missing — binary not snapshotted"
fi

# config + small metadata (not the model cache under .local/share)
for rel in .config/opencode .local/state/opencode; do
  if [[ -d "$OC_HOME/$rel" ]]; then
    mkdir -p "$OUT/$(dirname "$rel")"
    cp -a "$OC_HOME/$rel" "$OUT/$rel"
  fi
done
# persist service.json presence without leaking password into a world-readable file
if [[ -f "$OC_HOME/.config/opencode/service.json" ]]; then
  node -e 'const f=require("fs");const j=JSON.parse(f.readFileSync(process.argv[1],"utf8"));f.writeFileSync(process.argv[2],JSON.stringify({hasPassword:typeof j.password==="string"&&j.password.length>0,keys:Object.keys(j)},null,2)+"\n",{mode:0o600})' \
    "$OC_HOME/.config/opencode/service.json" "$OUT/config/service-json-summary.json" || true
fi

find "$OUT" -type f -print0 | xargs -0 sha256sum >"$OUT/SHA256SUMS"
chmod 0600 "$OUT/SHA256SUMS"
log "snapshot at $OUT"
