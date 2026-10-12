#!/usr/bin/env bash
# review-finalize.sh — deterministic review-pr Phases 6-9: finding triage and filing preparation (part A), verdict, calibration, merge gates, integrity (part B).
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
#   verdict       7A gate log + 7B base-conflict computation; posts the verdict comment when --result stale|clean|blocking is given.
#   calibrate     7B.5 calibration-table consultation (can only tighten); records FORGE:CALIBRATION_CHECK on the linked issue.
#   merge-gate    Phase 8: note-disposition, in-PR fix, --issue, phase-trail, guard-state, base-conflict / calibration / trust routing,
#                 pre-merge mergeability, previously-escalated parking, CI gate, reviewed-head guard, merge. Never skips a gate.
#   demilestone   8B / 9A: clears the milestone from open review-finding issues of a merged milestone PR.
#   integrity     Phase 9: stale-head check and the verifiable trusted REVIEW-AGENT count (carry-aware).
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
#   Phase 7-9 subcommands: --context FILE is optional; without it pass --review-sha SHA, --review-mode FULL|DELTA|BASE_SYNC_ONLY, --issue N, --base B.
#   verdict:      --merge-health S --merge-health-state S [--base B] [--head-branch H] [--is-milestone true|false] [--has-purpose-regression true|false]
#                 [--purpose-findings TEXT] [--result stale|clean|blocking] [--agents TEXT] [--findings-count N] [--blocking-count N]
#                 [--intensity-tier T] [--table-cell-key K] [--trust-shadow-mode B] [--dry-run]
#   calibrate:    [--intensity-tier T] [--table-cell-key K] [--trust-shadow-mode B] [--trust-needs-human B] [--dry-run]; the issue is context contract.issue or --issue N
#   merge-gate:   --verdict "APPROVED|CHANGES REQUESTED" --has-purpose-regression B --calibration-needs-human B --trust-needs-human B
#                 --base-conflict B --other-blocking B [--calibration-note T] [--table-cell-key K] [--base B] [--issue N]
#                 (every B is true|false; an empty or other value aborts the merge: the guard state must be bound)
#   demilestone:  --is-milestone true|false [--merge-state S] (8B passes MERGED; 9A omits it and the state is read from the PR)
# Env: FORGE_CONFIG (forge.yaml for review.max_filed_findings; default ./forge.yaml).
# Exit: 0 ok | 3 BLOCKED (REVIEW_RESULT: status: BLOCKED printed; the caller must stop the review, never skip) | 4 merge-gate only:
#       REVIEW_RESULT: status: PHASE_TRAIL_FAILED printed, followed by the verifier's MISSING lines (re-dispatch is owned by work-on/review.md R4)
#       | 1 file-verify found no issue number | 2 usage error
# merge-gate reports every non-merging routed outcome as MERGE_OUTCOME=<merged|merge-failed|parked-awaiting-merge|base-conflict|needs-human|
# protection-blocked|stale-review|ci-not-green>; everything except merged / merge-failed / parked-awaiting-merge also exits 3 with a blocker.
#
# Stdout of each subcommand is KEY=value lines (plus REVIEW_RESULT on BLOCKED). Bash 3.2 portable (no mapfile, associative arrays, grep -P).

set -u

SUB="${1:-}"
case "$SUB" in
    extract|classify|file-prepare|file-verify|verdict|calibrate|merge-gate|demilestone|integrity) shift ;;
    *) echo "usage: review-finalize.sh extract|classify|file-prepare|file-verify|verdict|calibrate|merge-gate|demilestone|integrity --pr N --repo owner/name --context FILE [options]" >&2; exit 2 ;;
esac

PR_NUMBER=""; REPO=""; CONTEXT=""; OUT_DIR=""; IN_FILE=""; OUT_FILE=""; AUTO_MERGE="false"; NOTES_FIXED=0; NOTES_DROPPED=0; PATTERNS=""; DRY_RUN="false"
REVIEW_SHA_OPT=""; REVIEW_MODE_OPT=""; BASE_OPT=""; HEAD_BRANCH=""; ISSUE_OPT=""; VERDICT=""; HAS_PURPOSE_REGRESSION=""; CALIBRATION_NEEDS_HUMAN=""; CALIBRATION_NOTE=""; TRUST_NEEDS_HUMAN=""
BASE_CONFLICT=""; OTHER_BLOCKING=""; INTENSITY_TIER=""; TABLE_CELL_KEY=""; TRUST_SHADOW_MODE=""; MERGE_HEALTH=""; MERGE_HEALTH_STATE=""; RESULT=""
AGENTS_TEXT=""; FINDINGS_COUNT=""; BLOCKING_COUNT=""; PURPOSE_FINDINGS=""; IS_MILESTONE="false"; MERGE_STATE_IN=""
while [ $# -gt 0 ]; do
    case "$1" in
        --pr|--repo|--context|--out-dir|--findings|--out|--auto-merge|--notes-fixed|--notes-dropped|--patterns|--base|--head-branch|--issue|--verdict|--has-purpose-regression|--calibration-needs-human|--calibration-note|--trust-needs-human|--base-conflict|--other-blocking|--intensity-tier|--table-cell-key|--trust-shadow-mode|--merge-health|--merge-health-state|--result|--agents|--findings-count|--blocking-count|--purpose-findings|--is-milestone|--merge-state|--review-sha|--review-mode)
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
        --review-sha) REVIEW_SHA_OPT="${2:-}"; shift 2 ;;
        --review-mode) REVIEW_MODE_OPT="${2:-}"; shift 2 ;;
        --base) BASE_OPT="${2:-}"; shift 2 ;;
        --head-branch) HEAD_BRANCH="${2:-}"; shift 2 ;;
        --issue) ISSUE_OPT="${2:-}"; shift 2 ;;
        --verdict) VERDICT="${2:-}"; shift 2 ;;
        --has-purpose-regression) HAS_PURPOSE_REGRESSION="${2:-}"; shift 2 ;;
        --calibration-needs-human) CALIBRATION_NEEDS_HUMAN="${2:-}"; shift 2 ;;
        --calibration-note) CALIBRATION_NOTE="${2:-}"; shift 2 ;;
        --trust-needs-human) TRUST_NEEDS_HUMAN="${2:-}"; shift 2 ;;
        --base-conflict) BASE_CONFLICT="${2:-}"; shift 2 ;;
        --other-blocking) OTHER_BLOCKING="${2:-}"; shift 2 ;;
        --intensity-tier) INTENSITY_TIER="${2:-}"; shift 2 ;;
        --table-cell-key) TABLE_CELL_KEY="${2:-}"; shift 2 ;;
        --trust-shadow-mode) TRUST_SHADOW_MODE="${2:-}"; shift 2 ;;
        --merge-health) MERGE_HEALTH="${2:-}"; shift 2 ;;
        --merge-health-state) MERGE_HEALTH_STATE="${2:-}"; shift 2 ;;
        --result) RESULT="${2:-}"; shift 2 ;;
        --agents) AGENTS_TEXT="${2:-}"; shift 2 ;;
        --findings-count) FINDINGS_COUNT="${2:-}"; shift 2 ;;
        --blocking-count) BLOCKING_COUNT="${2:-}"; shift 2 ;;
        --purpose-findings) PURPOSE_FINDINGS="${2:-}"; shift 2 ;;
        --is-milestone) IS_MILESTONE="${2:-false}"; shift 2 ;;
        --merge-state) MERGE_STATE_IN="${2:-}"; shift 2 ;;
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
# Phase 6 subcommands need the review-prepare context; the Phase 7-9 subcommands take it when given and otherwise run from flags
# (--review-sha, --review-mode, --issue, --base), so their spec fences stand alone.
case "$SUB" in
    extract|classify|file-prepare) [ -n "$CONTEXT" ] || { echo "review-finalize: --context FILE is required" >&2; exit 2; } ;;
esac
case "$NOTES_FIXED" in ''|*[!0-9]*) NOTES_FIXED=0 ;; esac
case "$NOTES_DROPPED" in ''|*[!0-9]*) NOTES_DROPPED=0 ;; esac
[ "$AUTO_MERGE" = "true" ] || AUTO_MERGE="false"
[ "$IS_MILESTONE" = "true" ] || IS_MILESTONE="false"
case "$RESULT" in ''|stale|clean|blocking) ;; *) echo "review-finalize: --result must be stale|clean|blocking" >&2; exit 2 ;; esac
case "$FINDINGS_COUNT" in *[!0-9]*) FINDINGS_COUNT="" ;; esac
case "$BLOCKING_COUNT" in *[!0-9]*) BLOCKING_COUNT="" ;; esac
command -v jq >/dev/null 2>&1 || { echo "review-finalize: jq is required" >&2; exit 2; }

# --- trusted helper resolution (install roots only; never cwd) ---
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; _SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)"; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" "${CLAUDE_PLUGIN_ROOT:-}" "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/* "$_SELF_ROOT"; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }

# Every fail-closed path prints the spec's marker text byte-identically, then exits 3 so the caller cannot skip it.
blocked() { echo "REVIEW_RESULT: status: BLOCKED, blocker: $1"; exit 3; }

# --- the review-prepare context (schema_version 1) ---
REVIEW_SHA="$REVIEW_SHA_OPT"; REVIEW_MODE="${REVIEW_MODE_OPT:-FULL}"; DELTA_FROM=""; MERGE_ISSUE=""; CTX_BASE_BRANCH=""
if [ -n "$CONTEXT" ]; then
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
fi
# --issue is the invoker's own --issue (never PR-author text); a non-numeric value is ignored like the context's.
case "$ISSUE_OPT" in ''|*[!0-9]*) ;; *) MERGE_ISSUE="$ISSUE_OPT" ;; esac
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
    # Match to the closing ` -->`, never `[^>]+`: a `>` or `->` inside a title must not drop the finding (#3897).
    FINDINGS=$(printf '%s\n' "$SOURCE_BODIES" | jq -r 'scan("<!-- FINDING:(.+?) -->") | .[0]' 2>/dev/null)
    # Fail closed when a raw marker did not parse: a lost finding must never read as a clean review.
    N_RAW_MARKERS=$(printf '%s\n' "$SOURCE_BODIES" | jq -r '[scan("<!-- FINDING:")] | length' 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')
    N_PARSED_MARKERS=$(printf '%s\n' "$FINDINGS" | grep -c . || true)
    [ "$N_RAW_MARKERS" -eq "$N_PARSED_MARKERS" ] \
        || { echo "REVIEW_RESULT: status: BLOCKED, blocker: ${N_RAW_MARKERS} FINDING markers but ${N_PARSED_MARKERS} parsed (malformed marker, fail closed)"; exit 3; }

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
                | jq -r --arg skip "${PF_SKIP:-}" 'select($skip == "" or (test("(^|\\n)Reviewed-SHA: " + $skip + "\\r?(\\n|$)") | not)) | scan("<!-- FINDING:(.+?) -->") | .[0]' 2>/dev/null \
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

# ======================================================================================================================
# verdict: 7A log + 7B base-conflict computation and verdict post
# ======================================================================================================================
# Computes BASE_CONFLICT (the single source of truth for "a base sync would fix this"), then posts the verdict comment when --result is
# given. gh pr review --approve fails for self-reviews, so the verdict is always a --comment review. The LLM-authored pieces (panel
# summary, finding counts, purpose-regression finding list) arrive as flags and are only ever interpolated as data.
do_verdict() {
    BASE="${BASE_OPT:-$CTX_BASE_BRANCH}"
    [ -n "$BASE" ] || BASE=$(gh pr view "$PR_NUMBER" -R "$REPO" --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "")
    HEAD="$HEAD_BRANCH"
    [ -n "$HEAD" ] || HEAD=$(gh pr view "$PR_NUMBER" -R "$REPO" --json headRefName --jq '.headRefName' 2>/dev/null || echo "")
    if [ -n "$RESULT" ]; then is_sha "$REVIEW_SHA" || blocked "REVIEW_SHA is not a commit id (pass --review-sha or --context)"; fi
    REVIEW_SHA_SHORT=$(printf '%s' "$REVIEW_SHA" | cut -c1-7)
    # 7A Step 4: the purpose-regression gate log (milestone PRs only; the judgement itself stays with the reviewer, passed as a flag).
    if [ "$IS_MILESTONE" = "true" ]; then
        if [ "$HAS_PURPOSE_REGRESSION" = "true" ]; then
            echo "PURPOSE REGRESSION GATE: BLOCKED"
            echo "Reason: ${PURPOSE_FINDINGS:-finding} contradicts milestone goal"
            echo "Verdict escalated to CHANGES REQUESTED."
        else
            echo "PURPOSE REGRESSION GATE: PASSED"
            echo "No findings contradict the milestone's stated purpose."
            echo "Verdict determined by standard blocking criteria."
        fi
    fi
    HAS_MERGE_CONFLICT=false
    BASE_CONFLICT=false
    MERGE_CONFLICT_MSG=""
    MERGE_PROTECTION_WARNING=""
    BASE_REQUIRES_UPTODATE=false
    if [ "$MERGE_HEALTH_STATE" = "BEHIND" ]; then
        # Unreadable protection (404 / 403 / no admin access) is treated as "not required": no sync, and a later failed merge lands in the existing needs-human path.
        [ "$(gh api "repos/${REPO}/branches/${BASE}/protection" --jq '.required_status_checks.strict // false' 2>/dev/null)" = "true" ] && BASE_REQUIRES_UPTODATE=true
    fi
    if [ "$MERGE_HEALTH" = "CONFLICTING" ] || [ "$MERGE_HEALTH_STATE" = "DIRTY" ] || { [ "$MERGE_HEALTH_STATE" = "BEHIND" ] && [ "$BASE_REQUIRES_UPTODATE" = "true" ]; }; then
        HAS_MERGE_CONFLICT=true
        BASE_CONFLICT=true
        MERGE_CONFLICT_MSG="Base conflict with \`${BASE}\`. Merge \`origin/${BASE}\` into \`${HEAD}\` (merge only, no rebase, no force-push), resolve the conflicting files by reading both sides, then re-run /review-pr."
    elif [ "$MERGE_HEALTH_STATE" = "BLOCKED" ]; then
        MERGE_PROTECTION_WARNING="Merge state is BLOCKED: branch protection is not satisfied (required review or check). Syncing the base cannot clear this."
    fi
    # ONLY_BASE_CONFLICT is NOT computed here: CALIBRATION_NEEDS_HUMAN and TRUST_NEEDS_HUMAN are only final at the merge gate.
    ATTRIBUTION_PR_FOOTER=$(grep -A5 "^attribution:" "${FORGE_CONFIG:-forge.yaml}" 2>/dev/null | grep "pr_footer:" | awk '{print $(2)}' | tr -d '"')
    [ -n "$ATTRIBUTION_PR_FOOTER" ] || ATTRIBUTION_PR_FOOTER="false"
    ATTRIBUTION_FOOTER_LINE=""
    if [ "$ATTRIBUTION_PR_FOOTER" = "true" ]; then
        ATTRIBUTION_FOOTER_LINE="
---
> ⚒️ Orchestrated with [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) — state, scheduling, review, and memory on GitHub."
    fi
    # Trust annotation: always included so the decision is auditable (defaults mirror Phase 3B.5).
    TRUST_ANNOTATION="**Intensity tier**: ${INTENSITY_TIER:-SHADOW} | **Cell**: \`${TABLE_CELL_KEY:-(unavailable)}\` | **Shadow mode**: ${TRUST_SHADOW_MODE:-true}"
    # A clean verdict can never be posted over a blocker this subcommand computed (criteria 3 and 4): fail closed to CHANGES REQUESTED.
    VERDICT_COERCED=false
    if [ "$RESULT" = "clean" ] && { [ "$BASE_CONFLICT" = "true" ] || [ "$HAS_PURPOSE_REGRESSION" = "true" ]; }; then
        RESULT="blocking"; VERDICT_COERCED=true
    fi
    VERDICT_OUT=""
    case "$RESULT" in
        stale) VERDICT_OUT="STALE" ;;
        clean) VERDICT_OUT="APPROVED" ;;
        blocking) VERDICT_OUT="CHANGES REQUESTED" ;;
    esac
    if [ -n "$RESULT" ] && [ "$DRY_RUN" != "true" ]; then
        PURPOSE_LINE=""; [ "$HAS_PURPOSE_REGRESSION" = "true" ] && PURPOSE_LINE="
⚠ Purpose Regression: ${BLOCKING_COUNT:-[N]} finding(s) contradict the milestone's stated goal and are automatically blocking regardless of runtime impact. See: ${PURPOSE_FINDINGS}"
        CONFLICT_LINE=""; [ "$HAS_MERGE_CONFLICT" = "true" ] && CONFLICT_LINE="
🔴 Base Conflict: ${MERGE_CONFLICT_MSG}"
        PROTECTION_LINE=""; [ -n "$MERGE_PROTECTION_WARNING" ] && PROTECTION_LINE="
⚠ ${MERGE_PROTECTION_WARNING}"
        UNKNOWN_LINE=""; [ "$MERGE_HEALTH" = "UNKNOWN" ] && UNKNOWN_LINE="
⚠ Mergeability: GitHub is still computing merge state (UNKNOWN after retries). Verify manually before merging."
        case "$RESULT" in
            stale)
                gh pr review "$PR_NUMBER" -R "$REPO" --comment --body "Review of commit $REVIEW_SHA_SHORT is stale — PR HEAD changed. Re-run /review-pr." \
                    || blocked "verdict comment could not be posted" ;;
            clean)
                gh pr review "$PR_NUMBER" -R "$REPO" --comment --body "APPROVED: commit $REVIEW_SHA_SHORT after context-aware review (${AGENTS_TEXT:-[N] agents: [names]}). ${FINDINGS_COUNT:-[M]} findings created as issues. Safe to merge.
${TRUST_ANNOTATION}${UNKNOWN_LINE}${ATTRIBUTION_FOOTER_LINE}" \
                    || blocked "verdict comment could not be posted" ;;
            blocking)
                gh pr review "$PR_NUMBER" -R "$REPO" --comment --body "CHANGES REQUESTED: commit $REVIEW_SHA_SHORT — ${BLOCKING_COUNT:-[N]} blocking issues found. See GitHub issues.
${TRUST_ANNOTATION}${CONFLICT_LINE}${PROTECTION_LINE}${PURPOSE_LINE}${ATTRIBUTION_FOOTER_LINE}" \
                    || blocked "verdict comment could not be posted" ;;
        esac
    fi
    echo "VERDICT=${VERDICT_OUT}"
    echo "VERDICT_COERCED=${VERDICT_COERCED}"
    echo "HAS_PURPOSE_REGRESSION=${HAS_PURPOSE_REGRESSION}"
    echo "HAS_MERGE_CONFLICT=${HAS_MERGE_CONFLICT}"
    echo "BASE_CONFLICT=${BASE_CONFLICT}"
    echo "MERGE_CONFLICT_MSG=${MERGE_CONFLICT_MSG}"
    echo "MERGE_PROTECTION_WARNING=${MERGE_PROTECTION_WARNING}"
    exit 0
}

# ======================================================================================================================
# calibrate: 7B.5 calibration threshold consultation
# ======================================================================================================================
# Fail-safe: ANY error reading the table yields CALIBRATION_NEEDS_HUMAN=false (static criteria stay authoritative); the table can only tighten.
do_calibrate() {
    CALIBRATION_NEEDS_HUMAN=false
    CALIBRATION_CELL=""
    CALIBRATION_NOTE=""
    ISSUE_NUMBER="${MERGE_ISSUE:-}"
    TASK_TYPE=""; CONFIDENCE=""
    if [ -n "$ISSUE_NUMBER" ]; then
        INVESTIGATOR_BODY=$(gh api "repos/${REPO}/issues/${ISSUE_NUMBER}/comments" \
            --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR"))] | last | .body // ""' 2>/dev/null || echo '')
        TASK_TYPE=$(printf '%s\n' "$INVESTIGATOR_BODY" | sed -n 's/.*\*\*Task Type\*\*: \(.*\)/\1/p' | head -1 | tr -d ' \r')
        CONFIDENCE=$(printf '%s\n' "$INVESTIGATOR_BODY" | sed -n 's/.*\*\*Confidence\*\*: \(.*\)/\1/p' | head -1 | tr -d ' \r')
        echo "Phase 7B.5: task_type=${TASK_TYPE:-unknown} confidence=${CONFIDENCE:-unknown} (from issue #${ISSUE_NUMBER})"
    fi
    if [ -n "${TASK_TYPE:-}" ] && [ -n "${CONFIDENCE:-}" ]; then
        CALIB_RAW=$(git show "origin/forge-knowledge:calibration/table.json" 2>/dev/null || echo '')
        if [ -n "$CALIB_RAW" ]; then
            CALIB_CELL=$(echo "$CALIB_RAW" | jq -r --arg tt "$TASK_TYPE" --arg c "$CONFIDENCE" \
                '.rows[] | select(.taskType == $tt and .confidence == $c and .trusted == true)' 2>/dev/null || echo '')
            if [ -n "$CALIB_CELL" ]; then
                SURVIVAL_RATE=$(echo "$CALIB_CELL" | jq -r '.survivalRate // "null"' 2>/dev/null || echo 'null')
                SAMPLE_COUNT=$(echo "$CALIB_CELL" | jq -r '.sampleCount // 0' 2>/dev/null || echo '0')
                CELL_FLAG=$(echo "$CALIB_CELL" | jq -r '.flag // "null"' 2>/dev/null || echo 'null')
                CALIBRATION_CELL="${TASK_TYPE} × ${CONFIDENCE}: survival=${SURVIVAL_RATE} (n=${SAMPLE_COUNT})"
                echo "Phase 7B.5: calibration cell found — ${CALIBRATION_CELL} flag=${CELL_FLAG}"
                if [ "$CONFIDENCE" = "HIGH" ] && [ "$CELL_FLAG" = "overconfidence" ]; then
                    CALIBRATION_NEEDS_HUMAN=true
                    CALIBRATION_NOTE="Calibration table: ${TASK_TYPE} × HIGH confidence has ${SURVIVAL_RATE} survival rate (< 0.80 threshold, n=${SAMPLE_COUNT}). Routing to needs-human per forge#1741 policy."
                    echo "Phase 7B.5: CALIBRATION_NEEDS_HUMAN=true — ${CALIBRATION_NOTE}"
                else
                    CALIBRATION_NOTE="Calibration cell: ${CALIBRATION_CELL} — within acceptable threshold"
                    echo "Phase 7B.5: CALIBRATION_NEEDS_HUMAN=false — ${CALIBRATION_NOTE}"
                fi
            else
                CALIBRATION_NOTE="Calibration cell for ${TASK_TYPE} × ${CONFIDENCE} is absent or untrusted — using static behavior"
                echo "Phase 7B.5: no trusted cell — ${CALIBRATION_NOTE}"
            fi
        else
            CALIBRATION_NOTE="forge-knowledge:calibration/table.json not found — using static behavior"
            echo "Phase 7B.5: calibration table unavailable — ${CALIBRATION_NOTE}"
        fi
    else
        CALIBRATION_NOTE="task type or confidence not resolved from FORGE:INVESTIGATOR — using static behavior"
        echo "Phase 7B.5: could not resolve task type/confidence — ${CALIBRATION_NOTE}"
    fi
    # TRAJECTORY record: the threshold decision and the cell that justified it.
    if [ -n "$ISSUE_NUMBER" ] && [ "$DRY_RUN" != "true" ]; then
        gh issue comment "${ISSUE_NUMBER}" -R "$REPO" --body "<!-- FORGE:CALIBRATION_CHECK -->
**Phase 7B.5 — Calibration Threshold Check**
**Cell**: ${CALIBRATION_CELL:-not found}
**CALIBRATION_NEEDS_HUMAN**: ${CALIBRATION_NEEDS_HUMAN}
**Note**: ${CALIBRATION_NOTE}

**Phase 3B.5 — Provenance Trust Decision**
**Intensity tier**: ${INTENSITY_TIER:-SHADOW}
**Provenance cell**: \`${TABLE_CELL_KEY:-(unavailable)}\`
**Shadow mode**: ${TRUST_SHADOW_MODE:-true}
**TRUST_NEEDS_HUMAN**: ${TRUST_NEEDS_HUMAN:-false}
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null || true
    fi
    echo "CALIBRATION_NEEDS_HUMAN=${CALIBRATION_NEEDS_HUMAN}"
    echo "CALIBRATION_CELL=${CALIBRATION_CELL}"
    echo "CALIBRATION_NOTE=${CALIBRATION_NOTE}"
    exit 0
}

# ======================================================================================================================
# merge-gate: Phase 8 (note disposition, in-PR fix, phase trail, guard state, routing, pre-merge, CI gate, merge)
# ======================================================================================================================
# Every refusal prints the REVIEW_RESULT line and exits 3 (4 for PHASE_TRAIL_FAILED, which carries the MISSING lines). A parked or
# routed outcome (base-conflict, awaiting-merge) is reported through MERGE_OUTCOME. Nothing below a failed gate ever runs.
do_merge_gate() {
    BASE="${BASE_OPT:-$CTX_BASE_BRANCH}"
    # --- note-disposition preflight: fail closed on an unreadable comment list ---
    DISPO_JSON=$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null) || DISPO_JSON=""
    if [ -z "$DISPO_JSON" ]; then
        echo "NOTE DISPOSITION: could not read PR comments — refusing to merge (fail closed)" >&2
        blocked "note disposition unreadable"
    fi
    FINDING_COUNT=$(printf '%s' "$DISPO_JSON" | jq -s '[.[][] | select(.body | test("<!-- FINDING:"))] | length' 2>/dev/null)
    TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
    if [ -z "$TRUSTED_SCRIPT" ] || [ -z "$FINDING_COUNT" ]; then
        echo "NOTE DISPOSITION: scripts/trusted-comments.sh unresolvable or findings unreadable — refusing to merge (fail closed)" >&2
        blocked "note disposition unreadable"
    fi
    DISPOSITION_COUNT=$(printf '%s' "$DISPO_JSON" | bash "$TRUSTED_SCRIPT" count '^<!-- FORGE:NOTE_DISPOSITION') || DISPOSITION_COUNT=""
    if [ -z "$DISPOSITION_COUNT" ]; then
        echo "NOTE DISPOSITION: trust filter failed — refusing to merge (fail closed)" >&2
        blocked "note disposition unreadable"
    fi
    if [ "${FINDING_COUNT:-0}" -gt 0 ] && [ "${DISPOSITION_COUNT:-0}" -eq 0 ]; then
        echo "NOTE DISPOSITION: ${FINDING_COUNT} finding comment(s) but no FORGE:NOTE_DISPOSITION record — run §6B.5 before merging" >&2
        gh pr comment "$PR_NUMBER" -R "$REPO" --body "Auto-merge skipped: review findings exist but §6B.5 note disposition was not recorded. Re-run \`/review-pr ${PR_NUMBER} --auto-merge --issue <N>\`." 2>/dev/null || true # allowlist:check-command-side-effects
        blocked "note disposition missing"
    fi
    # --- in-PR fix gate (§6B.6): an unanswered INPR_FIX request at the current head blocks the merge ---
    PR_HEAD_NOW=$(gh pr view "$PR_NUMBER" -R "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null || echo "")
    INPR_BODIES=$(printf '%s' "$DISPO_JSON" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:INPR_FIX: ') || INPR_BODIES="__ERR__"
    INPR_WAIVED=$(printf '%s' "$DISPO_JSON" | bash "$TRUSTED_SCRIPT" count "^<!-- FORGE:INPR_FIX_WAIVED: head=${PR_HEAD_NOW}") || INPR_WAIVED=""
    if [ "$INPR_BODIES" = "__ERR__" ] || [ -z "$INPR_WAIVED" ]; then
        echo "IN-PR FIX: trust filter failed — refusing to merge (fail closed)" >&2
        blocked "note disposition unreadable"
    fi
    # Latest trusted request wins (bodies are JSON strings, one per line).
    INPR_REQ=$(printf '%s\n' "$INPR_BODIES" | tail -n 1 | jq -r 'capture("head=(?<h>[0-9a-f]{7,40})").h // ""' 2>/dev/null || echo "")
    if [ -n "$INPR_REQ" ] && [ "$INPR_REQ" = "$PR_HEAD_NOW" ] && [ "${INPR_WAIVED:-0}" -eq 0 ]; then
        echo "IN-PR FIX: CONFIRMED findings in this PR's files were requested at head ${PR_HEAD_NOW} — fix them before merging (§6B.6)" >&2
        # Not needs-human: /work-on R4 runs one fix round.
        blocked "in-pr fix required"
    fi

    # --- phase-trail preflight: a reviewer verdict alone must not merge work whose earlier phases were skipped ---
    if [ -z "${MERGE_ISSUE:-}" ]; then
        echo "PHASE TRAIL: auto-merge requested without --issue — the issue is never inferred from PR-author-controlled text, so the phase trail cannot be verified; refusing to merge (fail closed)" >&2
        gh pr comment "$PR_NUMBER" -R "$REPO" --body "Auto-merge skipped: no --issue was given, so the phase trail cannot be verified. Re-run \`/review-pr ${PR_NUMBER} --auto-merge --issue <N>\` or merge manually." 2>/dev/null || true # allowlist:check-command-side-effects
        # Not a PHASE_TRAIL_FAILED (nothing to re-run).
        blocked "auto-merge requires --issue"
    fi
    TRAIL_SCRIPT=$(forge_resolve verify-phase-trail.sh); DOCS_ONLY_SCRIPT=$(forge_resolve is-docs-only.sh)
    # Docs-only predicate: ONE shared copy (scripts/is-docs-only.sh). Fail closed: unresolved script or empty diff -> no flag.
    DOCS_ONLY_FLAG=""
    # Both sides of a rename (filename + previous_filename): `gh pr diff --name-only` collapses a rename to its destination.
    PR_FILES_ALL=$(gh api --paginate "repos/${REPO}/pulls/${PR_NUMBER}/files" --jq '.[] | .filename, (.previous_filename // empty)' 2>/dev/null) || PR_FILES_ALL=""
    # Fail closed on truncation: the files API caps at 3000 files, so a PR at/over the cap (or an unreadable count) never yields a docs-only flag.
    PR_CHANGED_N=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq .changed_files 2>/dev/null) || PR_CHANGED_N=""
    case "$PR_CHANGED_N" in ''|*[!0-9]*) PR_FILES_ALL="" ;; *) [ "$PR_CHANGED_N" -ge 3000 ] && PR_FILES_ALL="" ;; esac
    if [ -n "$PR_FILES_ALL" ] && [ -n "$DOCS_ONLY_SCRIPT" ] && echo "$PR_FILES_ALL" | bash "$DOCS_ONLY_SCRIPT"; then DOCS_ONLY_FLAG="--docs-only"; fi
    # Band cross-check: a non-docs PR diff means an agent-chosen INVESTIGATION band must not waive requirements. Anything not positively docs-only is a code diff.
    CODE_DIFF_FLAG="--code-diff"
    if [ -n "$DOCS_ONLY_FLAG" ]; then CODE_DIFF_FLAG=""; fi
    OVERRIDE_BOUND_HEAD=""
    if [ -z "$TRAIL_SCRIPT" ]; then
        # Fail closed: an unresolvable verifier is NOT a pass (never fall back to the consumer repo).
        echo "PHASE TRAIL: verify-phase-trail.sh not resolvable (set FORGEDOCK_HOME to the ForgeDock install) — refusing to merge" >&2
        TRAIL="PHASE_TRAIL: ERROR (verifier not resolvable)"; TRAIL_RC=127
    else
        # Bind the human break-glass override to the PR head. An unreadable head omits the flag, so no override is offered (fails closed).
        PR_HEAD_SHA=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq .head.sha 2>/dev/null) || PR_HEAD_SHA=""
        HEAD_SHA_ARGS=()
        if [[ "$PR_HEAD_SHA" =~ ^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$ ]]; then HEAD_SHA_ARGS=(--head-sha "$PR_HEAD_SHA"); fi
        TRAIL=$(bash "$TRAIL_SCRIPT" "$MERGE_ISSUE" -R "$REPO" $DOCS_ONLY_FLAG $CODE_DIFF_FLAG ${HEAD_SHA_ARGS[@]+"${HEAD_SHA_ARGS[@]}"}); TRAIL_RC=$?
        if [ "$TRAIL_RC" -eq 0 ]; then
            # An `OVERRIDE:` line means the verifier accepted a human override. Record it from the verifier's output (never agent prose).
            OVR=$(printf '%s\n' "$TRAIL" | sed -n 's/^OVERRIDE: //p' | sed -n '1p')
            if [ -n "$OVR" ]; then
                OVERRIDE_BOUND_HEAD="$PR_HEAD_SHA"   # the merge below must land exactly this commit
                gh pr comment "$PR_NUMBER" -R "$REPO" --body "$(printf '<!-- FORGE:PHASE_TRAIL_OVERRIDE_APPLIED -->\nThe phase-trail gate was waived by a human break-glass override.\n\n%s\n%s\n%s\n' '```' "$OVR" '```')" # <!-- allowlist:check-command-side-effects -->
            fi
        fi
    fi
    if [ "$TRAIL_RC" -ge 2 ]; then
        # rc 2 (trail unreadable) / 127 (verifier not resolvable) is an infrastructure failure, NOT missing phases: never report PHASE_TRAIL_FAILED here.
        TRAIL_ERR_BODY="<!-- FORGE:PHASE_TRAIL_ERROR -->
Auto-merge refused for PR #${PR_NUMBER}: the phase-trail verifier could not run (rc=${TRAIL_RC}). This is an infrastructure problem, not a missing phase. Do not re-run phases.

\`\`\`
${TRAIL}
\`\`\`

Fix the cause (gh auth/API outage, \`FORGE_TRAIL_QG_SINCE\`/runner clock, or set \`FORGEDOCK_HOME\` when the verifier is unresolvable), then re-run /review-pr."
        gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "$TRAIL_ERR_BODY" # <!-- allowlist:check-command-side-effects -->
        # Nothing can resume this automatically, so park it for a human instead of leaving workflow:in-review.
        gh issue edit "$MERGE_ISSUE" -R "$REPO" --add-label "needs-human" 2>/dev/null || true # <!-- allowlist:check-command-side-effects -->
        # The PR stays open and unmerged; callers must NOT fall back to a manual merge.
        blocked "phase trail unreadable (rc=${TRAIL_RC})"
    elif [ "$TRAIL_RC" -ne 0 ]; then
        TRAIL_FAIL_BODY="<!-- FORGE:PHASE_TRAIL_FAILED -->
Auto-merge refused for PR #${PR_NUMBER}: the issue's phase trail is incomplete.

\`\`\`
${TRAIL}
\`\`\`

Re-run each missing phase via its Skill (see the \`->\` action on each MISSING line), then re-run /review-pr."
        gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "$TRAIL_FAIL_BODY" # <!-- allowlist:check-command-side-effects -->
        # rc 1 only; the work-on review phase (work-on/review.md R4) is the single owner of re-dispatching the named phases. Not an immediate needs-human escalation.
        echo "REVIEW_RESULT: status: PHASE_TRAIL_FAILED"
        printf '%s\n' "$TRAIL"
        exit 4
    fi
    [ "${TRAIL_RC:-1}" -eq 0 ] || blocked "phase trail unreadable (rc=${TRAIL_RC:-1})"   # hard guard: nothing below runs unless the trail verified

    # --- merge guard state: §7B verdict + purpose-regression + calibration + trust-escalation ---
    # These are decided in earlier steps (earlier shells), so they arrive as flags. An empty or unbound value would read as
    # "not blocking" and fall through to the merge path, so any value outside the expected set stops here instead of merging.
    [ "$VERDICT" = "APPROVE" ] && VERDICT="APPROVED"
    GUARD_STATE_OK=true
    case "$VERDICT" in "APPROVED"|"CHANGES REQUESTED") ;; *) GUARD_STATE_OK=false ;; esac
    for _guard_val in "$HAS_PURPOSE_REGRESSION" "$CALIBRATION_NEEDS_HUMAN" "$TRUST_NEEDS_HUMAN" "$BASE_CONFLICT" "$OTHER_BLOCKING"; do
        case "$_guard_val" in true|false) ;; *) GUARD_STATE_OK=false ;; esac
    done
    if [ "$GUARD_STATE_OK" != "true" ]; then
        gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "⛔ Auto-merge aborted for PR #${PR_NUMBER}: the Phase 8 merge guard state is unbound (VERDICT='${VERDICT}', HAS_PURPOSE_REGRESSION='${HAS_PURPOSE_REGRESSION}', CALIBRATION_NEEDS_HUMAN='${CALIBRATION_NEEDS_HUMAN}', TRUST_NEEDS_HUMAN='${TRUST_NEEDS_HUMAN}', BASE_CONFLICT='${BASE_CONFLICT}', OTHER_BLOCKING='${OTHER_BLOCKING}'). Not merging; re-run /review-pr." # <!-- allowlist:check-command-side-effects -->
        gh issue edit "$MERGE_ISSUE" -R "$REPO" --add-label "needs-human" 2>/dev/null || true # <!-- allowlist:check-command-side-effects -->
        blocked "merge guard state unbound"
    fi
    # ONLY_BASE_CONFLICT: the base conflict is the ONLY reason for CHANGES REQUESTED, evaluated after every human gate is set.
    ONLY_BASE_CONFLICT=false
    if [ "$BASE_CONFLICT" = "true" ] && [ "$OTHER_BLOCKING" != "true" ] && [ "$HAS_PURPOSE_REGRESSION" != "true" ] && [ "$CALIBRATION_NEEDS_HUMAN" != "true" ] && [ "$TRUST_NEEDS_HUMAN" != "true" ]; then
        ONLY_BASE_CONFLICT=true
    fi
    if [ "$ONLY_BASE_CONFLICT" = "true" ] && [ "$VERDICT" = "CHANGES REQUESTED" ]; then
        # Pure base conflict: route to the base-sync path, NOT needs-human. A standalone /review-pr caller just sees the blocker.
        gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "⛔ Auto-merge aborted for PR #${PR_NUMBER}: base conflict with \`${BASE}\` (the only blocking reason). No operator action is needed: the pipeline is performing the base sync automatically (merging \`origin/${BASE}\` into the PR branch, merge only, no rebase, no force-push), re-running the quality gate, then re-reviewing the new head. A human is pulled in only if the conflict cannot be resolved automatically." # <!-- allowlist:check-command-side-effects -->
        echo "MERGE_OUTCOME=base-conflict"
        blocked "base-conflict"
    elif [ "$VERDICT" = "CHANGES REQUESTED" ] || [ "$HAS_PURPOSE_REGRESSION" = "true" ] || [ "$CALIBRATION_NEEDS_HUMAN" = "true" ] || [ "$TRUST_NEEDS_HUMAN" = "true" ]; then
        BLOCK_REASON=""
        [ "$VERDICT" = "CHANGES REQUESTED" ] && BLOCK_REASON="review verdict is CHANGES REQUESTED (blocking finding confirmed by Phase 7B)"
        [ "$HAS_PURPOSE_REGRESSION" = "true" ] && BLOCK_REASON="${BLOCK_REASON:+${BLOCK_REASON}; }purpose regression detected by Phase 7A (\`HAS_PURPOSE_REGRESSION=true\`)"
        [ "$CALIBRATION_NEEDS_HUMAN" = "true" ] && BLOCK_REASON="${BLOCK_REASON:+${BLOCK_REASON}; }calibration threshold: ${CALIBRATION_NOTE}"
        [ "$TRUST_NEEDS_HUMAN" = "true" ] && BLOCK_REASON="${BLOCK_REASON:+${BLOCK_REASON}; }provenance trust: NOVEL_NEEDS_HUMAN tier for cell \`${TABLE_CELL_KEY}\` — no sufficient prior data (forge#1745)"
        gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "⛔ Auto-merge aborted for PR #${PR_NUMBER}: ${BLOCK_REASON}. Manual review required before merging."
        gh issue edit "$MERGE_ISSUE" -R "$REPO" --add-label "needs-human" 2>/dev/null || true
        echo "MERGE_OUTCOME=needs-human"
        blocked "auto-merge blocked: ${BLOCK_REASON}"
    fi

    # --- pre-merge mergeability guard: re-fetch fresh state (the base may have moved while the review ran) ---
    PRE_MERGE_RESULT=$(gh pr view "$PR_NUMBER" -R "$REPO" --json mergeable,mergeStateStatus --jq '"\(.mergeable)|\(.mergeStateStatus)"')
    PRE_MERGE_HEALTH=${PRE_MERGE_RESULT%%|*}
    PRE_MERGE_HEALTH_STATE=${PRE_MERGE_RESULT##*|}
    PRE_MERGE_BASE_CONFLICT=false
    if [ "$PRE_MERGE_HEALTH" = "CONFLICTING" ] || [ "$PRE_MERGE_HEALTH_STATE" = "DIRTY" ]; then
        PRE_MERGE_BASE_CONFLICT=true
    elif [ "$PRE_MERGE_HEALTH_STATE" = "BEHIND" ]; then
        # BEHIND is a conflict only under required-up-to-date protection; unreadable protection counts as "not required".
        [ "$(gh api "repos/${REPO}/branches/${BASE}/protection" --jq '.required_status_checks.strict // false' 2>/dev/null)" = "true" ] && PRE_MERGE_BASE_CONFLICT=true
    fi
    if [ "$PRE_MERGE_BASE_CONFLICT" = "true" ]; then
        # Base moved during review: route to the base-sync path, NOT needs-human.
        gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "⛔ Auto-merge aborted for PR #${PR_NUMBER}: base conflict (\`mergeable=${PRE_MERGE_HEALTH}\`, \`mergeStateStatus=${PRE_MERGE_HEALTH_STATE}\`). No operator action is needed: the pipeline is performing the base sync automatically (merging \`origin/${BASE}\` into the PR branch, merge only, no rebase, no force-push) and then re-reviewing. A human is pulled in only if the conflict cannot be resolved automatically." # <!-- allowlist:check-command-side-effects -->
        echo "MERGE_OUTCOME=base-conflict"
        blocked "base-conflict"
    elif [ "$PRE_MERGE_HEALTH_STATE" = "BLOCKED" ]; then
        # Branch protection not satisfied: syncing the base cannot clear it, so this is NOT a base-conflict blocker.
        gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "⛔ Auto-merge aborted for PR #${PR_NUMBER}: branch protection is not satisfied (\`mergeStateStatus=BLOCKED\`); syncing the base cannot clear it. Satisfy the required review/checks, then re-run /review-pr."
        gh issue edit "$MERGE_ISSUE" -R "$REPO" --add-label "needs-human" 2>/dev/null || true
        echo "MERGE_OUTCOME=protection-blocked"
        blocked "branch protection not satisfied"
    fi

    # --- previously-escalated re-review guard (base-scoped): park at awaiting-merge, never merge here ---
    PREVIOUSLY_ESCALATED=$(gh issue view "$MERGE_ISSUE" -R "$REPO" --json labels,comments \
        --jq '([.labels[].name | . == "needs-human" or . == "workflow:remediating"] + [.comments[].body | contains("FORGE:REMEDIATION")]) | any' 2>/dev/null || echo "false")
    GUARD_BASE=$(gh pr view "$PR_NUMBER" -R "$REPO" --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "")
    if [ "$PREVIOUSLY_ESCALATED" = "true" ]; then
        # `jq -r '.baseRefName'` stringifies a JSON null to the text "null": the resolver treats that like an unresolved base (strict).
        GATE_SCRIPT=$(forge_resolve resolve-deploy-gate.sh)
        if [ -n "$GATE_SCRIPT" ]; then GUARD_GATE=$(bash "$GATE_SCRIPT" "$GUARD_BASE" "$REPO" 2>/dev/null || echo true); else GUARD_GATE=true; fi; [ "$GUARD_GATE" = "false" ] || GUARD_GATE=true
        if [ "$GUARD_GATE" = "false" ]; then
            gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "🟠 PR #${PR_NUMBER} was previously escalated (\`needs-human\`) and has now been re-reviewed to \`${VERDICT:-APPROVED}\` with a clean mergeability check on non-default-branch base \`${GUARD_BASE}\`. It is parked at \`workflow:awaiting-merge\` for the remediation auto-land bar (\`remediate.md\` Phase M7, forge#2570) — which auto-merges it on the same fast-lane condition the normal \`/work-on\` path uses for this target branch — NOT for a human merge decision. If no remediation \`M7\` follows (e.g. this review was invoked standalone), merge manually once reviewed: \`gh pr merge ${PR_NUMBER} -R ${REPO} --merge\`."
        else
            gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "🟠 PR #${PR_NUMBER} was previously escalated (\`needs-human\`) and has now been re-reviewed to \`${VERDICT:-APPROVED}\` with a clean mergeability check. This PR targets the deploy gate (\`${GUARD_BASE:-unresolved base}\`), so it is held at \`workflow:awaiting-merge\` for a human merge decision — \`staging → main\` is the genuine human gate. Merge manually once reviewed: \`gh pr merge ${PR_NUMBER} -R ${REPO} --merge\`."
        fi
        # transition-label.sh: install roots only. Unresolvable falls through to the prose label edit so the transition is never silently skipped.
        TRANSITION_SCRIPT=$(forge_resolve transition-label.sh)
        if [ -n "$TRANSITION_SCRIPT" ]; then
            bash "$TRANSITION_SCRIPT" "$MERGE_ISSUE" -R "$REPO" awaiting-merge
        else
            gh issue edit "$MERGE_ISSUE" -R "$REPO" --add-label "workflow:awaiting-merge" \
                --remove-label "needs-human,workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:remediating,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true
        fi
        # Do not merge here: a human decides for a deploy-gate base, remediate.md Phase M7's auto-land bar for any other base.
        echo "MERGE_OUTCOME=parked-awaiting-merge"
        echo "GUARD_GATE=${GUARD_GATE}"
        exit 0
    fi

    # --- CI gate (MANDATORY before any autonomous merge): merge only when every check on the PR is green ---
    CI_GATE_SCRIPT=$(forge_resolve wait-ci-green.sh)
    if [ -n "$CI_GATE_SCRIPT" ]; then CI_GATE_OUT=$(bash "$CI_GATE_SCRIPT" "$PR_NUMBER" -R "$REPO"); CI_GATE_RC=$?
    else CI_GATE_OUT="CI_GATE: ERROR — scripts/wait-ci-green.sh not resolvable (fail closed)"; CI_GATE_RC=2; fi
    echo "$CI_GATE_OUT"
    GATED_HEAD=$(printf '%s\n' "$CI_GATE_OUT" | sed -n 's/^CI_GATE_HEAD: //p' | head -1)
    # rc 2 "head moved" is a stale review, not a human problem; rc 3 TIMEOUT means CI is still running.
    printf '%s\n' "$CI_GATE_OUT" | grep -q 'PR head moved during the wait' && CI_GATE_RC=4
    if [ "$CI_GATE_RC" -eq 3 ]; then
        echo "CI_GATE_TIMEOUT: CI still running — re-run this subcommand (up to 3 more times) before treating it as a failure."
    fi
    # Reviewed-head guard: merge only the exact commit this review approved. REVIEWED_SHORT is re-derived from this review's
    # FORGE:REVIEW_ROUTE marker, never assumed. A docs-only delta (this review's own §6B.5 note fixes) is allowed; any other change is stale.
    REVIEWED_SHORT=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" --paginate --jq '.[] | select(.body | contains("FORGE:REVIEW_ROUTE")) | .body' 2>/dev/null \
        | sed -n 's/.*FORGE:REVIEW_ROUTE[^>]* sha=\([0-9a-f]\{7,\}\).*/\1/p' | tail -1)
    if [ "$CI_GATE_RC" -eq 0 ]; then
        if [ -z "$REVIEWED_SHORT" ] || [ -z "$GATED_HEAD" ] || [ "$GATED_HEAD" = "unknown" ]; then
            CI_GATE_RC=4; CI_GATE_OUT="STALE_REVIEW: cannot bind the merge to a reviewed commit (route sha='${REVIEWED_SHORT}', gated head='${GATED_HEAD}')"
        elif [ "${GATED_HEAD#"$REVIEWED_SHORT"}" = "$GATED_HEAD" ]; then
            REVIEW_BASE_SHA=$(gh api "repos/${REPO}/commits/${REVIEWED_SHORT}" --jq '.sha' 2>/dev/null)
            POST_REVIEW_FILES=$(gh api "repos/${REPO}/compare/${REVIEW_BASE_SHA:-$REVIEWED_SHORT}...${GATED_HEAD}" --jq '.files[] | .filename, (.previous_filename // empty)' 2>/dev/null)
            if [ -n "$POST_REVIEW_FILES" ] && [ -n "$DOCS_ONLY_SCRIPT" ] && printf '%s\n' "$POST_REVIEW_FILES" | bash "$DOCS_ONLY_SCRIPT"; then
                echo "Post-review commits are docs-only (note fixes) — reviewed code unchanged."
            else
                CI_GATE_RC=4; CI_GATE_OUT="STALE_REVIEW: PR head ${GATED_HEAD:0:7} is not the reviewed commit ${REVIEWED_SHORT} and the delta is not docs-only"
            fi
        fi
    fi
    # An accepted break-glass override is bound to one exact head: a push after the verifier ran (even a docs-only one) is not covered.
    if [ "$CI_GATE_RC" -eq 0 ] && [ -n "${OVERRIDE_BOUND_HEAD:-}" ] && [ "$GATED_HEAD" != "$OVERRIDE_BOUND_HEAD" ]; then
        CI_GATE_RC=4; CI_GATE_OUT="STALE_REVIEW: break-glass override was bound to ${OVERRIDE_BOUND_HEAD:0:7} but the gated head is ${GATED_HEAD:0:7}"
    fi
    if [ "$CI_GATE_RC" -eq 4 ]; then
        # Not a human problem: the caller re-runs /review-pr on the new head (work-on/review.md R4).
        echo "MERGE_OUTCOME=stale-review"
        blocked "stale review — ${CI_GATE_OUT}; re-run /review-pr on the new head"
    elif [ "$CI_GATE_RC" -ne 0 ]; then
        CI_MSG="⛔ Auto-merge refused for PR #${PR_NUMBER}: CI is not green (ci gate rc=${CI_GATE_RC}). The PR stays open; fix the failing checks on its branch (remediation treats this as FIXABLE) or re-run flaky ones.
\`\`\`
${CI_GATE_OUT}
\`\`\`"
        gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "$CI_MSG" 2>/dev/null || true # allowlist:check-command-side-effects
        gh issue edit "$MERGE_ISSUE" -R "$REPO" --add-label "needs-human" 2>/dev/null || true # allowlist:check-command-side-effects
        echo "MERGE_OUTCOME=ci-not-green"
        blocked "ci gate not green (rc=${CI_GATE_RC})"
    fi

    # --- merge exactly the commit the CI gate (and the reviewed-head guard) checked ---
    gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "Review complete for PR #${PR_NUMBER}. Verdict: ${VERDICT:-APPROVED}. CI green. Proceeding to merge."
    gh pr merge "$PR_NUMBER" -R "$REPO" --merge --match-head-commit "$GATED_HEAD"
    MERGE_STATE=$(gh pr view "$PR_NUMBER" -R "$REPO" --json state --jq '.state')
    if [ "$MERGE_STATE" != "MERGED" ]; then
        gh issue comment "$MERGE_ISSUE" -R "$REPO" --body "PR #${PR_NUMBER} merge failed. State: $MERGE_STATE."
        echo "MERGE_OUTCOME=merge-failed"
    else
        echo "MERGE_OUTCOME=merged"
    fi
    echo "MERGE_STATE=${MERGE_STATE}"
    echo "MERGED_HEAD=${GATED_HEAD}"
    exit 0
}

# ======================================================================================================================
# demilestone: 8B (merge just happened) and 9A (manual-merge fallback) review-finding demilestoning
# ======================================================================================================================
# With --merge-state the caller reports the state it just observed (8B: only MERGED runs); without it the state is read from the PR (9A).
do_demilestone() {
    [ "$IS_MILESTONE" = "true" ] || { echo "DEMILESTONED=0"; exit 0; }
    if [ -z "$MERGE_STATE_IN" ]; then MERGE_STATE_IN=$(gh pr view "$PR_NUMBER" -R "$REPO" --json state --jq '.state' 2>/dev/null || echo ""); fi
    [ "$MERGE_STATE_IN" = "MERGED" ] || { echo "DEMILESTONED=0"; exit 0; }
    echo "Phase 8B/9A: Clearing milestone from open review-finding issues referencing PR #${PR_NUMBER}..."
    # The title template in Phase 6C always includes: "review finding — PR #${PR_NUMBER}"
    FINDINGS_TO_DEMILESTONE=$(gh issue list -R "${REPO}" \
        --state open \
        --label "review-finding" \
        --limit 200 \
        --json number,title,milestone \
        --jq ".[] | select(.milestone != null) | select(.title | test(\"PR #${PR_NUMBER}\")) | .number" \
        2>/dev/null || echo "")
    MOVED_COUNT=0
    if [ -z "$FINDINGS_TO_DEMILESTONE" ]; then
        echo "Phase 8B/9A: No open review-finding issues with milestones found referencing PR #${PR_NUMBER} (already cleared or none created)."
    else
        for FINDING_NUM in $FINDINGS_TO_DEMILESTONE; do
            case "$FINDING_NUM" in ''|*[!0-9]*) continue ;; esac
            FINDING_TITLE=$(gh issue view "$FINDING_NUM" -R "${REPO}" --json title --jq '.title' 2>/dev/null || echo "#${FINDING_NUM}")
            if gh issue edit "$FINDING_NUM" -R "${REPO}" --milestone "" 2>/dev/null; then
                echo "  Moved to fast lane: #${FINDING_NUM} — ${FINDING_TITLE}"
                MOVED_COUNT=$((MOVED_COUNT + 1))
            else
                echo "  WARNING: Failed to clear milestone for #${FINDING_NUM}"
            fi
        done
        echo "Phase 8B/9A: Review finding demilestoning complete."
    fi
    echo "DEMILESTONED=${MOVED_COUNT}"
    exit 0
}

# ======================================================================================================================
# integrity: Phase 9 stale check and verifiable agent count
# ======================================================================================================================
do_integrity() {
    is_sha "$REVIEW_SHA" || blocked "REVIEW_SHA is not a commit id (pass --review-sha or --context)"
    CURRENT_SHA=$(gh pr view "$PR_NUMBER" -R "$REPO" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
    REVIEW_IS_STALE="false"
    # An unreadable head is stale (fail closed): the summary must never claim CURRENT without having read the head.
    if [ -z "$CURRENT_SHA" ] || [ "$CURRENT_SHA" != "$REVIEW_SHA" ]; then REVIEW_IS_STALE="true"; fi
    # Same trust rule as Phase 3C/4: only trusted comments whose body starts with the marker count.
    TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
    REVIEW_DELTA_SCRIPT=$(forge_resolve review-delta.sh)
    BASE_BRANCH="${BASE_OPT:-$CTX_BASE_BRANCH}"
    [ -n "$BASE_BRANCH" ] || BASE_BRANCH=$(gh pr view "$PR_NUMBER" -R "$REPO" --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "")
    COMMENTS_JSON=$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null || echo "")
    _dm=$(forge_resolve lib/review-delta-mode.sh); [ -n "$_dm" ] && . "$_dm" || { review_delta_mode() { echo "FULL - 0"; }; carry_verified_from() { :; }; }
    # BASE_SYNC_ONLY: zero reviewers is the expected panel only when the carry record is trusted and the resolver re-verifies it.
    CARRIED_FROM=""
    if [ "$REVIEW_MODE" = "BASE_SYNC_ONLY" ]; then CARRIED_FROM=$(carry_verified_from); fi
    ACTUAL_AGENT_DOMAINS=""
    if [ -n "$TRUSTED_SCRIPT" ]; then
        ACTUAL_AGENT_DOMAINS=$(printf '%s' "$COMMENTS_JSON" \
            | bash "$TRUSTED_SCRIPT" bodies "^<!-- FORGE:REVIEW-AGENT:[a-z-]+ -->" 2>/dev/null \
            | jq -rs '[.[] | scan("^<!-- FORGE:REVIEW-AGENT:([a-z-]+) -->") | .[0]] | unique | join(", ")' 2>/dev/null || echo "")   # unresolvable => empty => count 0 (degraded, fail closed)
    fi
    # No `|| echo 0` fallback after grep -c: it always prints a count (0 on no match) even though it exits 1, so a fallback would double-count to "0\n0".
    ACTUAL_AGENT_COUNT=$(echo "$ACTUAL_AGENT_DOMAINS" | tr ',' '\n' | grep -c '.' 2>/dev/null)
    # A verified carried head dispatched no reviewers by design: report it as carried instead of a degraded zero-agent panel.
    if [ -n "$CARRIED_FROM" ]; then ACTUAL_AGENT_DOMAINS="carried from ${CARRIED_FROM}"; ACTUAL_AGENT_COUNT=0; fi
    echo "REVIEW_SHA=${REVIEW_SHA}"
    echo "CURRENT_SHA=${CURRENT_SHA}"
    echo "REVIEW_IS_STALE=${REVIEW_IS_STALE}"
    echo "ACTUAL_AGENT_COUNT=${ACTUAL_AGENT_COUNT}"
    echo "ACTUAL_AGENT_DOMAINS=${ACTUAL_AGENT_DOMAINS}"
    echo "CARRIED_FROM: ${CARRIED_FROM}"
    exit 0
}

case "$SUB" in
    extract) do_extract ;;
    classify) do_classify ;;
    file-prepare) do_file_prepare ;;
    verdict) do_verdict ;;
    calibrate) do_calibrate ;;
    merge-gate) do_merge_gate ;;
    demilestone) do_demilestone ;;
    integrity) do_integrity ;;
esac
