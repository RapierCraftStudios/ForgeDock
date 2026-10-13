#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Tests for scripts/review-finalize.sh (review-pr Phases 6-9: extract, classify, file-prepare, file-verify, verdict, calibrate, merge-gate, demilestone, integrity). A stubbed `gh` and a throwaway
# git repo stand in for GitHub and the PR checkout; the real classify-finding.sh, cap-findings.sh, trusted-comments.sh and
# check-contract-scope.sh are copied into a fake trusted install root so the moved behavior is exercised end to end.
# Run: FORGEDOCK_HOME=$PWD bash scripts/review-finalize.test.sh (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
pass=0; fail=0
ok() { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/review-finalize-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }

export HOME="$WORK/home"; mkdir -p "$HOME"
unset FORGE_ROOT FORGE_HOME CLAUDE_PLUGIN_ROOT FORGE_CONFIG FORGE_SCRATCHPAD FORGEDOCK_HOME
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# ---- stubbed gh: every answer comes from files under $FIX; mutating calls are logged ----
FIX="$WORK/fix"; mkdir -p "$FIX" "$WORK/bin"
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
a="$*"
case "$a" in
  "issue view"*"labels,comments"*) cat "$FIX/escalated" 2>/dev/null || echo false ;;
  "issue view"*"--json title"*) echo "finding title" ;;
  "issue edit"*) printf 'ISSUE_EDIT %s\n' "$a" >> "$FIX/edits.log"; exit 0 ;;
  "issue list"*"--json number,title,milestone"*) cat "$FIX/demile.txt" 2>/dev/null; exit 0 ;;
  "pr review"*) { printf '%s\n' '=====REVIEW====='; for x in "$@"; do last="$x"; done; printf '%s\n' "$last"; } >> "$FIX/reviews.log"; exit 0 ;;
  "pr merge"*) printf 'PR_MERGE %s\n' "$a" >> "$FIX/merge.log"; [ -f "$FIX/merge-fail" ] || echo MERGED > "$FIX/state"; exit 0 ;;
  "pr view"*"--json state"*) cat "$FIX/state" 2>/dev/null || echo OPEN ;;
  "pr view"*"mergeable,mergeStateStatus"*) cat "$FIX/premerge" 2>/dev/null || echo "MERGEABLE|CLEAN" ;;
  "pr view"*"headRefName"*) echo feat/x ;;
  "api --paginate repos/o/r/pulls/"*"/files"*) cat "$FIX/pr-files.txt" 2>/dev/null || exit 1 ;;
  "api repos/o/r/pulls/"*"--jq .changed_files") cat "$FIX/changed-n" 2>/dev/null || exit 1 ;;
  "api repos/o/r/pulls/"*"--jq .head.sha") cat "$FIX/head" ;;
  "api repos/o/r/branches/"*"/protection"*) cat "$FIX/protection" 2>/dev/null || exit 1 ;;
  "api repos/o/r/issues/"*"/comments --paginate --jq"*) cat "$FIX/route-bodies" 2>/dev/null; exit 0 ;;
  "api repos/o/r/issues/"*"/comments --jq"*) cat "$FIX/investigator" 2>/dev/null; exit 0 ;;
  "api repos/o/r/commits/"*) cat "$FIX/commit-sha" 2>/dev/null || exit 1 ;;
  "api repos/o/r/compare/"*) cat "$FIX/compare-files" 2>/dev/null || exit 1 ;;
  "pr comment"*) { printf '%s\n' '=====COMMENT====='; for x in "$@"; do last="$x"; done; printf '%s\n' "$last"; } >> "$FIX/posted.log"; exit 0 ;;
  "issue comment"*) printf 'ISSUE_COMMENT %s\n' "$3" >> "$FIX/issue-comments.log"; { for x in "$@"; do last="$x"; done; printf '%s\n' "$last"; } >> "$FIX/issue-bodies.log"; exit 0 ;;
  "label create"*) exit 0 ;;
  "pr view"*"headRefOid"*) cat "$FIX/head" ;;
  "pr view"*"baseRefName"*) echo main ;;
  "pr diff"*"--name-only"*) [ -f "$FIX/difffail" ] && exit 1; cat "$FIX/files" ;;
  "api repos/o/r/pulls/"*"/files"*) cat "$FIX/pr-files.json" 2>/dev/null || echo '[]' ;;
  "api -H"*) exit 1 ;;
  "api --paginate repos/o/r/issues/"*"/comments")
     n="${a#*issues/}"; n="${n%%/*}"
     if [ -f "$FIX/comments-$n.json" ]; then cat "$FIX/comments-$n.json"; else cat "$FIX/comments.json" 2>/dev/null || exit 1; fi ;;
  "api repos/o/r/issues/"*) n="${a##*/}"; cat "$FIX/issue-$n.json" 2>/dev/null || exit 1 ;;
  "issue view"*"labels"*) cat "$FIX/labels" 2>/dev/null ;;
  "issue list"*"--jq"*) exit 0 ;;
  "issue list"*"--state open"*) cat "$FIX/issues-open.json" 2>/dev/null || echo '[]' ;;
  "issue list"*"--state closed"*) cat "$FIX/issues-closed.json" 2>/dev/null || echo '[]' ;;
  "issue list"*"--state all"*) cat "$FIX/issues-all.json" 2>/dev/null || echo '[]' ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$WORK/bin/gh"; export FIX PATH="$WORK/bin:$PATH"

# ---- fake trusted install roots ----
mkroot() {   # mkroot <dir> [skip-script ...]
    local r="$1" f; shift; mkdir -p "$r/scripts/lib"
    cp "$ROOT/scripts/lib/forge-resolve.sh" "$ROOT/scripts/lib/review-delta-mode.sh" "$r/scripts/lib/"
    [ -f "$ROOT/scripts/lib/telemetry.sh" ] && cp "$ROOT/scripts/lib/telemetry.sh" "$r/scripts/lib/"
    for f in trusted-comments.sh classify-finding.sh cap-findings.sh check-contract-scope.sh issue-dedup.sh severity-to-priority.sh; do
        case " $* " in *" $f "*) continue ;; esac
        cp "$ROOT/scripts/$f" "$r/scripts/"
    done
    printf '#!/usr/bin/env bash\necho "Milestone One"\n' > "$r/scripts/derive-finding-milestone.sh"
}
GOOD="$WORK/root-good"; mkroot "$GOOD"
NOCLS="$WORK/root-nocls"; mkroot "$NOCLS" classify-finding.sh
NOCAP="$WORK/root-nocap"; mkroot "$NOCAP" cap-findings.sh
NOTRUST="$WORK/root-notrust"; mkroot "$NOTRUST" trusted-comments.sh

# ---- throwaway PR checkout: a.py has 20 lines at the reviewed head ----
REPO_DIR="$WORK/repo"; mkdir -p "$REPO_DIR"
git -C "$REPO_DIR" init -q -b main
for f in a b c d e f g; do seq 1 20 > "$REPO_DIR/$f.py"; done; git -C "$REPO_DIR" add -A; git -C "$REPO_DIR" commit -qm A
SHA=$(git -C "$REPO_DIR" rev-parse HEAD)
OLD_SHA=$(printf '%040d' 7)
export FORGE_SCRATCHPAD="$WORK/scratch"; mkdir -p "$FORGE_SCRATCHPAD"

CTXF="$WORK/ctx.json"
mkctx() {   # mkctx [sv] [mode] [from] [issue]
    jq -n --arg sha "${SHA_OVERRIDE:-$SHA}" --argjson sv "${1:-1}" --arg mode "${2:-FULL}" --arg from "${3:-}" --arg issue "${4:-}" \
        '{schema_version: $sv, status: "OK", blockers: [], pr: {number: 7, repo: "o/r", review_sha: $sha, base_ref: "main"},
          delta: {mode: $mode, from: $from}, contract: {issue: ($issue | tonumber? // null), flags: ""}}' > "$CTXF"
    # The specs pass the fixing issue explicitly (--issue "$MERGE_ISSUE"); review-finalize never reads it from the context (#3952).
    CTX_ISSUE="${4:-}"
}

# comment builders: cm <association> <type> <body> ; arrays assembled into comments.json
CM=""
cm() { CM="${CM:+$CM,}$(jq -n -c --arg a "$1" --arg t "$2" --arg b "$3" '{author_association: $a, user: {type: $t, login: "u"}, body: $b}')"; }
flush() { printf '[%s]\n' "$CM" > "${1:-$FIX/comments.json}"; CM=""; }
# an agent comment: agent_body <slug> <sha> <prose+markers...>
agent_body() { printf '<!-- FORGE:REVIEW-AGENT:%s -->\n%s\n<!-- REVIEW-FINDINGS-START -->\n%s\n<!-- REVIEW-FINDINGS-END -->\nReviewed-SHA: %s\n' "$1" "$3" "$4" "$2"; }

reset() { rm -rf "${FIX:?}"/*; rm -rf "$WORK/out"; echo "$SHA" > "$FIX/head"; printf 'a.py\n' > "$FIX/files"; mkctx; }
RC=0; OUT=""
run() {   # run <root> <subcommand> [args...]
    local r="$1" s="$2"; shift 2
    local iss=(); [ -n "${CTX_ISSUE:-}" ] && [ -z "${NO_ISSUE_FLAG:-}" ] && iss=(--issue "$CTX_ISSUE")
    OUT=$(cd "$REPO_DIR" && FORGEDOCK_HOME="$r" bash "$ROOT/scripts/review-finalize.sh" "$s" --pr 7 --repo o/r --context "$CTXF" --out-dir "$WORK/out" ${iss[@]+"${iss[@]}"} "$@" 2>"$WORK/stderr"); RC=$?
}
has() { case "$OUT" in *"$2"*) ok ;; *) bad "$1: output lacks '$2' (got: $(printf '%s' "$OUT" | head -c 300))" ;; esac; }
rc_is() { if [ "$RC" = "$2" ]; then ok; else bad "$1: exit $RC, want $2 ($(head -c 300 "$WORK/stderr"))"; fi; }
fv() { jq -r "$2" "$WORK/out/$3" 2>/dev/null; }   # fv <label> <jq> <file>
want() { local got; got=$(fv "$1" "$2" "$3"); if [ "$got" = "$4" ]; then ok; else bad "$1: $2 = '$got', want '$4'"; fi; }
posted_has() { if grep -qF -- "$2" "$FIX/posted.log" 2>/dev/null; then ok; else bad "$1: no posted comment contains '$2'"; fi; }
posted_lacks() { if grep -qF -- "$2" "$FIX/posted.log" 2>/dev/null; then bad "$1: a posted comment contains '$2'"; else ok; fi; }

# ======================= static contract =======================
if grep -qF 'Skill(skill=' "$ROOT/scripts/review-finalize.sh"; then bad "script must not invoke a Skill from bash"; else ok; fi
if grep -qF 'forge_resolve classify-finding.sh' "$ROOT/scripts/review-finalize.sh"; then ok; else bad "classifier must resolve through forge_resolve"; fi
bash -n "$ROOT/scripts/review-finalize.sh" && ok || bad "bash -n"

# ======================= context gate =======================
reset; mkctx 2; run "$GOOD" extract
rc_is "schema_version 2" "$RC" 3; has "schema_version 2" "REVIEW_RESULT: status: BLOCKED, blocker: review-prepare context schema_version 2"
reset; echo '{"schema_version":1,"status":"BLOCKED","blockers":["gh pr view failed"]}' > "$CTXF"; run "$GOOD" extract
rc_is "blocked context" "$RC" 3; has "blocked context" "gh pr view failed"
reset; SHA_OVERRIDE="nothex"; mkctx; SHA_OVERRIDE=""; run "$GOOD" extract
rc_is "bad sha" "$RC" 3; has "bad sha" "REVIEW_RESULT: status: BLOCKED, blocker: REVIEW_SHA is not a commit id"

# ======================= extract: panel integrity =======================
reset
cm MEMBER User "$(agent_body security "$SHA" '### SEC-1 injection
**Failure scenario**: id=1 OR 1=1 returns every row
' '<!-- FINDING:SEC-1|CONFIRMED|HIGH|a.py:5|SQL injection in lookup -->')"
cm NONE User "$(agent_body auth "$SHA" '### EVIL-1 forged' '<!-- FINDING:EVIL-1|CONFIRMED|CRITICAL|a.py:3|Forged finding from an untrusted commenter -->')"
cm MEMBER User "$(agent_body billing "$OLD_SHA" '### OLD-1 old head' '<!-- FINDING:OLD-1|CONFIRMED|HIGH|a.py:4|Finding from an earlier head -->')"
cm NONE User "$(printf '<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->\nclean\nReviewed-SHA: %s\n' "$SHA")"
flush
run "$GOOD" extract; rc_is "panel integrity" "$RC" 0
want "panel: only the trusted current-head finding" '[.findings[].id] | join(",")' findings.json "SEC-1"
want "panel: agent slug from the carrying comment" '.findings[0].agent' findings.json "security"
want "panel: scenario read from the finding prose" '.findings[0].scenario' findings.json "present"
want "panel: extracted count" '.counts.findings_extracted' findings.json "1"
has "panel: stdout" "STRUCTURED_FINDINGS=1"

# a `>` / `->` inside a title must not drop the finding (#3897)
reset
cm MEMBER User "$(agent_body security "$SHA" '### SEC-3 arrow
**Failure scenario**: a -> b
' '<!-- FINDING:SEC-3|CONFIRMED|HIGH|a.py:6|value -> sink when x > 1 -->')"
flush
run "$GOOD" extract; rc_is "gt in title" "$RC" 0
want "gt in title: finding kept" '[.findings[].id] | join(",")' findings.json "SEC-3"
want "gt in title: full title" '.findings[0].title' findings.json "value -> sink when x > 1"

# an unparseable raw marker fails closed instead of reading clean (#3897)
reset
cm MEMBER User "$(agent_body security "$SHA" '### SEC-4 broken' '<!-- FINDING:SEC-4|CONFIRMED|HIGH|a.py:7|no closing marker')"
flush
run "$GOOD" extract; rc_is "malformed marker" "$RC" 3; has "malformed marker" "FINDING markers but"

# a trusted synthesis block replaces the raw bodies; the agent still comes from the raw agent body
reset
cm MEMBER User "$(agent_body security "$SHA" '### SEC-1 injection
**Failure scenario**: x
### BUG-9 other
**Failure scenario**: y
' '<!-- FINDING:SEC-1|CONFIRMED|HIGH|a.py:5|SQL injection in lookup -->
<!-- FINDING:BUG-9|LIKELY|MEDIUM|a.py:15|Other bug -->')"
cm MEMBER User "$(printf '<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->\n<!-- FINDING:SEC-1|CONFIRMED|HIGH|a.py:5|SQL injection in lookup -->\nReviewed-SHA: %s\n' "$SHA")"
flush; run "$GOOD" extract
want "synthesis preferred" '[.findings[].id] | join(",")' findings.json "SEC-1"
want "synthesis: agent from raw body" '.findings[0].agent' findings.json "security"

# fail closed: no trusted body for the head; unresolvable trust script; unreadable comments
reset; cm NONE User "$(agent_body security "$SHA" 'x' '<!-- FINDING:SEC-1|CONFIRMED|HIGH|a.py:5|t -->')"; flush
run "$GOOD" extract; rc_is "no trusted bodies" "$RC" 3; has "no trusted bodies" "no trusted reviewer comments for head ${SHA}"
reset; run "$NOTRUST" extract; rc_is "trust script missing" "$RC" 3; has "trust script missing" "scripts/trusted-comments.sh unresolvable or PR comments unreadable; refusing to read clean (fail closed)"
reset; run "$GOOD" extract; rc_is "comments unreadable" "$RC" 3; has "comments unreadable" "refusing to read clean"

# a findings summary list above the per-finding sections must not hide the scenario (summary bullets never start the section)
reset
cm MEMBER User "$(agent_body bug-hunter "$SHA" 'Findings summary:
- BUG-1: first problem
- BUG-2: second problem
- BUG-3: third problem

### BUG-1 first problem
**Failure scenario**: one breaks
### BUG-2 second problem
**Failure scenario**: two breaks
### BUG-3 third problem
**Fix efficacy**: n/a
' '<!-- FINDING:BUG-1|CONFIRMED|MEDIUM|a.py:2|First problem alpha -->
<!-- FINDING:BUG-2|CONFIRMED|MEDIUM|b.py:10|Second problem bravo -->
<!-- FINDING:BUG-3|CONFIRMED|MEDIUM|c.py:18|Third problem charlie -->')"
flush; run "$GOOD" extract; rc_is "summary list" "$RC" 0
want "summary: first id keeps its scenario" '[.findings[] | select(.id == "BUG-1") | .scenario] | join(",")' findings.json "present"
want "summary: middle id keeps its scenario" '[.findings[] | select(.id == "BUG-2") | .scenario] | join(",")' findings.json "present"
want "summary: a section without a scenario stays absent" '[.findings[] | select(.id == "BUG-3") | .scenario] | join(",")' findings.json "absent"

# the same id repeated across two agents binds each finding to its own body: agent and scenario
reset
cm MEMBER User "$(agent_body security "$SHA" '### BUG-1 alpha
**Failure scenario**: alpha scenario
' '<!-- FINDING:BUG-1|CONFIRMED|MEDIUM|a.py:2|Alpha problem in security -->')"
cm MEMBER User "$(agent_body billing "$SHA" '### BUG-1 omega
no scenario written here
' '<!-- FINDING:BUG-1|CONFIRMED|MEDIUM|d.py:15|Omega problem in billing -->')"
flush; run "$GOOD" extract; rc_is "repeated id" "$RC" 0
want "repeated id: first binds its own agent" '[.findings[] | select(.title | test("Alpha")) | .agent] | join(",")' findings.json "security"
want "repeated id: first keeps its scenario" '[.findings[] | select(.title | test("Alpha")) | .scenario] | join(",")' findings.json "present"
want "repeated id: second binds its own agent" '[.findings[] | select(.title | test("Omega")) | .agent] | join(",")' findings.json "billing"
want "repeated id: second does not borrow the first scenario" '[.findings[] | select(.title | test("Omega")) | .scenario] | join(",")' findings.json "absent"

# the identical marker line repeated across two heads (DELTA) binds each occurrence to its own head's body
reset; mkctx 1 DELTA "$OLD_SHA"
cm MEMBER User "$(agent_body security "$SHA" '### BUG-1 same
no scenario at the current head
' '<!-- FINDING:BUG-1|CONFIRMED|MEDIUM|a.py:2|Same marker both heads -->')"
cm MEMBER User "$(agent_body billing "$OLD_SHA" '### BUG-1 same
**Failure scenario**: earlier head scenario
' '<!-- FINDING:BUG-1|CONFIRMED|MEDIUM|a.py:2|Same marker both heads -->')"
flush; run "$GOOD" extract
want "repeated across heads: both occurrences extracted" '.counts.findings_extracted' findings.json "2"

# ======================= extract: 6B dedup =======================
reset
cm MEMBER User "$(agent_body security "$SHA" '### A-1 x
**Failure scenario**: s
### A-2 y
**Failure scenario**: s
### A-3 z
**Failure scenario**: s
' '<!-- FINDING:A-1|POSSIBLE|MEDIUM|a.py:10|Unrelated title words -->
<!-- FINDING:A-2|CONFIRMED|MEDIUM|a.py:13|Token handling loose everywhere -->
<!-- FINDING:A-3|LIKELY|MEDIUM|a.py:19|Token handling loose here again -->')"
flush; run "$GOOD" extract
want "dedup: line range keeps the higher confidence, then title keywords drop the third" '[.findings[].id] | join(",")' findings.json "A-2"
want "dedup: deduped count" '.counts.findings_deduped' findings.json "1"

# ======================= extract: 6B.4 gates =======================
reset
for f in a b c d e f g; do printf '{"filename":"%s.py","status":"modified","patch":"@@ -9,0 +10,1 @@\\n+new line"}\n' "$f"; done | jq -s . > "$FIX/pr-files.json"
cm MEMBER User "$(agent_body security "$SHA" '### S-1 stale
**Failure scenario**: s
### P-1 pre
**Failure scenario**: s
### P-2 pre high
**Failure scenario**: s
### N-1 no scenario
Some prose without the field.
### N-2 no scenario high
Some prose without the field.
### N-3 intro
**Failure scenario**: s
' '<!-- FINDING:S-1|CONFIRMED|MEDIUM|a.py:999|Cited line past the end of the file -->
<!-- FINDING:P-1|LIKELY|MEDIUM|b.py:19|Pre-existing defect far from added lines -->
<!-- FINDING:P-2|LIKELY|HIGH|c.py:19|High severity is never pre-existing -->
<!-- FINDING:N-1|LIKELY|MEDIUM|d.py:11|Speculative hardening without a scenario -->
<!-- FINDING:N-2|LIKELY|HIGH|e.py:12|High severity without a scenario stays an issue -->
<!-- FINDING:U-1|LIKELY|MEDIUM|f.py:13|Prose for this id was never posted -->
<!-- FINDING:N-3|LIKELY|MEDIUM|g.py:10|Introduced line with a scenario -->')"
flush; run "$GOOD" extract; rc_is "gates" "$RC" 0
want "gate1: stale dropped" '[.findings[].id] | contains(["S-1"]) | not' findings.json "true"
want "gate1: counted" '.counts.findings_dropped_stale' findings.json "1"
want "gate2: MEDIUM far from added lines is pre-existing" '.findings[] | select(.id == "P-1") | .route' findings.json "pre-existing"
want "gate2: HIGH is never pre-existing" '.findings[] | select(.id == "P-2") | .route' findings.json "file"
want "gate3: MEDIUM without scenario demoted" '.findings[] | select(.id == "N-1") | .route' findings.json "demoted-no-scenario"
want "gate3: HIGH exempt" '.findings[] | select(.id == "N-2") | .route' findings.json "file"
want "gate3: unreadable prose keeps the finding" '.findings[] | select(.id == "U-1") | .route' findings.json "file"
want "gate: introduced finding stays" '.findings[] | select(.id == "N-3") | .route' findings.json "file"
want "gate: counts" '[.counts.findings_preexisting, .counts.notes_demoted_no_scenario] | join(",")' findings.json "1,1"
# scope (#3975): recorded for every finding, any severity, computed from the added-line map
want "scope: MEDIUM far from added lines" '.findings[] | select(.id == "P-1") | .scope' findings.json "pre-existing"
want "scope: HIGH is recorded although never routed pre-existing" '.findings[] | select(.id == "P-2") | .scope' findings.json "pre-existing"
want "scope: HIGH near an added line" '.findings[] | select(.id == "N-2") | .scope' findings.json "introduced"
want "scope: MEDIUM near an added line" '.findings[] | select(.id == "N-3") | .scope' findings.json "introduced"
want "scope: every finding carries a valid scope" '[.findings[].scope | select(. == "introduced" or . == "pre-existing" or . == "unknown")] | length' findings.json "$(jq '.findings | length' "$WORK/out/findings.json")"
want "scope: introduced count" '.counts.findings_introduced' findings.json "$(jq '[.findings[] | select(.scope == "introduced")] | length' "$WORK/out/findings.json")"
# an unreadable files API classifies nothing as pre-existing
reset; echo '[]' > "$FIX/pr-files.json"
cm MEMBER User "$(agent_body security "$SHA" '### P-1 pre
**Failure scenario**: s
' '<!-- FINDING:P-1|LIKELY|MEDIUM|a.py:19|Pre-existing defect far from added lines -->')"; flush
run "$GOOD" extract; want "unreadable diff keeps" '.findings[0].route' findings.json "file"
want "unreadable diff: scope unknown" '.findings[0].scope' findings.json "unknown"

# gate 2 route table (ported from the retired spec sketch test): severity normalisation, deleted/renamed/patch-less files, files absent from the diff
reset
printf '%s\n' '[{"filename":"a.sh","status":"modified","patch":"@@ -9,2 +9,3 @@\n ctx\n+added\n ctx"},{"filename":"big.txt","status":"modified"},{"filename":"gone.txt","status":"removed"},{"filename":"new.sh","status":"renamed","previous_filename":"old.sh","patch":"@@ -1,1 +1,1 @@\n+x"}]' > "$FIX/pr-files.json"
G2_PROSE=""; G2_MARKS=""
g2() {   # g2 <id> <severity> <file:line> <title words>
    G2_PROSE="${G2_PROSE}### $1 finding
**Failure scenario**: s
"
    G2_MARKS="${G2_MARKS}<!-- FINDING:$1|LIKELY|$2|$3|$4 -->
"
}
g2 G-1 MEDIUM a.sh:10 "alpha one"; g2 G-2 MEDIUM a.sh:100 "bravo two"; g2 G-3 CRITICAL a.sh:120 "charlie three"; g2 G-4 MEDIUM big.txt:3 "delta four"
g2 G-5 high a.sh:140 "echo five"; g2 G-6 "HIGH " a.sh:160 "foxtrot six"; g2 G-7 "" a.sh:180 "golf seven"; g2 G-8 SEVERE a.sh:200 "hotel eight"
g2 G-9 medium a.sh:220 "india nine"; g2 G-10 INFO a.sh:240 "juliet ten"; g2 G-11 MEDIUM old.sh:3 "kilo eleven"; g2 G-12 LOW a.sh:260 "lima twelve"
g2 G-13 LOW gone.txt:3 "mike thirteen"; g2 G-14 MEDIUM other.sh:5 "november fourteen"
cm MEMBER User "$(agent_body security "$SHA" "$G2_PROSE" "$G2_MARKS")"; flush
run "$GOOD" extract; rc_is "gate2 table" "$RC" 0
for pair in G-1:file G-2:pre-existing G-3:file G-4:file G-5:file G-6:file G-7:file G-8:file G-9:pre-existing G-10:pre-existing G-11:file G-12:pre-existing G-13:file; do
    want "gate2 table: ${pair%%:*}" ".findings[] | select(.id == \"${pair%%:*}\") | .route" findings.json "${pair#*:}"
done
for pair in G-1:introduced G-2:pre-existing G-3:pre-existing G-4:unknown G-7:pre-existing G-13:introduced G-12:pre-existing; do
    want "scope table: ${pair%%:*}" ".findings[] | select(.id == \"${pair%%:*}\") | .scope" findings.json "${pair#*:}"
done
want "gate2 table: a file absent from the PR and from the head is stale (gate 1), not pre-existing" '[.findings[].id] | contains(["G-14"]) | not' findings.json "true"

# DELTA: the earlier reviewed head's findings are read as well
reset; mkctx 1 DELTA "$OLD_SHA"
cm MEMBER User "$(agent_body security "$SHA" '### D-1 new
**Failure scenario**: s
' '<!-- FINDING:D-1|CONFIRMED|HIGH|a.py:5|Finding on the delta -->')"
cm MEMBER User "$(agent_body billing "$OLD_SHA" '### D-2 old
**Failure scenario**: s
' '<!-- FINDING:D-2|CONFIRMED|HIGH|a.py:15|Finding on the earlier head -->')"
flush; run "$GOOD" extract
want "delta: both heads" '[.findings[].id] | sort | join(",")' findings.json "D-1,D-2"
reset; mkctx 1 DELTA "$OLD_SHA"
cm MEMBER User "$(agent_body security "$SHA" 'x' '<!-- FINDING:D-1|CONFIRMED|HIGH|a.py:5|Finding on the delta -->')"; flush
run "$GOOD" extract; rc_is "delta: earlier head unreadable" "$RC" 3; has "delta: earlier head unreadable" "earlier reviewed head ${OLD_SHA} findings unreadable (fail closed)"

# clean review
reset; cm MEMBER User "$(agent_body security "$SHA" 'all good' 'no findings')"; flush
run "$GOOD" extract; has "clean" "STRUCTURED_FINDINGS=0"; has "clean" "CLEAN_STRUCTURED=true"
has "clean: no undelivered agent" "AGENTS_WITHOUT_BLOCK=
"
lacks() { case "$OUT" in *"$2"*) bad "$1: output has '$2'" ;; *) ok ;; esac; }
nob() { printf '<!-- FORGE:REVIEW-AGENT:%s -->\n**Verdict: APPROVE - no findings.**\nReviewed-SHA: %s\n' "$1" "$2"; }

# verdict-only agent comment (no findings block): undelivered, never a finding, never clean
reset; cm MEMBER User "$(nob security "$SHA")"; flush
run "$GOOD" extract; rc_is "no-block agent" "$RC" 0
has "no-block agent: reported undelivered" "AGENTS_WITHOUT_BLOCK=security"
has "no-block agent: no finding created" "STRUCTURED_FINDINGS=0"
lacks "no-block agent: not clean" "CLEAN_STRUCTURED=true"
# mix: one clean (empty block) agent and one block-less agent
reset; cm MEMBER User "$(agent_body auth "$SHA" 'all good' '')"; cm MEMBER User "$(nob security "$SHA")"; flush
run "$GOOD" extract
has "mixed: block-less agent listed" "AGENTS_WITHOUT_BLOCK=security"
lacks "mixed: block-delivering agent not listed" "AGENTS_WITHOUT_BLOCK=auth"
lacks "mixed: block-delivering agent not listed (joined)" "security auth"
lacks "mixed: not clean" "CLEAN_STRUCTURED=true"
# SEC-1: a re-dispatched agent's later complete block clears its earlier block-less comment
reset; cm MEMBER User "$(nob security "$SHA")"; cm MEMBER User "$(agent_body security "$SHA" 'all good' '')"; flush
run "$GOOD" extract
lacks "redispatch: delivered domain not listed" "AGENTS_WITHOUT_BLOCK=security"
has "redispatch: clean" "CLEAN_STRUCTURED=true"
# SEC-2: START without END (truncated) is not delivered
reset; cm MEMBER User "$(printf '<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: %s\n<!-- REVIEW-FINDINGS-START -->\n' "$SHA")"; flush
run "$GOOD" extract
has "START without END: undelivered" "AGENTS_WITHOUT_BLOCK=security"
lacks "START without END: not clean" "CLEAN_STRUCTURED=true"
# a synthesized block must not mask a block-less raw agent comment
reset; cm MEMBER User "$(nob security "$SHA")"
cm MEMBER User "$(printf '<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->\nclean\nReviewed-SHA: %s\n' "$SHA")"; flush
run "$GOOD" extract
has "synth: block-less agent still reported" "AGENTS_WITHOUT_BLOCK=security"
lacks "synth: not clean" "CLEAN_STRUCTURED=true"
# an untrusted block-less comment is ignored (cannot park a review)
reset; cm MEMBER User "$(agent_body auth "$SHA" 'ok' '')"; cm NONE User "$(nob security "$SHA")"; flush
run "$GOOD" extract
lacks "untrusted block-less ignored" "AGENTS_WITHOUT_BLOCK=security"
has "untrusted block-less ignored: clean" "CLEAN_STRUCTURED=true"

# ======================= classify =======================
# mkfind <id> <conf> <sev> <file> <line> <title> [route] [agent] [scenario-text] [scope]
FJ=""
mkfind() {
    FJ="${FJ:+$FJ,}$(jq -n -c --arg id "$1" --arg c "$2" --arg s "$3" --arg f "$4" --arg l "$5" --arg t "$6" --arg r "${7:-file}" --arg a "${8:-}" --arg sc "${10:-}" \
        '{id: $id, confidence: $c, severity: $s, loc: ($f + ":" + $l), file: $f, line_start: ($l | tonumber), line_end: ($l | tonumber), title: $t, agent: $a,
          scenario: "present", fix_efficacy: "", text: ($t + "\n" + $f), route: $r} + (if $sc == "" then {} else {scope: $sc} end)')"
}
putfind() { printf '{"schema_version":1,"review_sha":"%s","review_mode":"FULL","counts":{"findings_extracted":%s,"findings_dropped_stale":0,"findings_preexisting":%s,"notes_demoted_no_scenario":%s},"findings":[%s]}\n' \
    "$SHA" "${1:-1}" "${2:-0}" "${3:-0}" "$FJ" > "$WORK/findings-in.json"; FJ=""; mkdir -p "$WORK/out"; cp "$WORK/findings-in.json" "$WORK/out/findings.json"; }

# ---- NOTE disposition marker, ISSUE counting, prior-list round trip ----
reset
mkfind X-1 POSSIBLE LOW a.py 5 "Rename a local variable for clarity"
mkfind X-2 CONFIRMED HIGH a.py 6 "Unchecked return value hides a failure"
putfind 2
run "$GOOD" classify; rc_is "classify" "$RC" 0
has "classify: filed" "FINDINGS_FILED=1"
want "classify: note" '.findings[] | select(.id == "X-1") | .disposition | startswith("NOTE")' classified.json "true"
want "classify: issue" '.findings[] | select(.id == "X-2") | .class' classified.json "ISSUE"
posted_has "marker first line" "<!-- FORGE:NOTE_DISPOSITION: notes_fixed=0 notes_listed=1 notes_dropped=0 findings_filed=1 inpr_fix=0 contract_demoted=0 findings_dropped_stale=0 findings_preexisting=0 introduced=0 notes_demoted_no_scenario=0 lineage=none classifier=script notes_reflag=0 notes_capped=0 reviewed_sha=${SHA} -->"
posted_has "note list line" "- X-1 a.py:5 [POSSIBLE] Rename a local variable for clarity:"
# the later-head reader (prior_findings_tsv) must be able to parse the list line this script wrote
ROUND=$(grep '^- X-1' "$FIX/posted.log" | sed -n 's/^- [^ ]* \([^ ]*\) \[[A-Za-z?]*\] \(.*\): [^:]*$/\1\t\2/p')
[ "$ROUND" = "$(printf 'a.py:5\tRename a local variable for clarity')" ] && ok || bad "note list round trip: '$ROUND'"
posted_lacks "no in-pr fix without auto-merge" "FORGE:INPR_FIX"

# ---- no marker when the review extracted nothing; dry-run posts nothing ----
reset; mkfind X-1 POSSIBLE LOW a.py 5 "Rename a local variable"; putfind 0
run "$GOOD" classify; [ ! -f "$FIX/posted.log" ] && ok || bad "no disposition when nothing was extracted"
reset; mkfind X-1 POSSIBLE LOW a.py 5 "Rename a local variable"; putfind 1
run "$GOOD" classify --dry-run; [ ! -f "$FIX/posted.log" ] && ok || bad "dry-run posts nothing"
has "dry-run" "NOTE_DISPOSITION_POSTED=false"

# ---- fail closed: classifier / cap helper unavailable ----
reset; mkfind X-1 CONFIRMED HIGH a.py 5 "Something real here"; putfind 1
run "$NOCLS" classify; rc_is "classifier unavailable" "$RC" 3
has "classifier unavailable" "REVIEW_RESULT: status: BLOCKED, blocker: classifier unavailable (classify-finding.sh not resolvable through the trusted resolver)"
[ ! -f "$FIX/posted.log" ] && ok || bad "classifier unavailable posts no disposition"
run "$NOCAP" classify; rc_is "cap unavailable" "$RC" 3
has "cap unavailable" "REVIEW_RESULT: status: BLOCKED, blocker: cap helper unavailable (cap-findings.sh not resolvable through the trusted resolver)"

# ---- per-review cap ----
reset
mkfind C-1 CONFIRMED MEDIUM a.py 1 "First confirmed medium defect"
mkfind C-2 CONFIRMED MEDIUM a.py 8 "Second confirmed medium defect"
mkfind C-3 CONFIRMED MEDIUM a.py 16 "Third confirmed medium defect"
putfind 3; run "$GOOD" classify
has "cap" "FINDINGS_FILED=2"; has "cap" "NOTES_CAPPED=1"
want "cap: one capped note" '[.findings[] | select(.disposition == "NOTE capped")] | length' classified.json "1"
posted_has "cap marker" "notes_capped=1"
posted_has "cap listed without a colon in the reason" "capped - over review.max_filed_findings"

# ---- in-PR fix gate: first round only ----
reset; mkctx 1 FULL "" 12; echo "false" > "$FIX/labels"; printf 'a.py\n' > "$FIX/files"; echo '[]' > "$FIX/comments.json"
mkfind I-1 CONFIRMED MEDIUM a.py 5 "Confirmed defect inside the changed file"; putfind 1
run "$GOOD" classify --auto-merge true; has "inpr round 1" "INPR_FIX=1"
posted_has "inpr marker" "<!-- FORGE:INPR_FIX: round=1 head=${SHA} max_severity=MEDIUM findings=I-1 -->"
want "inpr class" '.findings[0].class' classified.json "INPR_FIX"
reset; mkctx 1 FULL "" 12; printf 'a.py\n' > "$FIX/files"
cm MEMBER User "<!-- FORGE:INPR_FIX: round=1 head=${OLD_SHA} max_severity=MEDIUM findings=I-0 -->"; flush
mkfind I-1 CONFIRMED MEDIUM a.py 5 "Confirmed defect inside the changed file"; putfind 1
run "$GOOD" classify --auto-merge true; has "inpr round 2" "INPR_FIX=0"
posted_lacks "no second in-pr fix request" "FORGE:INPR_FIX"
want "inpr round 2 files it" '.findings[0].class' classified.json "ISSUE"
# scope (#3975): an introduced MEDIUM LIKELY finding in the diff is an in-PR fix; other scopes keep filing it
reset; mkctx 1 FULL "" 12; echo "false" > "$FIX/labels"; printf 'a.py\n' > "$FIX/files"; echo '[]' > "$FIX/comments.json"
mkfind S-1 LIKELY MEDIUM a.py 5 "Introduced likely defect in new code" file "" "" introduced
mkfind S-2 LIKELY MEDIUM a.py 6 "Pre-existing likely defect in old code" file "" "" pre-existing
mkfind S-3 LIKELY MEDIUM a.py 7 "Likely defect with unknown provenance" file "" "" unknown
mkfind S-4 LIKELY MEDIUM a.py 8 "Likely defect with no scope recorded"; putfind 4
run "$GOOD" classify --auto-merge true; has "scope inpr" "INPR_FIX=1"
want "scope: introduced LIKELY is INPR_FIX" '.findings[] | select(.id == "S-1") | .class' classified.json "INPR_FIX"
want "scope: pre-existing LIKELY is ISSUE" '.findings[] | select(.id == "S-2") | .class' classified.json "ISSUE"
want "scope: unknown LIKELY is ISSUE" '.findings[] | select(.id == "S-3") | .class' classified.json "ISSUE"
want "scope: absent LIKELY is never INPR_FIX" '.findings[] | select(.id == "S-4") | .class != "INPR_FIX"' classified.json "true"
want "scope: carried into classified.json" '.findings[] | select(.id == "S-1") | .scope' classified.json "introduced"
posted_has "NOTE_DISPOSITION records introduced count" " introduced=1 "
# an untrusted FORGE:INPR_FIX marker does not use up the round
reset; mkctx 1 FULL "" 12; printf 'a.py\n' > "$FIX/files"
cm NONE User "<!-- FORGE:INPR_FIX: round=1 head=${OLD_SHA} max_severity=MEDIUM findings=I-0 -->"; flush
mkfind I-1 CONFIRMED MEDIUM a.py 5 "Confirmed defect inside the changed file"; putfind 1
run "$GOOD" classify --auto-merge true; has "untrusted marker" "INPR_FIX=1"

# ---- contract-declared scope ----
reset; mkctx 1 FULL "" 12; echo false > "$FIX/labels"; printf 'a.py\n' > "$FIX/files"
CONTRACT_BODY=$(printf '<!-- FORGE:CONTRACT -->\n### Out of Scope\n\n- `docs/` — deferred → #30: tracked there\n')
cm MEMBER User "$CONTRACT_BODY"; flush "$FIX/comments-12.json"; echo '[]' > "$FIX/comments.json"
echo '{"state":"open","body":"x <!-- FORGE:DEFERRED_FROM: #12 --> docs/","author_association":"MEMBER","user":{"type":"User"}}' > "$FIX/issue-30.json"
mkfind K-1 LIKELY MEDIUM docs/guide.md 3 "Docs example is misleading"; putfind 1
run "$GOOD" classify; has "contract" "CONTRACT_DEMOTED=1"
want "contract-deferred" '.findings[0].disposition' classified.json "NOTE contract-deferred #30"
[ "$(cat "$FIX/issue-comments.log" 2>/dev/null)" = "ISSUE_COMMENT 30" ] && ok || bad "deferred issue comment not posted"
posted_has "contract list line" "tracked on #30"
# an untrusted contract demotes nothing
reset; mkctx 1 FULL "" 12; echo false > "$FIX/labels"; printf 'a.py\n' > "$FIX/files"
cm NONE User "$CONTRACT_BODY"; flush "$FIX/comments-12.json"; echo '[]' > "$FIX/comments.json"
echo '{"state":"open","body":"x <!-- FORGE:DEFERRED_FROM: #12 --> docs/","author_association":"MEMBER","user":{"type":"User"}}' > "$FIX/issue-30.json"
mkfind K-1 LIKELY MEDIUM docs/guide.md 3 "Docs example is misleading"; putfind 1
run "$GOOD" classify; has "untrusted contract" "CONTRACT_DEMOTED=0"

# ---- cross-head re-flag via an earlier NOTE_DISPOSITION record ----
reset
cm MEMBER User "<!-- FORGE:NOTE_DISPOSITION: notes_fixed=0 notes_listed=1 reviewed_sha=${OLD_SHA} -->
- R-1 a.py:5 [LIKELY] Retry loop swallows the final exception silently: noted"; flush
mkfind R-9 LIKELY MEDIUM a.py 6 "Retry loop swallows final exception silently"; putfind 1
run "$GOOD" classify; has "reflag" "NOTES_REFLAG=1"
want "reflag disposition" '.findings[0].disposition' classified.json "NOTE reflag-note"
posted_has "reflag marker" "notes_reflag=1"
# HIGH is never demoted by a re-flag
reset
cm MEMBER User "<!-- FORGE:NOTE_DISPOSITION: notes_fixed=0 notes_listed=1 reviewed_sha=${OLD_SHA} -->
- R-1 a.py:5 [LIKELY] Retry loop swallows the final exception silently: noted"; flush
mkfind R-9 CONFIRMED HIGH a.py 6 "Retry loop swallows final exception silently"; putfind 1
run "$GOOD" classify; has "reflag high" "NOTES_REFLAG=0"

# ---- staging bundle review (--scope-files / --prior-prs, #3841) ----
# scope rule: only a MEDIUM/LOW/INFO finding that cites a file outside the scoped set is demoted to a listed NOTE; HIGH/CRITICAL, safety-exempt, re-flagged and file-less findings never are
reset; printf 'a.py\n' > "$WORK/scope-files.txt"
mkfind S-1 LIKELY LOW b.py 5 "Rename a local variable for clarity"
mkfind S-2 CONFIRMED HIGH b.py 6 "Unchecked return value hides a failure"
mkfind S-3 CONFIRMED MEDIUM b.py 7 "Missing timeout on the outbound request"
mkfind S-4 CONFIRMED MEDIUM a.py 8 "Missing timeout on the inbound request"
mkfind S-5 CONFIRMED LOW b.py 9 "SQL injection through unescaped auth token input"
mkfind S-6 CONFIRMED MEDIUM c.py 10 "Cache never invalidated after update"
mkfind S-7 LIKELY MEDIUM "" 0 "Cross cutting wiring problem with no cited file"
putfind 7
run "$GOOD" classify --scope-files "$WORK/scope-files.txt" --prior-prs ""; rc_is "scoped classify" "$RC" 0
want "scope: LOW outside the set is a listed NOTE" '.findings[] | select(.id == "S-1") | .disposition' classified.json "NOTE out_of_scope"
want "scope: HIGH outside the set stays ISSUE" '.findings[] | select(.id == "S-2") | .class' classified.json "ISSUE"
want "scope: MEDIUM outside the set is demoted" '.findings[] | select(.id == "S-3") | .disposition' classified.json "NOTE out_of_scope"
want "scope: MEDIUM in the set stays ISSUE" '.findings[] | select(.id == "S-4") | .class' classified.json "ISSUE"
want "scope: a safety-exempt finding is never demoted as out of scope" '.findings[] | select(.id == "S-5") | .disposition | startswith("NOTE out_of_scope") | not' classified.json "true"
want "scope: a finding without a file is never demoted" '.findings[] | select(.id == "S-7") | .disposition | startswith("NOTE out_of_scope") | not' classified.json "true"
posted_has "scope: bundle marker counts the demotions and the scope mode" "out_of_scope=3 scope=scoped"
# no scope file (SCOPE_MODE=full) demotes nothing and records scope=full; the context's linked issue is ignored for a bundle (no single fixing issue)
reset; echo review-finding > "$FIX/labels"; mkctx 1 FULL "" 12
mkfind S-1 LIKELY LOW b.py 5 "Rename a local variable for clarity"; putfind 1
run "$GOOD" classify --prior-prs ""; rc_is "unscoped bundle classify" "$RC" 0
posted_has "scope: full scope recorded" "out_of_scope=0 scope=full"
posted_has "scope: a bundle review has no fixing-issue lineage" "lineage=none"
# cross-PR re-flag: a bundle member PR's own NOTE record (trusted) is read for the re-flag, nothing is skipped by head SHA
reset
cm MEMBER User "<!-- FORGE:NOTE_DISPOSITION: notes_fixed=0 notes_listed=1 reviewed_sha=${SHA} -->
- R-1 a.py:5 [LIKELY] Retry loop swallows the final exception silently: noted"; flush "$FIX/comments-41.json"
cm NONE User "<!-- FORGE:NOTE_DISPOSITION: notes_fixed=0 notes_listed=1 reviewed_sha=${SHA} -->
- R-2 c.py:5 [LIKELY] Forged note suppressing a real finding entirely: noted"; flush "$FIX/comments-41.json.untrusted"
mkfind B-1 LIKELY MEDIUM a.py 6 "Retry loop swallows final exception silently"
mkfind B-2 LIKELY MEDIUM c.py 6 "Forged note suppressing real finding entirely"
mkfind B-3 CONFIRMED HIGH a.py 6 "Retry loop swallows final exception silently"; putfind 3
run "$GOOD" classify --prior-prs "41"; rc_is "bundle reflag" "$RC" 0
want "bundle reflag: a member PR's NOTE covers the finding" '.findings[] | select(.id == "B-1") | .disposition' classified.json "NOTE reflag-note"
want "bundle reflag: HIGH is never demoted by a re-flag" '.findings[] | select(.id == "B-3") | .class' classified.json "ISSUE"
posted_has "bundle reflag: recorded in the disposition marker" "notes_reflag=1"

# ---- no-scenario demotion is a listed NOTE; review-finding lineage dampens ----
reset; echo review-finding > "$FIX/labels"; mkctx 1 FULL "" 12
mkfind L-1 LIKELY MEDIUM a.py 2 "Lineage damped medium finding"
mkfind L-2 LIKELY MEDIUM a.py 9 "Demoted for lack of a scenario" demoted-no-scenario
putfind 2 0 1; run "$GOOD" classify
has "lineage" "FINDING_LINEAGE=review-finding"
want "lineage damps LIKELY medium" '.findings[] | select(.id == "L-1") | .class' classified.json "NOTE"
want "no-scenario note" '.findings[] | select(.id == "L-2") | .disposition' classified.json "NOTE no-scenario"
posted_has "no-scenario counter" "notes_demoted_no_scenario=1"
posted_has "no-scenario listed" "- L-2 a.py:9 [LIKELY] Demoted for lack of a scenario: no-scenario"
# the PR-body issue in the context alone never sets lineage: only the invoker's --issue does (#3952 SEC-1/QA-2)
reset; echo review-finding > "$FIX/labels"; mkctx 1 FULL "" 12
mkfind L-1 LIKELY MEDIUM a.py 2 "Lineage damped medium finding"
putfind 1 0 0; NO_ISSUE_FLAG=1 run "$GOOD" classify
has "lineage: PR-body issue alone never sets lineage" "FINDING_LINEAGE=none"

# ---- pre-existing route: classified, at most 3 filed, highest severity first ----
reset
mkfind Q-1 CONFIRMED MEDIUM a.py 1 "Pre-existing medium one" pre-existing
mkfind Q-2 CONFIRMED MEDIUM a.py 3 "Pre-existing medium two" pre-existing
mkfind Q-3 CONFIRMED MEDIUM a.py 7 "Pre-existing medium three" pre-existing
mkfind Q-4 CONFIRMED MEDIUM a.py 12 "Pre-existing medium four" pre-existing
mkfind Q-5 CONFIRMED HIGH a.py 18 "Pre-existing high one" pre-existing
putfind 5 5 0; run "$GOOD" classify
has "pre-existing" "PREEXISTING_FILED=3"
want "pre-existing: highest severity first" '.findings[] | select(.id == "Q-5") | .route' classified.json "file-pre-existing"
want "pre-existing: the fourth over the cap is listed only" '[.findings[] | select(.disposition == "NOTE preexisting-over-cap")] | length' classified.json "2"
has "pre-existing excluded from findings_filed" "FINDINGS_FILED=0"

# ======================= file-prepare =======================
fp_setup() { reset; mkctx 1 FULL "" 12; }
fp_setup
mkfind F-1 CONFIRMED HIGH a.py 10 "High defect to file"
mkfind F-2 CONFIRMED MEDIUM a.py 20 "Medium defect to file"
mkfind F-3 CONFIRMED LOW a.py 2 "Low defect to file"
mkfind F-4 CONFIRMED LOW billing/pay.py 2 "Low billing defect"
mkfind F-5 CONFIRMED MEDIUM a.py 19 "Pre-existing medium defect" file-pre-existing
mkfind F-6 LIKELY LOW a.py 3 "A note, never filed" file
FJ=$(printf '%s' "[$FJ]" | jq -c 'map(if .id == "F-2" then . + {scope: "introduced"} elif .id == "F-5" then . + {scope: "pre-existing"} else . end) | .[]' | paste -sd, -)
putfind 6
cp "$WORK/out/findings.json" "$WORK/out/classified.json"
jq '.findings |= map(. + {class: (if .id == "F-6" then "NOTE" else "ISSUE" end), disposition: (if .id == "F-6" then "NOTE x" else "ISSUE x" end)})' "$WORK/out/findings.json" > "$WORK/out/classified.json"
run "$GOOD" file-prepare; rc_is "file-prepare" "$RC" 0
want "worklist: notes are not filed" '[.items[].id] | join(",")' worklist.json "F-1,F-2,F-3,F-4,F-5"
want "priority from severity (HIGH)" '.items[] | select(.id == "F-1") | .priority' worklist.json "priority:P1"
want "priority from severity (MEDIUM)" '.items[] | select(.id == "F-2") | .priority' worklist.json "priority:P2"
want "labels" '.items[] | select(.id == "F-2") | .labels | join(",")' worklist.json "review-finding,needs-validation,priority:P2"
want "worklist item carries scope" '.items[] | select(.id == "F-2") | .scope' worklist.json "introduced"
want "worklist item scope pre-existing" '.items[] | select(.id == "F-5") | .scope' worklist.json "pre-existing"
want "worklist item without scope is unknown" '.items[] | select(.id == "F-1") | .scope' worklist.json "unknown"
want "P3 batchable" '.items[] | select(.id == "F-3") | .batchable' worklist.json "true"
want "P3 on a billing path is not batchable" '.items[] | select(.id == "F-4") | .batchable' worklist.json "false"
want "pre-existing label only" '.items[] | select(.id == "F-5") | .labels | join(",")' worklist.json "pre-existing,priority:P2"
want "milestone via the resolver" '.milestone' worklist.json "Milestone One"
want "base branch from the context" '.base_branch' worklist.json "main"
want "title shape" '.items[] | select(.id == "F-1") | .title' worklist.json "fix: High defect to file (review finding — PR #7)"

# line-range dedup, regression, title dedup
fp_setup
echo '[{"number":40,"title":"fix: totally different words (review finding — PR #3)","body":"see a.py:12 for the defect"}]' > "$FIX/issues-open.json"
echo '[{"number":41,"title":"fix: unrelated closed (review finding — PR #2)","body":"older bug at b.py:30"}]' > "$FIX/issues-closed.json"
mkfind G-1 CONFIRMED MEDIUM a.py 10 "Open duplicate within five lines"
mkfind G-2 CONFIRMED MEDIUM b.py 33 "Closed duplicate regresses"
mkfind G-3 CONFIRMED MEDIUM a.py 19 "Brand new defect"
putfind 3; jq '.findings |= map(. + {class: "ISSUE", disposition: "ISSUE x"})' "$WORK/out/findings.json" > "$WORK/out/classified.json"
run "$GOOD" file-prepare
want "dedup: open issue within +-5 lines" '.items[] | select(.id == "G-1") | [.action, (.dedup_of | tostring)] | join(",")' worklist.json "skip-dedup,40"
want "regression: closed issue within +-5 lines" '.items[] | select(.id == "G-2") | [.action, (.regression_of | tostring), .priority] | join(",")' worklist.json "file,41,priority:P1"
want "new finding files" '.items[] | select(.id == "G-3") | .action' worklist.json "file"
# the issue this PR fixes is never a dedup target
fp_setup
echo '[{"number":12,"title":"x","body":"see a.py:12"}]' > "$FIX/issues-open.json"
mkfind G-1 CONFIRMED MEDIUM a.py 10 "Duplicate of the linked issue"; putfind 1
jq '.findings |= map(. + {class: "ISSUE", disposition: "ISSUE x"})' "$WORK/out/findings.json" > "$WORK/out/classified.json"
run "$GOOD" file-prepare; want "linked issue excluded" '.items[0].action' worklist.json "file"

# pattern recurrence: exempt severities skip, a prior instance in the same subsystem consolidates
fp_setup
echo '[{"number":50,"body":"x commands/work-on/z.md <!-- FORGE:PATTERN: slug-one -->","labels":[],"stateReason":"COMPLETED"}]' > "$FIX/issues-all.json"
mkfind H-1 CONFIRMED MEDIUM commands/work-on/y.md 4 "Recurring medium pattern"
mkfind H-2 CONFIRMED HIGH commands/work-on/y.md 9 "Recurring high pattern"
mkfind H-3 CONFIRMED MEDIUM top.md 3 "Root file has no subsystem"
putfind 3; jq '.findings |= map(. + {class: "ISSUE", disposition: "ISSUE x"})' "$WORK/out/findings.json" > "$WORK/out/classified.json"
echo '{"H-1":"slug-one","H-2":"slug-one","H-3":"slug-one"}' > "$WORK/patterns.json"
run "$GOOD" file-prepare --patterns "$WORK/patterns.json"
want "recurrence: consolidate" '.items[] | select(.id == "H-1") | [(.pattern.consolidate | tostring), (.pattern.prior | map(tostring) | join(",")), .pattern.subsystem] | join(" ")' worklist.json "true 50 commands/work-on"
want "recurrence: HIGH exempt" '.items[] | select(.id == "H-2") | .pattern.consolidate' worklist.json "false"
want "recurrence: exempt reason" '.items[] | select(.id == "H-2") | .pattern.recurrence | startswith("exempt")' worklist.json "true"
want "recurrence: no subsystem" '.items[] | select(.id == "H-3") | .pattern.recurrence | startswith("skipped - no valid subsystem")' worklist.json "true"

# ======================= file-verify =======================
OUT=$(printf 'noise\nISSUE_CREATE_RESULT:CREATED number=321 url=x\n' | bash "$ROOT/scripts/review-finalize.sh" file-verify); RC=$?
rc_is "verify created" "$RC" 0; has "verify created" "ISSUE_NUM=321"
OUT=$(printf 'ISSUE_CREATE_RESULT:DEDUP number=55\n' | bash "$ROOT/scripts/review-finalize.sh" file-verify); RC=$?
rc_is "verify dedup" "$RC" 0; has "verify dedup" "ISSUE_NUM=55"; has "verify dedup" "DEDUPED=true"
OUT=$(printf 'something else\n' | bash "$ROOT/scripts/review-finalize.sh" file-verify 2>"$WORK/stderr"); RC=$?
rc_is "verify missing number" "$RC" 1
grep -q "did not report a verified review-finding number" "$WORK/stderr" && ok || bad "verify missing number message"

# ======================= part B: Phases 7-9 gate parity =======================
# Phase 7-9 subcommands run against a trusted install root that also carries the real is-docs-only.sh and controllable stand-ins for the
# phase-trail verifier, CI gate, deploy-gate resolver and label transition (each answers from files under $FIX).
mkgate() {   # mkgate <dir> [skip-script ...]
    local r="$1" f; shift; mkroot "$r"
    cp "$ROOT/scripts/is-docs-only.sh" "$r/scripts/"
    for f in verify-phase-trail wait-ci-green resolve-deploy-gate transition-label; do
        case " $* " in *" $f.sh "*) continue ;; esac
        case "$f" in
            verify-phase-trail) printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "$FIX/trail-args"\ncat "$FIX/trail-out"\nexit "$(cat "$FIX/trail-rc")"\n' > "$r/scripts/$f.sh" ;;
            wait-ci-green) printf '#!/usr/bin/env bash\ncat "$FIX/ci-out"\nexit "$(cat "$FIX/ci-rc")"\n' > "$r/scripts/$f.sh" ;;
            resolve-deploy-gate) printf '#!/usr/bin/env bash\ncat "$FIX/gate-out" 2>/dev/null || echo true\n' > "$r/scripts/$f.sh" ;;
            transition-label) printf '#!/usr/bin/env bash\nprintf "TRANSITION %%s\\n" "$*" >> "$FIX/transition.log"\n' > "$r/scripts/$f.sh" ;;
        esac
    done
}
GATE="$WORK/root-gate"; mkgate "$GATE"
G_NOTRAIL="$WORK/root-g-notrail"; mkgate "$G_NOTRAIL" verify-phase-trail.sh
G_NOCI="$WORK/root-g-noci"; mkgate "$G_NOCI" wait-ci-green.sh
G_NODEPLOY="$WORK/root-g-nodeploy"; mkgate "$G_NODEPLOY" resolve-deploy-gate.sh
G_NOTRANS="$WORK/root-g-notrans"; mkgate "$G_NOTRANS" transition-label.sh
G_NOTRUST="$WORK/root-g-notrust"; mkgate "$G_NOTRUST"; rm -f "$G_NOTRUST/scripts/trusted-comments.sh"
OTHER_SHA=$(printf '%040d' 9)

gate_reset() {   # a green PR: issue 42, no findings, trail ok, CI green at the reviewed head
    reset; mkctx 1 FULL "" 42
    cm MEMBER User "hello"; flush
    echo 0 > "$FIX/trail-rc"; echo "PHASE_TRAIL: OK" > "$FIX/trail-out"
    echo 0 > "$FIX/ci-rc"; printf 'CI_GATE: PASS\nCI_GATE_HEAD: %s\n' "$SHA" > "$FIX/ci-out"
    printf '<!-- FORGE:REVIEW_ROUTE mode=FULL sha=%s -->\n' "$(printf '%s' "$SHA" | cut -c1-7)" > "$FIX/route-bodies"
    printf 'a.py\n' > "$FIX/pr-files.txt"; echo 1 > "$FIX/changed-n"
    echo "MERGEABLE|CLEAN" > "$FIX/premerge"; echo false > "$FIX/escalated"; echo OPEN > "$FIX/state"
}
mg() {   # mg <root> [flag overrides...]: a clean, bound merge-gate invocation
    local r="$1"; shift
    run "$r" merge-gate --verdict APPROVED --has-purpose-regression false --calibration-needs-human false --trust-needs-human false \
        --base-conflict false --other-blocking false "$@"
}
logged() { if grep -qF -- "$3" "$FIX/$2" 2>/dev/null; then ok; else bad "$1: $2 lacks '$3'"; fi; }
not_logged() { if grep -qF -- "$3" "$FIX/$2" 2>/dev/null; then bad "$1: $2 contains '$3'"; else ok; fi; }
merged() { if [ -f "$FIX/merge.log" ]; then ok; else bad "$1: expected a merge"; fi; }
not_merged() { if [ -f "$FIX/merge.log" ]; then bad "$1: must not merge"; else ok; fi; }

# --- static contract: the gates live in the script, are bash 3.2 portable and read trust only through the shared helper ---
for tok in NOTE_DISPOSITION INPR_FIX verify-phase-trail wait-ci-green is-docs-only PHASE_TRAIL_FAILED FORGE:REVIEW-AGENT; do
    grep -qF -- "$tok" "$ROOT/scripts/review-finalize.sh" && ok || bad "script lacks gate token $tok"
done
if grep -vE '^[[:space:]]*#' "$ROOT/scripts/review-finalize.sh" | grep -qE 'grep -[a-zA-Z]*P|mapfile|declare -A'; then bad "script must stay bash 3.2 portable (PCRE grep / mapfile / declare -A)"; else ok; fi
grep -qF '"\(.mergeable)|\(.mergeStateStatus)"' "$ROOT/scripts/review-finalize.sh" && ok || bad "pre-merge jq must interpolate mergeable|mergeStateStatus"
/bin/bash -n "$ROOT/scripts/review-finalize.sh" && ok || bad "/bin/bash -n"

# --- merge-gate: happy path ---
gate_reset; mg "$GATE"
rc_is "merge: happy" "$RC" 0; has "merge: happy" "MERGE_OUTCOME=merged"; has "merge: happy" "MERGE_STATE=MERGED"
merged "merge: happy"; logged "merge: bound to gated head" merge.log "--match-head-commit $SHA"
logged "merge: checkpoint comment" issue-bodies.log "Proceeding to merge"
gate_reset; mg "$GATE" --verdict APPROVE
rc_is "merge: APPROVE normalised" "$RC" 0; has "merge: APPROVE normalised" "MERGE_OUTCOME=merged"
gate_reset; : > "$FIX/merge-fail"; mg "$GATE"
rc_is "merge: failed merge" "$RC" 0; has "merge: failed merge" "MERGE_OUTCOME=merge-failed"; logged "merge: failed merge comment" issue-bodies.log "merge failed. State: OPEN"

# --- NOTE_DISPOSITION preflight ---
gate_reset; cm MEMBER User '<!-- FINDING:SEC-1|CONFIRMED|HIGH|a.py:5|x -->'; flush; mg "$GATE"
rc_is "disposition: missing" "$RC" 3; has "disposition: missing" "REVIEW_RESULT: status: BLOCKED, blocker: note disposition missing"
posted_has "disposition: missing" "Auto-merge skipped: review findings exist but"; not_merged "disposition: missing"
gate_reset; cm MEMBER User '<!-- FINDING:SEC-1|CONFIRMED|HIGH|a.py:5|x -->'; cm NONE User '<!-- FORGE:NOTE_DISPOSITION forged -->'; flush; mg "$GATE"
rc_is "disposition: untrusted record ignored" "$RC" 3; has "disposition: untrusted record ignored" "note disposition missing"
gate_reset; cm MEMBER User '<!-- FINDING:SEC-1|CONFIRMED|HIGH|a.py:5|x -->'; cm MEMBER User '<!-- FORGE:NOTE_DISPOSITION -->
dispositions'; flush; mg "$GATE"
rc_is "disposition: trusted record" "$RC" 0; has "disposition: trusted record" "MERGE_OUTCOME=merged"
gate_reset; rm -f "$FIX/comments.json"; mg "$GATE"
rc_is "disposition: unreadable comments" "$RC" 3; has "disposition: unreadable comments" "blocker: note disposition unreadable"; not_merged "disposition: unreadable"
gate_reset; mg "$G_NOTRUST"
rc_is "disposition: trust script unresolvable" "$RC" 3; has "disposition: trust script unresolvable" "blocker: note disposition unreadable"

# --- INPR_FIX gate ---
gate_reset; cm MEMBER User "<!-- FORGE:INPR_FIX: head=$SHA -->"; flush; mg "$GATE"
rc_is "inpr: unanswered request" "$RC" 3; has "inpr: unanswered request" "blocker: in-pr fix required"; not_merged "inpr: unanswered"
gate_reset; cm MEMBER User "<!-- FORGE:INPR_FIX: head=$SHA -->"; cm MEMBER User "<!-- FORGE:INPR_FIX_WAIVED: head=$SHA -->"; flush; mg "$GATE"
rc_is "inpr: waived" "$RC" 0; has "inpr: waived" "MERGE_OUTCOME=merged"
gate_reset; cm MEMBER User "<!-- FORGE:INPR_FIX: head=$OLD_SHA -->"; flush; mg "$GATE"
rc_is "inpr: request for an older head" "$RC" 0
gate_reset; cm NONE User "<!-- FORGE:INPR_FIX: head=$SHA -->"; flush; mg "$GATE"
rc_is "inpr: untrusted request ignored" "$RC" 0
gate_reset; cm MEMBER User "<!-- FORGE:INPR_FIX: head=$SHA -->"; cm NONE User "<!-- FORGE:INPR_FIX_WAIVED: head=$SHA -->"; flush; mg "$GATE"
rc_is "inpr: untrusted waiver ignored" "$RC" 3

# --- degraded-gate gate (forge#3628): issue 42's newest trusted QUALITY_GATE / ACCEPTANCE_GATE name the degraded checks; PR 7's comments must cover each ---
QG_DEG=$'<!-- FORGE:QUALITY_GATE -->\n## Quality Gate Result\n\n**Result**: PASS\n**Degraded**: python.test — test run exercised nothing; blast-radius — check did not complete'
QG_OK=$'<!-- FORGE:QUALITY_GATE -->\n## Quality Gate Result\n\n**Result**: PASS\n**Degraded**: none'
AG_DEG=$'<!-- FORGE:ACCEPTANCE_GATE -->\n## Acceptance Gate — DEGRADED\n\n**Degraded checks (verified nothing)**: python.test — test run exercised nothing\n\n<!-- FORGE:ACCEPTANCE_GATE:DEGRADED -->'
AGM='<!-- FORGE:REVIEW-AGENT:security -->'
SEC_FULL="$AGM"$'\nReviewed-SHA: '"$SHA"$'\n\n### Degraded Paths Reviewed\n- python.test: read the skipped DB tests by hand\n- blast-radius: callers checked manually\n\n### Other\nx'
SEC_PART="$AGM"$'\nReviewed-SHA: '"$SHA"$'\n\n### Degraded Paths Reviewed\n- python.test: read the skipped DB tests by hand\n\n### Other\nblast-radius is mentioned only outside the section'
SEC_GENERIC="$AGM"$'\nReviewed-SHA: '"$SHA"$'\n\n### Degraded Paths Reviewed\nAll degraded paths were reviewed.\n'
SEC_STALE="$AGM"$'\nReviewed-SHA: '"$OLD_SHA"$'\n\n### Degraded Paths Reviewed\n- python.test: read the skipped DB tests by hand\n- blast-radius: callers checked manually\n'
SEC_NEG="$AGM"$'\nReviewed-SHA: '"$SHA"$'\n\n### Degraded Paths Reviewed\n- python.test: NOT reviewed\n- blast-radius: callers checked manually\n'
SEC_PLAIN=$'### Degraded Paths Reviewed\n- python.test: read the skipped DB tests by hand\n- blast-radius: callers checked manually\n'
SEC_AG="$AGM"$'\nReviewed-SHA: '"$SHA"$'\n\n### Degraded Paths Reviewed\n- python.test: covered by hand\n'
gate_reset; cm MEMBER User "$QG_DEG"; flush "$FIX/comments-42.json"; mg "$GATE"
rc_is "degraded: no section" "$RC" 3; has "degraded: no section" "REVIEW_RESULT: status: BLOCKED, blocker: degraded-gate-unreviewed"
logged "degraded: no section needs-human" edits.log "needs-human"; logged "degraded: no section comment" issue-bodies.log "FORGE:DEGRADED_GATE_UNREVIEWED"; not_merged "degraded: no section"
gate_reset; cm MEMBER User "$QG_DEG"; flush "$FIX/comments-42.json"; cm MEMBER User "$SEC_PART"; flush; mg "$GATE"
rc_is "degraded: partial coverage" "$RC" 3; has "degraded: partial coverage" "blocker: degraded-gate-unreviewed"; logged "degraded: partial names the gap" issue-bodies.log "not covered: blast-radius"; not_merged "degraded: partial"
gate_reset; cm MEMBER User "$QG_DEG"; flush "$FIX/comments-42.json"; cm MEMBER User "$SEC_GENERIC"; flush; mg "$GATE"
rc_is "degraded: generic section" "$RC" 3; has "degraded: generic section" "blocker: degraded-gate-unreviewed"; not_merged "degraded: generic"
gate_reset; cm MEMBER User "$QG_DEG"; flush "$FIX/comments-42.json"; cm NONE User "$SEC_FULL"; flush; mg "$GATE"
rc_is "degraded: untrusted section ignored" "$RC" 3; has "degraded: untrusted section ignored" "blocker: degraded-gate-unreviewed"
gate_reset; cm MEMBER User "$QG_DEG"; flush "$FIX/comments-42.json"; cm MEMBER User "$SEC_STALE"; flush; mg "$GATE"
rc_is "degraded: stale-head section ignored" "$RC" 3; has "degraded: stale-head section ignored" "blocker: degraded-gate-unreviewed"
gate_reset; cm MEMBER User "$QG_DEG"; flush "$FIX/comments-42.json"; cm MEMBER User "$SEC_NEG"; flush; mg "$GATE"
rc_is "degraded: negated item is not coverage" "$RC" 3; logged "degraded: negated item names the gap" issue-bodies.log "not covered: python.test"
gate_reset; cm MEMBER User "$QG_DEG"; flush "$FIX/comments-42.json"; cm MEMBER User "$SEC_PLAIN"; flush; mg "$GATE"
rc_is "degraded: plain comment without review marker ignored" "$RC" 3
gate_reset; cm MEMBER User "$QG_DEG"; flush "$FIX/comments-42.json"; cm MEMBER User "$SEC_FULL"; flush; mg "$GATE"
rc_is "degraded: full per-check section" "$RC" 0; has "degraded: full per-check section" "MERGE_OUTCOME=merged"; merged "degraded: full"
gate_reset; cm Bot Bot "$QG_DEG"; flush "$FIX/comments-42.json"; cm NONE Bot "$SEC_FULL"; flush; mg "$GATE"
rc_is "degraded: bot-authored gate and section" "$RC" 0
gate_reset; cm MEMBER User "$AG_DEG"; flush "$FIX/comments-42.json"; mg "$GATE"
rc_is "degraded: ACCEPTANCE_GATE:DEGRADED unreviewed" "$RC" 3; has "degraded: ACCEPTANCE_GATE:DEGRADED unreviewed" "blocker: degraded-gate-unreviewed"
gate_reset; cm MEMBER User "$AG_DEG"; flush "$FIX/comments-42.json"; cm MEMBER User "$SEC_AG"; flush; mg "$GATE"
rc_is "degraded: ACCEPTANCE_GATE:DEGRADED reviewed" "$RC" 0
gate_reset; cm MEMBER User "$QG_OK"; flush "$FIX/comments-42.json"; mg "$GATE"
rc_is "degraded: Degraded none is unaffected" "$RC" 0; has "degraded: Degraded none" "MERGE_OUTCOME=merged"
gate_reset; cm MEMBER User "$QG_DEG"; cm MEMBER User "$QG_OK"; flush "$FIX/comments-42.json"; mg "$GATE"
rc_is "degraded: a newer clean gate clears it" "$RC" 0
gate_reset; cm MEMBER User "$QG_OK"; cm MEMBER User "$QG_DEG"; flush "$FIX/comments-42.json"; mg "$GATE"
rc_is "degraded: a newer degraded gate wins" "$RC" 3
gate_reset; cm NONE User "$QG_DEG"; flush "$FIX/comments-42.json"; mg "$GATE"
rc_is "degraded: untrusted DEGRADED marker cannot block" "$RC" 0
gate_reset; mg "$GATE"
rc_is "degraded: no gate comments is unaffected" "$RC" 0
gate_reset; rm -f "$FIX/comments.json"; mg "$GATE"
rc_is "degraded: unreadable comments fail closed" "$RC" 3; not_merged "degraded: unreadable"

# --- --issue requirement ---
gate_reset; mkctx 1 FULL "" ""; mg "$GATE"
rc_is "issue: missing" "$RC" 3; has "issue: missing" "blocker: auto-merge requires --issue"; posted_has "issue: missing" "no --issue was given"
case "$OUT" in *PHASE_TRAIL_FAILED*) bad "issue: missing must not be PHASE_TRAIL_FAILED" ;; *) ok ;; esac
gate_reset; mkctx 1 FULL "" ""; mg "$GATE" --issue 42
rc_is "issue: --issue flag" "$RC" 0; has "issue: --issue flag" "MERGE_OUTCOME=merged"
gate_reset; mkctx 1 FULL "" ""; mg "$GATE" --issue 4x2
rc_is "issue: non-numeric --issue ignored" "$RC" 3

# --- phase-trail gate ---
gate_reset; echo 1 > "$FIX/trail-rc"; printf 'PHASE_TRAIL: INCOMPLETE\nMISSING: FORGE:QUALITY_GATE -> run quality-gate\n' > "$FIX/trail-out"; mg "$GATE"
rc_is "trail: rc 1" "$RC" 4; has "trail: rc 1" "REVIEW_RESULT: status: PHASE_TRAIL_FAILED"; has "trail: rc 1" "MISSING: FORGE:QUALITY_GATE -> run quality-gate"
logged "trail: rc 1 comment" issue-bodies.log "<!-- FORGE:PHASE_TRAIL_FAILED -->"; not_logged "trail: rc 1 is not needs-human" edits.log "needs-human"; not_merged "trail: rc 1"
gate_reset; echo 2 > "$FIX/trail-rc"; echo "PHASE_TRAIL: ERROR (gh)" > "$FIX/trail-out"; mg "$GATE"
rc_is "trail: rc 2" "$RC" 3; has "trail: rc 2" "blocker: phase trail unreadable (rc=2)"
case "$OUT" in *"status: PHASE_TRAIL_FAILED"*) bad "trail: rc 2 must not report PHASE_TRAIL_FAILED" ;; *) ok ;; esac
logged "trail: rc 2 comment" issue-bodies.log "<!-- FORGE:PHASE_TRAIL_ERROR -->"; logged "trail: rc 2 parks" edits.log "needs-human"; not_merged "trail: rc 2"
gate_reset; mg "$G_NOTRAIL"
rc_is "trail: verifier unresolvable" "$RC" 3; has "trail: verifier unresolvable" "blocker: phase trail unreadable (rc=127)"; not_merged "trail: unresolvable"
gate_reset; mg "$GATE"
logged "trail: code diff flag" trail-args "--code-diff"; logged "trail: head bound" trail-args "--head-sha $SHA"; logged "trail: issue arg" trail-args "42 -R o/r"
gate_reset; printf 'README.md\n' > "$FIX/pr-files.txt"; mg "$GATE"
logged "trail: docs-only flag" trail-args "--docs-only"; not_logged "trail: docs-only is not a code diff" trail-args "--code-diff"
gate_reset; printf 'README.md\n' > "$FIX/pr-files.txt"; echo 3000 > "$FIX/changed-n"; mg "$GATE"
logged "trail: truncated files list fails closed" trail-args "--code-diff"
gate_reset; printf 'README.md\n' > "$FIX/pr-files.txt"; rm -f "$FIX/changed-n"; mg "$GATE"
logged "trail: unreadable count fails closed" trail-args "--code-diff"
gate_reset; printf 'OVERRIDE: human waived (bound to head)\nPHASE_TRAIL: OK\n' > "$FIX/trail-out"; mg "$GATE"
rc_is "trail: override on the bound head" "$RC" 0; posted_has "trail: override recorded" "FORGE:PHASE_TRAIL_OVERRIDE_APPLIED"
gate_reset; printf 'OVERRIDE: human waived\nPHASE_TRAIL: OK\n' > "$FIX/trail-out"
printf 'CI_GATE: PASS\nCI_GATE_HEAD: %s\n' "$OTHER_SHA" > "$FIX/ci-out"; printf '<!-- FORGE:REVIEW_ROUTE sha=%s -->\n' "$(printf '%s' "$OTHER_SHA" | cut -c1-7)" > "$FIX/route-bodies"; mg "$GATE"
rc_is "trail: override bound to another head" "$RC" 3; has "trail: override bound to another head" "break-glass override was bound to"; not_merged "trail: override"

# --- unbound guard state aborts (fail closed) ---
gate_reset; run "$GATE" merge-gate
rc_is "guard: nothing bound" "$RC" 3; has "guard: nothing bound" "blocker: merge guard state unbound"; logged "guard: needs-human" edits.log "needs-human"; not_merged "guard: nothing bound"
gate_reset; mg "$GATE" --other-blocking ""
rc_is "guard: empty OTHER_BLOCKING" "$RC" 3; has "guard: empty OTHER_BLOCKING" "merge guard state unbound"
gate_reset; mg "$GATE" --verdict "NEEDS RE-REVIEW"
rc_is "guard: NEEDS RE-REVIEW" "$RC" 3; has "guard: NEEDS RE-REVIEW" "merge guard state unbound"
gate_reset; mg "$GATE" --trust-needs-human maybe
rc_is "guard: non-boolean" "$RC" 3; has "guard: non-boolean" "merge guard state unbound"; not_merged "guard: non-boolean"

# --- verdict / calibration / trust / base-conflict routing ---
gate_reset; mg "$GATE" --verdict "CHANGES REQUESTED" --base-conflict true
rc_is "route: only base conflict" "$RC" 3; has "route: only base conflict" "blocker: base-conflict"; has "route: only base conflict" "MERGE_OUTCOME=base-conflict"
logged "route: base-sync comment" issue-bodies.log "the pipeline is performing the base sync automatically"; not_logged "route: base conflict is not needs-human" edits.log "needs-human"; not_merged "route: base conflict"
gate_reset; mg "$GATE" --verdict "CHANGES REQUESTED" --base-conflict true --other-blocking true
rc_is "route: base conflict plus blocker" "$RC" 3; has "route: base conflict plus blocker" "MERGE_OUTCOME=needs-human"; logged "route: needs-human" edits.log "needs-human"
gate_reset; mg "$GATE" --verdict "CHANGES REQUESTED" --base-conflict true --trust-needs-human true --table-cell-key "feature x HIGH"
rc_is "route: base conflict plus trust" "$RC" 3; logged "route: trust reason" issue-bodies.log "provenance trust: NOVEL_NEEDS_HUMAN tier for cell \`feature x HIGH\`"; logged "route: trust needs-human" edits.log "needs-human"
gate_reset; mg "$GATE" --verdict "CHANGES REQUESTED" --base-conflict true --calibration-needs-human true --calibration-note "overconfident cell"
rc_is "route: base conflict plus calibration" "$RC" 3; logged "route: calibration reason" issue-bodies.log "calibration threshold: overconfident cell"; logged "route: calibration needs-human" edits.log "needs-human"
gate_reset; mg "$GATE" --has-purpose-regression true
rc_is "route: purpose regression with APPROVED" "$RC" 3; logged "route: purpose reason" issue-bodies.log "purpose regression detected by Phase 7A"; logged "route: purpose needs-human" edits.log "needs-human"; not_merged "route: purpose"
for payload in "it's cal" "\$(touch $FIX/SENTINEL)" "\`touch $FIX/SENTINEL\`" "'; touch $FIX/SENTINEL; '"; do
    gate_reset; rm -f "$FIX/SENTINEL"; printf '%s' "$payload" > "$FIX/cn.txt"
    mg "$GATE" --calibration-needs-human true --calibration-note-file "$FIX/cn.txt"
    rc_is "calibration note file: gate blocks" "$RC" 3
    if [ -e "$FIX/SENTINEL" ]; then bad "calibration note file: payload executed ($payload)"; else ok; fi
    logged "calibration note file: rendered as data" issue-bodies.log "calibration threshold: $payload"
done
gate_reset; mg "$GATE" --calibration-needs-human true --calibration-note "note"
rc_is "route: calibration alone blocks an APPROVED verdict" "$RC" 3; not_merged "route: calibration alone"
gate_reset; mg "$GATE" --trust-needs-human true
rc_is "route: trust alone blocks an APPROVED verdict" "$RC" 3; not_merged "route: trust alone"
gate_reset; mg "$GATE" --verdict "CHANGES REQUESTED"
rc_is "route: CHANGES REQUESTED" "$RC" 3; logged "route: verdict reason" issue-bodies.log "review verdict is CHANGES REQUESTED"; not_merged "route: CHANGES REQUESTED"

# --- pre-merge mergeability guard ---
gate_reset; echo "CONFLICTING|DIRTY" > "$FIX/premerge"; mg "$GATE"
rc_is "premerge: conflicting" "$RC" 3; has "premerge: conflicting" "blocker: base-conflict"; not_logged "premerge: conflict is not needs-human" edits.log "needs-human"; not_merged "premerge: conflicting"
gate_reset; echo "MERGEABLE|BEHIND" > "$FIX/premerge"; echo true > "$FIX/protection"; mg "$GATE"
rc_is "premerge: behind under strict protection" "$RC" 3; has "premerge: behind under strict protection" "blocker: base-conflict"
gate_reset; echo "MERGEABLE|BEHIND" > "$FIX/premerge"; echo false > "$FIX/protection"; mg "$GATE"
rc_is "premerge: behind without strict protection" "$RC" 0; has "premerge: behind without strict protection" "MERGE_OUTCOME=merged"
gate_reset; echo "MERGEABLE|BEHIND" > "$FIX/premerge"; mg "$GATE"
rc_is "premerge: behind, unreadable protection" "$RC" 0
gate_reset; echo "MERGEABLE|BLOCKED" > "$FIX/premerge"; mg "$GATE"
rc_is "premerge: branch protection" "$RC" 3; has "premerge: branch protection" "blocker: branch protection not satisfied"
case "$OUT" in *base-conflict*) bad "premerge: protection must never read as base-conflict" ;; *) ok ;; esac
logged "premerge: protection needs-human" edits.log "needs-human"

# --- previously-escalated re-review guard ---
gate_reset; echo true > "$FIX/escalated"; echo false > "$FIX/gate-out"; mg "$GATE"
rc_is "escalated: non-default base" "$RC" 0; has "escalated: non-default base" "MERGE_OUTCOME=parked-awaiting-merge"
logged "escalated: non-default comment" issue-bodies.log "remediation auto-land bar"; logged "escalated: transition" transition.log "awaiting-merge"; not_merged "escalated: non-default"
gate_reset; echo true > "$FIX/escalated"; echo true > "$FIX/gate-out"; mg "$GATE"
rc_is "escalated: deploy gate" "$RC" 0; logged "escalated: deploy gate comment" issue-bodies.log "for a human merge decision"; not_merged "escalated: deploy gate"
gate_reset; echo true > "$FIX/escalated"; echo false > "$FIX/gate-out"; mg "$G_NODEPLOY"
rc_is "escalated: unresolved resolver" "$RC" 0; logged "escalated: unresolved resolver holds for a human" issue-bodies.log "for a human merge decision"; not_merged "escalated: unresolved resolver"
gate_reset; echo true > "$FIX/escalated"; mg "$G_NOTRANS"
rc_is "escalated: no transition script" "$RC" 0; logged "escalated: prose label fallback" edits.log "workflow:awaiting-merge"

# --- CI gate, reviewed-head guard ---
gate_reset; echo 1 > "$FIX/ci-rc"; printf 'CI_GATE: FAIL\nCI_GATE_HEAD: %s\nfailed: build\n' "$SHA" > "$FIX/ci-out"; mg "$GATE"
rc_is "ci: red" "$RC" 3; has "ci: red" "blocker: ci gate not green (rc=1)"; logged "ci: red comment" issue-bodies.log "CI is not green (ci gate rc=1)"; logged "ci: red needs-human" edits.log "needs-human"; not_merged "ci: red"
gate_reset; echo 3 > "$FIX/ci-rc"; printf 'CI_GATE: TIMEOUT\nCI_GATE_HEAD: %s\n' "$SHA" > "$FIX/ci-out"; mg "$GATE"
rc_is "ci: timeout" "$RC" 3; has "ci: timeout" "CI_GATE_TIMEOUT: CI still running"; has "ci: timeout" "blocker: checks still pending after the wait window"; case "$OUT" in *"blocker: ci gate"*) bad "ci: timeout blocker must not match the work-on \"ci gate\" remediation route" ;; *) ok ;; esac; has "ci: timeout outcome" "MERGE_OUTCOME=ci-pending"; not_logged "ci: timeout is not needs-human (#3919)" edits.log "needs-human"; not_merged "ci: timeout"
gate_reset; mg "$G_NOCI"
rc_is "ci: gate unresolvable" "$RC" 3; has "ci: gate unresolvable" "blocker: ci gate not green (rc=2)"; not_merged "ci: unresolvable"
gate_reset; echo 2 > "$FIX/ci-rc"; printf 'CI_GATE: ERROR\nCI_GATE_HEAD: %s\nPR head moved during the wait\n' "$SHA" > "$FIX/ci-out"; mg "$GATE"
rc_is "ci: head moved" "$RC" 3; has "ci: head moved" "blocker: stale review"; not_logged "ci: stale is not needs-human" edits.log "needs-human"; not_merged "ci: head moved"
gate_reset; rm -f "$FIX/route-bodies"; mg "$GATE"
rc_is "stale: no route marker" "$RC" 3; has "stale: no route marker" "cannot bind the merge to a reviewed commit"; not_merged "stale: no route"
gate_reset; printf 'CI_GATE: PASS\nCI_GATE_HEAD: %s\n' "$OTHER_SHA" > "$FIX/ci-out"; echo "$SHA" > "$FIX/commit-sha"; printf 'README.md\n' > "$FIX/compare-files"; mg "$GATE"
rc_is "stale: docs-only post-review delta" "$RC" 0; has "stale: docs-only post-review delta" "Post-review commits are docs-only"; logged "stale: merges the gated head" merge.log "--match-head-commit $OTHER_SHA"
gate_reset; printf 'CI_GATE: PASS\nCI_GATE_HEAD: %s\n' "$OTHER_SHA" > "$FIX/ci-out"; echo "$SHA" > "$FIX/commit-sha"; printf 'a.py\n' > "$FIX/compare-files"; mg "$GATE"
rc_is "stale: code post-review delta" "$RC" 3; has "stale: code post-review delta" "is not the reviewed commit"; not_merged "stale: code delta"
gate_reset; printf 'CI_GATE: PASS\nCI_GATE_HEAD: %s\n' "$OTHER_SHA" > "$FIX/ci-out"; rm -f "$FIX/compare-files"; mg "$GATE"
rc_is "stale: unreadable compare fails closed" "$RC" 3; not_merged "stale: unreadable compare"

# --- verdict (7A log, 7B base conflict and posting) ---
vd() { run "$GOOD" verdict --merge-health "${MH:-MERGEABLE}" --merge-health-state "${MHS:-CLEAN}" --base main --head-branch feat/x "$@"; }
reset; MH=MERGEABLE; MHS=CLEAN; vd
rc_is "verdict: clean state" "$RC" 0; has "verdict: clean state" "BASE_CONFLICT=false"; has "verdict: clean state" "HAS_MERGE_CONFLICT=false"
reset; MH=CONFLICTING; MHS=DIRTY; vd
has "verdict: conflicting" "BASE_CONFLICT=true"; has "verdict: conflicting message" "Merge \`origin/main\` into \`feat/x\` (merge only, no rebase, no force-push)"
reset; MH=MERGEABLE; MHS=DIRTY; vd; has "verdict: dirty alone" "BASE_CONFLICT=true"
reset; MH=MERGEABLE; MHS=BEHIND; echo true > "$FIX/protection"; vd; has "verdict: behind under strict protection" "BASE_CONFLICT=true"
reset; MH=MERGEABLE; MHS=BEHIND; echo false > "$FIX/protection"; vd; has "verdict: behind without strict protection" "BASE_CONFLICT=false"
reset; MH=MERGEABLE; MHS=BEHIND; vd; has "verdict: behind, unreadable protection" "BASE_CONFLICT=false"
reset; MH=MERGEABLE; MHS=BLOCKED; vd
has "verdict: blocked is not a conflict" "BASE_CONFLICT=false"; has "verdict: blocked warning" "MERGE_PROTECTION_WARNING=Merge state is BLOCKED"
reset; MH=MERGEABLE; MHS=CLEAN; vd --result clean --agents "3 agents: a, b, c" --findings-count 2
rc_is "verdict: clean post" "$RC" 0; has "verdict: clean" "VERDICT=APPROVED"
logged "verdict: clean body" reviews.log "APPROVED: commit $(printf '%s' "$SHA" | cut -c1-7) after context-aware review (3 agents: a, b, c). 2 findings created as issues. Safe to merge."
logged "verdict: trust annotation defaults" reviews.log '**Intensity tier**: SHADOW | **Cell**: `(unavailable)` | **Shadow mode**: true'
reset; MH=UNKNOWN; MHS=UNKNOWN; vd --result clean; logged "verdict: unknown mergeability warning" reviews.log "GitHub is still computing merge state"
reset; MH=MERGEABLE; MHS=CLEAN; vd --result clean --intensity-tier FAST --table-cell-key "bug HIGH" --trust-shadow-mode false
logged "verdict: trust annotation" reviews.log '**Intensity tier**: FAST | **Cell**: `bug HIGH` | **Shadow mode**: false'
reset; MH=CONFLICTING; MHS=DIRTY; vd --result blocking --blocking-count 1
has "verdict: blocking" "VERDICT=CHANGES REQUESTED"; logged "verdict: blocking body" reviews.log "CHANGES REQUESTED: commit"; logged "verdict: base conflict line" reviews.log "🔴 Base Conflict:"
reset; MH=CONFLICTING; MHS=DIRTY; vd --result clean
has "verdict: clean coerced over a base conflict" "VERDICT_COERCED=true"; has "verdict: coerced verdict" "VERDICT=CHANGES REQUESTED"; logged "verdict: coerced body" reviews.log "CHANGES REQUESTED: commit"
reset; MH=MERGEABLE; MHS=CLEAN; vd --result clean --has-purpose-regression true --purpose-findings "F-1"
has "verdict: clean coerced over a purpose regression" "VERDICT_COERCED=true"; logged "verdict: purpose line" reviews.log "⚠ Purpose Regression:"; logged "verdict: purpose finding list" reviews.log "See: F-1"
reset; MH=MERGEABLE; MHS=CLEAN; vd --result stale
has "verdict: stale" "VERDICT=STALE"; logged "verdict: stale body" reviews.log "is stale — PR HEAD changed. Re-run /review-pr."
reset; MH=MERGEABLE; MHS=CLEAN; vd --result clean --dry-run
if [ -f "$FIX/reviews.log" ]; then bad "verdict: --dry-run must post nothing"; else ok; fi
# 7A: the purpose-regression log is milestone-only
reset; MH=MERGEABLE; MHS=CLEAN; vd --is-milestone true --has-purpose-regression true --purpose-findings "F-1"
has "7A: blocked log" "PURPOSE REGRESSION GATE: BLOCKED"; has "7A: escalation" "Verdict escalated to CHANGES REQUESTED."
reset; MH=MERGEABLE; MHS=CLEAN; vd --is-milestone true --has-purpose-regression false; has "7A: passed log" "PURPOSE REGRESSION GATE: PASSED"
reset; MH=MERGEABLE; MHS=CLEAN; vd --has-purpose-regression true
case "$OUT" in *"PURPOSE REGRESSION GATE"*) bad "7A: non-milestone PRs print no gate log" ;; *) ok ;; esac
# free text arrives through *-file flags and is data, never code (injection payload classes: apostrophe, command substitution, backtick, quote breakout, newline)
SENT="$FIX/SENTINEL"
for payload in "it's a F-1" "\$(touch $SENT)" "\`touch $SENT\`" "'; touch $SENT; '" "\"; touch $SENT; \"" "F-1
touch $SENT"; do
    reset; rm -f "$SENT"; MH=MERGEABLE; MHS=CLEAN
    printf '%s' "$payload" > "$FIX/pf.txt"; printf '%s' "$payload" > "$FIX/ag.txt"
    vd --result clean --has-purpose-regression true --purpose-findings-file "$FIX/pf.txt" --agents-file "$FIX/ag.txt"
    rc_is "payload file: verdict runs" "$RC" 0
    if [ -e "$SENT" ]; then bad "payload file: payload executed ($payload)"; else ok; fi
    logged "payload file: purpose text kept as data" reviews.log "See: $(printf '%s' "$payload" | tr '\n' ' ')"
done
reset; MH=MERGEABLE; MHS=CLEAN; printf 'a\001b\033c\nd' > "$FIX/pf.txt"
vd --result clean --has-purpose-regression true --purpose-findings-file "$FIX/pf.txt"
logged "payload file: control characters stripped, newline folded" reviews.log "See: abc d"
reset; MH=MERGEABLE; MHS=CLEAN; head -c 5000 /dev/zero | tr '\0' 'x' > "$FIX/pf.txt"
vd --result clean --has-purpose-regression true --purpose-findings-file "$FIX/pf.txt"
if grep -qF "$(head -c 2001 /dev/zero | tr '\0' 'x')" "$FIX/reviews.log" 2>/dev/null; then bad "payload file: text must be capped at 2000 bytes"; else ok; fi
logged "payload file: capped text still rendered" reviews.log "See: $(head -c 2000 /dev/zero | tr '\0' 'x')"
reset; MH=MERGEABLE; MHS=CLEAN
vd --result clean --has-purpose-regression true --purpose-findings-file "$FIX/does-not-exist.txt"
rc_is "payload file: missing file tolerated" "$RC" 0
reset; MH=MERGEABLE; MHS=CLEAN; printf 'from-file' > "$FIX/pf.txt"
vd --result clean --has-purpose-regression true --purpose-findings "from-flag" --purpose-findings-file "$FIX/pf.txt"
logged "payload file: file wins over inline flag" reviews.log "See: from-file"; not_logged "payload file: inline flag overridden" reviews.log "from-flag"
reset; OUT=$(cd "$REPO_DIR" && FORGEDOCK_HOME="$GOOD" bash "$ROOT/scripts/review-finalize.sh" verdict --pr 7 --repo o/r --context "$CTXF" --merge-health 2>/dev/null); RC=$?
rc_is "verdict: flag without a value" "$RC" 2
reset; vd --result bogus; rc_is "verdict: invalid result" "$RC" 2

# --- calibrate (7B.5) ---
CAL_ROW() { printf '{"rows":[{"taskType":"%s","confidence":"%s","trusted":%s,"survivalRate":0.5,"sampleCount":20,"flag":"%s"}]}' "$1" "$2" "$3" "$4"; }
setcal() {   # setcal <json>: publish calibration/table.json as origin/forge-knowledge in the throwaway checkout
    git -C "$REPO_DIR" checkout -q -b kn-tmp; mkdir -p "$REPO_DIR/calibration"; printf '%s' "$1" > "$REPO_DIR/calibration/table.json"
    git -C "$REPO_DIR" add -A; git -C "$REPO_DIR" commit -qm cal
    git -C "$REPO_DIR" update-ref refs/remotes/origin/forge-knowledge HEAD
    git -C "$REPO_DIR" checkout -q main; git -C "$REPO_DIR" branch -q -D kn-tmp; rm -rf "$REPO_DIR/calibration"
}
clrcal() { git -C "$REPO_DIR" update-ref -d refs/remotes/origin/forge-knowledge 2>/dev/null || true; }
# investigator comments: inv_comments <association> <type> <body> -> $FIX/comments-42.json (read by calibrate via --paginate)
inv_comments() { jq -n -c --arg a "$1" --arg t "$2" --arg b "$3" '[{author_association: $a, user: {type: $t, login: "u"}, body: $b}]' > "$FIX/comments-42.json"; }
cal() { reset; mkctx 1 FULL "" 42; inv_comments NONE Bot "$(printf '<!-- FORGE:INVESTIGATOR -->\n## Investigation\n**Task Type**: Refactor\n**Confidence**: HIGH\n')"; run "$GOOD" calibrate "$@"; }
setcal "$(CAL_ROW Refactor HIGH true overconfidence)"
cal; rc_is "calibrate: overconfidence" "$RC" 0; has "calibrate: overconfidence" "CALIBRATION_NEEDS_HUMAN=true"; has "calibrate: cell" "CALIBRATION_CELL=Refactor × HIGH: survival=0.5 (n=20)"
has "calibrate: note" "Routing to needs-human per forge#1741 policy."; logged "calibrate: trajectory record" issue-bodies.log "<!-- FORGE:CALIBRATION_CHECK -->"
cal --intensity-tier FAST --table-cell-key "k" --trust-shadow-mode false --trust-needs-human true
logged "calibrate: provenance record" issue-bodies.log '**TRUST_NEEDS_HUMAN**: true'
cal --dry-run; has "calibrate: dry run" "CALIBRATION_NEEDS_HUMAN=true"; if [ -f "$FIX/issue-bodies.log" ]; then bad "calibrate: --dry-run must post nothing"; else ok; fi
clrcal; setcal "$(CAL_ROW Refactor HIGH true null)"
cal; has "calibrate: healthy cell" "CALIBRATION_NEEDS_HUMAN=false"; has "calibrate: healthy cell note" "within acceptable threshold"
clrcal; setcal "$(CAL_ROW Refactor HIGH false overconfidence)"
cal; has "calibrate: untrusted cell never tightens" "CALIBRATION_NEEDS_HUMAN=false"; has "calibrate: untrusted cell note" "absent or untrusted"
clrcal; setcal "$(CAL_ROW Refactor MEDIUM true overconfidence)"
cal; has "calibrate: only HIGH confidence tightens" "CALIBRATION_NEEDS_HUMAN=false"
clrcal; setcal "not json"
cal; has "calibrate: malformed table fails safe" "CALIBRATION_NEEDS_HUMAN=false"
clrcal
cal; has "calibrate: missing table fails safe" "CALIBRATION_NEEDS_HUMAN=false"; has "calibrate: missing table note" "calibration table unavailable"
# untrusted / unanchored INVESTIGATOR text never feeds the note, and the note never carries shell metacharacters (BUG-3, #3952)
reset; mkctx 1 FULL "" 42; inv_comments NONE User "$(printf '<!-- FORGE:INVESTIGATOR -->\n**Task Type**: X\x27;touch${IFS}/tmp/pwn;\x27\n**Confidence**: HIGH\n')"; run "$GOOD" calibrate
has "calibrate: untrusted investigator ignored" "could not resolve task type/confidence"
reset; mkctx 1 FULL "" 42; inv_comments MEMBER User "$(printf 'see <!-- FORGE:INVESTIGATOR -->\n**Task Type**: Refactor\n**Confidence**: HIGH\n')"; run "$GOOD" calibrate
has "calibrate: unanchored marker ignored" "could not resolve task type/confidence"
reset; mkctx 1 FULL "" 42; inv_comments MEMBER User "$(printf '<!-- FORGE:INVESTIGATOR -->\n**Task Type**: Re\x27fa$(id)ctor\n**Confidence**: HIGH\n')"; run "$GOOD" calibrate
if [ -s "$(dirname "$CTXF")/review-finalize-7/calibration-note.txt" ] || find "$FIX" "$(dirname "$CTXF")" -name calibration-note.txt 2>/dev/null | grep -q .; then ok; else bad "calibrate: must write calibration-note.txt under the out dir"; fi
note=$(printf '%s\n' "$OUT" | sed -n 's/^CALIBRATION_NOTE=//p'); case "$note" in *"'"*|*'$'*|*'`'*) bad "calibrate: note carries a shell metacharacter: $note" ;; *) ok ;; esac
setcal "$(CAL_ROW Refactor HIGH true overconfidence)"
reset; mkctx 1 FULL "" 42; run "$GOOD" calibrate; has "calibrate: no investigator comment fails safe" "CALIBRATION_NEEDS_HUMAN=false"; has "calibrate: unresolved note" "task type or confidence not resolved"
reset; mkctx 1 FULL "" ""; run "$GOOD" calibrate; has "calibrate: no issue fails safe" "CALIBRATION_NEEDS_HUMAN=false"
clrcal

# --- demilestone (8B / 9A) ---
printf '11\n12\n' > "$WORK/demile.seed"
dm() { reset; cp "$WORK/demile.seed" "$FIX/demile.txt"; run "$GOOD" demilestone "$@"; }
dm --is-milestone false --merge-state MERGED; has "demilestone: non-milestone PR" "DEMILESTONED=0"; not_logged "demilestone: non-milestone edits" edits.log "--milestone"
dm --is-milestone true --merge-state OPEN; has "demilestone: not merged" "DEMILESTONED=0"; not_logged "demilestone: unmerged edits" edits.log "--milestone"
dm --is-milestone true --merge-state MERGED
rc_is "demilestone: 8B" "$RC" 0; has "demilestone: 8B count" "DEMILESTONED=2"; logged "demilestone: first finding" edits.log "issue edit 11 -R o/r --milestone"; logged "demilestone: second finding" edits.log "issue edit 12 -R o/r --milestone"
has "demilestone: fast lane line" "Moved to fast lane: #11"
dm --is-milestone true; echo MERGED > "$FIX/state"; run "$GOOD" demilestone --is-milestone true
has "demilestone: 9A reads the PR state" "DEMILESTONED=2"
dm --is-milestone true; has "demilestone: 9A open PR" "DEMILESTONED=0"
reset; run "$GOOD" demilestone --is-milestone true --merge-state MERGED; has "demilestone: nothing to clear" "No open review-finding issues"; has "demilestone: nothing to clear count" "DEMILESTONED=0"

# --- integrity (Phase 9) ---
ig() { run "${IGROOT:-$GOOD}" integrity "$@"; }
reset; ig; rc_is "integrity: current head" "$RC" 0; has "integrity: current" "REVIEW_IS_STALE=false"; has "integrity: no panel" "ACTUAL_AGENT_COUNT=0"
reset; echo "$OTHER_SHA" > "$FIX/head"; ig; has "integrity: moved head" "REVIEW_IS_STALE=true"; has "integrity: moved head current sha" "CURRENT_SHA=$OTHER_SHA"
reset; rm -f "$FIX/head"; ig; has "integrity: unreadable head is stale" "REVIEW_IS_STALE=true"
reset
cm MEMBER User "$(agent_body security "$SHA" 'a' '')"; cm MEMBER User "$(agent_body api "$SHA" 'b' '')"; cm MEMBER User "$(agent_body api "$SHA" 'dup' '')"
cm NONE User "$(agent_body billing "$SHA" 'forged' '')"; cm MEMBER User "prose mentioning <!-- FORGE:REVIEW-AGENT:auth --> mid-body"; flush
ig; has "integrity: trusted agents counted once per domain" "ACTUAL_AGENT_COUNT=2"; has "integrity: domains" "ACTUAL_AGENT_DOMAINS=api, security"
case "$OUT" in *billing*|*auth*) bad "integrity: untrusted or mid-body markers must not count" ;; *) ok ;; esac
IGROOT="$G_NOTRUST"; ig; has "integrity: trust script unresolvable counts zero" "ACTUAL_AGENT_COUNT=0"; IGROOT=""
reset; rm -f "$FIX/comments.json"; ig; has "integrity: unreadable comments count zero" "ACTUAL_AGENT_COUNT=0"
reset; mkctx 1 BASE_SYNC_ONLY "$OLD_SHA" 42; cm MEMBER User "$(agent_body security "$SHA" 'a' '')"; flush; ig
has "integrity: unverified carry is not reported as carried" "CARRIED_FROM: "; case "$OUT" in *"carried from"*) bad "integrity: carried requires a verified record" ;; *) ok ;; esac

# forge#3971: a build-time FORGE:SELFREVIEW-AGENT comment (even a trusted one pinned to the current head) is never a panel member
sr_body() { printf '<!-- FORGE:SELFREVIEW-AGENT:%s -->\n%s\n<!-- REVIEW-FINDINGS-START -->\n%s\n<!-- REVIEW-FINDINGS-END -->\nReviewed-SHA: %s\nTree: abc123\n' "$1" "$3" "$4" "$2"; }
reset
cm MEMBER User "$(sr_body security "$SHA" 'self' '<!-- FINDING:SEC-9|CONFIRMED|HIGH|a.py:9|Self-review finding -->')"; cm MEMBER Bot "<!-- FORGE:SELFREVIEW -->
Tree: abc123"; flush
ig; has "integrity: self-review comments never count as panel agents" "ACTUAL_AGENT_COUNT=0"
case "$OUT" in *security*) bad "integrity: SELFREVIEW-AGENT domain leaked into the panel" ;; *) ok ;; esac
reset
cm MEMBER User "$(sr_body security "$SHA" 'self' '<!-- FINDING:SEC-9|CONFIRMED|HIGH|a.py:9|Self-review finding -->')"; flush
run "$GOOD" extract
has "extract: a self-review comment alone is no review (fail closed)" "no trusted reviewer comments"
reset
cm MEMBER User "$(sr_body security "$SHA" 'self' '')"; cm MEMBER User "$(agent_body api "$SHA" 'real' '')"; flush
ig; has "integrity: only the REVIEW-AGENT counts beside a self-review" "ACTUAL_AGENT_COUNT=1"; has "integrity: only the real domain" "ACTUAL_AGENT_DOMAINS=api"

# --- Phase 7-9 subcommands run without a review-prepare context (flags only) ---
nctx() { local sub="$1"; shift; OUT=$(cd "$REPO_DIR" && FORGEDOCK_HOME="$GATE" bash "$ROOT/scripts/review-finalize.sh" "$sub" --pr 7 --repo o/r "$@" 2>"$WORK/stderr"); RC=$?; }
gate_reset; nctx merge-gate --issue 42 --base main --verdict APPROVED --has-purpose-regression false --calibration-needs-human false --trust-needs-human false --base-conflict false --other-blocking false
rc_is "no context: merge-gate" "$RC" 0; has "no context: merge-gate" "MERGE_OUTCOME=merged"
gate_reset; nctx merge-gate --base main --verdict APPROVED --has-purpose-regression false --calibration-needs-human false --trust-needs-human false --base-conflict false --other-blocking false
rc_is "no context: merge-gate without --issue" "$RC" 3; has "no context: merge-gate without --issue" "auto-merge requires --issue"
gate_reset; nctx integrity --review-sha "$SHA"; rc_is "no context: integrity" "$RC" 0; has "no context: integrity" "REVIEW_IS_STALE=false"
gate_reset; nctx integrity; rc_is "no context: integrity without a sha" "$RC" 3; has "no context: integrity without a sha" "REVIEW_SHA is not a commit id"
gate_reset; nctx extract --out-dir "$WORK/out"; rc_is "no context: extract still needs one" "$RC" 2

# ======================= usage errors =======================
OUT=$(bash "$ROOT/scripts/review-finalize.sh" bogus 2>/dev/null); RC=$?; rc_is "unknown subcommand" "$RC" 2
OUT=$(bash "$ROOT/scripts/review-finalize.sh" extract --pr x --repo o/r --context "$CTXF" 2>/dev/null); RC=$?; rc_is "non-numeric pr" "$RC" 2
OUT=$(bash "$ROOT/scripts/review-finalize.sh" extract --pr 7 --repo o/r 2>/dev/null); RC=$?; rc_is "missing context" "$RC" 2

# ======================= forge#4037: build.md red-green DEGRADED entry survives the real name splitter =======================
RG_LINE=$(grep -F 'RG_DEGRADED_LIST="${RG_DEGRADED_LIST}' "$ROOT/commands/work-on/build.md" | sed -n '1p' | sed 's/^[[:space:]]*\*) //; s/ ;;.*$//')
SPLIT_LINE=$(grep -F 'DEG_NAME_LIST=$(printf' "$ROOT/scripts/review-finalize.sh" | sed -n '1p' | sed 's/^[[:space:]]*//')
if [ -n "$RG_LINE" ] && [ -n "$SPLIT_LINE" ]; then
  RG_DEGRADED_LIST=""; ID="AC2"; RG_BASE=UNRUNNABLE; RG_HEAD=RAN
  eval "$RG_LINE"
  RG_DEGRADED_LIST="${RG_DEGRADED_LIST}; AC3 — base run cannot execute (base=UNRUNNABLE head=RAN), so the test is unproven"
  DEG_NAMES="$RG_DEGRADED_LIST"
  eval "$SPLIT_LINE"
  [ "$DEG_NAME_LIST" = "$(printf 'AC2\nAC3')" ] && ok || bad "red-green DEGRADED entries split into exactly their check names (got: $DEG_NAME_LIST)"
else
  bad "could not extract the build.md DEGRADED entry or the review-finalize splitter"
fi

echo "review-finalize tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
