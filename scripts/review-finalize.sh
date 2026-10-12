#!/usr/bin/env bash
# review-finalize.sh — deterministic review-pr Phase 6 (finding triage and issue-filing preparation), part A.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# One self-contained shell per subcommand: each re-derives every value it uses (no helper or variable is defined in one place and
# consumed in another), resolves ForgeDock's own helpers through forge_resolve (FORGEDOCK_HOME / plugin root / FORGE_ROOT / plugin
# cache; the working directory and the PR checkout are NEVER a script source), and treats everything reviewer-controlled (comment
# bodies, finding titles, file paths) as data: comment text is only ever read through scripts/trusted-comments.sh, JSON is built with
# `jq --arg`, nothing from a comment is eval'd or expanded in arithmetic.
#
# Usage: review-finalize.sh <subcommand> --pr N --repo owner/name --context FILE [options]
#   extract       6A trusted-comment extraction + 6B dedup + 6B.4 provenance/concreteness gates. Writes the findings JSON.
#   classify      6B.5 note disposition: classifier (classify-finding.sh, called as is), contract scope, cross-head re-flag, per-review
#                 cap, pre-existing route; posts FORGE:NOTE_DISPOSITION (and FORGE:INPR_FIX on the first auto-merge round).
#   file-prepare  6C pre-filing work: labels, milestone, title and line-range dedup, regression to P1, pattern recurrence,
#                 severity-to-priority, BATCHABLE. Writes the JSON work list the caller files from.
#   file-verify   6C post-filing parse: reads the issue-creation result text on stdin, prints ISSUE_NUM=N, exits 1 when no number.
#
# Boundary: the filing call itself (the /issue skill with its programmatic contract) and the LLM-authored finding body stay in the
# spec: a shell script cannot invoke a skill. The script ends at the work list (file-prepare) and resumes at file-verify.
# Also left to the caller: INTEG-N findings from Phase 2.5, unstructured-finding extraction when `extract` reports 0 structured
# findings, pattern-class consolidation issue creation, project-board add, 6D, and the choice of which NOTEs are fixed or dropped
# (pass --notes-fixed / --notes-dropped; every other plain NOTE is counted as listed).
#
# Options:
#   --pr N            PR number (numeric, required)         --repo owner/name   (required)
#   --context FILE    the review-prepare.sh context JSON (schema_version 1 required): pr.review_sha, pr.base_ref, delta.mode/from,
#                     contract.issue (the PR's linked issue) are read from it, never re-derived
#   --out-dir DIR     artifacts (default: ${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}/review-finalize-<pr>)
#   --findings FILE   input findings JSON (default: extract -> n/a, classify -> OUT_DIR/findings.json, file-prepare -> OUT_DIR/classified.json)
#   --out FILE        output JSON (default: extract -> OUT_DIR/findings.json, classify -> OUT_DIR/classified.json, file-prepare -> OUT_DIR/worklist.json)
#   --auto-merge B    classify: true enables the in-PR fix gate (auto-merge review with a linked issue, first round only)
#   --notes-fixed N / --notes-dropped N   classify: NOTE dispositions chosen by the caller (default 0); the rest are notes_listed
#   --patterns FILE   file-prepare: JSON object {finding id: FORGE:PATTERN slug}; absent = the recurrence check is skipped
#   --dry-run         classify: post no PR or issue comments; file-prepare: create no labels
# Env: FORGE_CONFIG (forge.yaml for review.max_filed_findings; default ./forge.yaml).
# Exit: 0 ok | 3 BLOCKED (REVIEW_RESULT: status: BLOCKED printed; the caller must stop the review, never skip) | 1 file-verify found no
#       issue number | 2 usage error
#
# Stdout of each subcommand is KEY=value lines (plus REVIEW_RESULT on BLOCKED). Bash 3.2 portable (no mapfile, associative arrays, grep -P).

set -u

SUB="${1:-}"
case "$SUB" in
    extract|classify|file-prepare|file-verify) shift ;;
    *) echo "usage: review-finalize.sh extract|classify|file-prepare|file-verify --pr N --repo owner/name --context FILE [options]" >&2; exit 2 ;;
esac

PR_NUMBER=""; REPO=""; CONTEXT=""; OUT_DIR=""; IN_FILE=""; OUT_FILE=""; AUTO_MERGE="false"; NOTES_FIXED=0; NOTES_DROPPED=0; PATTERNS=""; DRY_RUN="false"
while [ $# -gt 0 ]; do
    case "$1" in
        --pr|--repo|--context|--out-dir|--findings|--out|--auto-merge|--notes-fixed|--notes-dropped|--patterns)
            [ $# -ge 2 ] || { echo "review-finalize: $1 requires a value" >&2; exit 2; } ;;
    esac
    case "$1" in
        --pr) PR_NUMBER="${2:-}"; shift 2 ;;
        --repo) REPO="${2:-}"; shift 2 ;;
        --context) CONTEXT="${2:-}"; shift 2 ;;
        --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
        --findings) IN_FILE="${2:-}"; shift 2 ;;
        --out) OUT_FILE="${2:-}"; shift 2 ;;
        --auto-merge) AUTO_MERGE="${2:-false}"; shift 2 ;;
        --notes-fixed) NOTES_FIXED="${2:-0}"; shift 2 ;;
        --notes-dropped) NOTES_DROPPED="${2:-0}"; shift 2 ;;
        --patterns) PATTERNS="${2:-}"; shift 2 ;;
        --dry-run) DRY_RUN="true"; shift ;;
        *) echo "review-finalize: unknown argument: $1" >&2; exit 2 ;;
    esac
done

# --- file-verify needs nothing else: it only parses the issue-creation result text on stdin ---
if [ "$SUB" = "file-verify" ]; then
    ISSUE_SKILL_OUTPUT=$(cat)
    # The creation step succeeds only after its API create-token read-back; its explicit result marker distinguishes a verified create
    # from an intentional dedup STOP. Never use title search to mask a swallowed 403.
    ISSUE_NUM=$(printf '%s\n' "$ISSUE_SKILL_OUTPUT" | sed -n 's/.*ISSUE_CREATE_RESULT:CREATED number=\([0-9][0-9]*\).*/\1/p' | head -1)
    DEDUP_NUMBER=$(printf '%s\n' "$ISSUE_SKILL_OUTPUT" | sed -n 's/.*ISSUE_CREATE_RESULT:DEDUP number=\([0-9][0-9]*\).*/\1/p' | head -1)
    if [ -n "$DEDUP_NUMBER" ]; then
        echo "Review finding deduped against existing issue #${DEDUP_NUMBER}."
        echo "ISSUE_NUM=${DEDUP_NUMBER}"; echo "DEDUPED=true"; exit 0
    elif [ -z "$ISSUE_NUM" ]; then
        echo "ERROR: /issue did not report a verified review-finding number; stopping review instead of silently dropping the finding." >&2
        exit 1
    fi
    echo "ISSUE_NUM=${ISSUE_NUM}"; echo "DEDUPED=false"; exit 0
fi

case "$PR_NUMBER" in ''|*[!0-9]*) echo "review-finalize: --pr must be numeric" >&2; exit 2 ;; esac
case "$REPO" in */*) ;; *) echo "review-finalize: --repo must be owner/name" >&2; exit 2 ;; esac
case "$REPO" in *[!A-Za-z0-9._/-]*|*/*/*|/*|*/) echo "review-finalize: invalid --repo" >&2; exit 2 ;; esac
[ -n "$CONTEXT" ] || { echo "review-finalize: --context FILE is required" >&2; exit 2; }
case "$NOTES_FIXED" in ''|*[!0-9]*) NOTES_FIXED=0 ;; esac
case "$NOTES_DROPPED" in ''|*[!0-9]*) NOTES_DROPPED=0 ;; esac
[ "$AUTO_MERGE" = "true" ] || AUTO_MERGE="false"
command -v jq >/dev/null 2>&1 || { echo "review-finalize: jq is required" >&2; exit 2; }

# --- trusted helper resolution (install roots only; never cwd) ---
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; _SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)"; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" "${CLAUDE_PLUGIN_ROOT:-}" "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/* "$_SELF_ROOT"; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }

# Every fail-closed path prints the spec's marker text byte-identically, then exits 3 so the caller cannot skip it.
blocked() { echo "REVIEW_RESULT: status: BLOCKED, blocker: $1"; exit 3; }

# --- the review-prepare context (schema_version 1) ---
[ -r "$CONTEXT" ] || blocked "review-prepare context unreadable: $CONTEXT"
jq -e . "$CONTEXT" >/dev/null 2>&1 || blocked "review-prepare context is not valid JSON"
CTX_SV=$(jq -r '.schema_version // empty' "$CONTEXT" 2>/dev/null)
[ "$CTX_SV" = "1" ] || blocked "review-prepare context schema_version ${CTX_SV:-missing} is not supported (expected 1)"
[ "$(jq -r '.status // empty' "$CONTEXT")" != "BLOCKED" ] || blocked "review-prepare context is BLOCKED: $(jq -r '(.blockers // []) | join("; ")' "$CONTEXT")"
REVIEW_SHA=$(jq -r '.pr.review_sha // empty' "$CONTEXT")
REVIEW_MODE=$(jq -r '.delta.mode // "FULL"' "$CONTEXT")
DELTA_FROM=$(jq -r '.delta.from // empty' "$CONTEXT")
MERGE_ISSUE=$(jq -r '.contract.issue // empty' "$CONTEXT")
case "$MERGE_ISSUE" in *[!0-9]*) MERGE_ISSUE="" ;; esac
CTX_BASE_BRANCH=$(jq -r '.pr.base_ref // empty' "$CONTEXT")
case "$REVIEW_MODE" in FULL|DELTA|BASE_SYNC_ONLY) ;; *) REVIEW_MODE="FULL" ;; esac

[ -n "$OUT_DIR" ] || OUT_DIR="${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}/review-finalize-${PR_NUMBER}"
mkdir -p "$OUT_DIR" 2>/dev/null || { echo "review-finalize: cannot create $OUT_DIR" >&2; exit 2; }
WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/review-finalize.XXXXXX") || exit 2
trap 'rm -rf "$WORKDIR"' EXIT
_pscr="$WORKDIR"

is_sha() { case "${1}" in *[!0-9a-f]*|"") return 1 ;; esac; [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ]; }
# Shared: validate the input findings JSON for classify and file-prepare.
need_findings() {
    [ -r "$IN_FILE" ] && jq -e '.findings | type == "array"' "$IN_FILE" >/dev/null 2>&1 \
        || { echo "review-finalize: findings JSON unreadable or malformed: $IN_FILE" >&2; exit 2; }
}
fj() { jq -r --argjson i "$I" ".findings[\$i]$1 // empty" "$IN_FILE" 2>/dev/null; }   # one field of finding I
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]'; }
sev_rank() { case "$(upper "$1")" in CRITICAL) echo 0 ;; HIGH) echo 1 ;; MEDIUM) echo 2 ;; LOW) echo 3 ;; *) echo 4 ;; esac; }

# ======================================================================================================================
# extract: 6A + 6B + 6B.4
# ======================================================================================================================
do_extract() {
    OUT_FILE="${OUT_FILE:-$OUT_DIR/findings.json}"
    case "$REVIEW_SHA" in *[!0-9a-f]*|"") REVIEW_SHA_OK=false ;; *) [ "${#REVIEW_SHA}" -eq 40 ] || [ "${#REVIEW_SHA}" -eq 64 ] && REVIEW_SHA_OK=true || REVIEW_SHA_OK=false ;; esac
    [ "$REVIEW_SHA_OK" = "true" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: REVIEW_SHA is not a commit id (an empty SHA would count every head's findings)"; exit 3; }
    # Only TRUSTED bodies for the CURRENT head count (BASE_SYNC_ONLY and DELTA add the carried / earlier reviewed head, see below) (scripts/trusted-comments.sh + anchored marker + Reviewed-SHA line):
    # findings from earlier heads are already fixed or re-reviewed, and an untrusted commenter must never be able to inject
    # findings or post a forged synthesis block that makes the review read clean (the head SHA is public).
    TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
    REVIEW_DELTA_SCRIPT=$(forge_resolve review-delta.sh)
    BASE_BRANCH="$CTX_BASE_BRANCH"
    [ -n "$BASE_BRANCH" ] || BASE_BRANCH=$(gh pr view "$PR_NUMBER" -R "$REPO" --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "")
    COMMENTS_JSON=$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null || echo "")
    if [ -z "$TRUSTED_SCRIPT" ] || [ -z "$COMMENTS_JSON" ]; then
        echo "REVIEW_RESULT: status: BLOCKED, blocker: scripts/trusted-comments.sh unresolvable or PR comments unreadable; refusing to read clean (fail closed)"; exit 3
    fi
    _dm=$(forge_resolve lib/review-delta-mode.sh); [ -n "$_dm" ] && . "$_dm" || { review_delta_mode() { echo "FULL - 0"; }; carry_verified_from() { :; }; }
    # Trusted synthesized block for one head when present, else that head's trusted agent bodies (the same predicate as before,
    # now per head). Returns non-zero when the trust script cannot count or read.
    bodies_at() {
        local sha="${1}" synth agent has
        synth="^<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->[\\s\\S]*(^|\\n)Reviewed-SHA: ${sha}(\\r?\\n|$)"
        agent="^<!-- FORGE:REVIEW-AGENT:[a-z-]+ -->[\\s\\S]*(^|\\n)Reviewed-SHA: ${sha}(\\r?\\n|$)"
        has=$(printf '%s' "$COMMENTS_JSON" | bash "$TRUSTED_SCRIPT" count "$synth" 2>/dev/null || echo "")
        case "$has" in ''|*[!0-9]*) return 1 ;; esac
        if [ "$has" -gt 0 ]; then
            printf '%s' "$COMMENTS_JSON" | bash "$TRUSTED_SCRIPT" bodies "$synth" 2>/dev/null || return 1
        else
            printf '%s' "$COMMENTS_JSON" | bash "$TRUSTED_SCRIPT" bodies "$agent" 2>/dev/null || return 1
        fi
    }
    # Trusted raw agent bodies for one head (the carrier of each finding's agent name and prose, even when a synthesis block is the source).
    agent_bodies_at() {
        printf '%s' "$COMMENTS_JSON" | bash "$TRUSTED_SCRIPT" bodies "^<!-- FORGE:REVIEW-AGENT:[a-z-]+ -->[\\s\\S]*(^|\\n)Reviewed-SHA: ${1}(\\r?\\n|$)" 2>/dev/null || true
    }
    # FULL: the current head's bodies, exactly as before. BASE_SYNC_ONLY: the head has no reviewers, so the findings are the
    # carried head's, and only a VERIFIED carry record (trusted, same head, resolver agrees) selects that SHA. DELTA: reviewers
    # saw only the delta, so the earlier fully reviewed head's findings are read too (they must still reach the Phase 8 gates);
    # the 6B.4 head-SHA and provenance gates then drop any whose cited line is gone from the current head.
    PRIMARY_SHA="$REVIEW_SHA"; EARLIER_SHA=""
    if [ "$REVIEW_MODE" = "BASE_SYNC_ONLY" ]; then
        CARRIED_FROM=$(carry_verified_from); [ -n "$CARRIED_FROM" ] && PRIMARY_SHA="$CARRIED_FROM"
    fi
    if [ "$REVIEW_MODE" = "DELTA" ] && is_sha "$DELTA_FROM"; then EARLIER_SHA="$DELTA_FROM"; fi
    SOURCE_BODIES=$(bodies_at "$PRIMARY_SHA") \
        || { echo "REVIEW_RESULT: status: BLOCKED, blocker: trusted reviewer comments unreadable (fail closed)"; exit 3; }
    # The panel guard guarantees at least one trusted reviewer body for this head; none means a misread, never "clean".
    [ -n "$SOURCE_BODIES" ] || { echo "REVIEW_RESULT: status: BLOCKED, blocker: no trusted reviewer comments for head ${PRIMARY_SHA} (fail closed)"; exit 3; }
    CARRIER_BODIES=$(agent_bodies_at "$PRIMARY_SHA")
    if [ -n "$EARLIER_SHA" ]; then
        EARLIER_BODIES=$(bodies_at "$EARLIER_SHA") && [ -n "$EARLIER_BODIES" ] \
            || { echo "REVIEW_RESULT: status: BLOCKED, blocker: earlier reviewed head ${EARLIER_SHA} findings unreadable (fail closed)"; exit 3; }
        SOURCE_BODIES=$(printf '%s\n%s' "$SOURCE_BODIES" "$EARLIER_BODIES")
        CARRIER_BODIES=$(printf '%s\n%s' "$CARRIER_BODIES" "$(agent_bodies_at "$EARLIER_SHA")")
    fi
    FINDINGS=$(printf '%s\n' "$SOURCE_BODIES" | jq -r 'scan("<!-- FINDING:([^>]+) -->") | .[0]' 2>/dev/null)

    # Carrier lookup order: raw agent bodies first (they carry the agent marker and the per-finding prose), then the source bodies.
    printf '%s\n%s\n' "$CARRIER_BODIES" "$SOURCE_BODIES" | grep -v '^$' > "$WORKDIR/carriers.jsonl" || : > "$WORKDIR/carriers.jsonl"

    RAW="$WORKDIR/raw.jsonl"; : > "$RAW"; N_EXTRACTED=0
    while IFS='|' read -r F_ID F_CONF F_SEV F_LOC F_TITLE; do
        [ -n "$F_ID" ] || continue
        N_EXTRACTED=$((N_EXTRACTED + 1))
        # file[:N[-M]] -> file, line start, line end (a non-numeric suffix stays part of the file name).
        F_FILE="$F_LOC"; L1=""; L2=""
        case "$F_LOC" in
            *:[0-9]*) _r="${F_LOC##*:}"
                case "$_r" in *[!0-9-]*|"") ;; *) F_FILE="${F_LOC%:*}"; L1="${_r%%-*}"; L2="${_r#*-}"; [ "$L2" != "$_r" ] || L2="$L1" ;; esac ;;
        esac
        case "$L1" in *[!0-9]*) L1=""; L2="" ;; esac; case "$L2" in *[!0-9]*) L2="$L1" ;; esac
        # The carrying comment: the first trusted body that holds this finding's marker.
        BODY_FILE="$WORKDIR/body.$N_EXTRACTED"
        jq -rs --arg m "<!-- FINDING:${F_ID}|" 'map(select(contains($m))) | .[0] // ""' "$WORKDIR/carriers.jsonl" > "$BODY_FILE" 2>/dev/null || : > "$BODY_FILE"
        AGENT=$(sed -n 's/^<!-- FORGE:REVIEW-AGENT:\([a-z-]*\) -->.*/\1/p' "$BODY_FILE" | head -n 1)
        # The finding's own prose section: from the first non-marker line naming the id to the next heading / marker / other finding id.
        SECTION_FILE="$WORKDIR/section.$N_EXTRACTED"
        awk -v id="$F_ID" '
            function hasid(l,   p, pre, post, rest, off) {
                rest = l; off = 0
                while ((p = index(rest, id)) > 0) {
                    pre = (off + p > 1) ? substr(l, off + p - 1, 1) : ""
                    post = substr(rest, p + length(id), 1)
                    if (pre !~ /[A-Za-z0-9-]/ && post !~ /[0-9A-Za-z]/) return 1
                    off += p; rest = substr(rest, p + 1)
                }
                return 0
            }
            /<!-- (FINDING:|REVIEW-FINDINGS)/ { if (started) exit; next }
            !started { if (hasid($0)) { started = 1; print; first = 0; n = 1 } ; next }
            { n++
              if ($0 ~ /^#/) exit
              if (match($0, /^[-*#> \t]*\**[A-Z][A-Z0-9]*-[0-9]+/) && !hasid($0)) exit
              print }' "$BODY_FILE" > "$SECTION_FILE" 2>/dev/null || : > "$SECTION_FILE"
        # Failure scenario: present / absent when the section was found, unknown when the carrying comment or section is unreadable.
        SCENARIO="unknown"
        if [ -s "$SECTION_FILE" ]; then
            SCENARIO=$(awk '
                tolower($0) ~ /\*\*failure scenario\*\*/ { s = $0; sub(/^.*\*\*[Ff]ailure [Ss]cenario\*\*[*:[:space:]]*/, "", s); gsub(/[[:space:]]/, "", s)
                    if (s != "") { print "present"; found = 1; exit } else { want = 1; next } }
                want { t = $0; gsub(/[[:space:]]/, "", t); if (t != "") { print "present"; found = 1; exit } }
                END { if (!found) print "absent" }' "$SECTION_FILE")
        fi
        FIX_EFF=$(grep -iE '^[[:space:]]*(\*\*Fix efficacy\*\*:?|FIX_EFFICACY:)[[:space:]]*\**[[:space:]]*(fails|regresses)' "$SECTION_FILE" 2>/dev/null | head -n 1 \
            | tr '[:upper:]' '[:lower:]' | sed -E 's/.*(fails|regresses).*/\1/')
        TEXT_FILE="$WORKDIR/text.$N_EXTRACTED"
        { printf '%s\n%s\n' "$F_TITLE" "$F_FILE"; cat "$SECTION_FILE" 2>/dev/null; } > "$TEXT_FILE"
        jq -n -c --arg id "$F_ID" --arg c "$F_CONF" --arg s "$F_SEV" --arg loc "$F_LOC" --arg file "$F_FILE" --arg l1 "$L1" --arg l2 "$L2" \
            --arg title "$F_TITLE" --arg agent "$AGENT" --arg scen "$SCENARIO" --arg fe "$FIX_EFF" --rawfile text "$TEXT_FILE" \
            '{id: $id, confidence: $c, severity: $s, loc: $loc, file: $file, line_start: ($l1 | tonumber? // null), line_end: ($l2 | tonumber? // null),
              title: $title, agent: $agent, scenario: $scen, fix_efficacy: $fe, text: $text}' >> "$RAW"
    done <<EOF
$FINDINGS
EOF

    # 6B: dedup by file + line range +-5 (keep the higher confidence) and by same file + 3 shared title keywords; CONFIRMED first, then
    # LIKELY, then POSSIBLE, within a group by severity. Sorting first means a kept finding is always at least as confident as a dropped one.
    DEDUPED="$WORKDIR/deduped.json"
    jq -s '
        def up: (. // "") | ascii_upcase | gsub("\\s"; "");
        def cr: (.confidence | up) as $c | if $c == "CONFIRMED" then 0 elif $c == "LIKELY" then 1 elif $c == "POSSIBLE" then 2 else 3 end;
        def sr: (.severity | up) as $s | if $s == "CRITICAL" then 0 elif $s == "HIGH" then 1 elif $s == "MEDIUM" then 2 elif $s == "LOW" then 3 else 4 end;
        def kw: (.title | ascii_downcase | [scan("[a-z0-9_]+")] | map(select(length > 3)) | unique);
        def shared($a; $b): [$a[] | select(. as $w | any($b[]; . == $w))] | length;
        to_entries | map(.value + {_i: .key}) | sort_by([cr, sr, ._i])
        | reduce .[] as $f ([];
            if any(.[]; . as $k | $k.file == $f.file and (
                   (($f.line_start != null and $k.line_start != null) and ((($k.line_start - $f.line_start) | if . < 0 then -. else . end) <= 5))
                   or (shared($f | kw; $k | kw) >= 3)))
            then . else . + [$f] end)
        | map(del(._i))' "$RAW" > "$DEDUPED" 2>/dev/null || { echo "[]" > "$DEDUPED"; }
    N_DEDUPED=$(jq 'length' "$DEDUPED")

    # 6B.4: provenance and concreteness gates (head-SHA, introduced-line, concrete-failure), in this order. Every gate fails toward keeping.
    # Paths come from the files API (raw names), never from `+++` header lines: those are quoted/tab-suffixed for special names.
    FILES_JSON="$WORKDIR/pr-files.json"
    gh api "repos/${REPO}/pulls/${PR_NUMBER}/files" --paginate > "$FILES_JSON" 2>/dev/null || : > "$FILES_JSON"
    # "path:line" for every added line; an empty file means the diff was unreadable (gates then keep every finding).
    ADDED_LINES_FILE="$WORKDIR/added-lines"
    jq -r '.[] | select(.patch != null) | "FILE\t\(.filename)", .patch' "$FILES_JSON" 2>/dev/null | awk '
        /^FILE\t/{f=substr($(0),6);next}
        /^@@/{s=$(0);sub(/^@@ -[0-9,]+ \+/,"",s);sub(/[ ,].*/,"",s);n=s+0;next}
        /^\\/{next}
        /^\+/{print f":"n;n++;next}
        /^-/{next}
        {n++}' > "$ADDED_LINES_FILE" || : > "$ADDED_LINES_FILE"
    # Files the PR deleted or renamed (the old name too): findings on them always intersect.
    GONE_FILES_FILE="$WORKDIR/gone-files"
    jq -r '.[] | select(.status=="removed" or .status=="renamed") | .filename, (.previous_filename // empty)' "$FILES_JSON" > "$GONE_FILES_FILE" 2>/dev/null || : > "$GONE_FILES_FILE"
    # Files present with no `patch` (large/truncated diff): their added lines are UNKNOWN, so findings on them are always kept.
    NOPATCH_FILES_FILE="$WORKDIR/nopatch-files"
    jq -r '.[] | select(.patch == null and .status != "removed") | .filename' "$FILES_JSON" > "$NOPATCH_FILES_FILE" 2>/dev/null || : > "$NOPATCH_FILES_FILE"
    PR_NAMES_FILE="$WORKDIR/pr-names"
    jq -r '.[] | .filename' "$FILES_JSON" > "$PR_NAMES_FILE" 2>/dev/null || : > "$PR_NAMES_FILE"

    # Line count of FILE at REVIEW_SHA: a number, ABSENT (the commit is local and the path is not in it) or UNKNOWN (a failed probe is never 0).
    file_lines_at_sha() {
        local f="$1" t="$WORKDIR/at-sha"
        if git rev-parse -q --verify "${REVIEW_SHA}^{commit}" >/dev/null 2>&1; then
            if git show "${REVIEW_SHA}:${f}" > "$t" 2>/dev/null; then awk 'END{print NR}' "$t"; return 0; fi
            if git cat-file -e "${REVIEW_SHA}:${f}" 2>/dev/null; then echo UNKNOWN; else echo ABSENT; fi
            return 0
        fi
        case "$f" in *[!A-Za-z0-9._/@+-]*|"") echo UNKNOWN; return 0 ;; esac
        if gh api -H "Accept: application/vnd.github.raw" "repos/${REPO}/contents/${f}?ref=${REVIEW_SHA}" > "$t" 2>/dev/null; then awk 'END{print NR}' "$t"; else echo UNKNOWN; fi
    }

    FINAL="$WORKDIR/final.jsonl"; : > "$FINAL"
    N_STALE=0; N_PREEXISTING=0; N_NO_SCENARIO=0; N_KEPT=0
    I=0; TOTAL=$(jq 'length' "$DEDUPED")
    while [ "$I" -lt "$TOTAL" ]; do
        F=$(jq -c ".[$I]" "$DEDUPED"); I=$((I + 1))
        FILE=$(printf '%s' "$F" | jq -r '.file'); SEV=$(upper "$(printf '%s' "$F" | jq -r '.severity')")
        LINE=$(printf '%s' "$F" | jq -r '.line_start // empty'); SCEN=$(printf '%s' "$F" | jq -r '.scenario')
        ROUTE="file"
        # Validate before any arithmetic: never expand reviewer text in $(( )).
        case "$LINE" in ""|*[!0-9]*) LINE="" ;; esac
        GONE=0; NOPATCH=0
        grep -qxF -- "$FILE" "$GONE_FILES_FILE" && GONE=1
        grep -qxF -- "$FILE" "$NOPATCH_FILES_FILE" && NOPATCH=1
        # Gate 1 (head-SHA): the cited line must exist at REVIEW_SHA. A file the PR deleted or renamed is kept (checked first).
        if [ "$GONE" -eq 0 ] && [ -n "$LINE" ]; then
            AT=$(file_lines_at_sha "$FILE")
            STALE=0
            case "$AT" in
                UNKNOWN|"") ;;
                ABSENT) if [ -s "$PR_NAMES_FILE" ] && ! grep -qxF -- "$FILE" "$PR_NAMES_FILE"; then STALE=1; fi ;;
                *[!0-9]*) ;;
                *) [ "$LINE" -gt "$AT" ] && STALE=1 ;;
            esac
            if [ "$STALE" -eq 1 ]; then N_STALE=$((N_STALE + 1)); continue; fi
        fi
        # Gate 2 (introduced-line): MEDIUM or lower with no added line within +-5 is pre-existing. CRITICAL/HIGH and unknown severities never are.
        if [ -n "$LINE" ] && [ "$GONE" -eq 0 ] && [ "$NOPATCH" -eq 0 ] && [ -s "$ADDED_LINES_FILE" ]; then
            case "$SEV" in
                MEDIUM|LOW|INFO)
                    LO=$((LINE > 5 ? LINE - 5 : 1)); INTRODUCED=0; L="$LO"
                    while [ "$L" -le $((LINE + 5)) ]; do
                        if grep -qxF -- "${FILE}:${L}" "$ADDED_LINES_FILE"; then INTRODUCED=1; break; fi
                        L=$((L + 1))
                    done
                    [ "$INTRODUCED" -eq 1 ] || ROUTE="pre-existing" ;;
            esac
        fi
        # Gate 3 (concrete failure): MEDIUM or lower without a **Failure scenario** is speculative hardening, demoted to a NOTE.
        # CRITICAL/HIGH are exempt; an unreadable carrying comment keeps the finding.
        if [ "$ROUTE" = "file" ] && [ "$SCEN" = "absent" ]; then
            case "$SEV" in MEDIUM|LOW|INFO) ROUTE="demoted-no-scenario" ;; esac
        fi
        case "$ROUTE" in pre-existing) N_PREEXISTING=$((N_PREEXISTING + 1)) ;; demoted-no-scenario) N_NO_SCENARIO=$((N_NO_SCENARIO + 1)) ;; esac
        N_KEPT=$((N_KEPT + 1))
        printf '%s' "$F" | jq -c --arg r "$ROUTE" '. + {route: $r}' >> "$FINAL"
    done

    jq -s --arg sha "$REVIEW_SHA" --arg mode "$REVIEW_MODE" --arg mi "$MERGE_ISSUE" \
        --argjson ex "$N_EXTRACTED" --argjson dd "$N_DEDUPED" --argjson st "$N_STALE" --argjson pe "$N_PREEXISTING" --argjson ns "$N_NO_SCENARIO" \
        '{schema_version: 1, review_sha: $sha, review_mode: $mode, merge_issue: ($mi | tonumber? // null),
          counts: {findings_extracted: $ex, findings_deduped: $dd, findings_dropped_stale: $st, findings_preexisting: $pe, notes_demoted_no_scenario: $ns},
          findings: .}' "$FINAL" > "$OUT_FILE" || { echo "review-finalize: cannot write $OUT_FILE" >&2; exit 2; }
    echo "FINDINGS_OUT=$OUT_FILE"
    echo "STRUCTURED_FINDINGS=$N_EXTRACTED"
    echo "FINDINGS_KEPT=$N_KEPT"
    echo "FINDINGS_DROPPED_STALE=$N_STALE"
    echo "FINDINGS_PREEXISTING=$N_PREEXISTING"
    echo "NOTES_DEMOTED_NO_SCENARIO=$N_NO_SCENARIO"
    [ "$N_EXTRACTED" -gt 0 ] || echo "CLEAN_STRUCTURED=true"   # 0 structured findings: the caller scans unstructured text, then skips to Phase 7 if still 0
    exit 0
}

# ======================================================================================================================
# classify: 6B.5 + 6B.6
# ======================================================================================================================
do_classify() {
    IN_FILE="${IN_FILE:-$OUT_DIR/findings.json}"; OUT_FILE="${OUT_FILE:-$OUT_DIR/classified.json}"
    need_findings
    case "$REVIEW_SHA" in *[!0-9a-f]*|"") echo "REVIEW_RESULT: status: BLOCKED, blocker: REVIEW_SHA is not a commit id"; exit 3 ;; esac
    CLASSIFY_SCRIPT=$(forge_resolve classify-finding.sh)
    # Fail closed (#3639): no hand classification. An unresolvable classifier ends the review here.
    if [ -z "$CLASSIFY_SCRIPT" ]; then
        echo "REVIEW_RESULT: status: BLOCKED, blocker: classifier unavailable (classify-finding.sh not resolvable through the trusted resolver)"
        exit 3
    fi
    export FORGE_REPO="$REPO" FORGE_PR="$PR_NUMBER" FORGE_ISSUE="${MERGE_ISSUE:-}" # forge#3834: classifier telemetry context
    # Per-review cap (#3642): same trusted resolver, same fail-closed rule. An unresolvable cap helper would file unbounded, so it ends the review.
    CAP_SCRIPT=$(forge_resolve cap-findings.sh)
    if [ -z "$CAP_SCRIPT" ]; then
        echo "REVIEW_RESULT: status: BLOCKED, blocker: cap helper unavailable (cap-findings.sh not resolvable through the trusted resolver)"
        exit 3
    fi
    # forge.yaml review.max_filed_findings (optional; absent = the helper default: 2, or 1 on review-finding lineage). Never validate here: the helper falls back on an invalid value.
    MAX_FILED_FINDINGS=$(yq '.review.max_filed_findings // ""' "${FORGE_CONFIG:-forge.yaml}" 2>/dev/null || echo '')
    FINDING_LINEAGE="none"
    if [ -n "${MERGE_ISSUE:-}" ] && gh issue view "$MERGE_ISSUE" -R "$REPO" --json labels --jq '.labels[].name' 2>/dev/null | grep -qx 'review-finding'; then
        FINDING_LINEAGE="review-finding"
    fi
    TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
    # In-PR fix gate (6B.6): only for an auto-merge review with a linked issue, and only for the first
    # fix round on this PR. Any trusted FORGE:INPR_FIX* marker already on the PR means the round is used.
    INPR_DIFF_FILE=""
    if [ "${AUTO_MERGE:-false}" = "true" ] && [ -n "${MERGE_ISSUE:-}" ]; then
        if [ -n "$TRUSTED_SCRIPT" ]; then INPR_MARKERS=$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null \
            | bash "$TRUSTED_SCRIPT" count '^<!-- FORGE:INPR_FIX' 2>/dev/null || echo ""); else INPR_MARKERS=""; fi
        if [ "$INPR_MARKERS" = "0" ]; then
            INPR_DIFF_FILE="$WORKDIR/inpr-diff"
            gh pr diff "$PR_NUMBER" -R "$REPO" --name-only > "$INPR_DIFF_FILE" 2>/dev/null || { rm -f "$INPR_DIFF_FILE"; INPR_DIFF_FILE=""; }
        fi
        # An unreadable marker list or diff leaves INPR_DIFF_FILE empty: findings are filed as before (never gated blind).
    fi
    # Contract-declared scope (#3447; rules in the 6B.5 bullet): `deferred -> #N` (follow-up open) and `accepted-risk:` paths become NOTEs, `not-affected`
    # never demotes, and any missing input or unverifiable deferred row leaves nothing demoted (fail toward filing).
    CONTRACT_SCOPE_FILE=""; CONTRACT_OPEN_FILE=""; PR_FILES_FILE=""; CONTRACT_DEMOTED=0
    if [ -n "${MERGE_ISSUE:-}" ]; then
        SCOPE_SCRIPT=""
        [ -n "$TRUSTED_SCRIPT" ] && [ -f "$(dirname "$TRUSTED_SCRIPT")/check-contract-scope.sh" ] && SCOPE_SCRIPT="$(dirname "$TRUSTED_SCRIPT")/check-contract-scope.sh"
        if [ -n "$SCOPE_SCRIPT" ]; then
            _scratch="$WORKDIR"
            CONTRACT_BODY_FILE="$_scratch/contract"; CONTRACT_SCOPE_FILE="$_scratch/contract-scope"; CONTRACT_OPEN_FILE="$_scratch/contract-open"; PR_FILES_FILE="$_scratch/pr-files"
            : > "$CONTRACT_BODY_FILE"; : > "$CONTRACT_SCOPE_FILE"; : > "$CONTRACT_OPEN_FILE"; : > "$PR_FILES_FILE"
            # Only a trusted author's contract counts (an untrusted comment must not suppress findings); the LAST one wins.
            gh api --paginate "repos/${REPO}/issues/${MERGE_ISSUE}/comments" 2>/dev/null \
                | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:CONTRACT -->' 2>/dev/null | tail -n 1 | jq -r . > "$CONTRACT_BODY_FILE" 2>/dev/null
            if [ -s "$CONTRACT_BODY_FILE" ] \
               && bash "$SCOPE_SCRIPT" list "$CONTRACT_BODY_FILE" > "$CONTRACT_SCOPE_FILE" 2>/dev/null \
               && [ -s "$CONTRACT_SCOPE_FILE" ] \
               && gh pr diff "$PR_NUMBER" -R "$REPO" --name-only > "$PR_FILES_FILE" 2>/dev/null; then
                # A deferred row counts only if issue N is OPEN, is an issue (not a PR), is not MERGE_ISSUE, and its body
                # carries `FORGE:DEFERRED_FROM: #<MERGE_ISSUE>` plus the row's path, and is authored by a trusted author
                # (OWNER/MEMBER/COLLABORATOR or Bot; same predicate as trusted-comments.sh; missing fields fail closed).
                # Unverified rows are dropped.
                _verified="$_scratch/contract-verified"; : > "$_verified"
                while IFS="$(printf '\t')" read -r _disp _ipath _n; do
                    if [ "$_disp" = "deferred" ]; then
                        case "$_n" in ''|*[!0-9]*) continue ;; esac
                        [ "$_n" = "${MERGE_ISSUE#\#}" ] && continue
                        gh api "repos/${REPO}/issues/$_n" 2>/dev/null \
                            | jq -e --arg m "FORGE:DEFERRED_FROM: #${MERGE_ISSUE#\#} -->" --arg p "$_ipath" \
                                '.state == "open" and .pull_request == null and ((.body // "") | contains($m) and contains($p)) and (((.author_association // "") | IN("OWNER","MEMBER","COLLABORATOR")) or ((.user.type // "") == "Bot"))' >/dev/null 2>&1 \
                            || continue
                        grep -Fxq -- "$_n" "$CONTRACT_OPEN_FILE" || echo "$_n" >> "$CONTRACT_OPEN_FILE"
                    fi
                    printf '%s\t%s\t%s\n' "$_disp" "$_ipath" "$_n" >> "$_verified"
                done < "$CONTRACT_SCOPE_FILE"
                mv "$_verified" "$CONTRACT_SCOPE_FILE"
            else
                rm -f "$CONTRACT_SCOPE_FILE" "$CONTRACT_OPEN_FILE" "$PR_FILES_FILE"; CONTRACT_SCOPE_FILE=""; CONTRACT_OPEN_FILE=""; PR_FILES_FILE=""
            fi
            rm -f "$CONTRACT_BODY_FILE"
        fi
    fi
    PRIOR_FILE=""; DIFF_MAP_FILE=""; NOTES_REFLAG=0
    # Cross-head re-flag input (#3641). Fail soft: an unreadable source only shrinks the TSV, never blocks the review.
    # PF_SKIP="<sha or empty>" PF_PRS="<pr numbers>" prior_findings_tsv prints file<TAB>line-start<TAB>line-end<TAB>title<TAB>disposition<TAB>issue# rows
    # (disposition: filed = linked issue OPEN, filed-closed = CLOSED, note = recorded NOTE_DISPOSITION with no issue, unknown = reviewer-body finding whose linkage failed, never demotes a MEDIUM CONFIRMED/LIKELY re-flag).
    # Every comment is read through scripts/trusted-comments.sh. With PF_SKIP set, that head's reviewer bodies are skipped and only NOTE_DISPOSITION records with a different `reviewed_sha=` count.
    pf_split_loc() { # PF_LOC="file[:N[-M]]" -> file<TAB>N<TAB>M (`-` sentinel when a line column is absent: a tab IFS read collapses empty fields)
        local _loc="$PF_LOC" _file _r _a="" _b=""; _file="$_loc"
        case "$_loc" in *:[0-9]*) _r="${_loc##*:}"; case "$_r" in *[!0-9-]*|"") ;; *) _file="${_loc%:*}"; _a="${_r%%-*}"; _b="${_r#*-}"; [ "$_b" != "$_r" ] || _b="$_a" ;; esac ;; esac
        printf '%s\t%s\t%s\n' "$_file" "${_a:--}" "${_b:--}"
    }
    prior_findings_tsv() {
        local pr cj rows issues _id _c _s _loc _t _p _hit _f _a _b _src _dflt
        [ -n "${TRUSTED_SCRIPT:-}" ] || return 0
        rows=$(mktemp "${_pscr}/prior-rows.XXXXXX"); issues=$(mktemp "${_pscr}/prior-issues.XXXXXX")
        for pr in $PF_PRS; do
            case "$pr" in ''|*[!0-9]*) continue ;; esac
            cj=$(gh api --paginate "repos/${REPO}/issues/${pr}/comments" 2>/dev/null) || continue
            [ -n "$cj" ] || continue
            printf '%s' "$cj" | bash "$TRUSTED_SCRIPT" bodies '^<!-- (FORGE:REVIEW-AGENT:[a-z-]+|REVIEW-FINDINGS-SYNTHESIZED-START) -->[\s\S]*(^|\n)Reviewed-SHA: [0-9a-f]{40,64}' 2>/dev/null \
                | jq -r --arg skip "${PF_SKIP:-}" 'select($skip == "" or (test("(^|\\n)Reviewed-SHA: " + $skip + "\\r?(\\n|$)") | not)) | scan("<!-- FINDING:([^>]+) -->") | .[0]' 2>/dev/null \
                | while IFS='|' read -r _id _c _s _loc _t; do
                    [ -n "$_t" ] || continue
                    _p=$(PF_LOC="$_loc" pf_split_loc); printf 'F\t%s\t%s\n' "$_p" "$(printf '%s' "$_t" | tr '\t' ' ')"
                done >> "$rows"
            printf '%s' "$cj" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:NOTE_DISPOSITION' 2>/dev/null \
                | jq -r --arg skip "${PF_SKIP:-}" 'select($skip == "" or ((capture("^<!-- FORGE:NOTE_DISPOSITION:[^>]*reviewed_sha=(?<s>[0-9a-f]{40,64})") | .s) as $s | $s != $skip)) | split("\n")[] | select(startswith("- "))' 2>/dev/null \
                | sed -n 's/^- [^ ]* \([^ ]*\) \[[A-Za-z?]*\] \(.*\): [^:]*$/\1\t\2/p' \
                | while IFS="$(printf '\t')" read -r _loc _t; do
                    [ "$_loc" != "?" ] || continue
                    _p=$(PF_LOC="$_loc" pf_split_loc); printf 'N\t%s\t%s\n' "$_p" "$_t"
                done >> "$rows"
            gh issue list -R "$REPO" --label review-finding --state all --search "${pr} in:body" --limit 100 --json number,state,title,body 2>/dev/null \
                | jq -c '.[]' >> "$issues" 2>/dev/null || true
        done
        # Linkage: a filed issue whose body names the file and whose title shares >= 3 tokens with the finding (open preferred).
        # Rows carry a leading source column (F = reviewer FINDING marker, N = NOTE_DISPOSITION record), stripped on output. An unlinked F row may
        # have been filed under a reworded title, so it is `unknown` (never demotes MEDIUM CONFIRMED/LIKELY); an unlinked N row is a true `note`.
        sort -u "$rows" | while IFS="$(printf '\t')" read -r _src _f _a _b _t; do
            [ -n "$_f" ] || continue
            [ "$_a" != "-" ] || _a=""; [ "$_b" != "-" ] || _b=""
            case "$_src" in N) _dflt=note ;; *) _dflt=unknown ;; esac
            _hit=$(jq -rs --arg f "$_f" --arg t "$_t" 'def toks: ascii_downcase | [scan("[a-z0-9]{3,}")] | unique;
                ($t | toks) as $a | [ .[] | select((.body // "") | contains($f))
                    | select((((.title // "") | toks) as $b | [$a[] | select(. as $x | $b | index($x))] | length) >= 3)
                    | {n: .number, s: (.state | ascii_downcase)} ]
                | (map(select(.s == "open")) + map(select(.s != "open"))) | .[0] // empty | "\(.s)\t\(.n)"' "$issues" 2>/dev/null) || _hit=""
            case "$_hit" in
                open*) printf '%s\t%s\t%s\t%s\tfiled\t%s\n' "$_f" "$_a" "$_b" "$_t" "${_hit#*	}" ;;
                closed*) printf '%s\t%s\t%s\t%s\tfiled-closed\t%s\n' "$_f" "$_a" "$_b" "$_t" "${_hit#*	}" ;;
                *) printf '%s\t%s\t%s\t%s\t%s\t\n' "$_f" "$_a" "$_b" "$_t" "$_dflt" ;;
            esac
        done
        rm -f "$rows" "$issues"
    }
    PRIOR_ROWS=$(PF_SKIP="$REVIEW_SHA" PF_PRS="$PR_NUMBER" prior_findings_tsv)
    if [ -n "$PRIOR_ROWS" ]; then
        PRIOR_FILE="$WORKDIR/prior-findings"; printf '%s\n' "$PRIOR_ROWS" > "$PRIOR_FILE"
        # Best-effort hunk map from the most recent prior reviewed head to this one, so a moved line still overlaps. Any failure leaves the unshifted ranges.
        PRIOR_SHA=$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null \
            | bash "$TRUSTED_SCRIPT" bodies '^<!-- (FORGE:REVIEW-AGENT:[a-z-]+|REVIEW-FINDINGS-SYNTHESIZED-START) -->[\s\S]*(^|\n)Reviewed-SHA: [0-9a-f]{40,64}' 2>/dev/null \
            | jq -r 'scan("(^|\\n)Reviewed-SHA: ([0-9a-f]{40,64})") | .[1]' 2>/dev/null | grep -vx "$REVIEW_SHA" | tail -n 1)
        _top=$(git rev-parse --show-toplevel 2>/dev/null) || _top=""
        if [ -n "$PRIOR_SHA" ] && [ -n "$_top" ]; then
            DIFF_MAP_FILE="$WORKDIR/prior-diffmap"
            { git -C "$_top" diff -U0 --no-color --no-renames "$PRIOR_SHA" "$REVIEW_SHA" 2>/dev/null || true; } | while IFS= read -r _l; do
                case "$_l" in
                    "+++ b/"*) _f="${_l#+++ b/}" ;;
                    "@@ "*) _h="${_l#@@ -}"; _o="${_h%% *}"; _n="${_h#* +}"; _n="${_n%% *}"
                        case "$_o" in *,*) _oc="${_o#*,}" ;; *) _oc=1 ;; esac; case "$_n" in *,*) _nc="${_n#*,}" ;; *) _nc=1 ;; esac
                        printf '%s\t%s\t%s\t%s\t%s\n' "$_f" "${_o%%,*}" "$_oc" "${_n%%,*}" "$_nc" ;;
                esac
            done > "$DIFF_MAP_FILE" || : > "$DIFF_MAP_FILE"
        fi
    fi

    # Per deduped finding: the classifier is called as is (§6B.5). Pre-existing findings are classified without --inpr-diff (a defect the PR did
    # not introduce is never an in-PR fix); no-scenario demotions are NOTEs and are not classified.
    CAP_ROWS_FILE="$WORKDIR/cap-rows"; : > "$CAP_ROWS_FILE"
    DISP_FILE="$WORKDIR/disp.tsv"; : > "$DISP_FILE"
    INPR_FIX_COUNT=0; INPR_FIX_IDS=""; INPR_MAX_RANK=9; INPR_MAX_SEV=""; INPR_FIX_LIST_FILE="$WORKDIR/inpr-fix-list"; : > "$INPR_FIX_LIST_FILE"
    TOTAL=$(jq '.findings | length' "$IN_FILE"); I=0
    while [ "$I" -lt "$TOTAL" ]; do
        F_ID=$(fj .id); F_SEV=$(fj .severity); F_CONF=$(fj .confidence); F_AGENT=$(fj .agent); F_FILE=$(fj .file); F_TITLE=$(fj .title)
        F_ROUTE=$(fj .route); F_FIX=$(fj .fix_efficacy); F_L1=$(fj .line_start); F_L2=$(fj .line_end); F_LOC=$(fj .loc)
        if [ "$F_ROUTE" = "demoted-no-scenario" ]; then printf '%s\t%s\n' "$I" "NOTE no-scenario" >> "$DISP_FILE"; I=$((I + 1)); continue; fi
        FINDING_TEXT_FILE="$WORKDIR/finding-text.$I"; jq -r ".findings[$I].text // \"\"" "$IN_FILE" > "$FINDING_TEXT_FILE" 2>/dev/null
        set -- --severity "$F_SEV" --confidence "$F_CONF" --agent "$F_AGENT" --lineage "$FINDING_LINEAGE" --text-file "$FINDING_TEXT_FILE"
        [ -n "$F_FILE" ] && set -- "$@" --file "$F_FILE"
        [ -n "$INPR_DIFF_FILE" ] && [ "$F_ROUTE" != "pre-existing" ] && set -- "$@" --inpr-diff "$INPR_DIFF_FILE"
        [ -n "$CONTRACT_SCOPE_FILE" ] && set -- "$@" --contract-scope "$CONTRACT_SCOPE_FILE" --contract-open "$CONTRACT_OPEN_FILE" --pr-files "$PR_FILES_FILE"
        [ -n "$MERGE_ISSUE" ] && set -- "$@" --fixes-issue "$MERGE_ISSUE"
        case "$F_FIX" in fails|regresses) set -- "$@" --fix-efficacy "$F_FIX" ;; esac
        [ -n "$PRIOR_FILE" ] && { set -- "$@" --prior-findings "$PRIOR_FILE" --title "$F_TITLE"; [ -n "$DIFF_MAP_FILE" ] && set -- "$@" --diff-map "$DIFF_MAP_FILE"; }
        [ -n "$F_L1" ] && set -- "$@" --line-start "$F_L1" --line-end "${F_L2:-$F_L1}"
        DISPOSITION=$(bash "$CLASSIFY_SCRIPT" "$@" 2>/dev/null) || DISPOSITION=""
        DISPOSITION=$(printf '%s\n' "$DISPOSITION" | head -n 1)
        # A classifier runtime failure fails toward filing, like the classifier itself (the resolution failure above is what blocks).
        case "$DISPOSITION" in ISSUE*|NOTE*|INPR_FIX*) ;; *) DISPOSITION="ISSUE classifier-error" ;; esac
        case "$DISPOSITION" in
            "NOTE contract-deferred #"*)
                _dn="${DISPOSITION##*#}"
                case "$_dn" in ''|*[!0-9]*) ;; *)
                    [ "$DRY_RUN" = "true" ] || gh issue comment "$_dn" -R "$REPO" --body "Review of #${PR_NUMBER} also found this on a path declared deferred here: ${F_LOC} ${F_TITLE}" >/dev/null 2>&1 || true # allowlist:check-command-side-effects
                ;; esac
                CONTRACT_DEMOTED=$((CONTRACT_DEMOTED + 1)) ;;
            "NOTE contract-accepted-risk"*) CONTRACT_DEMOTED=$((CONTRACT_DEMOTED + 1)) ;;
            "NOTE reflag-"*) NOTES_REFLAG=$((NOTES_REFLAG + 1)) ;;
            INPR_FIX*)
                INPR_FIX_COUNT=$((INPR_FIX_COUNT + 1)); INPR_FIX_IDS="${INPR_FIX_IDS:+$INPR_FIX_IDS,}${F_ID}"
                _rk=$(sev_rank "$F_SEV"); if [ "$_rk" -lt "$INPR_MAX_RANK" ]; then INPR_MAX_RANK="$_rk"; INPR_MAX_SEV=$(upper "$F_SEV"); fi
                _fix=$(grep -iE '(suggested fix|\*\*fix\*\*)[*]*:' "$FINDING_TEXT_FILE" 2>/dev/null | head -n 1 | sed -E 's/^.*[Ff]ix[*]*:[[:space:]]*//')
                printf -- '- %s %s: %s%s\n' "$F_ID" "$F_LOC" "$(printf '%s' "$F_TITLE" | tr '\t\n' '  ')" "${_fix:+ (fix: $_fix)}" >> "$INPR_FIX_LIST_FILE" ;;
        esac
        printf '%s\t%s\t%s\t%s\t%s\n' "$I" "$F_SEV" "$F_CONF" "$DISPOSITION" "$F_AGENT" > "$WORKDIR/row.$I"
        # Pre-existing findings are bounded separately (below) and never consume the per-review cap.
        [ "$F_ROUTE" = "pre-existing" ] || cat "$WORKDIR/row.$I" >> "$CAP_ROWS_FILE"
        printf '%s\t%s\n' "$I" "$DISPOSITION" >> "$DISP_FILE"
        I=$((I + 1))
    done

    # Per-review cap pass (#3642, MANDATORY): classify EVERY finding first; file nothing until the cap has run.
    CAP_OUT=$(bash "$CAP_SCRIPT" --lineage "$FINDING_LINEAGE" ${MAX_FILED_FINDINGS:+--cap "$MAX_FILED_FINDINGS"} --input "$CAP_ROWS_FILE" 2>/dev/null) || CAP_OUT=""
    NOTES_CAPPED=$(printf '%s\n' "$CAP_OUT" | sed -n 's/^CAPPED=//p' | tail -n 1); NOTES_CAPPED="${NOTES_CAPPED:-0}"
    CAPPED_IDS=$(printf '%s\n' "$CAP_OUT" | awk -F'\t' 'NF >= 2 && $2 == "NOTE capped" { print $1 }')   # allowlist:positional-arg
    # An id in CAPPED_IDS is a NOTE (`capped`, list it, never filed); every other row keeps the classifier disposition. A helper runtime failure
    # (empty CAP_OUT) keeps the original dispositions and NOTES_CAPPED=0 (fail toward filing; the cap is a damper, not a gate).
    [ -n "$CAP_OUT" ] || NOTES_CAPPED=0
    case "$NOTES_CAPPED" in ''|*[!0-9]*) NOTES_CAPPED=0 ;; esac
    for _cid in $CAPPED_IDS; do
        case "$_cid" in ''|*[!0-9]*) continue ;; esac
        awk -F'\t' -v k="$_cid" 'BEGIN{OFS="\t"} $1 == k { $2 = "NOTE capped" } { print }' "$DISP_FILE" > "$DISP_FILE.n" && mv "$DISP_FILE.n" "$DISP_FILE"
    done

    # Assemble the classified JSON: disposition and class per finding.
    jq --rawfile d "$DISP_FILE" '
        ($d | split("\n") | map(select(length > 0) | split("\t") | {(.[0]): .[1]}) | add // {}) as $m
        | .findings |= (to_entries | map(.value + {disposition: ($m[.key | tostring] // "")} | . + {class: (.disposition | split(" ")[0])}) )' "$IN_FILE" > "$OUT_FILE.tmp" \
        || { echo "review-finalize: cannot assemble classified JSON" >&2; exit 2; }
    # Pre-existing route: at most 3 per review, highest severity first, among those the classifier called ISSUE; the rest are listed only.
    PRE_FILED=0; PRE_IDX=$(jq -r '.findings | to_entries | map(select(.value.route == "pre-existing" and .value.class == "ISSUE")) | sort_by([(.value.severity | ascii_upcase | if . == "CRITICAL" then 0 elif . == "HIGH" then 1 elif . == "MEDIUM" then 2 else 3 end), .key]) | .[].key' "$OUT_FILE.tmp")
    PRE_KEEP=$(printf '%s\n' "$PRE_IDX" | sed -n '1,3p' | tr '\n' ' ')
    PRE_FILED=$(printf '%s\n' "$PRE_IDX" | sed -n '1,3p' | grep -c . || true)
    jq --arg keep " ${PRE_KEEP}" '
        .findings = [ .findings | to_entries[] | .key as $k | .value
            | if .route == "pre-existing" and .class == "ISSUE" then
                (if ($keep | contains(" " + ($k | tostring) + " ")) then . + {route: "file-pre-existing"}
                 else . + {disposition: "NOTE preexisting-over-cap", class: "NOTE"} end)
              else . end ]' "$OUT_FILE.tmp" > "$OUT_FILE" || { echo "review-finalize: cannot assemble classified JSON" >&2; exit 2; }
    rm -f "$OUT_FILE.tmp"

    # Counters (after the cap pass). Contract-demoted, re-flagged and capped NOTEs are counted only in their own counters.
    FINDINGS_FILED=$(jq '[.findings[] | select(.class == "ISSUE" and .route != "file-pre-existing" and .route != "pre-existing")] | length' "$OUT_FILE")
    PLAIN_NOTES=$(jq '[.findings[] | select(.class == "NOTE" and .route != "pre-existing" and (.disposition | test("^NOTE (contract-|reflag-|capped)") | not))] | length' "$OUT_FILE")
    NOTES_LISTED=$((PLAIN_NOTES - NOTES_FIXED - NOTES_DROPPED)); [ "$NOTES_LISTED" -ge 0 ] || NOTES_LISTED=0
    N_STALE=$(jq -r '.counts.findings_dropped_stale // 0' "$OUT_FILE"); N_PRE=$(jq -r '.counts.findings_preexisting // 0' "$OUT_FILE"); N_NOSCEN=$(jq -r '.counts.notes_demoted_no_scenario // 0' "$OUT_FILE")
    N_EXTRACTED=$(jq -r '.counts.findings_extracted // (.findings | length)' "$OUT_FILE")
    CLASSIFIER_MODE=script   # the guard above blocks the review when the classifier is unresolvable, so this is always script

    # NOTE list: one line per NOTE `- <id> <file:line|?> [<CONFIDENCE>] <title>: <disposition>` (the shape prior_findings_tsv parses on a later head;
    # the disposition text carries no colon so the last `: ` always splits title from disposition).
    NOTE_LIST_FILE="$OUT_DIR/note-list.txt"; : > "$NOTE_LIST_FILE"
    jq -r '.findings[] | select(.class == "NOTE" and .route != "pre-existing") |
        [.id, (if (.file // "") == "" then "?" else .loc end), ((.confidence // "") | ascii_upcase | gsub("[^A-Z]"; "") | if . == "" then "?" else . end),
         ((.title // "") | gsub("[\t\r\n]"; " ")),
         (.disposition | sub("^NOTE "; "")
            | if test("^reflag-filed #") then "tracked on #" + (capture("#(?<n>[0-9]+)").n // "?")
              elif test("^reflag-note") then "already noted on an earlier head"
              elif test("^contract-deferred #") then "tracked on #" + (capture("#(?<n>[0-9]+)").n // "?")
              elif test("^contract-accepted-risk") then "accepted-risk"
              elif . == "capped" then "capped - over review.max_filed_findings"
              else gsub(":"; " ") end)]
        | "- \(.[0]) \(.[1] | gsub(" "; "_")) [\(.[2])] \(.[3]): \(.[4])"' "$OUT_FILE" > "$NOTE_LIST_FILE" 2>/dev/null

    # Disposition marker (MANDATORY whenever Phase 6A extracted at least one finding): Phase 8 refuses to auto-merge a PR that has FINDING:
    # markers but no FORGE:NOTE_DISPOSITION comment. `reviewed_sha` is the head this record covers (a later review of ANOTHER head reads it as a prior list).
    NOTE_DISPOSITION_BODY="<!-- FORGE:NOTE_DISPOSITION: notes_fixed=${NOTES_FIXED:-0} notes_listed=${NOTES_LISTED:-0} notes_dropped=${NOTES_DROPPED:-0} findings_filed=${FINDINGS_FILED:-0} inpr_fix=${INPR_FIX_COUNT:-0} contract_demoted=${CONTRACT_DEMOTED:-0} findings_dropped_stale=${N_STALE:-0} findings_preexisting=${N_PRE:-0} notes_demoted_no_scenario=${N_NOSCEN:-0} lineage=${FINDING_LINEAGE} classifier=${CLASSIFIER_MODE} notes_reflag=${NOTES_REFLAG:-0} notes_capped=${NOTES_CAPPED:-0} reviewed_sha=${REVIEW_SHA} -->
$(cat "$NOTE_LIST_FILE" 2>/dev/null)"
    printf '%s\n' "$NOTE_DISPOSITION_BODY" > "$OUT_DIR/note-disposition.md"
    POSTED_DISPOSITION=false; POSTED_INPR=false
    if [ "$N_EXTRACTED" -gt 0 ] && [ "$DRY_RUN" != "true" ]; then
        gh pr comment "$PR_NUMBER" -R "$REPO" --body "$NOTE_DISPOSITION_BODY" >/dev/null || blocked "could not post FORGE:NOTE_DISPOSITION (fail closed)" # allowlist:check-command-side-effects
        POSTED_DISPOSITION=true
    fi
    # In-PR fix request (6B.6), after the disposition marker. Phase 8 then refuses to merge this head (`in-pr fix required`).
    if [ "$INPR_FIX_COUNT" -gt 0 ] && [ "$DRY_RUN" != "true" ]; then
        INPR_HEAD=$(gh pr view "$PR_NUMBER" -R "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null); is_sha "$INPR_HEAD" || INPR_HEAD="$REVIEW_SHA"
        gh pr comment "$PR_NUMBER" -R "$REPO" --body "<!-- FORGE:INPR_FIX: round=1 head=${INPR_HEAD} max_severity=${INPR_MAX_SEV:-MEDIUM} findings=${INPR_FIX_IDS} -->
In-PR fix requested before merge (CONFIRMED findings in files this PR changed). One fix round; anything still present on the next review is filed as an issue.
$(cat "$INPR_FIX_LIST_FILE" 2>/dev/null)" >/dev/null || blocked "could not post FORGE:INPR_FIX (fail closed)" # allowlist:check-command-side-effects
        POSTED_INPR=true
    fi
    echo "CLASSIFIED_OUT=$OUT_FILE"
    echo "NOTE_LIST=$NOTE_LIST_FILE"
    echo "FINDING_LINEAGE=$FINDING_LINEAGE"
    echo "FINDINGS_FILED=$FINDINGS_FILED"
    echo "INPR_FIX=$INPR_FIX_COUNT"
    echo "CONTRACT_DEMOTED=$CONTRACT_DEMOTED"
    echo "NOTES_REFLAG=$NOTES_REFLAG"
    echo "NOTES_CAPPED=$NOTES_CAPPED"
    echo "NOTES_LISTED=$NOTES_LISTED"
    echo "PREEXISTING_FILED=$PRE_FILED"
    echo "NOTE_DISPOSITION_POSTED=$POSTED_DISPOSITION"
    echo "INPR_FIX_POSTED=$POSTED_INPR"
    exit 0
}

# ======================================================================================================================
# file-prepare: 6C up to (not including) the issue-creation call
# ======================================================================================================================
do_file_prepare() {
    IN_FILE="${IN_FILE:-$OUT_DIR/classified.json}"; OUT_FILE="${OUT_FILE:-$OUT_DIR/worklist.json}"
    need_findings
    if [ "$DRY_RUN" != "true" ]; then
        # Colors match the canonical ForgeDock label manifest (bin/labels.json).
        gh label create "review-finding" --color "D93F0B" --description "Defect or improvement found during automated PR review. Managed by ForgeDock." --force -R "$REPO" >/dev/null 2>&1 || true
        gh label create "needs-validation" --color "FBCA04" --description "Review finding awaiting human validation. Managed by ForgeDock." --force -R "$REPO" >/dev/null 2>&1 || true
        gh label create "validated" --color "0E8A16" --description "Review finding confirmed as a real issue. Managed by ForgeDock." --force -R "$REPO" >/dev/null 2>&1 || true
        gh label create "false-positive" --color "CCCCCC" --description "Review finding dismissed as a false positive. Managed by ForgeDock." --force -R "$REPO" >/dev/null 2>&1 || true
        gh label create "pre-existing" --color "BFD4F2" --description "Defect noticed during PR review that the PR did not introduce. Managed by ForgeDock." --force -R "$REPO" >/dev/null 2>&1 || true
    fi
    BASE_BRANCH="$CTX_BASE_BRANCH"
    [ -n "$BASE_BRANCH" ] || BASE_BRANCH=$(gh pr view "$PR_NUMBER" -R "$REPO" --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "")
    # scripts/derive-finding-milestone.sh is the single source of truth for milestone derivation (also called by review-pr-staging.md, so
    # the specs cannot drift). Unresolved helper: empty milestone (non-blocking), never a cwd-relative fallback.
    DERIVE_MILESTONE_SCRIPT=$(forge_resolve derive-finding-milestone.sh)
    MILESTONE_TITLE=""
    [ -n "$DERIVE_MILESTONE_SCRIPT" ] && MILESTONE_TITLE=$(bash "$DERIVE_MILESTONE_SCRIPT" "${PR_NUMBER}" -R "${REPO}" 2>/dev/null)
    DEDUP_SCRIPT=$(forge_resolve issue-dedup.sh)
    PRIORITY_SCRIPT=$(forge_resolve severity-to-priority.sh)
    # Existing review-finding issues, read once (never per finding). An unreadable list means nothing matches (file normally).
    OPEN_JSON=$(gh issue list -R "$REPO" --state open --label "review-finding" --limit 100 --json number,title,body 2>/dev/null) || OPEN_JSON="[]"
    CLOSED_JSON=$(gh issue list -R "$REPO" --state closed --label "review-finding" --limit 100 --json number,title,body 2>/dev/null) || CLOSED_JSON="[]"
    printf '%s' "$OPEN_JSON" | jq -e 'type == "array"' >/dev/null 2>&1 || OPEN_JSON="[]"
    printf '%s' "$CLOSED_JSON" | jq -e 'type == "array"' >/dev/null 2>&1 || CLOSED_JSON="[]"
    SELF="${MERGE_ISSUE:-0}"; [[ "$SELF" =~ ^[0-9]+$ ]] || SELF=0

    # first number of the open (or closed) issue whose body cites FILE within +-5 lines of LINE (a title rule applies to open issues only)
    line_match() { # line_match <json> <file> <line> <title> <title-rule 0|1>
        printf '%s' "$1" | jq -r --arg file "$2" --argjson ln "$3" --arg title "$4" --argjson tr "$5" --argjson self "$SELF" '
            def words: ascii_downcase | split(" ") | map(select(length > 3));
            .[] | select(.number != $self) | select((.body // "") | contains($file))
            | ([(.body | split($file + ":") | .[1:][] | capture("^(?<l>[0-9]+)")? | .l | tonumber)] | .[0] // 0) as $el
            | if ($ln > 0 and $el >= ($ln - 5) and $el <= ($ln + 5)) then .number
              elif ($tr == 1 and (($title | words) as $a | (.title | words) as $b | ([$a[] | select(. as $w | any($b[]; . == $w))] | unique | length) >= 3)) then .number
              else empty end' 2>/dev/null | head -1
    }

    OUT_ITEMS="$WORKDIR/items.jsonl"; : > "$OUT_ITEMS"
    TOTAL=$(jq '.findings | length' "$IN_FILE"); I=0; N_FILE=0
    while [ "$I" -lt "$TOTAL" ]; do
        F_ROUTE=$(fj .route); F_CLASS=$(fj .class)
        case "$F_CLASS:$F_ROUTE" in ISSUE:file|ISSUE:file-pre-existing) ;; *) I=$((I + 1)); continue ;; esac
        F_ID=$(fj .id); F_FILE=$(fj .file); F_TITLE=$(fj .title); F_SEV=$(fj .severity); F_AGENT=$(fj .agent); F_LINE=$(fj .line_start)
        case "$F_LINE" in ''|*[!0-9]*) F_LINE=0 ;; esac
        ACTION="file"; DEDUP_OF=""; REGRESSION=""; NOTE=""; CONSOLIDATE="false"; PRIOR_NUMS=""; SUBSYSTEM=""; RECURRENCE=""
        # Title (defense in depth: strip command substitution so the raw title stays readable if it round-trips through an eval-based consumer).
        ISSUE_TITLE="fix: ${F_TITLE} (review finding — PR #${PR_NUMBER})"
        ISSUE_TITLE=$(printf '%s' "$ISSUE_TITLE" | tr '\t\n`' "  '" | sed 's/\$(/$ (/g')
        # Step 0: deterministic title dedup (scripts/issue-dedup.sh; also excludes the issue this PR fixes: it is about to be closed, so a
        # finding matched to it is tracked nowhere). Unresolved helper: "not deduped"; NEVER exit 1 (which means "duplicate, skip").
        if [ -n "$DEDUP_SCRIPT" ]; then
            DEDUP_RESULT=$(bash "$DEDUP_SCRIPT" "$ISSUE_TITLE" "-R $REPO" ${MERGE_ISSUE:+--exclude "$MERGE_ISSUE"} 2>&1); DEDUP_EXIT=$?
        else
            DEDUP_RESULT=""; DEDUP_EXIT=0
        fi
        if [ "$DEDUP_EXIT" -eq 1 ]; then
            ACTION="skip-dedup"; NOTE="$DEDUP_RESULT"; DEDUP_OF=$(printf '%s' "$DEDUP_RESULT" | sed -n 's/[^0-9]*\([0-9][0-9]*\).*/\1/p' | head -1)
            echo "DEDUP: Skipping — $DEDUP_RESULT"
        elif [ "$DEDUP_EXIT" -eq 2 ]; then
            ACTION="skip-usage-error"; NOTE="$DEDUP_RESULT"
            echo "DEDUP: Usage error — $DEDUP_RESULT"
        else
            # Line-range / title dedup: +-5 tolerance covers off-by-one from upstream insertions; titles are compared without the
            # constant "(review finding — PR #N)" suffix, which every review-finding title shares.
            EXISTING=""; [ -n "$F_FILE" ] && EXISTING=$(line_match "$OPEN_JSON" "$F_FILE" "$F_LINE" "$F_TITLE" 1)
            if [ -n "$EXISTING" ]; then
                ACTION="skip-dedup"; DEDUP_OF="$EXISTING"
                echo "DEDUP: Skipping — open issue #${EXISTING} already covers ${F_FILE}:${F_LINE} (range/title match)"
            else
                # A CLOSED review-finding at the same location +-5 lines is a regression: create with a warning and elevate to priority:P1.
                [ -n "$F_FILE" ] && REGRESSION=$(line_match "$CLOSED_JSON" "$F_FILE" "$F_LINE" "$F_TITLE" 0)
                [ -z "$REGRESSION" ] || echo "REGRESSION: Previously fixed in #${REGRESSION} — elevating priority"
            fi
        fi
        # priority:* is a function of Severity only (scripts/severity-to-priority.sh), never of Confidence. Unresolved or failing helper: skip
        # the finding (never defaulted to a label).
        FINDING_PRIORITY=""
        if [ -n "$PRIORITY_SCRIPT" ]; then FINDING_PRIORITY=$(bash "$PRIORITY_SCRIPT" "$F_SEV" 2>/dev/null); PRIORITY_EXIT=$?; else PRIORITY_EXIT=127; fi
        if [ "$PRIORITY_EXIT" -ne 0 ] || [ -z "$FINDING_PRIORITY" ]; then
            [ "$ACTION" = "file" ] && { ACTION="skip-priority"; NOTE="severity-to-priority.sh failed (exit $PRIORITY_EXIT) for severity '$F_SEV'"; }
            echo "PRIORITY: severity-to-priority.sh failed (exit $PRIORITY_EXIT) for severity '$F_SEV' — skipping finding issue creation"
            FINDING_PRIORITY=""
        fi
        [ -z "$REGRESSION" ] || [ -z "$FINDING_PRIORITY" ] || FINDING_PRIORITY="priority:P1"
        # Pattern recurrence (needs the FORGE:PATTERN slug the caller wrote for the finding, passed in --patterns). Exemptions are decided FIRST.
        PATTERN_SLUG=""
        [ -n "$PATTERNS" ] && [ -r "$PATTERNS" ] && PATTERN_SLUG=$(jq -r --arg id "$F_ID" '.[$id] // empty' "$PATTERNS" 2>/dev/null)
        if [ "$ACTION" != "file" ]; then RECURRENCE="not-applicable"
        elif [ -z "$PATTERN_SLUG" ]; then RECURRENCE="skipped - no pattern slug supplied"
        else
            FINDING_EXEMPT="false"
            case "$(upper "$F_SEV")" in HIGH|CRITICAL) FINDING_EXEMPT="true" ;; esac
            case "$(printf '%s' "$F_AGENT" | tr '[:upper:]' '[:lower:]')" in *security*) FINDING_EXEMPT="true" ;; esac
            [ -z "$REGRESSION" ] || FINDING_EXEMPT="true"
            case "$FINDING_PRIORITY" in priority:P0|priority:P1) FINDING_EXEMPT="true" ;; esac
            if [ "$FINDING_EXEMPT" = "true" ]; then
                RECURRENCE="exempt (severity/category/regression) - filing normally"
            elif ! [[ "$PATTERN_SLUG" =~ ^[a-z0-9-]+$ ]]; then
                RECURRENCE="skipped - invalid slug, filing normally"
            else
                # Subsystem = the directory of the finding's primary file, truncated to its first two segments.
                SUBSYSTEM=$(dirname -- "$F_FILE" | cut -d/ -f1-2)
                if [ "$SUBSYSTEM" = "." ] || ! [[ "$SUBSYSTEM" =~ ^[A-Za-z0-9._/-]+$ ]]; then
                    RECURRENCE="skipped - no valid subsystem, filing normally"; SUBSYSTEM=""
                else
                    # Narrow server-side by the exact slug tag (the slug is validated, so safe in --search), then filter in jq. Excludes class
                    # issues, false-positive findings and issues closed as not planned. Fail closed on lookup errors: file normally.
                    PRIOR=$(gh issue list -R "$REPO" --state all --label review-finding --limit 200 --search "FORGE:PATTERN: ${PATTERN_SLUG} in:body" \
                        --json number,body,labels,stateReason 2>/dev/null) || PRIOR="__LOOKUP_FAILED__"
                    if [ "$PRIOR" = "__LOOKUP_FAILED__" ] || ! printf '%s' "$PRIOR" | jq -e 'type == "array"' >/dev/null 2>&1; then
                        RECURRENCE="lookup failed - filing as a normal instance issue"
                    else
                        RECURRENCE="checked"
                        PRIOR_NUMS=$(printf '%s' "$PRIOR" | jq -r --arg slug "$PATTERN_SLUG" --arg sub "$SUBSYSTEM" --argjson self "$SELF" '
                            ($sub | gsub("\\."; "\\.")) as $esc
                            | [.[] | select(.number != $self)
                                   | select(.stateReason != "NOT_PLANNED")
                                   | select((.labels | map(.name)) as $l | (($l | index("pattern-class")) or ($l | index("false-positive"))) | not)
                                   | select(.body | contains("<!-- FORGE:PATTERN: " + $slug + " -->"))
                                   | select(.body | test("(^|[^A-Za-z0-9._-])" + $esc + "/"))
                                   | .number] | join(" ")')
                        [ -z "$PRIOR_NUMS" ] || { CONSOLIDATE="true"; echo "RECURRENCE: $PATTERN_SLUG seen before in $SUBSYSTEM (#${PRIOR_NUMS// /, #}) - consolidating"; }
                    fi
                fi
            fi
        fi
        # P3 batchable annotation: a P3 finding off security/billing paths may be grouped with other P3s by the orchestrator.
        BATCHABLE="false"
        if [ "$FINDING_PRIORITY" = "priority:P3" ]; then
            IS_SECURITY_PATH=0; IS_BILLING_PATH=0
            echo "$F_FILE" | grep -qiE 'security|billing|payment|stripe|charge|invoice' && IS_SECURITY_PATH=1
            echo "$F_TITLE" | grep -qiE 'security|billing|payment|stripe|charge|invoice' && IS_BILLING_PATH=1
            if [ "$IS_SECURITY_PATH" -eq 0 ] && [ "$IS_BILLING_PATH" -eq 0 ]; then BATCHABLE="true"; fi
        fi
        LABELS='["review-finding","needs-validation"]'
        [ "$F_ROUTE" != "file-pre-existing" ] || LABELS='["pre-existing"]'
        [ -z "$FINDING_PRIORITY" ] || LABELS=$(printf '%s' "$LABELS" | jq -c --arg p "$FINDING_PRIORITY" '. + [$p]')
        [ "$ACTION" != "file" ] || N_FILE=$((N_FILE + 1))
        jq -n -c --arg id "$F_ID" --arg action "$ACTION" --arg title "$ISSUE_TITLE" --arg file "$F_FILE" --arg line "$F_LINE" --arg sev "$(upper "$F_SEV")" \
            --arg prio "$FINDING_PRIORITY" --argjson labels "$LABELS" --arg ms "$MILESTONE_TITLE" --arg batch "$BATCHABLE" --arg dedup "$DEDUP_OF" \
            --arg reg "$REGRESSION" --arg note "$NOTE" --arg cons "$CONSOLIDATE" --arg prior "$PRIOR_NUMS" --arg sub "$SUBSYSTEM" --arg slug "$PATTERN_SLUG" \
            --arg rec "$RECURRENCE" --arg route "$F_ROUTE" --arg agent "$F_AGENT" \
            '{id: $id, action: $action, route: $route, title: $title, file: $file, line: ($line | tonumber), severity: $sev, agent: $agent, priority: $prio,
              labels: $labels, milestone: $ms, batchable: ($batch == "true"), dedup_of: ($dedup | tonumber? // null), regression_of: ($reg | tonumber? // null),
              note: $note, pattern: {slug: $slug, subsystem: $sub, consolidate: ($cons == "true"), prior: ($prior | split(" ") | map(select(length > 0) | tonumber)), recurrence: $rec}}' >> "$OUT_ITEMS"
        I=$((I + 1))
    done
    jq -s --arg ms "$MILESTONE_TITLE" --arg base "$BASE_BRANCH" --arg mi "$MERGE_ISSUE" --arg sha "$REVIEW_SHA" --argjson pr "$PR_NUMBER" --arg repo "$REPO" \
        '{schema_version: 1, pr: $pr, repo: $repo, review_sha: $sha, base_branch: $base, merge_issue: ($mi | tonumber? // null), milestone: $ms, items: .}' "$OUT_ITEMS" > "$OUT_FILE" \
        || { echo "review-finalize: cannot write $OUT_FILE" >&2; exit 2; }
    echo "WORKLIST_OUT=$OUT_FILE"
    echo "FINDINGS_TO_FILE=$N_FILE"
    echo "MILESTONE=$MILESTONE_TITLE"
    exit 0
}

case "$SUB" in
    extract) do_extract ;;
    classify) do_classify ;;
    file-prepare) do_file_prepare ;;
esac
