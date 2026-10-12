#!/usr/bin/env bash
# Install/refresh the PiForge runtime on the Pi: system users, directories, data
# migration, secrets, systemd units and the generated sudoers rule.
#
#   ssh antifield@169.254.77.10 'bash /home/antifield/piforge/scripts/deploy-pi.sh'
#
# Idempotent: every step is safe to re-run. It does NOT build or copy code — the caller
# must already have built and rsynced the checkout (packages/gateway/dist, apps/web/dist).
#
# Privilege model installed here:
#   piforge-gw  runs wb-gateway.service, no sudo except /etc/sudoers.d/piforge-gw
#   piforge-oc  runs opencode-serve.service, no sudo, home /var/lib/piforge-oc
#   antifield   stays the human/ops login and keeps its own sudoers file (untouched)
#
# Environment:
#   FORCE_ENV=1   rewrite /etc/piforge/gateway.env and opencode.env even if they exist
#
# Usage: bash scripts/deploy-pi.sh [--prune-legacy]
set -euo pipefail

PIFORGE=/home/antifield/piforge
RUNTIME=/opt/piforge
LEGACY_DATA=/home/antifield/piforge/data
GW_USER=piforge-gw
OC_USER=piforge-oc
GW_HOME=/var/lib/piforge
OC_HOME=/var/lib/piforge-oc
OC_WORKSPACE=$OC_HOME/workspace
CONF=/etc/piforge
STAMP=$(date +%Y%m%d-%H%M%S)
FORCE_ENV="${FORCE_ENV:-0}"
MIGRATED=0

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  SUDO=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    printf '[deploy] ERROR: run as root or install sudo\n' >&2
    exit 1
  fi
  SUDO=(sudo)
fi
as_root() { "${SUDO[@]}" "$@"; }

log() { printf '[deploy] %s\n' "$*"; }
die() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

PRUNE_LEGACY=0
for arg in "$@"; do
  case "$arg" in
    --prune-legacy) PRUNE_LEGACY=1 ;;
    *) die "unknown argument: $arg (supported: --prune-legacy)" ;;
  esac
done

TMP_FILES=()
# Path of the file created by the last make_tmp call.
TMP_LAST=""
cleanup() {
  local file
  for file in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do
    [[ -n "$file" && -e "$file" ]] && rm -f -- "$file"
  done
}
trap cleanup EXIT

# Create a 0600 temp file and register it for cleanup. Not usable in a command
# substitution (the subshell would lose the registration); use $TMP_LAST instead.
make_tmp() {
  TMP_LAST=$(mktemp)
  chmod 600 "$TMP_LAST"
  TMP_FILES+=("$TMP_LAST")
}

# Read KEY=value without sourcing the file (a dotenv must never execute code here).
read_secret() {
  local file="$1" key="$2" value
  [[ -f "$file" ]] || return 0
  value=$(as_root grep -E "^${key}=" "$file" 2>/dev/null | head -n1 | cut -d= -f2- || true)
  value="${value%$'\r'}"
  printf '%s' "$value"
}

gen_secret() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }

write_file_as() { # dest owner group mode content
  local dest="$1" owner="$2" group="$3" mode="$4" content="$5"
  make_tmp
  printf '%s' "$content" >"$TMP_LAST"
  as_root install -m "$mode" -o "$owner" -g "$group" "$TMP_LAST" "$dest"
}

wait_for_port() { # port [seconds]
  local port="$1" deadline=$((SECONDS + ${2:-15}))
  while ((SECONDS < deadline)); do
    if ss -lnt 2>/dev/null | grep -q ":${port} "; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------
# 0. Preconditions
# ---------------------------------------------------------------------------
[[ -d "$PIFORGE" ]] || die "$PIFORGE not found — build and rsync the checkout first"
[[ -f "$PIFORGE/packages/gateway/dist/index.js" ]] ||
  die "packages/gateway/dist/index.js missing — build the gateway before deploying"
[[ -f "$PIFORGE/deploy/wb-gateway.service" ]] || die "deploy/wb-gateway.service missing"
[[ -f "$PIFORGE/config/services.allowlist.json" ]] || die "config/services.allowlist.json missing"
command -v node >/dev/null 2>&1 || die "node not found in PATH"
command -v openssl >/dev/null 2>&1 || die "openssl not found in PATH"
command -v rsync >/dev/null 2>&1 || die "rsync not found in PATH"

# ---------------------------------------------------------------------------
# 0.5 Runtime install: /opt/piforge
# ---------------------------------------------------------------------------
# /home/antifield is 0700, so piforge-gw/piforge-oc cannot read the checkout there. The units
# start from /opt/piforge, which is root-owned and read-only for the service users.
as_root install -d -m 0755 -o root -g root "$RUNTIME"
# No *.env may reach the runtime tree: /home/antifield is 0700 but /opt/piforge is a+rX and
# the legacy checkout file holds ADMIN_PASSWORD/SESSION_SECRET/OPENCODE_PASSWORD in
# plaintext (deploy itself reads $PIFORGE/gateway.env for the migration).
as_root rsync -a --delete \
  --exclude '.git/' \
  --exclude 'opencode/' \
  --exclude 'data/' \
  --exclude '*.log' \
  --exclude 'scripts/legacy/' \
  --exclude '*.env' \
  --exclude 'gateway.env' \
  --exclude 'opencode.env' \
  --exclude 'backup.env' \
  "$PIFORGE/" "$RUNTIME/"
as_root chown -R root:root "$RUNTIME"
# Defense in depth before the chmod: `--delete` does not remove excluded files, so a copy left
# by an older deploy would silently become world-readable below. Fail, never chmod a key store.
RUNTIME_SECRETS=$(as_root find "$RUNTIME" -type f \( -name '*.env' -o -name '*.env.bak-*' \) 2>/dev/null || true)
if [[ -n "$RUNTIME_SECRETS" ]]; then
  printf '%s\n' "$RUNTIME_SECRETS" | sed 's/^/[deploy]   /' >&2
  die "secret file(s) found under $RUNTIME — refusing to chmod -R; remove them (sudo rm -f <paths above>) and re-run"
fi
# a+rX: readable/enterable for the service users; go-w keeps every service user out of the code.
as_root chmod -R a+rX,go-w "$RUNTIME"
as_root find "$RUNTIME/scripts" -name '*.sh' -exec chmod 0755 {} + 2>/dev/null || true
[[ -f "$RUNTIME/packages/gateway/dist/index.js" ]] || die "runtime install failed: $RUNTIME/packages/gateway/dist/index.js missing"
# tsc does not bundle: dist/index.js imports fastify/@fastify/* at runtime, so the dependency
# tree must have been installed in the checkout before this deploy.
[[ -d "$RUNTIME/node_modules/fastify" ]] ||
  die "runtime install failed: $RUNTIME/node_modules/fastify missing — run the dependency install in $PIFORGE first"
log "runtime installed to $RUNTIME ($(du -sh "$RUNTIME" | cut -f1))"

# ---------------------------------------------------------------------------
# 1. Service users (system accounts, no sudo)
# ---------------------------------------------------------------------------
ensure_user() { # name home
  local name="$1" home="$2"
  if id -u "$name" >/dev/null 2>&1; then
    log "user $name already exists"
  else
    as_root useradd --system --create-home --home-dir "$home" --shell /usr/sbin/nologin "$name"
    log "created system user $name (home $home, shell /usr/sbin/nologin, no sudo)"
  fi
  # useradd may have skipped the home directory; make sure it exists with tight modes.
  as_root install -d -m 0750 -o "$name" -g "$name" "$home"
}
ensure_user "$GW_USER" "$GW_HOME"
ensure_user "$OC_USER" "$OC_HOME"

# ---------------------------------------------------------------------------
# 2. Directories
# ---------------------------------------------------------------------------
as_root install -d -m 0750 -o "$GW_USER" -g "$GW_USER" "$GW_HOME" "$GW_HOME/cloud" "$GW_HOME/backups"
as_root install -d -m 0750 -o "$OC_USER" -g "$OC_USER" "$OC_HOME" "$OC_WORKSPACE"
as_root install -d -m 0755 -o root -g root "$CONF"
# wb.db holds notes/todos/password hashes: owner-only files, group-traversable directories.
# (The unit sets UMask=0077 for new files; this fixes files that predate it.)
as_root find "$GW_HOME" -type d -exec chmod 0750 {} +
as_root find "$GW_HOME" -type f -exec chmod 0600 {} +
log "directories ready: $GW_HOME (piforge-gw, 0750/0600), $OC_HOME + workspace (piforge-oc), $CONF"

# ---------------------------------------------------------------------------
# 3. Data migration (/home/antifield/piforge/data -> /var/lib/piforge)
# ---------------------------------------------------------------------------
if [[ -f "$LEGACY_DATA/wb.db" && ! -f "$GW_HOME/wb.db" ]]; then
  log "legacy database found at $LEGACY_DATA/wb.db — proving the backup chain before migration"
  # AGENTS red line 4: relocating storage is only allowed after a verifiable backup exists.
  # A one-shot safety snapshot (db + wal/shm + cloud) is written next to the new backup
  # root and checked (sha256 + PRAGMA integrity_check) before any mv runs.
  as_root install -d -m 0750 -o root -g root "$GW_HOME/backups/piforge"
  SAFETY_DIR="$GW_HOME/backups/piforge/pre-migration-$STAMP"
  as_root install -d -m 0750 -o root -g root "$SAFETY_DIR"
  for suffix in "" "-wal" "-shm"; do
    if [[ -f "$LEGACY_DATA/wb.db$suffix" ]]; then
      as_root cp -a "$LEGACY_DATA/wb.db$suffix" "$SAFETY_DIR/wb.db$suffix"
    fi
  done
  if [[ -d "$LEGACY_DATA/cloud" ]]; then
    as_root cp -a "$LEGACY_DATA/cloud" "$SAFETY_DIR/cloud"
  fi
  make_tmp
  ( cd "$SAFETY_DIR" && as_root find . -type f -print0 | as_root xargs -0 sha256sum >"$TMP_LAST" )
  as_root mv "$TMP_LAST" "$SAFETY_DIR/SHA256SUMS"
  as_root chmod 0600 "$SAFETY_DIR/SHA256SUMS"
  if ! ( cd "$SAFETY_DIR" && as_root sha256sum -c SHA256SUMS >/dev/null 2>&1 ); then
    die "pre-migration safety backup checksum failed at $SAFETY_DIR — refusing to migrate"
  fi
  if ! as_root node -e '
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(process.argv[1], { readOnly: true })
    const row = db.prepare("PRAGMA integrity_check").get()
    const text = Object.values(row ?? {})[0]
    db.close()
    if (text !== "ok") {
      process.stderr.write(`integrity_check: ${text}\n`)
      process.exit(1)
    }
  ' "$SAFETY_DIR/wb.db"; then
    die "pre-migration integrity_check failed on $SAFETY_DIR/wb.db — refusing to migrate"
  fi
  log "safety backup verified at $SAFETY_DIR (sha256 + integrity_check) — proceeding with migration"

  # Never move a database out from under a running gateway.
  as_root systemctl stop wb-gateway.service 2>/dev/null || true
  for suffix in "" "-wal" "-shm"; do
    if [[ -f "$LEGACY_DATA/wb.db$suffix" ]]; then
      as_root mv -f "$LEGACY_DATA/wb.db$suffix" "$GW_HOME/wb.db$suffix"
      log "moved wb.db$suffix"
    fi
  done
  if [[ -d "$LEGACY_DATA/cloud" ]]; then
    if [[ -e "$GW_HOME/cloud/." && -n "$(ls -A "$GW_HOME/cloud" 2>/dev/null || true)" ]]; then
      log "WARN: $GW_HOME/cloud is not empty; left $LEGACY_DATA/cloud in place"
    else
      as_root rmdir "$GW_HOME/cloud" 2>/dev/null || true
      as_root mv "$LEGACY_DATA/cloud" "$GW_HOME/cloud"
      log "moved cloud/"
    fi
  fi
  as_root chown -R "$GW_USER:$GW_USER" "$GW_HOME"
  MIGRATED=1
  log "data migration done (owner $GW_USER:$GW_USER); safety copy remains at $SAFETY_DIR"
elif [[ -f "$GW_HOME/wb.db" ]]; then
  log "database already at $GW_HOME/wb.db — no migration"
else
  log "no database yet (first deploy without data); the gateway will create $GW_HOME/wb.db"
fi

# ---------------------------------------------------------------------------
# 4. Config: allowlist + secrets
# ---------------------------------------------------------------------------
as_root install -m 0644 -o root -g root "$PIFORGE/config/services.allowlist.json" "$CONF/services.allowlist.json"
log "installed $CONF/services.allowlist.json (0644 root:root)"

NEW_ENV="$CONF/gateway.env"
LEGACY_ENV="$PIFORGE/gateway.env"

from_anywhere() { # key
  local value
  value=$(read_secret "$NEW_ENV" "$1")
  if [[ -z "$value" ]]; then
    value=$(read_secret "$LEGACY_ENV" "$1")
  fi
  printf '%s' "$value"
}

ADMIN_USER_V=$(from_anywhere ADMIN_USER)
ADMIN_USER_V="${ADMIN_USER_V:-admin}"
ADMIN_PASSWORD_V=$(from_anywhere ADMIN_PASSWORD)
SESSION_SECRET_V=$(from_anywhere SESSION_SECRET)

# The gateway authenticates to OpenCode with OPENCODE_PASSWORD, so gateway.env is the
# source of truth and opencode.env must match it.
GW_OC_PW=$(from_anywhere OPENCODE_PASSWORD)
OC_ENV_PW=$(read_secret "$CONF/opencode.env" OPENCODE_PASSWORD)
if [[ -n "$GW_OC_PW" ]]; then
  OPENCODE_PASSWORD_V="$GW_OC_PW"
  if [[ -n "$OC_ENV_PW" && "$OC_ENV_PW" != "$GW_OC_PW" ]]; then
    log "WARN: $CONF/opencode.env disagrees with gateway.env — using the gateway value"
  fi
elif [[ -n "$OC_ENV_PW" ]]; then
  OPENCODE_PASSWORD_V="$OC_ENV_PW"
else
  OPENCODE_PASSWORD_V=""
fi

generated=""
if [[ -z "$ADMIN_PASSWORD_V" ]]; then
  ADMIN_PASSWORD_V=$(gen_secret)
  generated="$generated ADMIN_PASSWORD"
fi
if [[ -z "$SESSION_SECRET_V" ]]; then
  SESSION_SECRET_V=$(gen_secret)
  generated="$generated SESSION_SECRET"
fi
if [[ -z "$OPENCODE_PASSWORD_V" ]]; then
  OPENCODE_PASSWORD_V=$(gen_secret)
  generated="$generated OPENCODE_PASSWORD"
fi
if [[ -n "$generated" ]]; then
  log "generated new secret(s):$generated (values never printed)"
  if [[ "$generated" == *ADMIN_PASSWORD* ]]; then
    log "WARN: the admin password was generated — set a known one with:"
    log "      bash $RUNTIME/scripts/set-admin-password.sh"
    log "      (prompts for the password; or PIFORGE_ADMIN_PASSWORD=… — never as argv)"
  fi
fi

need_write=0
if [[ "$FORCE_ENV" == "1" || ! -s "$NEW_ENV" ]]; then
  need_write=1
else
  for key in ADMIN_PASSWORD SESSION_SECRET OPENCODE_PASSWORD; do
    if [[ -z "$(read_secret "$NEW_ENV" "$key")" ]]; then
      need_write=1
    fi
  done
fi

if ((need_write)); then
  write_file_as "$NEW_ENV" root "$GW_USER" 0640 "$(printf 'ADMIN_USER=%s\nADMIN_PASSWORD=%s\nSESSION_SECRET=%s\nOPENCODE_PASSWORD=%s\n' \
    "$ADMIN_USER_V" "$ADMIN_PASSWORD_V" "$SESSION_SECRET_V" "$OPENCODE_PASSWORD_V")"
  log "installed $NEW_ENV (0640 root:$GW_USER)$([[ "$FORCE_ENV" == "1" ]] && printf ' [FORCE_ENV=1]')"
else
  log "keeping existing $NEW_ENV (use FORCE_ENV=1 to rewrite)"
fi

if [[ ! -s "$CONF/opencode.env" || "$FORCE_ENV" == "1" || "$(read_secret "$CONF/opencode.env" OPENCODE_PASSWORD)" != "$OPENCODE_PASSWORD_V" ]]; then
  write_file_as "$CONF/opencode.env" root "$OC_USER" 0640 "OPENCODE_PASSWORD=$OPENCODE_PASSWORD_V"
  log "installed $CONF/opencode.env (0640 root:$OC_USER)"
else
  log "keeping existing $CONF/opencode.env"
fi

if [[ ! -e "$CONF/backup.env" ]]; then
  write_file_as "$CONF/backup.env" root root 0640 "$(printf 'BACKUP_TARGET=%s\nKEEP=14\n' "$GW_HOME/backups/piforge")"
  log "created $CONF/backup.env (0640 root:root, no secrets)"
fi

if [[ -f "$LEGACY_ENV" ]]; then
  log "NOTE: legacy $LEGACY_ENV still holds a copy of the secrets; it is shredded after the"
  log "      verification block below succeeds (values now live in $NEW_ENV)."
fi

# ---------------------------------------------------------------------------
# 5. OpenCode install migration (/home/antifield/.opencode -> /var/lib/piforge-oc)
# ---------------------------------------------------------------------------
# Never move the OpenCode home (it holds the live session database) under a running server.
as_root systemctl stop opencode-serve.service 2>/dev/null || true
for rel in .opencode .config/opencode .local/state/opencode .local/share/opencode; do
  src="/home/antifield/$rel"
  dst="$OC_HOME/$rel"
  if [[ -e "$src" && ! -e "$dst" ]]; then
    as_root install -d -m 0750 -o "$OC_USER" -g "$OC_USER" "$(dirname "$dst")"
    as_root mv "$src" "$dst"
    as_root chown -R "$OC_USER:$OC_USER" "$dst"
    log "migrated $src -> $dst"
  elif [[ -e "$dst" ]]; then
    log "already in place: $dst"
  fi
done
if [[ ! -x "$OC_HOME/.opencode/bin/opencode" ]]; then
  log "WARN: $OC_HOME/.opencode/bin/opencode is missing or not executable — opencode-serve.service will fail to start"
fi

# Explicit ask/deny policy instead of upstream defaults (AGENTS.md red line 6). Installed only
# when absent so a local edit is never clobbered.
OC_CONFIG="$OC_HOME/.config/opencode/opencode.json"
as_root install -d -m 0750 -o "$OC_USER" -g "$OC_USER" "$OC_HOME/.config/opencode"
if [[ ! -f "$OC_CONFIG" ]]; then
  as_root install -m 0640 -o "$OC_USER" -g "$OC_USER" "$PIFORGE/deploy/opencode-config.json" "$OC_CONFIG"
  log "installed agent permission policy $OC_CONFIG (edit/write/bash/webfetch = ask)"
else
  log "keeping existing $OC_CONFIG"
  if ! as_root grep -q '"permission"' "$OC_CONFIG"; then
    log "WARN: $OC_CONFIG has no permission block — the agent would use upstream defaults"
  fi
fi

# Keep the persisted service password in sync with the one the unit exports, so a later change of
# startup path cannot silently authenticate with a stale credential (that drift already happened
# once: service.json held an older password than the working systemd value).
OC_ENV_FILE="$CONF/opencode.env"
OC_PW_SYNC=$(read_secret "$OC_ENV_FILE" OPENCODE_PASSWORD)
if [[ -n "$OC_PW_SYNC" ]]; then
  # The password travels through a 0600 temp file, never argv: `env KEY=value cmd`
  # would expose it in /proc/*/cmdline and `ps` (and sudo logs can record the full
  # command line). Same discipline as lib/env.sh and set-admin-password.sh.
  make_tmp
  printf '%s' "$OC_PW_SYNC" >"$TMP_LAST"
  if as_root node -e '
    const fs = require("node:fs")
    const file = process.argv[1]
    const pwFile = process.argv[2]
    const pw = fs.readFileSync(pwFile, "utf8")
    let current = {}
    try { current = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
    if (current.password === pw) process.exit(0)
    fs.writeFileSync(file, JSON.stringify({ ...current, password: pw }), { mode: 0o600 })
  ' "$OC_HOME/.config/opencode/service.json" "$TMP_LAST"; then
    as_root chown "$OC_USER:$OC_USER" "$OC_HOME/.config/opencode/service.json" 2>/dev/null || true
    as_root chmod 0600 "$OC_HOME/.config/opencode/service.json" 2>/dev/null || true
    log "aligned $OC_HOME/.config/opencode/service.json with the configured password"
  else
    log "WARN: could not align service.json (non-fatal)"
  fi
fi

# ---------------------------------------------------------------------------
# 6. systemd units (each previous version is kept as <name>.bak-<stamp>)
# ---------------------------------------------------------------------------
install_unit() { # source-file unit-name
  # Split deliberately: with `set -u`, `local a="$1" b="x$a"` expands $a before it is declared.
  local src="$1" name="$2"
  local dest="/etc/systemd/system/$name"
  [[ -f "$src" ]] || die "missing unit source $src"
  if [[ -f "$dest" ]]; then
    as_root cp -a "$dest" "$dest.bak-$STAMP"
    log "backed up $dest -> $dest.bak-$STAMP"
  fi
  as_root install -m 0644 -o root -g root "$src" "$dest"
  log "installed $dest"
}
install_unit "$PIFORGE/deploy/wb-gateway.service" wb-gateway.service
install_unit "$PIFORGE/deploy/opencode-serve.service" opencode-serve.service
install_unit "$PIFORGE/deploy/piforge-backup.service" piforge-backup.service
install_unit "$PIFORGE/deploy/piforge-backup.timer" piforge-backup.timer

# The old deploy wrote OPENCODE_PASSWORD with Environment= into a drop-in, which exposes
# the value to every local user through `systemctl show -p Environment`. Remove it.
DROPIN=/etc/systemd/system/opencode-serve.service.d/override.conf
if [[ -f "$DROPIN" ]] && as_root grep -q '^Environment=OPENCODE_PASSWORD=' "$DROPIN"; then
  as_root cp -a "$DROPIN" "$DROPIN.bak-$STAMP"
  as_root rm -f "$DROPIN"
  log "removed $DROPIN (Environment= leaked the password; backup at $DROPIN.bak-$STAMP)"
fi

as_root systemctl daemon-reload
log "systemctl daemon-reload done"

# ---------------------------------------------------------------------------
# 7. sudoers rule for the gateway (validated with visudo BEFORE installation)
# ---------------------------------------------------------------------------
SUDOERS=/etc/sudoers.d/piforge-gw
make_tmp
GEN="$TMP_LAST"
if node "$PIFORGE/scripts/gen-sudoers.mjs" "$CONF/services.allowlist.json" --out "$GEN"; then
  log "generated the sudoers rule from $CONF/services.allowlist.json"
else
  # Do NOT fall back to the committed template: it can drift from the allowlist
  # (e.g. a unit was removed) and would keep granting privileges that are no
  # longer intended. A broken generator must fail the deploy instead.
  die "gen-sudoers.mjs failed — refusing to install a possibly stale sudoers template"
fi

# Stage with a leading dot: sudo ignores dotted files in sudoers.d, so a half-installed
# file can never take effect while it is being validated.
STAGE=$(as_root mktemp /etc/sudoers.d/.piforge-gw.XXXXXX)
as_root install -m 0440 -o root -g root "$GEN" "$STAGE"
if ! as_root visudo -c -f "$STAGE"; then
  as_root rm -f "$STAGE"
  die "visudo rejected the generated rule — $SUDOERS left unchanged (previous rule still in force)"
fi
as_root rm -f "$STAGE"

SUDOERS_BAK=""
if [[ -f "$SUDOERS" ]]; then
  SUDOERS_BAK="$SUDOERS.bak-$STAMP"
  as_root cp -a "$SUDOERS" "$SUDOERS_BAK"
fi
as_root install -m 0440 -o root -g root "$GEN" "$SUDOERS"
# Gate on OUR file only: `visudo -c` without -f also inspects unrelated pre-existing files
# (an 0644 file in /etc/sudoers.d makes it fail), which must not roll back a good rule.
if ! as_root visudo -c -f "$SUDOERS" >/dev/null 2>&1; then
  if [[ -n "$SUDOERS_BAK" ]]; then
    as_root install -m 0440 -o root -g root "$SUDOERS_BAK" "$SUDOERS"
    die "$SUDOERS does not parse — rolled back from $SUDOERS_BAK"
  fi
  as_root rm -f "$SUDOERS"
  die "$SUDOERS does not parse — removed it again"
fi
log "installed $SUDOERS (0440 root:root, visudo -f OK)"
# Whole-tree check is advisory: report other files' problems without failing the deploy.
if ! as_root visudo -c >/dev/null 2>&1; then
  log "WARN: 'visudo -c' reports problems outside this deploy (usually a non-0440 mode in /etc/sudoers.d):"
  as_root visudo -c 2>&1 | grep -v '解析正确\|parsed OK' | sed 's/^/[deploy]   /' || true
fi

# ---------------------------------------------------------------------------
# 7.5 Legacy bypass left over from the pre-migration layout
# ---------------------------------------------------------------------------
# The old layout granted the "workbench" user systemctl over the same units. After the
# migration that file is an unused privilege grant, but it is NOT deleted automatically: the
# grantee may not be ours any more, and silently removing someone else's sudoers entry is
# worse than leaving a stale one. `--prune-legacy` is the explicit opt-in.
LEGACY_SUDOERS=/etc/sudoers.d/workbench-systemctl
if [[ -f "$LEGACY_SUDOERS" ]]; then
  LEGACY_GRANTEE=$(as_root awk '!/^[[:space:]]*#/ && NF { print $1; exit }' "$LEGACY_SUDOERS" 2>/dev/null || true)
  if [[ "$LEGACY_GRANTEE" != "workbench" ]]; then
    log "WARN: $LEGACY_SUDOERS exists but grants '${LEGACY_GRANTEE:-unknown}', which is not this project's legacy user"
    log "WARN: leaving it untouched — it may belong to another owner. Review and remove it by hand:"
    log "WARN:   sudo visudo -c -f $LEGACY_SUDOERS && sudo cat $LEGACY_SUDOERS"
  elif ((PRUNE_LEGACY)); then
    as_root cp -a "$LEGACY_SUDOERS" "$LEGACY_SUDOERS.bak-$STAMP"
    as_root rm -f "$LEGACY_SUDOERS"
    log "--prune-legacy: removed $LEGACY_SUDOERS (backup at $LEGACY_SUDOERS.bak-$STAMP)"
  elif id -u workbench >/dev/null 2>&1; then
    log "WARN: legacy user 'workbench' still exists and $LEGACY_SUDOERS still grants it systemctl"
    log "WARN: review it by hand, then remove it with: bash $0 --prune-legacy"
  else
    log "WARN: user 'workbench' is gone but $LEGACY_SUDOERS still grants it systemctl — leftover bypass"
    log "WARN: remove it with: bash $0 --prune-legacy"
  fi
fi

# ---------------------------------------------------------------------------
# 8. Enable and (re)start
# ---------------------------------------------------------------------------
as_root systemctl enable wb-gateway.service opencode-serve.service piforge-backup.timer >/dev/null
log "enabled wb-gateway.service, opencode-serve.service, piforge-backup.timer"

start_or_restart() { # unit
  if as_root systemctl is-active --quiet "$1"; then
    as_root systemctl restart "$1"
    log "restarted $1"
  else
    as_root systemctl start "$1"
    log "started $1"
  fi
}
start_or_restart opencode-serve.service
if wait_for_port 4096 20; then
  log "opencode is listening on 127.0.0.1:4096"
else
  log "WARN: nothing is listening on 4096 yet (check: journalctl -u opencode-serve -n 50)"
fi
start_or_restart wb-gateway.service
# The gateway needs a moment to bind; checking immediately reports a false failure.
if wait_for_port 8787 20; then
  log "gateway is listening on 127.0.0.1:8787"
else
  log "WARN: nothing is listening on 8787 yet (check: journalctl -u wb-gateway -n 50)"
fi
as_root systemctl start piforge-backup.timer
log "started piforge-backup.timer (next run: systemctl list-timers piforge-backup.timer)"

# ---------------------------------------------------------------------------
# 9. Verification block
# ---------------------------------------------------------------------------
log "=== verification ==="
for unit in wb-gateway.service opencode-serve.service piforge-backup.timer; do
  state=$(as_root systemctl is-active "$unit" 2>/dev/null || true)
  printf '[deploy] %-24s %s\n' "$unit" "${state:-unknown}"
done
printf '[deploy] listening:\n'
ss -lntp 2>/dev/null | grep -E ':(4096|8787)\b' || log "WARN: neither 4096 nor 8787 is listening"
printf '[deploy] health: '
HEALTH_OK=0
if curl -fsS -m 5 http://127.0.0.1:8787/api/v1/health; then
  printf '\n'
  HEALTH_OK=1
else
  printf '\n[deploy] WARN: gateway health check failed (journalctl -u wb-gateway -n 50)\n'
fi
printf '[deploy] sudo rule: '
as_root grep -c '^Cmnd_Alias PIFORGE_SERVICES' "$SUDOERS" 2>/dev/null || printf '0\n'

# The checkout copy of gateway.env is now redundant (and a second plaintext secret
# store). Remove it once the new layout is demonstrably working.
if ((HEALTH_OK)) && [[ -f "$LEGACY_ENV" ]]; then
  if command -v shred >/dev/null 2>&1; then
    shred -u "$LEGACY_ENV" 2>/dev/null || rm -f "$LEGACY_ENV"
  else
    rm -f "$LEGACY_ENV"
  fi
  log "removed legacy $LEGACY_ENV (secrets live only in $NEW_ENV now)"
fi

if ((MIGRATED)); then
  log "data was migrated to $GW_HOME — scripts/rollback-pi.sh prints the manual steps to move it back"
fi
log "DONE — secrets are in $CONF (0640 root:$GW_USER / root:$OC_USER), never in git or logs"
