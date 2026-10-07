#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Regression tests for verify-phase-trail.sh comment-author trust filtering (#3100).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
cat "$FIXTURE"
STUB
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"
FAIL=0
run() { # name expect-exit fixture-json [env...]
  local name="$1" want="$2"; export FIXTURE="$TMP/f.json"; printf '%s' "$3" > "$FIXTURE"
  local out rc; out=$(bash "$HERE/verify-phase-trail.sh" 1 -R o/r 2>/dev/null); rc=$?
  if [ "$rc" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name (exit $rc, want $want)"; echo "$out"; FAIL=1; fi
}
c() { printf '{"author_association":"%s","user":{"login":"%s","type":"%s"},"body":%s}' "$1" "$2" "$3" "$(jq -Rs . <<<"$4")"; }
INV='<!-- FORGE:INVESTIGATOR -->
x
<!-- INVESTIGATION:COMPLETE -->'
FP_INV='<!-- FORGE:FAST_PATH -->
**COMPLEXITY_BAND**: INVESTIGATION'
FP_STD='<!-- FORGE:FAST_PATH -->
**COMPLEXITY_BAND**: STANDARD'
ALL=("$(c OWNER own User "$INV")" "$(c OWNER own User "$FP_STD")" "$(c OWNER own User '<!-- FORGE:CONTRACT -->')" "$(c OWNER own User '<!-- FORGE:CONTEXT -->')" "$(c OWNER own User '<!-- FORGE:ARCHITECT -->')" "$(c OWNER own User $'<!-- FORGE:QUALITY_GATE -->\n**Result**: PASS')")
join() { local IFS=,; echo "[$*]"; }

run "trusted full trail passes" 0 "$(join "${ALL[@]}")"
# Forged early INVESTIGATION band from a stranger must not downgrade requirements.
run "forged early FAST_PATH ignored" 1 "$(join "$(c NONE evil User "$FP_INV")" "$(c OWNER own User "$INV")" "$(c OWNER own User "$FP_STD")")"
# Stranger-only markers satisfy nothing.
run "untrusted-only markers fail" 1 "$(join "$(c NONE evil User "$INV")" "$(c NONE evil User "$FP_INV")")"
# Bot identity is trusted.
run "bot trusted" 0 "$(join "$(c NONE app Bot "$INV")" "$(c NONE app Bot "$FP_INV")")"
# Allowlisted login is trusted.
export FORGE_TRAIL_TRUSTED_LOGINS="svc-user"
run "allowlisted login trusted" 0 "$(join "$(c NONE svc-user User "$INV")" "$(c NONE svc-user User "$FP_INV")")"
unset FORGE_TRAIL_TRUSTED_LOGINS
# Associations are configurable.
export FORGE_TRAIL_TRUSTED_ASSOCIATIONS="OWNER"
run "narrowed associations reject collaborator" 1 "$(join "$(c COLLABORATOR col User "$INV")" "$(c COLLABORATOR col User "$FP_INV")")"
unset FORGE_TRAIL_TRUSTED_ASSOCIATIONS
exit $FAIL
