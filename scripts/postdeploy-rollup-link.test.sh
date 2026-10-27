#!/usr/bin/env bash
# postdeploy-rollup-link.test.sh — stubbed-gh tests for scripts/postdeploy-rollup-link.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/postdeploy-rollup-link.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"; export T_DIR="$T"
cat > "$T/bin/gh" <<'MOCK'
#!/usr/bin/env bash
if [ "$1 $2" = "api -X" ]; then [ -n "${LOOKUP_FAIL:-}" ] && exit 1; cat "$T_DIR/search.json"; exit 0; fi
n="${2##*/}"; [ -f "$T_DIR/issue.$n.json" ] && { cat "$T_DIR/issue.$n.json"; exit 0; }
echo "HTTP 404: Not Found" >&2; exit 1
MOCK
chmod +x "$T/bin/gh"; export PATH="$T/bin:$PATH"
PASS=0; FAIL=0
check() { if eval "$2"; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi; }
M='<!-- FORGE:POSTDEPLOY_ROLLUP: default -->'
issue() { printf '{"number":%s,"state":"%s","author_association":"%s","user":{"type":"User"},"body":"%s"%s}\n' "$1" "$2" "$3" "$M" "${4:-}" > "$T/issue.$1.json"; }
reset() { rm -f "$T"/issue.*.json; unset LOOKUP_FAIL; echo '{"items":[{"number":9},{"number":5}]}' > "$T/search.json"; }

reset; issue 5 open OWNER; issue 9 open OWNER
OUT=$(bash "$S" --repo o/r); RC=$?
check "link: lowest open trusted rollup" "[ $RC -eq 0 ] && [ \"\$OUT\" = 'Post-deploy checklist: #5' ]"

reset; issue 5 open NONE; issue 9 open OWNER
OUT=$(bash "$S" --repo o/r)
check "untrusted author skipped, next candidate used" "[ \"\$OUT\" = 'Post-deploy checklist: #9' ]"

reset; issue 5 closed OWNER; issue 9 open OWNER ',"pull_request":{}'
OUT=$(bash "$S" --repo o/r); RC=$?
check "closed issue and PR ignored: empty, rc 0" "[ $RC -eq 0 ] && [ -z \"\$OUT\" ]"

reset; echo '{"items":[]}' > "$T/search.json"
OUT=$(bash "$S" --repo o/r); RC=$?
check "no rollup: empty, rc 0" "[ $RC -eq 0 ] && [ -z \"\$OUT\" ]"

reset; issue 5 open OWNER; OUT=$(LOOKUP_FAIL=1 bash "$S" --repo o/r); RC=$?
check "lookup failure: empty, rc 0" "[ $RC -eq 0 ] && [ -z \"\$OUT\" ]"

reset; issue 5 open OWNER; OUT=$(FORGE_RELEASE_LANE=other bash "$S" --repo o/r)
check "other lane marker does not match" "[ -z \"\$OUT\" ]"

bash "$S" >/dev/null 2>&1; check "missing --repo: exit 2" "[ $? -eq 2 ]"
echo "passed=$PASS failed=$FAIL"; [ "$FAIL" -eq 0 ]
