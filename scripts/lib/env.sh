#!/usr/bin/env bash
# Shared helpers for PiForge ops scripts (sourced, not executed).
#
# Rules encoded here, because getting them wrong is how secrets leak:
#   * never `source` an environment file — values are read with grep/cut so a dotenv
#     cannot execute code and its secrets never enter this shell's environment;
#   * never put a credential on a command line — curl credentials travel in a 0600
#     --config file and login bodies are built with real JSON escaping and passed by file;
#   * prefer the post-migration paths, fall back to the legacy layout so scripts keep
#     working before and after scripts/deploy-pi.sh runs.
#
# Usage from a script:
#   SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
#   # shellcheck source=lib/env.sh
#   source "$SCRIPT_DIR/lib/env.sh"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# Print the gateway env file path (post-migration first), or fail if there is none.
piforge_gateway_env() {
  local candidate
  for candidate in /etc/piforge/gateway.env /home/antifield/piforge/gateway.env; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Print the wb.db path: $DB_PATH when set and present, else the migrated path, else legacy.
piforge_wb_db() {
  local candidate
  for candidate in "${DB_PATH:-}" /var/lib/piforge/wb.db /home/antifield/piforge/data/wb.db; do
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf '%s\n' "${DB_PATH:-/var/lib/piforge/wb.db}"
}

# Read one KEY=value from a dotenv-style file. Never sources the file.
# Usage: piforge_env_get <file> <KEY>
piforge_env_get() {
  local file="$1" key="$2" value quote
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  # systemd EnvironmentFile is KEY=value, one per line; keep everything after the first '='.
  value=$(grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | head -n1 | cut -d= -f2- || true)
  value="${value%$'\r'}"
  # systemd strips one layer of surrounding quotes; mirror that. The quote characters are
  # kept in variables on purpose: a literal ' inside ${...#...} starts a nested quote.
  for quote in '"' "'"; do
    if [[ ${#value} -ge 2 && "$value" == "$quote"*"$quote" ]]; then
      value="${value:1:${#value}-2}"
    fi
  done
  printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# OpenCode credential (never written to disk, never passed as an argument)
# ---------------------------------------------------------------------------

# Print the OpenCode server password. Lookup order:
#   1. $OPENCODE_PASSWORD if the caller already has it;
#   2. the local OpenCode config/registration files under the (new, then legacy) home;
#   3. /etc/piforge/opencode.env read through sudo (0640 root:piforge-oc).
piforge_opencode_password() {
  local file value
  if [[ -n "${OPENCODE_PASSWORD:-}" ]]; then
    printf '%s' "$OPENCODE_PASSWORD"
    return 0
  fi
  for file in \
    /var/lib/piforge-oc/.config/opencode/service.json \
    /var/lib/piforge-oc/.local/state/opencode/service.json \
    /home/antifield/.config/opencode/service.json \
    /home/antifield/.local/state/opencode/service.json; do
    if [[ ! -f "$file" ]]; then
      continue
    fi
    value=$(node -e 'const fs=require("node:fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof j.password==="string"?j.password:"")}catch{}' "$file" 2>/dev/null || true)
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
  done
  if [[ -f /etc/piforge/opencode.env ]] && command -v sudo >/dev/null 2>&1; then
    value=$(sudo -n grep -E '^OPENCODE_PASSWORD=' /etc/piforge/opencode.env 2>/dev/null | head -n1 | cut -d= -f2- || true)
    value="${value%$'\r'}"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
  fi
  return 1
}

# Write a 0600 curl --config file holding HTTP Basic credentials.
# Usage: piforge_curlrc <file> <user> <password>
piforge_curlrc() {
  local file="$1" user="$2" password="$3" escaped
  if [[ "$password" == *$'\n'* || "$password" == *$'\r'* ]]; then
    printf 'piforge_curlrc: refusing a credential containing a newline\n' >&2
    return 1
  fi
  # curl config values are double-quoted with C-style escapes.
  escaped="${password//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  ( umask 077; printf 'user = "%s:%s"\n' "$user" "$escaped" > "$file" )
  # Tighten an existing file too: the 0600 guarantee must not depend on the caller's mktemp.
  chmod 600 "$file" 2>/dev/null || true
}

# Build a login JSON body on stdout from a username argument and the password on stdin.
# The password never appears in argv, and JSON escaping is done by JSON.stringify.
# Usage: printf '%s' "$password" | piforge_login_body "$username"
piforge_login_body() {
  local user="$1"
  node -e 'let d="";process.stdin.setEncoding("utf8");process.stdin.on("data",(c)=>{d+=c});process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({username:process.argv[1],password:d}))})' "$user"
}

# ---------------------------------------------------------------------------
# Temp files
# ---------------------------------------------------------------------------

# Temp files created here are 0600 and removed on exit.
PIFORGE_TMP=()
# Path of the file most recently created by piforge_tmpfile.
PIFORGE_TMPFILE=""

piforge_cleanup() {
  local file
  for file in ${PIFORGE_TMP[@]+"${PIFORGE_TMP[@]}"}; do
    if [[ -n "$file" && -e "$file" ]]; then
      rm -f -- "$file"
    fi
  done
}

# Create a 0600 temp file and register it for cleanup. Do NOT call this in a command
# substitution: the subshell would lose the registration. Use $PIFORGE_TMPFILE instead.
piforge_tmpfile() {
  PIFORGE_TMPFILE=$(mktemp "${TMPDIR:-/tmp}/piforge.XXXXXX")
  chmod 600 "$PIFORGE_TMPFILE"
  PIFORGE_TMP+=("$PIFORGE_TMPFILE")
}

trap piforge_cleanup EXIT
