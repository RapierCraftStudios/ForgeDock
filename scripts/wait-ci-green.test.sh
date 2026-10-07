#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# wait-ci-green.test.sh — offline tests for scripts/wait-ci-green.sh (fake gh on PATH).
# Usage: bash scripts/wait-ci-green.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; GATE="$HERE/wait-ci-green.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PASS=0; FAILN=0
expect() { [ "$2" = "$3" ] && PASS=$((PASS+1)) || { FAILN=$((FAILN+1)); echo "FAIL: $1 (got '$3' want '$2')"; }; }

# Fake gh: `pr view --json headRefOid` prints line N of $T/sha (N = call count, last line repeats);
# `pr checks --json` prints the N-th fixture $T/checks.N (last one repeats); "ERR" fixture = outage.
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
D="$FAKE_DIR"
if [ "$1 $2" = "pr view" ]; then
  n=$(( $(cat "$D/sha.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$D/sha.n"
  total=$(wc -l < "$D/sha"); [ "$n" -gt "$total" ] && n=$total; sed -n "${n}p" "$D/sha"; exit 0
fi
if [ "$1 $2" = "pr checks" ]; then
  case " $* " in *" --json "*) ;; *) [ -f "$D/nochecks" ] && { echo "no checks reported on the 'x' branch" >&2; exit 1; }; exit 1 ;; esac
  n=$(( $(cat "$D/chk.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$D/chk.n"
  f="$D/checks.$n"; while [ ! -f "$f" ] && [ "$n" -gt 1 ]; do n=$((n-1)); f="$D/checks.$n"; done
  c=$(cat "$f"); [ "$c" = "ERR" ] && { echo "HTTP 502" >&2; exit 1; }
  [ "$c" = "NONE" ] && { echo "no checks reported on the 'x' branch" >&2; exit 1; }
  echo "$c"; exit 0
fi
exit 1
GH
chmod +x "$T/bin/gh"

run() { # run <case-dir> [gate args...] -> prints "rc|first line"
  local d="$1"; shift
  local out; out=$(FAKE_DIR="$d" PATH="$T/bin:$PATH" FORGE_CI_INTERVAL=1 FORGE_CI_NO_CHECKS_GRACE=1 bash "$GATE" 7 -R o/r "$@" 2>/dev/null); local rc=$?
  printf '%s|%s' "$rc" "$(printf '%s\n' "$out" | head -1)"
}
mk() { local d="$T/$1"; mkdir -p "$d"; printf 'abc1234\n' > "$d/sha"; shift; local i=1; for c in "$@"; do printf '%s' "$c" > "$d/checks.$i"; i=$((i+1)); done; echo "$d"; }

P='[{"name":"a","bucket":"pass"},{"name":"b","bucket":"skipping"}]'
expect "all pass/skipping" "0|CI_GATE: PASS" "$(run "$(mk pass "$P")")"
expect "one failure" "1|CI_GATE: FAIL" "$(run "$(mk fail '[{"name":"a","bucket":"pass"},{"name":"b","bucket":"fail"}]')")"
expect "cancelled counts as failure" "1|CI_GATE: FAIL" "$(run "$(mk cancel '[{"name":"a","bucket":"cancel"}]')")"
expect "pending then pass" "0|CI_GATE: PASS" "$(run "$(mk pend '[{"name":"a","bucket":"pending"}]' "$P")")"
expect "pending then fail" "1|CI_GATE: FAIL" "$(run "$(mk pendfail '[{"name":"a","bucket":"pending"}]' '[{"name":"a","bucket":"fail"}]')")"
expect "pending past timeout" "3|CI_GATE: TIMEOUT" "$(run "$(mk slow '[{"name":"a","bucket":"pending"}]')" --timeout 2)"
expect "fail wins over pending" "1|CI_GATE: FAIL" "$(run "$(mk mixed '[{"name":"a","bucket":"pending"},{"name":"b","bucket":"fail"}]')")"
expect "transient outage then pass" "0|CI_GATE: PASS" "$(run "$(mk blip ERR "$P")")"
expect "persistent outage" "2|CI_GATE: ERROR" "$(run "$(mk down ERR)" --timeout 60)"
d=$(mk none NONE); touch "$d/nochecks"
expect "no checks after grace passes" "0|CI_GATE: PASS" "$(run "$d")"
expect "no checks + REQUIRE fails closed" "2|CI_GATE: ERROR" "$(FORGE_CI_REQUIRE_CHECKS=1 run "$d")"
d=$(mk moved '[{"name":"a","bucket":"pending"}]' "$P"); printf 'abc1234\nabc1234\ndef5678\n' > "$d/sha"
expect "head moved during wait" "2|CI_GATE: ERROR" "$(run "$d")"
expect "bad pr number" "2|CI_GATE: ERROR" "$(FAKE_DIR="$T/pass" PATH="$T/bin:$PATH" bash "$GATE" abc -R o/r 2>/dev/null | head -1 | sed 's/^/2|/')"
expect "missing repo" "2" "$(FAKE_DIR="$T/pass" PATH="$T/bin:$PATH" bash "$GATE" 7 >/dev/null 2>&1; echo $?)"

# Static guard: every autonomous `gh pr merge` command line in the pipeline specs must be preceded
# (within 25 lines) by a CI gate result check. Prose/manual instructions are not command lines.
for spec in commands/review-pr.md commands/work-on/review.md commands/work-on/remediate.md commands/recover-orphans.md; do
  bad=$(awk '
    { line[NR]=$0 }
    /^[[:space:]]*(MERGE_RESULT=\$\()?gh pr merge / {
      ok=0; for (i=NR-1; i>0 && i>=NR-25; i--) if (line[i] ~ /CI_GATE_RC/) { ok=1; break }
      if (!ok) print FILENAME ":" NR
    }' "$HERE/../$spec")
  expect "every autonomous merge in $spec is CI-gated" "" "$bad"
done
grep -q 'wait-ci-green.sh {PR_NUMBER} {GH_FLAG}' "$HERE/../commands/work-on.md" && PASS=$((PASS+1)) || { FAILN=$((FAILN+1)); echo "FAIL: work-on.md manual merge not CI-gated"; }

echo "wait-ci-green tests: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
