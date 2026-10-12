#!/usr/bin/env bash
# Self-check for scripts/lib/env.sh. Run it after editing the library:
#
#   bash scripts/lib/env-selftest.sh
#
# Exits non-zero on the first mismatch. It touches nothing outside 0600 mktemp files.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=env.sh
source "$SCRIPT_DIR/env.sh"

FAILED=0
check() { # label expected actual
  if [[ "$2" == "$3" ]]; then
    printf 'PASS %s\n' "$1"
  else
    printf 'FAIL %s: expected [%s] got [%s]\n' "$1" "$2" "$3" >&2
    FAILED=1
  fi
}

piforge_tmpfile
ENV_FILE=$PIFORGE_TMPFILE
cat >"$ENV_FILE" <<'EOF'
ADMIN_USER=admin
ADMIN_PASSWORD=abc"def\ghi
QUOTED="  spaced value  "
SINGLE='single value'
EMPTY=
EOF

check "plain value" "admin" "$(piforge_env_get "$ENV_FILE" ADMIN_USER)"
check "embedded quotes" 'abc"def\ghi' "$(piforge_env_get "$ENV_FILE" ADMIN_PASSWORD)"
check "double-quoted value" "  spaced value  " "$(piforge_env_get "$ENV_FILE" QUOTED)"
check "single-quoted value" "single value" "$(piforge_env_get "$ENV_FILE" SINGLE)"
check "empty value" "" "$(piforge_env_get "$ENV_FILE" EMPTY)"
check "missing key" "" "$(piforge_env_get "$ENV_FILE" NOPE)"
check "missing file" "" "$(piforge_env_get "$ENV_FILE.absent" NOPE)"

piforge_tmpfile
CURLRC=$PIFORGE_TMPFILE
piforge_curlrc "$CURLRC" opencode 'pw"with\quotes'
check "curlrc escaping" 'user = "opencode:pw\"with\\quotes"' "$(cat "$CURLRC")"

check "login body escaping" '{"username":"admin","password":"p@ss\"word\\here"}' \
  "$(printf '%s' 'p@ss"word\here' | piforge_login_body admin)"

check "tmp files registered" "2" "${#PIFORGE_TMP[@]}"

if [[ -n "${DB_PATH:-}" ]]; then
  printf 'SKIP wb.db lookup (DB_PATH is set in this environment)\n'
else
  # Nothing is installed in the test environment, so the fallback default is expected.
  check "wb.db fallback path" "/var/lib/piforge/wb.db" "$(piforge_wb_db)"
fi

if ((FAILED)); then
  printf 'FAILED\n' >&2
  exit 1
fi
printf 'OK — lib/env.sh behaves as documented\n'
