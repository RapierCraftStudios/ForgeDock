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
  if [ -f "$D/headerr" ]; then hn=$(( $(cat "$D/headerr.n" 2>/dev/null || echo 0) + 1 )); echo "$hn" > "$D/headerr.n"; if [ "$hn" -le "$(cat "$D/headerr.max")" ]; then cat "$D/headerr" >&2; exit 1; fi; fi
  n=$(( $(cat "$D/sha.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$D/sha.n"
  total=$(wc -l < "$D/sha"); [ "$n" -gt "$total" ] && n=$total; sed -n "${n}p" "$D/sha"; exit 0
fi
if [ "$1" = "api" ]; then
  case "$2" in *actions/runs*) cat "$D/runs" 2>/dev/null || echo 0; exit 0 ;; esac
  exit 1
fi
if [ "$1 $2" = "pr checks" ]; then
  case " $* " in *" --json "*) ;; *)
    [ -f "$D/nochecks" ] && { echo "no checks reported on the 'x' branch" >&2; exit 1; }
    cn=$(cat "$D/chk.n" 2>/dev/null || echo 1); while [ ! -f "$D/checks.$cn" ] && [ "$cn" -gt 1 ]; do cn=$((cn-1)); done; cc=$(cat "$D/checks.$cn" 2>/dev/null || true)
    case "$cc" in RALR) echo "HTTP 403: API rate limit already exceeded for user ID 12345. (https://api.github.com/graphql)" >&2 ;; RATE) echo "HTTP 403: API rate limit exceeded for user (https://api.github.com/graphql)" >&2 ;; SECOND) echo "You have exceeded a secondary rate limit" >&2 ;; ERR) echo "HTTP 502: Bad Gateway" >&2 ;; ERRX) echo "boom: unexpected failure" >&2 ;; A403) echo "HTTP 403: Resource not accessible by personal access token" >&2 ;; A401) echo "HTTP 401: Bad credentials" >&2 ;; R429) echo "HTTP 429: Too Many Requests" >&2 ;; RHDR) printf "HTTP 403: Forbidden\nx-ratelimit-remaining: 0\n" >&2 ;; TMO) echo "dial tcp: i/o timeout" >&2 ;; esac
    exit 1 ;; esac
  n=$(( $(cat "$D/chk.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$D/chk.n"
  f="$D/checks.$n"; while [ ! -f "$f" ] && [ "$n" -gt 1 ]; do n=$((n-1)); f="$D/checks.$n"; done
  c=$(cat "$f"); case "$c" in ERR|ERRX|RALR|RATE|SECOND|A403|A401|R429|RHDR|TMO) exit 1 ;; esac
  [ "$c" = "NONE" ] && { echo "no checks reported on the 'x' branch" >&2; exit 1; }
  echo "$c"; exit 0
fi
exit 1
GH
chmod +x "$T/bin/gh"

run() { # run <case-dir> [gate args...] -> prints "rc|first line"
  local d="$1"; shift
  local out; out=$(FAKE_DIR="$d" PATH="$T/bin:$PATH" FORGE_CI_INTERVAL=1 FORGE_CI_NO_CHECKS_GRACE=1 FORGE_CI_SETTLE="${SETTLE:-0}" bash "$GATE" 7 -R o/r "$@" 2>/dev/null); local rc=$?
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
# forge#4270: --ignore-check drops the named check (the lane's own report-only forgedock/verify) before deciding.
OWN='[{"name":"a","bucket":"pass"},{"name":"forgedock/verify","bucket":"fail"}]'
# forge#4298: forgedock/verify is ignored by default, so every caller (legacy engine, review-finalize, spec gates) agrees.
expect "own verify check failing is ignored by default" "0|CI_GATE: PASS" "$(run "$(mk ownfail "$OWN")")"
expect "default ignore keeps other failures" "1|CI_GATE: FAIL" "$(run "$(mk owndef '[{"name":"b","bucket":"fail"},{"name":"forgedock/verify","bucket":"fail"}]')")"
expect "usage text lists --ignore-check" "1" "$(bash "$GATE" 2>&1 >/dev/null | grep -c -- '--ignore-check NAME')"
expect "--ignore-check drops the named failing check" "0|CI_GATE: PASS" "$(run "$(mk ownign "$OWN")" --ignore-check forgedock/verify)"
expect "--ignore-check keeps other failures" "1|CI_GATE: FAIL" "$(run "$(mk ownother '[{"name":"b","bucket":"fail"},{"name":"forgedock/verify","bucket":"pass"}]')" --ignore-check forgedock/verify)"
expect "--ignore-check without a name is a usage error" "2|CI_GATE: ERROR" "$(run "$(mk ownusage "$P")" --ignore-check)"
expect "transient outage then pass" "0|CI_GATE: PASS" "$(run "$(mk blip ERR "$P")")"
expect "persistent unclassified failure is an ERROR" "2|CI_GATE: ERROR" "$(run "$(mk down ERRX)" --timeout 60)"
# Rate-limit / 5xx classification: retried, never an ERROR; a window that only saw them ends RATE_LIMITED (rc 4).
expect "rate limited then pass retries" "0|CI_GATE: PASS" "$(run "$(mk rl RATE "$P")")"
expect "secondary limit then pass retries" "0|CI_GATE: PASS" "$(run "$(mk rl2 SECOND "$P")")"
expect "transient 5xx then pass retries" "0|CI_GATE: PASS" "$(run "$(mk fivexx ERR "$P")")"
expect "rate limited for the whole window is RATE_LIMITED rc 4" "4|CI_GATE: RATE_LIMITED" "$(run "$(mk rlall RATE)" --timeout 2)"
expect "more than 5 rate-limit hits are not an ERROR" "0|CI_GATE: PASS" "$(run "$(mk rlmany RATE RATE RATE RATE RATE RATE RATE "$P")" --timeout 60)"
# forge#4037: only real rate-limit evidence is RATE_LIMITED; a bare 401/403 fails fast; timeouts/5xx are a small bounded retry.
expect "bare 403 is a permanent error rc 2" "2|CI_GATE: ERROR" "$(run "$(mk a403 A403 "$P")" --timeout 60)"
expect "bare 401 is a permanent error rc 2" "2|CI_GATE: ERROR" "$(run "$(mk a401 A401 "$P")" --timeout 60)"
expect "HTTP 429 is RATE_LIMITED rc 4" "4|CI_GATE: RATE_LIMITED" "$(run "$(mk r429 R429)" --timeout 2)"
expect "x-ratelimit-remaining: 0 on a 403 is RATE_LIMITED rc 4" "4|CI_GATE: RATE_LIMITED" "$(run "$(mk rhdr RHDR)" --timeout 2)"
expect "network timeout then pass retries" "0|CI_GATE: PASS" "$(run "$(mk tmo TMO "$P")")"
expect "persistent network timeout is a bounded ERROR, not the long wait" "2|CI_GATE: ERROR" "$(FORGE_CI_TRANSIENT_RETRIES=2 run "$(mk tmoall TMO)" --timeout 600)"
expect "persistent 5xx is a bounded ERROR, not the long wait" "2|CI_GATE: ERROR" "$(FORGE_CI_TRANSIENT_RETRIES=2 run "$(mk fivexxall ERR)" --timeout 600)"
# forge#4037: the initial head read uses the same classification.
d=$(mk headrl "$P"); echo "HTTP 403: API rate limit exceeded for user" > "$d/headerr"; echo 2 > "$d/headerr.max"
expect "rate-limited head read waits, then passes" "0|CI_GATE: PASS" "$(run "$d" --timeout 60)"
d=$(mk headrlall "$P"); echo "HTTP 429: Too Many Requests" > "$d/headerr"; echo 99999 > "$d/headerr.max"
expect "rate-limited head read for the whole window is rc 4" "4|CI_GATE: RATE_LIMITED" "$(run "$d" --timeout 2)"
d=$(mk head403 "$P"); echo "HTTP 403: Resource not accessible" > "$d/headerr"; echo 99999 > "$d/headerr.max"
# forge#4040: the GraphQL wording "API rate limit already exceeded (HTTP 403)" is a rate limit (rc 4), not the auth class (rc 2).
expect "GraphQL 'rate limit already exceeded' 403 is RATE_LIMITED rc 4" "4|CI_GATE: RATE_LIMITED" "$(run "$(mk ralr RALR)" --timeout 2)"
expect "rate limit already exceeded, then pass" "0|CI_GATE: PASS" "$(run "$(mk ralr2 RALR "$P")" --timeout 60)"
d=$(mk headralr "$P"); echo "HTTP 403: API rate limit already exceeded for user ID 12345." > "$d/headerr"; echo 99999 > "$d/headerr.max"
expect "GraphQL 'already exceeded' head read is RATE_LIMITED rc 4" "4|CI_GATE: RATE_LIMITED" "$(run "$d" --timeout 2)"
d=$(mk head403b "$P"); echo "HTTP 403: Resource not accessible" > "$d/headerr"; echo 99999 > "$d/headerr.max"
expect "bare 403 head read is rc 2" "2|CI_GATE: ERROR" "$(run "$d" --timeout 60)"
# Jitter: sleeps vary within +/-20% of the interval (fake sleep records its argument and returns at once).
mkdir -p "$T/bin2"; printf '#!/usr/bin/env bash\necho "$1" >> "$FAKE_DIR/sleeps"\n' > "$T/bin2/sleep"; chmod +x "$T/bin2/sleep"
d=$(mk jit '[{"name":"a","bucket":"pending"}]' '[{"name":"a","bucket":"pending"}]' '[{"name":"a","bucket":"pending"}]' '[{"name":"a","bucket":"pending"}]' '[{"name":"a","bucket":"pending"}]' '[{"name":"a","bucket":"pending"}]' '[{"name":"a","bucket":"pending"}]' '[{"name":"a","bucket":"pending"}]' "$P")
FAKE_DIR="$d" PATH="$T/bin2:$T/bin:$PATH" FORGE_CI_INTERVAL=100 FORGE_CI_SETTLE=0 bash "$GATE" 7 -R o/r >/dev/null 2>&1
expect "jittered sleeps stay within +/-20%" "0" "$(awk '$1<80||$1>120{bad++} END{print bad+0}' "$d/sleeps")"
expect "jitter is applied (not a fixed interval)" "1" "$(awk '{u[$1]=1} END{n=0; for(k in u) n++; print (n>1)?1:0}' "$d/sleeps")"
d=$(mk none NONE); touch "$d/nochecks"
expect "no checks after grace passes" "0|CI_GATE: PASS" "$(run "$d")"
expect "no checks + REQUIRE fails closed" "2|CI_GATE: ERROR" "$(FORGE_CI_REQUIRE_CHECKS=1 run "$d")"
d=$(mk moved '[{"name":"a","bucket":"pending"}]' "$P"); printf 'abc1234\nabc1234\ndef5678\n' > "$d/sha"
expect "head moved during wait" "2|CI_GATE: ERROR" "$(run "$d")"
expect "bad pr number" "2|CI_GATE: ERROR" "$(FAKE_DIR="$T/pass" PATH="$T/bin:$PATH" bash "$GATE" abc -R o/r 2>/dev/null | head -1 | sed 's/^/2|/')"
expect "missing repo" "2" "$(FAKE_DIR="$T/pass" PATH="$T/bin:$PATH" bash "$GATE" 7 >/dev/null 2>&1; echo $?)"

d=$(mk runsnochecks NONE); touch "$d/nochecks"; echo 3 > "$d/runs"
expect "no checks but workflow runs exist keeps waiting (timeout)" "3|CI_GATE: TIMEOUT" "$(run "$d" --timeout 3)"
expect "pass is held until the settle period" "0|CI_GATE: PASS" "$(SETTLE=2 run "$(mk settle "$P")")"
out=$(FAKE_DIR="$(mk headline "$P")" PATH="$T/bin:$PATH" FORGE_CI_INTERVAL=1 FORGE_CI_SETTLE=0 bash "$GATE" 7 -R o/r 2>/dev/null)
expect "every result names the gated head" "CI_GATE_HEAD: abc1234" "$(printf '%s\n' "$out" | grep '^CI_GATE_HEAD:')"

# Static guard: every autonomous `gh pr merge` command line in the pipeline specs must be preceded
# (within 25 lines) by a CI gate result check. Prose/manual instructions are not command lines.
for spec in commands/review-pr.md scripts/review-finalize.sh commands/work-on/review.md commands/work-on/remediate.md commands/recover-orphans.md commands/deploy-pr.md; do
  bad=$(awk '
    { line[NR]=$0 }
    /^[[:space:]]*(MERGE_RESULT=\$\()?gh pr merge / {
      ok=0; for (i=NR-1; i>0 && i>=NR-25; i--) if (line[i] ~ /CI_GATE_RC/) { ok=1; break }
      if (!ok) print FILENAME ":" NR
    }' "$HERE/../$spec")
  expect "every autonomous merge in $spec is CI-gated" "" "$bad"
done
# Every autonomous merge pins the gated head (forge#3187): no merge line may omit --match-head-commit.
for spec in commands/review-pr.md scripts/review-finalize.sh commands/work-on/review.md commands/work-on/remediate.md commands/recover-orphans.md commands/deploy-pr.md; do
  unpinned=$(grep -nE '^[[:space:]]*(MERGE_RESULT=\$\(|MERGE_OUTPUT=\$\()?gh pr merge ' "$HERE/../$spec" | grep -v -- '--match-head-commit')
  expect "every autonomous merge in $spec pins the gated head" "" "$unpinned"
done
# The gate's own default timeout stays under the 10-minute Bash tool limit (forge#3189).
expect "default gate timeout fits one Bash call" "540" "$(sed -n 's/.*TIMEOUT="\${FORGE_CI_TIMEOUT:-\([0-9]*\)}".*/\1/p' "$GATE")"

# The /work-on router never merges: every merge lives in a CI-gated phase.
if grep -qE '^[[:space:]]*(MERGE_RESULT=\$\()?gh pr merge ' "$HERE/../commands/work-on.md"; then FAILN=$((FAILN+1)); echo "FAIL: work-on.md router contains a merge command"; else PASS=$((PASS+1)); fi

# Reviewed-head guard: review-pr Phase 8 must refuse to merge a head other than the reviewed commit,
# and the work-on callers must route "stale review" to a re-review, never a manual merge.
grep -qF '${GATED_HEAD#"$REVIEWED_SHORT"}' "$HERE/../scripts/review-finalize.sh" && PASS=$((PASS+1)) || { FAILN=$((FAILN+1)); echo "FAIL: review-pr Phase 8 (scripts/review-finalize.sh merge-gate) lacks reviewed-head guard"; }
for f in commands/work-on/review.md; do
  grep -q 'stale review' "$HERE/../$f" && PASS=$((PASS+1)) || { FAILN=$((FAILN+1)); echo "FAIL: $f does not route stale review"; }
done

echo "wait-ci-green tests: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
