#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Tests for scripts/review-prepare.sh (review-pr Phases 1-3B + delta/slices) and its shared libs. A stubbed `gh` and throwaway git repos
# stand in for GitHub and the PR checkout. Run: FORGEDOCK_HOME=$PWD bash scripts/review-prepare.test.sh (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
pass=0; fail=0
ok() { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/review-prepare-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }
command -v yq >/dev/null 2>&1 || { echo "SKIP: yq not installed"; exit 0; }

export HOME="$WORK/home"; mkdir -p "$HOME"
unset FORGE_ROOT FORGE_HOME CLAUDE_PLUGIN_ROOT FORGE_CONFIG FORGE_SCRATCHPAD
export REVIEW_PREPARE_SLEEP=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# ---- stubbed gh: every answer comes from files under $FIX ----
FIX="$WORK/fix"; mkdir -p "$FIX" "$WORK/bin"
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
a="$*"
case "$a" in
  "pr view"*"mergeable,mergeStateStatus"*)
    f="$FIX/merge.seq"; l=$(head -n 1 "$f"); [ "$(wc -l < "$f")" -gt 1 ] && sed -i.bak 1d "$f"; echo "$l" ;;
  "pr view"*"--json body"*) cat "$FIX/body.txt" ;;
  "pr view"*) cat "$FIX/prinfo.json" ;;
  "pr diff"*"--name-only"*) [ -f "$FIX/difffail" ] && exit 1; cat "$FIX/files" ;;
  "pr diff"*) cat "$FIX/diff" ;;
  "pr list"*) cat "$FIX/prior" 2>/dev/null || echo 1 ;;
  "api --paginate"*) [ -f "$FIX/comments.fail" ] && exit 1; cat "$FIX/comments.json" 2>/dev/null || echo '[]' ;;
  "issue view"*"labels"*) cat "$FIX/labels" 2>/dev/null || echo false ;;
  "issue view"*"body"*) cat "$FIX/issuebody" 2>/dev/null ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$WORK/bin/gh"; export FIX PATH="$WORK/bin:$PATH"

# ---- fake trusted install roots (the real one, or a trimmed copy with a stub delta resolver) ----
mkroot() {   # mkroot <dir> [no-roster] [delta-stub-file] [templates]
    local r="$1"; mkdir -p "$r/scripts/lib"
    cp "$ROOT/scripts/lib/forge-resolve.sh" "$ROOT/scripts/lib/review-delta-mode.sh" "$ROOT/scripts/lib/pr-issue-number.sh" "$ROOT/scripts/lib/review-template-resolve.sh" "$r/scripts/lib/"
    cp "$ROOT/scripts/trusted-comments.sh" "$r/scripts/"
    [ "${2:-}" = "no-roster" ] || cp "$ROOT/scripts/review-roster.sh" "$r/scripts/"
    [ -n "${3:-}" ] && cp "$3" "$r/scripts/review-delta.sh"
    if [ -n "${4:-}" ]; then mkdir -p "$r/commands/review-pr-agents"; echo "# protocols" > "$r/commands/review-pr-agents/protocols.md"; fi
}

# ---- throwaway PR checkout: main (A) + one more commit (B = PR head) ----
REPO_DIR="$WORK/repo"; mkdir -p "$REPO_DIR/services/api"
git -C "$REPO_DIR" init -q -b main
echo a > "$REPO_DIR/a.txt"; git -C "$REPO_DIR" add -A; git -C "$REPO_DIR" commit -qm A
SHA_A=$(git -C "$REPO_DIR" rev-parse HEAD)
git -C "$REPO_DIR" checkout -q -b pr-branch; echo b > "$REPO_DIR/services/api/auth.py"
git -C "$REPO_DIR" add -A; git -C "$REPO_DIR" commit -qm B
SHA_B=$(git -C "$REPO_DIR" rev-parse HEAD)
git -C "$REPO_DIR" checkout -q main
git -C "$REPO_DIR" remote add origin "$REPO_DIR"

CFG="$WORK/forge.yaml"
printf 'project:\n  name: Demo\nverification:\n  commands:\n    typescript:\n      build: "npm run build"\n    python:\n      format: "ruff format --check"\n' > "$CFG"

# setup <head> <base> <files> <diff> [sha]
setup() {
    rm -f "${FIX:?}"/*; printf 'MERGEABLE|CLEAN\n' > "$FIX/merge.seq"; : > "$FIX/body.txt"
    printf '{"number":7,"title":"t","author":{"login":"dev"},"baseRefName":"%s","headRefName":"%s","headRefOid":"%s","isCrossRepository":%s,"additions":5,"deletions":2,"changedFiles":1}\n' "$2" "$1" "${5:-$SHA_B}" "${CROSS_REPO:-false}" > "$FIX/prinfo.json"
    printf '%s\n' "$3" > "$FIX/files"; printf '%s\n' "$4" > "$FIX/diff"
}
CTX=""; RC=0
# prep <install root> [extra args...]
prep() {
    local r="$1"; shift
    CTX=$(cd "$REPO_DIR" && FORGEDOCK_HOME="$r" FORGE_CONFIG="${CFG_OVERRIDE:-$CFG}" bash "$ROOT/scripts/review-prepare.sh" --pr 7 --repo o/r --out-dir "$WORK/out" "$@" 2>"$WORK/stderr"); RC=$?
}
jqv() { printf '%s' "$CTX" | jq -r "$1" 2>/dev/null; }
eq() { local got; got=$(jqv "$2"); if [ "$got" = "$3" ]; then ok; else bad "$1: $2 = '$got', want '$3'"; fi; }
rc_is() { if [ "$RC" = "$2" ]; then ok; else bad "$1: exit $RC, want $2 ($(head -c 300 "$WORK/stderr"))"; fi; }

DIFF_PLAIN='diff --git a/README.md b/README.md
+hello'
DIFF_AUTH_BILL='diff --git a/services/api/auth.py b/services/api/auth.py
+def f(): jwt = get_current_user(); stripe.charge()
diff --git a/services/api/billing.py b/services/api/billing.py
+credit = 1'

# --- 1. happy path, schema, small tier ---
setup feat/x staging "README.md" "$DIFF_PLAIN"
prep "$ROOT"
rc_is "happy path" 0
eq "schema" .schema_version 1; eq "status" .status OK; eq "pr number" .pr.number 7; eq "review sha" .pr.review_sha "$SHA_B"
eq "sha7" .pr.review_sha_short "$(printf '%s' "$SHA_B" | cut -c1-7)"
eq "review depth defaults to STANDARD" .roster.review_depth STANDARD
eq "review weight key present in context" '.roster | has("review_weight")' true
eq "small tier" .roster.tier small; eq "small roster" '.roster.agents | join(" ")' security
eq "lines" '.pr.additions + .pr.deletions' 7
eq "first-time false" .pr.first_time_contributor false
eq "template source resolved" '.templates.source != "none"' true
eq "delta FULL" .delta.mode FULL

# --- 2. merge health ---
setup feat/x staging "README.md" "$DIFF_PLAIN"; printf 'UNKNOWN|UNKNOWN\nUNKNOWN|UNKNOWN\nMERGEABLE|CLEAN\n' > "$FIX/merge.seq"
prep "$ROOT"; eq "retry count" .merge_health.retries 2; eq "retry result" .merge_health.mergeable MERGEABLE; eq "retry state" .merge_health.state CLEAN
setup feat/x staging "README.md" "$DIFF_PLAIN"; printf 'CONFLICTING|DIRTY\n' > "$FIX/merge.seq"
prep "$ROOT"; eq "conflicting" .merge_health.mergeable CONFLICTING; eq "conflicting state" .merge_health.state DIRTY; eq "no retry on CONFLICTING" .merge_health.retries 0
setup feat/x staging "README.md" "$DIFF_PLAIN"; printf 'UNKNOWN|UNKNOWN\n' > "$FIX/merge.seq"
prep "$ROOT"; eq "unknown stays unknown after 3 retries" .merge_health.retries 3; eq "still UNKNOWN" .merge_health.mergeable UNKNOWN
setup feat/x staging "README.md" "$DIFF_PLAIN"
# shellcheck disable=SC2016  # the literal $(rm -rf) is the hostile payload under test
printf 'garbage|$(rm -rf)\n' > "$FIX/merge.seq"
prep "$ROOT"; eq "garbage state normalized" .merge_health.state UNKNOWN
setup feat/x staging "README.md" "$DIFF_PLAIN"; echo 0 > "$FIX/prior"
prep "$ROOT"; eq "first-time contributor" .pr.first_time_contributor true

# --- 3. classification + scores ---
setup feat/x staging "services/api/auth.py
services/api/billing.py" "$DIFF_AUTH_BILL"
prep "$ROOT"
eq "services has API" '.classification.services | index("API") != null' true
eq "domains has AUTH" '.classification.domains | index("AUTH") != null' true
eq "domains has BILLING" '.classification.domains | index("BILLING") != null' true
eq "auth score" '.scores.AUTH > 0' true; eq "billing score" '.scores.BILLING > 0' true
eq "security baseline" .scores.SECURITY 1
eq "risk FINANCIAL" '.risk_signals | index("FINANCIAL") != null' true
eq "slice auth file exists" '.slices.auth.diff_file | length > 0' true
AUTH_SLICE=$(jqv '.slices.auth.diff_file')
eq "auth slice name is keyed by head SHA" '.slices.auth.diff_file | endswith("/slice-'"$(printf '%s' "$SHA_B" | cut -c1-7)"'-auth.diff")' true
if grep -q "auth.py" "$AUTH_SLICE" 2>/dev/null; then ok; else bad "auth slice should hold the auth.py diff"; fi
if grep -q "billing.py" "$AUTH_SLICE" 2>/dev/null; then bad "auth slice leaked the billing diff"; else ok; fi
if [ -z "$(ls -A "$WORK"/out/.slice-* 2>/dev/null)" ]; then ok; else bad "temp slice files left behind"; fi
# SHA isolation: a re-run at a different head SHA must not overwrite the earlier head's slice
FIRST_SUM=$(cksum < "$AUTH_SLICE")
setup feat/x staging "services/api/auth.py
services/api/billing.py" "$DIFF_AUTH_BILL
+changed-for-head-A" "$SHA_A"
prep "$ROOT"
AUTH_SLICE_A=$(jqv '.slices.auth.diff_file')
if [ -n "$AUTH_SLICE_A" ] && [ "$AUTH_SLICE_A" != "$AUTH_SLICE" ] && [ -f "$AUTH_SLICE" ] && [ -f "$AUTH_SLICE_A" ]; then ok; else bad "different head SHA must produce a distinct slice file ($AUTH_SLICE_A vs $AUTH_SLICE)"; fi
if [ "$(cksum < "$AUTH_SLICE")" = "$FIRST_SUM" ]; then ok; else bad "earlier head's slice was overwritten by a re-review at another SHA"; fi
if [ -z "$(ls -A "$WORK"/out/.slice-* 2>/dev/null)" ]; then ok; else bad "temp slice files left behind after re-run"; fi
setup feat/x staging "services/api/auth.py
services/api/billing.py" "$DIFF_AUTH_BILL"
prep "$ROOT"
eq "auth slice paths" '.slices.auth.paths | join(" ")' "services/api/auth.py"
eq "security slice is the full diff" '.slices.security.paths | length' 2

# --- 4. roster: thorough, scraping config ordering, unresolved roster script ---
setup feat/x staging "services/api/auth.py
services/api/billing.py" "$DIFF_AUTH_BILL"
prep "$ROOT" --thorough true
eq "thorough tier" .roster.tier full
eq "thorough roster has auth+billing+concurrency" '.roster.agents | (index("auth") != null) and (index("billing") != null) and (index("concurrency") != null)' true
SCRAPE_DIFF='diff --git a/x/scraper.py b/x/scraper.py
+stealth scrape'
setup feat/x staging "x/scraper.py" "$SCRAPE_DIFF"
prep "$ROOT" --thorough true; eq "scraping off without config" '.roster.agents | index("scraper") != null' false
printf 'review:\n  domains:\n    scraping: "tiers"\n' > "$WORK/scrape.yaml"
CFG_OVERRIDE="$WORK/scrape.yaml" prep "$ROOT" --thorough true
eq "scraping scored on first pass once configured" '.roster.agents | index("scraper") != null' true
eq "scraping configured flag" .config.scraping_configured true
eq "absent yq key is empty, not null" '.config.domains.auth' ""
mkroot "$WORK/root-noroster" no-roster
setup feat/x staging "README.md" "$DIFF_PLAIN"
prep "$WORK/root-noroster"
eq "unresolved roster script falls back to full" .roster.tier full
eq "unresolved roster still has security" '.roster.agents | index("security") != null' true

# --- 5. delta mode ---
cat > "$WORK/delta-stub.sh" <<STUB
#!/usr/bin/env bash
case "\${DELTA_KIND:-DELTA}" in
  DELTA) printf 'DELTA %s..%s\nFULL_ROUNDS=%s\n' "$SHA_A" "$SHA_B" "\${DELTA_ROUNDS:-1}" ;;
  BASE_SYNC_ONLY) printf 'BASE_SYNC_ONLY %s\nFULL_ROUNDS=1\n' "$SHA_A" ;;
  JUNK) echo nonsense ;;
esac
STUB
mkroot "$WORK/root-delta" "" "$WORK/delta-stub.sh" templates
FIXFILES="services/api/auth.py
services/api/billing.py"
setup feat/x staging "$FIXFILES" "$DIFF_AUTH_BILL"
DELTA_KIND=DELTA DELTA_ROUNDS=1 prep "$WORK/root-delta"
eq "DELTA mode" .delta.mode DELTA; eq "DELTA from" .delta.from "$SHA_A"; eq "DELTA files" '.delta.files | join(" ")' "services/api/auth.py"
eq "early rounds keep the 3B roster" '.roster.agents | index("security") != null' true
eq "DELTA slice paths narrow to the delta" '.slices.security.paths | join(" ")' "services/api/auth.py"
eq "full_files stays whole" '.full_files | length' 2
DELTA_KIND=DELTA DELTA_ROUNDS=2 prep "$WORK/root-delta"
eq "round 3 roster is security + touched domains" '.roster.agents | join(" ")' "security auth api"
DELTA_KIND=BASE_SYNC_ONLY prep "$WORK/root-delta"
eq "BASE_SYNC_ONLY mode" .delta.mode BASE_SYNC_ONLY; eq "carried from" .delta.carried_from "$SHA_A"
eq "BASE_SYNC_ONLY roster empty" '.roster.agents | length' 0; eq "BASE_SYNC_ONLY no slices" '.slices | length' 0
DELTA_KIND=JUNK prep "$WORK/root-delta"; eq "junk resolver output is FULL" .delta.mode FULL
mkroot "$WORK/root-nodelta" "" "" templates
prep "$WORK/root-nodelta"; eq "unresolved delta script is FULL" .delta.mode FULL
DELTA_KIND=DELTA prep "$WORK/root-delta" --thorough true; eq "thorough never goes DELTA" .delta.mode FULL
setup feat/x staging "$FIXFILES" "$DIFF_AUTH_BILL" "notasha"
DELTA_KIND=DELTA prep "$WORK/root-delta"; eq "unvalidated sha is FULL" .delta.mode FULL

# --- 6. full-build lane: empty trusted config is BLOCKED, never a silent skip ---
TS_DIFF='diff --git a/web/src/app/page.tsx b/web/src/app/page.tsx
+x'
printf 'project:\n  name: Demo\nverification:\n  commands:\n    typescript:\n      typecheck: "tsc"\n' > "$WORK/nobuild.yaml"
setup milestone/m1 staging "web/src/app/page.tsx" "$TS_DIFF"
CFG_OVERRIDE="$WORK/nobuild.yaml" prep "$ROOT"
rc_is "empty ts build on a milestone lane" 3; eq "BLOCKED status" .status BLOCKED
eq "blocker names typescript.build" '.blockers | join(" ") | test("typescript.build")' true
eq "config status blocked" .phase2.build_config.status blocked; eq "lane flag" .lane.requires_full_build true
prep "$ROOT"; rc_is "configured ts build passes" 0; eq "status OK" .status OK
# --build-gate advisory (review-pr-staging): an unconfigured build is a SKIPPED Phase 2 finding, never a block (#3952 QA-1)
CFG_OVERRIDE="$WORK/nobuild.yaml" prep "$ROOT" --build-gate advisory
rc_is "advisory build gate does not block" 0; eq "advisory status OK" .status OK
eq "advisory config status skipped" .phase2.build_config.status skipped
eq "advisory records SKIPPED finding" '.phase2.findings | join(" ") | test("SKIPPED — typescript.build")' true
PY_DIFF='diff --git a/app/x.py b/app/x.py
+x'
printf 'project:\n  name: Demo\n' > "$WORK/empty.yaml"
setup milestone/m1 staging "app/x.py" "$PY_DIFF"
CFG_OVERRIDE="$WORK/empty.yaml" prep "$ROOT"; rc_is "empty python.format on full-build lane" 3
eq "blocker names python.format" '.blockers | join(" ") | test("python.format")' true
setup milestone/m1 staging "README.md" "$DIFF_PLAIN"
CFG_OVERRIDE="$WORK/empty.yaml" prep "$ROOT"; rc_is "docs-only milestone needs no build config" 0
CFG_OVERRIDE="$WORK/missing.yaml" prep "$ROOT"; rc_is "no forge.yaml at all on a full-build lane" 3
setup feat/x staging "web/src/app/page.tsx" "$TS_DIFF"
CFG_OVERRIDE="$WORK/nobuild.yaml" prep "$ROOT"; rc_is "empty ts build on a normal lane is fine" 0
setup staging main "web/src/app/page.tsx" "$TS_DIFF"
CFG_OVERRIDE="$WORK/nobuild.yaml" prep "$ROOT"; rc_is "staging to main requires the build" 3

# --- 7. templates: none is a fatal setup error ---
mkroot "$WORK/root-notpl"
mkdir -p "$WORK/emptyrepo"; printf 'paths:\n  root: %s\n' "$WORK/emptyrepo" > "$WORK/emptyroot.yaml"
setup feat/x staging "README.md" "$DIFF_PLAIN"
CFG_OVERRIDE="$WORK/emptyroot.yaml" prep "$WORK/root-notpl"
rc_is "no template source" 3; eq "templates none" .templates.source none

# --- 8. issue number extraction and trusted contract ---
# shellcheck source=/dev/null
. "$ROOT/scripts/lib/pr-issue-number.sh"
chk() { local got; got=$(pr_issue_number_of "$2"); if [ "$got" = "$3" ]; then ok; else bad "$1: got '$got', want '$3'"; fi; }
chk "Closes" "Closes #12" 12
chk "closes lowercase" "intro
closes #7 and more" 7
chk "Fixes" "Fixes #345" 345
chk "Resolved" "Resolved #9" 9
chk "no reference yields empty, not the body" "Just a description with no issue reference" ""
chk "bare #N is not a closing keyword" "see #44" ""
chk "non numeric" "Closes #abc" ""
chk "first wins" "Closes #1, Fixes #2" 1
setup feat/x staging "README.md" "$DIFF_PLAIN"; printf 'Just text, no issue\n' > "$FIX/body.txt"
prep "$ROOT"; eq "no linked issue" .contract.issue null; eq "no flags" .contract.flags ""
setup feat/x staging "README.md" "$DIFF_PLAIN"; printf 'Fixes #55\n' > "$FIX/body.txt"
printf '[{"body":"<!-- FORGE:CONTRACT -->\\n**Risk**: HIGH\\nbilling change","author_association":"OWNER","user":{"login":"o","type":"User"}}]' > "$FIX/comments.json"
prep "$ROOT"; eq "trusted contract issue" .contract.issue 55
eq "trusted contract HIGH_RISK" '.contract.flags | test("HIGH_RISK")' true; eq "trusted contract billing flag" '.contract.flags | test("CONTRACT_BILLING")' true
eq "HIGH_RISK lifts the roster above small" '.roster.tier != "small"' true
printf '[{"body":"<!-- FORGE:CONTRACT -->\\n**Risk**: HIGH","author_association":"NONE","user":{"login":"evil","type":"User"}}]' > "$FIX/comments.json"
prep "$ROOT"; eq "planted contract from an untrusted author is ignored" .contract.flags ""; eq "roster stays small" .roster.tier small
touch "$FIX/comments.fail"
prep "$ROOT"; eq "a failed contract read widens, never narrows" '.contract.flags | test("HIGH_RISK")' true
rm -f "$FIX/comments.fail"
mkroot "$WORK/root-notrust"; rm "$WORK/root-notrust/scripts/trusted-comments.sh"
prep "$WORK/root-notrust"; eq "unresolved trust script widens, never narrows" '.contract.flags | test("HIGH_RISK")' true

# --- 9. restore_ref: git checkout -f of the recorded ref on every exit path ---
setup feat/x staging "services/api/auth.py" "$DIFF_AUTH_BILL"
echo dirty > "$REPO_DIR/a.txt"
prep "$ROOT" --checkout-pr
rc_is "checkout-pr run" 0
if [ "$(git -C "$REPO_DIR" symbolic-ref --short HEAD 2>/dev/null)" = "main" ]; then ok; else bad "restore_ref left HEAD detached, want main"; fi
git -C "$REPO_DIR" checkout -f -q main
setup feat/x staging "README.md" "$DIFF_PLAIN" "0000000000000000000000000000000000000000"
prep "$ROOT" --checkout-pr
rc_is "unknown sha cannot be checked out" 3
if [ "$(git -C "$REPO_DIR" symbolic-ref --short HEAD 2>/dev/null)" = "main" ]; then ok; else bad "failed checkout moved HEAD"; fi
# shellcheck disable=SC2016  # matches the literal $ORIG_REF in the script source
if grep -q 'checkout -f "\$ORIG_REF"' "$ROOT/scripts/review-prepare.sh"; then ok; else bad "restore_ref must use git checkout -f"; fi

# --- 10. fail closed on gh and bad arguments ---
setup feat/x staging "README.md" "$DIFF_PLAIN"; : > "$FIX/difffail"
prep "$ROOT"; rc_is "gh pr diff failure" 3; eq "blocked on gh failure" .status BLOCKED
# a staging bundle review (--no-delta) reads an API-oversized diff from the long-lived branches; a per-PR review still blocks
setup pr-branch main "README.md" "$DIFF_PLAIN"; : > "$FIX/difffail"
prep "$ROOT" --no-delta; rc_is "--no-delta falls back to git when the API diff fails" 0; eq "fallback status" .status OK
eq "fallback file list comes from git" '.full_files | index("services/api/auth.py") != null' true; eq "--no-delta mode is FULL" .delta.mode FULL
# forge#3935: the fallback is pinned to the review SHA and refuses fork PRs
setup pr-branch main "README.md" "$DIFF_PLAIN" "0000000000000000000000000000000000000000"; : > "$FIX/difffail"
prep "$ROOT" --no-delta; rc_is "--no-delta fallback refuses a branch tip that is not the review SHA" 3
CROSS_REPO=true setup pr-branch main "README.md" "$DIFF_PLAIN"; : > "$FIX/difffail"
prep "$ROOT" --no-delta; rc_is "--no-delta fallback refuses a cross-repository PR" 3
setup feat/x staging "README.md" "$DIFF_PLAIN"; : > "$FIX/difffail"
prep "$ROOT" --no-delta; rc_is "--no-delta with unfetchable branches still fails closed" 3; eq "unfetchable blocked" .status BLOCKED
# forge#4154: a milestone->staging PR (always FULL) gets the same pinned fallback without --no-delta; other per-PR lanes still block
git -C "$REPO_DIR" branch -f milestone/m1 "$SHA_B"; git -C "$REPO_DIR" branch -f staging "$SHA_A"
setup milestone/m1 staging "README.md" "$DIFF_PLAIN"; : > "$FIX/difffail"
prep "$ROOT"; rc_is "milestone->staging falls back to git when the API diff fails" 0; eq "milestone fallback status" .status OK
eq "milestone fallback lane" .lane.is_milestone_to_staging true; eq "milestone fallback mode is FULL" .delta.mode FULL
eq "milestone fallback file list comes from git" '.full_files | index("services/api/auth.py") != null' true
setup milestone/m1 staging "README.md" "$DIFF_PLAIN" "0000000000000000000000000000000000000000"; : > "$FIX/difffail"
prep "$ROOT"; rc_is "milestone fallback refuses a branch tip that is not the review SHA" 3
CROSS_REPO=true setup milestone/m1 staging "README.md" "$DIFF_PLAIN"; : > "$FIX/difffail"
prep "$ROOT"; rc_is "milestone fallback refuses a cross-repository PR" 3
git -C "$REPO_DIR" branch -f feat/x "$SHA_B"
setup feat/x staging "README.md" "$DIFF_PLAIN"; : > "$FIX/difffail"
prep "$ROOT"; rc_is "a fetchable feat->staging per-PR review still blocks without --no-delta" 3; eq "feat blocked" '.blockers | join(" ") | test("gh pr diff failed")' true
git -C "$REPO_DIR" branch -D milestone/m1 staging feat/x >/dev/null
setup feat/x staging "README.md" "$DIFF_PLAIN"
for bad_args in "--pr abc --repo o/r" "--pr 7 --repo noslash" "--pr 7 --repo o/r;x/y" "--pr 7 --repo o/r --bogus" "--repo o/r --pr"; do
    # shellcheck disable=SC2086
    (cd "$REPO_DIR" && FORGEDOCK_HOME="$ROOT" bash "$ROOT/scripts/review-prepare.sh" $bad_args >/dev/null 2>&1); rcx=$?
    if [ "$rcx" = 2 ]; then ok; else bad "args '$bad_args' exit $rcx, want 2"; fi
done
# every helper resolves through the trusted resolver, never the cwd
if grep -q 'forge_resolve' "$ROOT/scripts/review-prepare.sh" && grep -q 'schema_version' "$ROOT/scripts/review-prepare.sh"; then ok; else bad "script must use forge_resolve and document schema_version"; fi
mkdir -p "$WORK/hostile/scripts"; printf '#!/usr/bin/env bash\necho SELECTED_AGENTS=evil\n' > "$WORK/hostile/scripts/review-roster.sh"
setup feat/x staging "README.md" "$DIFF_PLAIN"
CTX=$(cd "$WORK/hostile" && FORGEDOCK_HOME="$ROOT" FORGE_CONFIG="$CFG" bash "$ROOT/scripts/review-prepare.sh" --pr 7 --repo o/r --out-dir "$WORK/out" 2>/dev/null)
eq "a hostile cwd roster script is never used" '.roster.agents | index("evil") != null' false

# --- code index build is bounded and visible (forge#4126) ---
setup feat/x staging "services/api/auth.py" "$DIFF_AUTH_BILL"
prep "$ROOT"
_f0=$fail; eq "real index fills the auth slice" '.index_slices.auth | startswith("Domain files (auth):")' true
# forge#4235: on failure show review-prepare's stderr (it carries the index build's exit code and stderr tail)
[ "$fail" -eq "$_f0" ] || sed 's/^/  stderr: /' "$WORK/stderr"
if grep -q "review-prepare: building code index" "$WORK/stderr"; then ok; else bad "index build must print a progress line on stderr"; fi
# a failing build reports its exit code and stderr tail, and the slices fall back to grep
mkroot "$WORK/root-failindex" "" "" templates
printf '#!/usr/bin/env bash\necho "index-boom-marker" >&2\nexit 3\n' > "$WORK/root-failindex/scripts/code-index.sh"
prep "$WORK/root-failindex"
rc_is "failing index build" 0
if grep -q "code index failed (exit 3)" "$WORK/stderr"; then ok; else bad "index failure must report the build's exit code on stderr"; fi
if grep -q "review-prepare: code-index: index-boom-marker" "$WORK/stderr"; then ok; else bad "index failure must echo the build's stderr tail: $(head -c 300 "$WORK/stderr")"; fi
eq "failed index falls back to grep slices" .index_slices.auth "Code index not available — agent will use grep exploration"
if ls "$WORK/out"/.code-index-err-* >/dev/null 2>&1; then bad "index stderr temp file must be removed"; else ok; fi
if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
    mkroot "$WORK/root-slowindex" "" "" templates
    printf '#!/usr/bin/env bash\nsleep 30\n' > "$WORK/root-slowindex/scripts/code-index.sh"
    t0=$(date +%s)
    REVIEW_PREPARE_INDEX_TIMEOUT=1 prep "$WORK/root-slowindex"; t1=$(date +%s)
    rc_is "hung index build" 0
    if [ $((t1 - t0)) -lt 20 ]; then ok; else bad "hung index build was not bounded ($((t1 - t0))s)"; fi
    eq "timed-out index falls back to grep slices" .index_slices.auth "Code index not available — agent will use grep exploration"
    if grep -q "code index timed out after 1s" "$WORK/stderr"; then ok; else bad "index timeout must be reported on stderr"; fi
fi

echo "review-prepare tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
