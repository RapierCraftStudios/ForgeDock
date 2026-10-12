#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/consumer-sweep.sh. Run: bash scripts/consumer-sweep.test.sh (bash 3.2 compatible)
# Fixture repos are multi-ecosystem (py, ts, go, yaml, sh) and codebase-agnostic.

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
S="$DIR/consumer-sweep.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/consumer-sweep-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
OUT=""; RC=0

g() { git -C "$T/r" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
run() { OUT=$(bash "$S" --repo "$T/r" "$@" 2>"$T/err"); RC=$?; }
has() { # has <desc> <substring>
  case "$OUT" in *"$2"*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "FAIL: $1 (missing '$2')"; printf '%s\n' "$OUT" | sed 's/^/    /' ;; esac
}
lacks() { # lacks <desc> <substring>
  case "$OUT" in *"$2"*) fail=$((fail+1)); echo "FAIL: $1 (unexpected '$2')"; printf '%s\n' "$OUT" | sed 's/^/    /' ;; *) pass=$((pass+1)) ;; esac
}
rc() { if [ "$RC" = "$1" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $2 (rc=$RC, want $1)"; printf '%s\n' "$OUT" | sed 's/^/    /'; fi; }
reset() { g checkout -q -f base; g branch -q -D feat; g checkout -q -b feat; }

mkdir "$T/r"; git -C "$T/r" init -q -b base >/dev/null 2>&1 || { git -C "$T/r" init -q; g checkout -b base; }
mkdir -p "$T/r/svc" "$T/r/web" "$T/r/cmd" "$T/r/ci" "$T/r/.github/workflows" "$T/r/vendor" "$T/r/scripts"
cat > "$T/r/svc/core.py" <<'P'
def compute_total(items):
    return sum(items)
TIMEOUT_SECONDS = 30
P
echo 'from svc.core import compute_total
print(compute_total([1]))' > "$T/r/svc/user_a.py"
echo 'import { compute_total } from "./bridge"
export const t = compute_total' > "$T/r/web/user_b.ts"
echo 'package cmd
// compute_total mirrors the python helper
func Run() {}' > "$T/r/cmd/main.go"
cat > "$T/r/ci/settings.yaml" <<'P'
retry_budget: 3
pinned_hash: "9f8e7d6c5b4a"
P
cat > "$T/r/.github/workflows/verify.yml" <<'P'
steps:
  - run: test "$(sha256sum policy.txt)" = "9f8e7d6c5b4a"
P
cat > "$T/r/scripts/run.sh" <<'P'
#!/bin/sh
exec tool --output-dir "$OUT_DIRECTORY" --retry_budget
read_cfg() { echo retry_budget; }
parse() { case "$1" in
  --output-dir) shift ;;
esac; }
P
echo 'compute_total vendored copy' > "$T/r/vendor/lib.txt"
echo 'x = TIMEOUT_SECONDS' > "$T/r/svc/user_c.py"
printf 'import os\nOUT = os.environ.get("OUT_DIRECTORY")\n' > "$T/r/svc/cfg.py"
mkdir -p "$T/r/db"
printf -- '-- see "obsolete_table_ref": dropped\nSELECT 1;\n' > "$T/r/db/schema.sql"
echo 'report reads obsolete_table_ref nightly' > "$T/r/db/report.txt"
echo 'docs: pass --output-dir and set OUT_DIRECTORY' > "$T/r/docs.txt"
g add -A; g commit -m base
g checkout -q -b feat

# (a) renamed function: the OLD name is swept across py, ts, go; the changed file is not a site
sed -i.bak 's/compute_total/compute_sum/' "$T/r/svc/core.py"; rm -f "$T/r/svc/core.py.bak"
g add -A; g commit -m rename
run --range base..feat
rc 0 "sweep exits 0"
has "renamed function: py consumer" "compute_total	function	svc/user_a.py:1"
has "renamed function: ts consumer" "compute_total	function	web/user_b.ts:1"
has "renamed function: go consumer" "compute_total	function	cmd/main.go:2"
lacks "changed file is not a site" "svc/core.py"
lacks "vendored path excluded by default" "vendor/lib.txt"

# (b) re-typed function: same name, changed signature line -> still swept
reset
printf 'def compute_total(items, scale):\n    return sum(items) * scale\nTIMEOUT_SECONDS = 30\n' > "$T/r/svc/core.py"
g add -A; g commit -m retype
run --range base..feat
has "re-typed function swept by name" "compute_total	function	svc/user_a.py:1"

# (c) renamed config key + renamed constant
reset
printf 'retry_budget: 3\npinned_hash: "9f8e7d6c5b4a"\n' | sed 's/retry_budget/retry_limit/' > "$T/r/ci/settings.yaml"
sed -i.bak 's/TIMEOUT_SECONDS = 30/TIMEOUT_LIMIT = 30/' "$T/r/svc/core.py"; rm -f "$T/r/svc/core.py.bak"
git -C "$T/r" add -A; g commit -m key
run --range base..feat
has "changed config key swept (sh consumer)" "retry_budget	key	scripts/run.sh:"
has "renamed constant swept" "TIMEOUT_SECONDS	const	svc/user_c.py:1"

# (d) changed literal hash is found in a different workflow
reset
sed -i.bak 's/9f8e7d6c5b4a/1a2b3c4d5e6f/' "$T/r/ci/settings.yaml"; rm -f "$T/r/ci/settings.yaml.bak"
g add -A; g commit -m hash
run --range base..feat
has "old literal hash swept" "9f8e7d6c5b4a	literal	.github/workflows/verify.yml:2"
lacks "new hash is not swept (added side)" "1a2b3c4d5e6f"

# (d2) removed line that starts with "-- " (diff line "--- ...") is content, not a file header
reset
printf 'SELECT 1;\n' > "$T/r/db/schema.sql"
g add -A; g commit -m dropcomment
run --range base..feat
has "removed '-- ' line identifier swept" "obsolete_table_ref	key	db/report.txt:1"

# (e) CLI flag and env var on the removed side
reset
sed -i.bak -e 's/--output-dir "\$OUT_DIRECTORY"/--out "$OUT_DIR"/' -e 's/^  --output-dir)/  --out)/' "$T/r/scripts/run.sh"; rm -f "$T/r/scripts/run.sh.bak"
sed -i.bak 's/OUT_DIRECTORY/OUT_DIR/' "$T/r/svc/cfg.py"; rm -f "$T/r/svc/cfg.py.bak"
g add -A; g commit -m flag
run --range base..feat
has "flag swept without dashes" "output-dir	flag	docs.txt:1"
has "env var swept" "OUT_DIRECTORY	env	docs.txt:1"

# (f) pure additions are not swept
reset
echo 'def brand_new_helper(): pass' >> "$T/r/svc/core.py"; echo 'brand_new_helper' > "$T/r/svc/ref.txt"
g add -A; g commit -m add
run --range base..feat
rc 0 "pure addition exits 0"
lacks "pure addition not swept" "brand_new_helper"

# (g) noise bounds: short ids, stop-list words, cap + truncated row
reset
sed -i.bak 's/def compute_total(items):/def compute_total(items):\n    # type value/' "$T/r/svc/core.py"; rm -f "$T/r/svc/core.py.bak"
printf 'def abc(): pass\ndef value(): pass\n' > "$T/r/svc/short.py"; g add -A; g commit -q -m short; g checkout -q -b feat2 2>/dev/null
git -C "$T/r" rm -q svc/short.py; g commit -m rmshort
run --range feat..feat2
lacks "3-char identifier skipped" "abc"
lacks "stop-list word skipped" "value"
reset
for i in 1 2 3 4 5 6; do echo "compute_total $i" > "$T/r/svc/many$i.txt"; done
g add -A; g commit -m many; g checkout -q -b feat3
sed -i.bak 's/compute_total/compute_sum/' "$T/r/svc/core.py"; rm -f "$T/r/svc/core.py.bak"; g add -A; g commit -m rename
run --range feat..feat3 --cap 2
rows=$(printf '%s\n' "$OUT" | grep -c '^compute_total	function	')
if [ "$rows" = 2 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: cap 2 yields $rows rows"; fi
has "truncated row at cap" "compute_total	truncated	+"
g checkout -q -f base; g branch -q -D feat2 feat3

# (h) extra exclude glob
reset
sed -i.bak 's/compute_total/compute_sum/' "$T/r/svc/core.py"; rm -f "$T/r/svc/core.py.bak"; g add -A; g commit -m rename
run --range base..feat --exclude-glob 'web/'
lacks "configured directory glob excludes web/" "web/user_b.ts"
has "other consumers remain" "svc/user_a.py"

# (i) gate mode: unaddressed, then justified
printf 'CONSUMERS:\n- svc/user_a.py:1 unaffected: imports the alias only\n' > "$T/c1"
run --range base..feat --consumers "$T/c1"
rc 1 "gate fails with unaddressed sites"
has "unaddressed ts consumer named" "UNADDRESSED: compute_total web/user_b.ts:1"
has "unaddressed go consumer named" "UNADDRESSED: compute_total cmd/main.go:2"
lacks "justified site not reported" "svc/user_a.py"
printf 'CONSUMERS:\n- `svc/user_a.py:9` unaffected: alias\n* web/user_b.ts unaffected: re-export\n- cmd/main.go:2 unaffected: comment only\n- svc/user_c.py updated\n' > "$T/c2"
run --range base..feat --consumers "$T/c2"
rc 0 "gate passes when every site is justified"
has "OK line" "OK:"
printf 'CONSUMERS:\n- cmd/main.go unaffected:\n' > "$T/c3"
run --range base..feat --consumers "$T/c3"
rc 1 "reasonless justification does not count"

# (j) worktree mode: uncommitted + untracked changes form the change set
reset
sed -i.bak 's/compute_total/compute_sum/' "$T/r/svc/core.py"; rm -f "$T/r/svc/core.py.bak"
echo 'compute_sum(1)' > "$T/r/svc/user_a.py"
echo 'compute_total again' > "$T/r/svc/untracked_new.txt"
run --range base..WORKTREE
has "unstaged rename swept" "compute_total	function	web/user_b.ts:1"
lacks "modified file is in the change set" "svc/user_a.py"
lacks "untracked file is in the change set" "untracked_new.txt"
g checkout -q -f base; rm -f "$T/r/svc/untracked_new.txt"; g checkout -q -f feat

# (k) identifier mode
run --ident compute_total --ident retry_budget
rc 0 "ident mode exits 0"
has "ident mode lists consumers" "compute_total	ident	svc/user_a.py:1"
has "ident mode lists the definition too (no change set)" "svc/core.py"
run --ident abc
rc 2 "short --ident is a usage error"
run --ident '-e'
rc 2 "dash-leading --ident rejected"

# (l) hostile identifier text is data, never evaluated
reset
printf 'def "$(touch %s/pwned)"():\n' "$T" > /dev/null
printf '%s\n' "x = '\$(touch $T/pwned)'" '`touch '"$T"'/pwned2`' "key: ; touch $T/pwned3" > "$T/r/svc/hostile.txt"
g add -A; g commit -m hostile; g checkout -q -b feat4
git -C "$T/r" rm -q svc/hostile.txt; g commit -m rmhostile
run --range feat..feat4
rc 0 "hostile text sweeps cleanly"
if [ ! -e "$T/pwned" ] && [ ! -e "$T/pwned2" ] && [ ! -e "$T/pwned3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: diff text was evaluated"; fi
g checkout -q -f base; g branch -q -D feat4

# (m) failure modes are exit 2, never a pass
run --range nosuchref..feat
rc 2 "unresolvable base is exit 2"
run --range base
rc 2 "malformed range is exit 2"
OUT=$(bash "$S" --repo "$T" --range base..feat 2>&1); RC=$?
rc 2 "non-repo is exit 2"
run --range base..feat --consumers "$T/missing"
rc 2 "missing consumers file is exit 2"
run --ident compute_total --consumers "$T/c1"
rc 2 "--consumers needs --range"
run
rc 2 "no mode is exit 2"

# (n) survival: an edit that keeps its identifiers flags nothing; prose words and version bumps flag nothing
reset
printf 'cfg = get_setting("alpha_key")\n' > "$T/r/svc/surv.py"
printf 'The tool MUST validate input.\n- `legacy_option` toggles the old path.\n' > "$T/r/docs-note.md"
printf '{\n  "name": "pkg",\n  "version": "1.2.3"\n}\n' > "$T/r/package.json"
printf 'MUST be set. alpha_key lives here. legacy_option is documented. 1.2.3 is pinned.\n' > "$T/r/svc/consumer_notes.txt"
g add -A; g commit -m survbase; g checkout -q -b feat5
printf 'cfg = get_setting("alpha_key", default=None)\n' > "$T/r/svc/surv.py"
printf 'The tool SHOULD validate input.\n- `legacy_option` toggles the old path.\n' > "$T/r/docs-note.md"
printf '{\n  "name": "pkg",\n  "version": "1.2.4"\n}\n' > "$T/r/package.json"
g add -A; g commit -m surv
run --range feat..feat5
rc 0 "survival sweep exits 0"
lacks "kept identifier is not swept" "alpha_key"
lacks "prose word change is not swept" "MUST"
lacks "version bump is not swept" "1.2.3"
lacks "kept backticked token is not swept" "legacy_option"
g checkout -q -b feat6
printf 'The tool SHOULD validate input.\n' > "$T/r/docs-note.md"
g add -A; g commit -m prose2
run --range feat5..feat6
has "removed documented prose option is swept" "legacy_option	"
has "backticked token consumer found" "svc/consumer_notes.txt:1"
g checkout -q -f base; g branch -q -D feat5 feat6

# (o) a removed function whose name is still defined outside the change set is ambiguous, not flagged
reset
printf 'def helper_probe(x):\n    return x\n' > "$T/r/svc/probe_a.py"
printf 'def helper_probe(y):\n    return y\n' > "$T/r/svc/probe_b.py"
printf 'helper_probe(1)\n' > "$T/r/svc/probe_use.py"
g add -A; g commit -m probes; g checkout -q -b feat7
git -C "$T/r" rm -q svc/probe_a.py; g commit -m dropprobe
run --range feat..feat7
has "still-defined name is reported ambiguous" "helper_probe	ambiguous"
lacks "ambiguous name has no site rows" "svc/probe_use.py"
g checkout -q -f base; g branch -q -D feat7

# (p) special-character paths can be justified (gate parser splits on the literal ' unaffected: ', not on characters)
reset
mkdir -p "$T/r/app/[id]" "$T/r/app/(auth)" "$T/r/docs"
echo 'compute_total(page)' > "$T/r/app/[id]/page.tsx"
echo 'compute_total(login)' > "$T/r/app/(auth)/login.tsx"
echo 'compute_total notes' > "$T/r/docs/my notes.md"
g add -A; g commit -m specialpaths; g checkout -q -b feat8
sed -i.bak 's/compute_total/compute_sum/' "$T/r/svc/core.py"; rm -f "$T/r/svc/core.py.bak"; g add -A; g commit -m rename
printf -- '- svc/user_a.py:1 unaffected: alias\n- web/user_b.ts:1 unaffected: re-export\n- cmd/main.go:2 unaffected: comment\n' > "$T/c4"
run --range feat..feat8 --consumers "$T/c4"
rc 1 "special-char paths stay unaddressed until justified"
has "bracket path reported" "UNADDRESSED: compute_total app/[id]/page.tsx:1"
has "paren path reported" "UNADDRESSED: compute_total app/(auth)/login.tsx:1"
has "space path reported" "UNADDRESSED: compute_total docs/my notes.md:1"
printf -- '%s\n' '- svc/user_a.py:1 unaffected: alias' '- web/user_b.ts:1 unaffected: re-export' '- cmd/main.go:2 unaffected: comment' \
  '- app/[id]/page.tsx:12 unaffected: route param only' '- `app/(auth)/login.tsx:3` unaffected: login copy' '* docs/my notes.md:2 unaffected: prose' > "$T/c5"
run --range feat..feat8 --consumers "$T/c5"
rc 0 "special-char paths are accepted as justified"
has "gate OK" "OK:"
printf -- '%s\n' '- app/[id]/page.tsx unresolved: not checked' > "$T/c6"
run --range feat..feat8 --consumers "$T/c6"
rc 1 "an unresolved line never justifies a site"

# (q) advisory mode records sites but never fails
run --range feat..feat8 --mode advisory --consumers "$T/c4"
rc 0 "advisory mode exits 0 with unaddressed sites"
has "advisory prints ADVISORY lines" "ADVISORY: compute_total app/[id]/page.tsx:1"
lacks "advisory never prints UNADDRESSED" "UNADDRESSED"
run --range feat..feat8 --mode sideways
rc 2 "unknown --mode is exit 2"

# (r) budget: an exhausted budget stops the run with the advisory BUDGET_EXCEEDED result, never exit 1
run --range feat..feat8 --budget-seconds 0
rc 0 "zero budget exits 0 in sweep mode"
has "zero budget reports BUDGET_EXCEEDED" "BUDGET_EXCEEDED"
run --range feat..feat8 --budget-seconds 0 --consumers "$T/c6"
rc 0 "zero budget never fails the gate"
has "gate prints BUDGET_EXCEEDED" "BUDGET_EXCEEDED:"
run --range feat..feat8 --budget-seconds abc
rc 2 "non-numeric budget is exit 2"
g checkout -q -f base; g branch -q -D feat8

# (s) one grep per run (a PATH shim counts git grep calls) and a 3000-hit identifier completes fast
reset
mkdir -p "$T/r/bulk"
i=1; while [ "$i" -le 30 ]; do
  j=1; : > "$T/r/bulk/b$i.txt"; while [ "$j" -le 100 ]; do echo "call heavy_symbol_x $j" >> "$T/r/bulk/b$i.txt"; j=$((j+1)); done
  i=$((i+1))
done
printf 'def heavy_symbol_x():\n    pass\ndef other_symbol_y():\n    pass\ndef third_symbol_z():\n    pass\n' > "$T/r/svc/heavy.py"
echo 'other_symbol_y third_symbol_z' > "$T/r/svc/other_use.txt"
g add -A; g commit -m bulk; g checkout -q -b feat9
printf 'def renamed_a():\n    pass\ndef renamed_b():\n    pass\ndef renamed_c():\n    pass\n' > "$T/r/svc/heavy.py"
g add -A; g commit -m renamebulk
mkdir "$T/shim"; REALGIT=$(command -v git)
printf '#!/bin/sh\ncase " $* " in *" grep "*) echo x >> "%s/grepcount" ;; esac\nexec "%s" "$@"\n' "$T" "$REALGIT" > "$T/shim/git"; chmod +x "$T/shim/git"
: > "$T/grepcount"
t0=$SECONDS
OUT=$(PATH="$T/shim:$PATH" bash "$S" --repo "$T/r" --range feat..feat9 2>"$T/err"); RC=$?
elapsed=$((SECONDS - t0))
rc 0 "bulk sweep exits 0"
n=$(wc -l < "$T/grepcount" | tr -d ' ')
if [ "$n" = 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: expected exactly 1 git grep, saw $n"; fi
if [ "$elapsed" -lt 3 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: 3000-hit sweep took ${elapsed}s (want < 3s)"; fi
has "heavy identifier is capped" "heavy_symbol_x	truncated	+2975"
rows=$(printf '%s\n' "$OUT" | grep -c '^heavy_symbol_x	function	')
if [ "$rows" = 25 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: heavy identifier rows=$rows (want 25)"; fi
has "sibling identifiers found with the same single grep" "other_symbol_y	function	svc/other_use.txt:1"
g checkout -q -f base; g branch -q -D feat9

# (t) --eval-history measures flagged sites per merge and prints mean and max (read-only)
mkdir "$T/h"
gh_() { git -C "$T/h" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
git -C "$T/h" init -q -b main >/dev/null 2>&1 || { git -C "$T/h" init -q; gh_ checkout -b main; }
printf 'def legacy_entry():\n    pass\n' > "$T/h/lib.py"; echo 'legacy_entry()' > "$T/h/use.py"
gh_ add -A; gh_ commit -m init
gh_ checkout -q -b topic1; sed -i.bak 's/legacy_entry/modern_entry/' "$T/h/lib.py"; rm -f "$T/h/lib.py.bak"; gh_ add -A; gh_ commit -m t1
gh_ checkout -q main; gh_ merge --no-ff -m "Merge topic1" topic1
gh_ checkout -q -b topic2; echo 'brand_new = 1' > "$T/h/new.py"; gh_ add -A; gh_ commit -m t2
gh_ checkout -q main; gh_ merge --no-ff -m "Merge topic2" topic2
before=$(git -C "$T/h" rev-parse HEAD)
OUT=$(bash "$S" --repo "$T/h" --eval-history 5 2>"$T/err"); RC=$?
rc 0 "eval-history exits 0"
has "eval prints the flagged merge" "sites=1"
has "eval prints mean and max" "mean=0.50 max=1 prs=2"
has "eval reports the guard verdict" "guard=PASS"
if [ "$before" = "$(git -C "$T/h" rev-parse HEAD)" ] && [ -z "$(git -C "$T/h" status --short)" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: eval-history modified the repo"; fi
run --eval-history 2 --range base..feat
rc 2 "eval-history is exclusive with --range"

# forge#4037: a 10,000-line YAML rewrite finishes quickly (per-file token sets, not removed x added), and extraction runs
# under --budget-seconds: a spent budget reports BUDGET_EXCEEDED, advisory, exit 0.
mkdir "$T/y"; gy() { git -C "$T/y" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
git -C "$T/y" init -q -b base >/dev/null 2>&1
awk 'BEGIN{for(i=1;i<=10000;i++) printf "  svc.old-key-%d: value_%d\n", i, i}' > "$T/y/big.yaml"
gy add -A; gy commit -m base; gy checkout -q -b feat
awk 'BEGIN{for(i=1;i<=10000;i++) printf "  svc.new-key-%d: value_%d\n", i, i}' > "$T/y/big.yaml"
gy add -A; gy commit -m rewrite
start=$(date +%s)
OUT=$(bash "$S" --repo "$T/y" --range base..feat --budget-seconds 20 --mode advisory 2>"$T/err"); RC=$?
elapsed=$(( $(date +%s) - start ))
rc 0 "10k-line yaml rewrite exits 0"
if [ "$elapsed" -le 20 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: 10k-line yaml rewrite took ${elapsed}s"; fi
OUT=$(bash "$S" --repo "$T/y" --range base..feat --budget-seconds 0 --mode blocking 2>"$T/err"); RC=$?
rc 0 "zero budget is advisory exit 0"
has "zero budget reports BUDGET_EXCEEDED" "BUDGET_EXCEEDED"

echo "consumer-sweep.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
