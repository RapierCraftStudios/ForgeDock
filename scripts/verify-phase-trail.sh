#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# verify-phase-trail.sh — Deterministic phase-trail gate for the /work-on pipeline.
#
# Verifies that an issue carries the FORGE artifacts that the mandatory phases
# are required to produce, so a PR is never opened or merged on a reviewer
# verdict alone after phases were silently skipped.
#
# Usage:
#   verify-phase-trail.sh <issue> -R <owner/repo> [--docs-only] [--code-diff] [--head-tree <sha>] [--head-sha <sha>]
#
#   --docs-only   The diff is documentation-only; the FORGE:QUALITY_GATE marker
#                 is not required.
#   --code-diff   The diff contains at least one non-documentation file. An agent-chosen
#                 INVESTIGATION band is then NOT honoured (investigation tasks produce issues,
#                 not code), so the STANDARD requirement set applies (#3149).
#   --head-tree   Git tree id (40 or 64 hex) of the commit being gated. The passing
#                 FORGE:QUALITY_GATE marker must record the same `**Tree**: <sha>`; a PASS from an
#                 earlier tree, or a marker without a Tree line, does not satisfy the gate (#3149).
#                 An empty or non-hex value is a usage error (exit 2, fails closed).
#                 Scope: this binds the PASS to the built tree; it is not tamper-proof, because the
#                 pipeline agent posts under the same trusted identity and could compute the tree itself.
#   --head-sha    Commit id (40 or 64 hex) of the head being gated. Enables the human break-glass
#                 override (below); without it an override comment is never evaluated. An empty or
#                 non-hex value is a usage error (exit 2, fails closed).
#
# Requirements by COMPLEXITY_BAND (read from the FORGE:FAST_PATH comment).
# The authoritative table is the `case "$EFFECTIVE"` block below; this summary must be
# updated together with it (and commands/work-on/review.md):
#   INVESTIGATION  INVESTIGATOR, FAST_PATH
#   TRIVIAL        INVESTIGATOR, CONTRACT, FAST_PATH, QUALITY_GATE*
#   STANDARD/COMPLEX (or unknown band)
#                  INVESTIGATOR, CONTRACT, FAST_PATH, CONTEXT, ARCHITECT, QUALITY_GATE*
#   (* waived with --docs-only)
#   A missing FAST_PATH is itself a failure; the remaining checks then use the
#   conservative STANDARD requirement set.
#
# Output (stdout, machine-readable):
#   PHASE_TRAIL: PASS|FAIL|ERROR
#   BAND: <band>
#   MISSING: <marker> -> <phase to re-run>      (one line per missing artifact)
#   PHASE_TRAIL: OVERRIDDEN                     (exit 0 via an accepted break-glass override)
#   WAIVED: <marker list>                       (the MISSING set the override waived)
#   OVERRIDE: approver=<login> head=<sha> missing=<list> reason=<sanitised>
#                                               (the ONLY source callers use to record the override)
#
# Exit codes: 0 pass (or accepted override), 1 one or more artifacts missing, 2 could not
# read the issue (fails closed — an unreadable trail is never treated as a pass).
# Exit 2 is NEVER overridable: override evaluation only runs on the exit-1 (MISSING) path.
# Callers route on the exit code: 1 -> re-run the MISSING phases; 2 (or 127 when the
# verifier itself cannot be resolved) -> infrastructure BLOCKED, never "missing phases".
#
# Legacy grace (#3102): an issue whose trusted FORGE:BUILDER:COMPLETE comment was last updated before
# FORGE_TRAIL_QG_SINCE (default: when the FORGE:QUALITY_GATE marker was introduced, #3061) could
# not have posted the marker, so QUALITY_GATE is waived for it. The time is the comment's
# `updated_at`, not `created_at`: BUILDER:COMPLETE is appended to the existing BUILDER comment later
# (#3149). A missing/undated BUILDER:COMPLETE never earns the grace (fail closed). Set FORGE_TRAIL_QG_SINCE="" to disable the grace.
# TRUSTED ENVIRONMENT ONLY (#3139): any valid past FORGE_TRAIL_QG_SINCE is honoured, and an earlier
# value waives QUALITY_GATE for every build completed before it. Never set it from untrusted input
# (PR content, issue text, contributor-controlled CI variables); only the operator's runner environment.
#
# Comment trust: only markers posted by a trusted author count; markers from any
# other commenter are ignored (they cannot satisfy the gate or force a band).
# Trusted = author_association in FORGE_TRAIL_TRUSTED_ASSOCIATIONS
# (default "OWNER,MEMBER,COLLABORATOR"), OR user.type == "Bot" (the pipeline's
# GitHub App identity), OR user.login in FORGE_TRAIL_TRUSTED_LOGINS
# (comma-separated, default empty).
# Identities outside that set -- e.g. a human with author_association CONTRIBUTOR/NONE/FIRST_TIME_CONTRIBUTOR
# (an external contributor running the pipeline under their own login) -- are NOT trusted, so their
# markers are ignored and the gate reports them MISSING. To accept such an identity add its login to
# FORGE_TRAIL_TRUSTED_LOGINS, or widen FORGE_TRAIL_TRUSTED_ASSOCIATIONS (e.g. add CONTRIBUTOR). On FAIL the
# script prints a NOTE when untrusted-author FORGE markers were seen, so this is diagnosable (#3123).
# Limits: "Bot" trusts any GitHub App/bot that can comment on the repo (set
# FORGE_TRAIL_TRUSTED_ASSOCIATIONS and FORGE_TRAIL_TRUSTED_LOGINS to tighten);
# COLLABORATOR includes read-level collaborators; login matching is case-sensitive.
#
# Break-glass override (#3152): a misfiring gate can be cleared by a HUMAN, never by the pipeline.
# A comment whose body starts with `<!-- FORGE:PHASE_TRAIL_OVERRIDE -->` and carries the lines
#   **Head**: <full head sha>
#   **Missing**: <marker names, comma separated>
#   **Reason**: <one line>
# is honoured only when ALL of these hold (any error, null field or API failure rejects it and the
# gate stays at exit 1; never a pass):
#   - user.type == "User" (allowlist: Bots and null users are rejected) with a plain login;
#   - updated_at == created_at (an edited comment is rejected: tamper evidence);
#   - the author has repo permission admin or write (collaborators/<login>/permission), not mere
#     org membership or read access;
#   - the author is NOT a pipeline identity: FORGE_TRAIL_PIPELINE_LOGINS (comma-separated, case-insensitive)
#     plus the author of every trusted FORGE marker comment (BUILDER, INVESTIGATOR, CONTRACT, ...), so a
#     pipeline running under a human token cannot approve its own gate. A solo operator therefore needs a
#     second human with write access to post the override;
#   - **Head** equals --head-sha and **Missing** equals the current MISSING marker-name set exactly
#     (a new commit or a different failure invalidates it);
#   - created_at is later than the latest trusted FORGE:BUILDER:COMPLETE update time.
# The reason is sanitised (control chars stripped, comment markers neutralised, whitespace collapsed,
# capped at 200 chars); an empty reason rejects the override.
# END-HELP (`-h` prints the header up to this line; keep it last)

set -uo pipefail

ISSUE=""
REPO=""
DOCS_ONLY=0
CODE_DIFF=0
HEAD_TREE=""
HEAD_TREE_SET=0
HEAD_SHA=""
HEAD_SHA_SET=0

while [ $# -gt 0 ]; do
  case "$1" in
    -R|--repo)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then echo "PHASE_TRAIL: ERROR"; echo "usage error: $1 needs a value" >&2; exit 2; fi
      REPO="$2"; shift 2 ;;
    --docs-only) DOCS_ONLY=1; shift ;;
    --code-diff) CODE_DIFF=1; shift ;;
    --head-tree)
      if [ $# -lt 2 ]; then echo "PHASE_TRAIL: ERROR"; echo "usage error: $1 needs a value" >&2; exit 2; fi
      HEAD_TREE="$2"; HEAD_TREE_SET=1; shift 2 ;;
    --head-sha)
      if [ $# -lt 2 ]; then echo "PHASE_TRAIL: ERROR"; echo "usage error: $1 needs a value" >&2; exit 2; fi
      HEAD_SHA="$2"; HEAD_SHA_SET=1; shift 2 ;;
    -h|--help) awk 'NR >= 5 { if (/^# END-HELP/) exit; print }' "$0"; exit 0 ;;
    *)
      if [ -z "$ISSUE" ] && [[ "$1" =~ ^[0-9]+$ ]]; then ISSUE="$1"; shift
      else echo "PHASE_TRAIL: ERROR"; echo "usage error: unexpected argument '$1'" >&2; exit 2; fi
      ;;
  esac
done

if [ -z "$ISSUE" ] || [ -z "$REPO" ]; then
  echo "PHASE_TRAIL: ERROR"
  echo "usage: verify-phase-trail.sh <issue> -R <owner/repo> [--docs-only] [--code-diff] [--head-tree <sha>] [--head-sha <sha>]" >&2
  exit 2
fi
if [ "$HEAD_TREE_SET" = "1" ]; then
  # Fail closed: a caller that could not resolve the tree passes an empty value and must not silently skip the binding.
  HEAD_TREE=$(printf '%s' "$HEAD_TREE" | tr 'A-F' 'a-f')
  if ! [[ "$HEAD_TREE" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    echo "PHASE_TRAIL: ERROR"
    echo "usage error: --head-tree needs a 40 or 64 hex git tree id" >&2
    exit 2
  fi
fi

if [ "$HEAD_SHA_SET" = "1" ]; then
  # Fail closed: a caller that could not resolve the head passes an empty value and must not silently skip the binding.
  HEAD_SHA=$(printf '%s' "$HEAD_SHA" | tr 'A-F' 'a-f')
  if ! [[ "$HEAD_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    echo "PHASE_TRAIL: ERROR"
    echo "usage error: --head-sha needs a 40 or 64 hex commit id" >&2
    exit 2
  fi
fi

RAW=$(gh api "repos/${REPO}/issues/${ISSUE}/comments" --paginate 2>/dev/null) || {
  echo "PHASE_TRAIL: ERROR"
  echo "could not read comments for ${REPO}#${ISSUE}" >&2
  exit 2
}

# `gh api --paginate` emits one JSON array per page; merge them into a single array so every
# later computation (notably the latest BUILDER:COMPLETE time) sees ALL pages (#3121).
# Every page must itself be a JSON array of comment OBJECTS (an error object, a scalar page, or a
# page holding non-object elements such as [1,"x"] fails closed, #3130/#3139).
RAW=$(printf '%s' "$RAW" | jq -s 'if all(.[]; type == "array" and all(.[]; type == "object")) then (add // []) else error("non-array page") end' 2>/dev/null) || {
  echo "PHASE_TRAIL: ERROR"
  echo "could not parse comments for ${REPO}#${ISSUE}" >&2
  exit 2
}

# One line per comment, newlines folded to \x1f so a marker and its sentinel can
# be matched within the SAME comment.
TRUSTED_ASSOC="${FORGE_TRAIL_TRUSTED_ASSOCIATIONS-OWNER,MEMBER,COLLABORATOR}"
TRUSTED_LOGINS="${FORGE_TRAIL_TRUSTED_LOGINS-}"
COMMENTS=$(printf '%s' "$RAW" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" '
  ($assoc | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $A
  | ($logins | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $L
  | .[]
  | select(
      ((.author_association // "") as $x | $A | index($x) != null)
      or ((.user.type // "") == "Bot")
      or ((.user.login // "") as $x | $L | index($x) != null)
    )
  | .body // "" | gsub("\r?\n"; "\u001f")' 2>/dev/null) || {
  echo "PHASE_TRAIL: ERROR"
  echo "could not parse comments for ${REPO}#${ISSUE}" >&2
  exit 2
}

# Last-update time of the LATEST trusted FORGE:BUILDER:COMPLETE comment (empty when absent/undated).
QG_SINCE="${FORGE_TRAIL_QG_SINCE-2026-10-07T03:40:12Z}"
# The cutoff must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ) and not in the future: a malformed or
# far-future value would otherwise waive QUALITY_GATE for every issue (#3121). Fails closed.
if [ -n "$QG_SINCE" ]; then
  NOW_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  QG_VALID=1
  if ! [[ "$QG_SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || [[ "$QG_SINCE" > "$NOW_UTC" ]]; then
    QG_VALID=0
  else
    # Round-trip through `date` so impossible dates (2020-13-45T99:99:99Z) are rejected (#3130).
    # GNU date first, then BSD/macOS date; no usable parser or a mismatch fails closed.
    QG_RT=$(date -u -d "$QG_SINCE" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -j -f %Y-%m-%dT%H:%M:%SZ "$QG_SINCE" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
    [ "$QG_RT" = "$QG_SINCE" ] || QG_VALID=0
  fi
  if [ "$QG_VALID" != "1" ]; then
    echo "PHASE_TRAIL: ERROR"
    # A runner clock behind the default cutoff also lands here (cutoff appears to be in the future): fails closed.
    echo "invalid FORGE_TRAIL_QG_SINCE '${QG_SINCE}': must be a real ISO-8601 UTC time (YYYY-MM-DDTHH:MM:SSZ) and not in the future (check the runner clock)" >&2
    exit 2
  fi
fi
BUILD_AT=$(printf '%s' "$RAW" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" '
  ($assoc | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $A
  | ($logins | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $L
  | [ .[]
      | select(
          ((.author_association // "") as $x | $A | index($x) != null)
          or ((.user.type // "") == "Bot")
          or ((.user.login // "") as $x | $L | index($x) != null)
        )
      | select((.body // "") | startswith("<!-- FORGE:BUILDER -->") and contains("<!-- FORGE:BUILDER:COMPLETE -->"))
      | .updated_at // empty ] | sort | .[-1] // empty' 2>/dev/null) || BUILD_AT=""

# NOTE: never use early-exiting `grep -q`/`head -1` after printf under pipefail: on large threads the
# writer gets SIGPIPE and the pipeline reports failure for a marker that is present (#3099).
# A marker only counts when it is the FIRST thing in a comment (comments are folded to one
# line each above), so a comment that merely quotes a marker mid-body cannot satisfy it.
has() { printf '%s\n' "$COMMENTS" | grep -E "^$1" >/dev/null; }

# INVESTIGATION:INVALID is the other terminal sentinel (issue closed invalid, no PR follows).
has_investigator() {
  printf '%s\n' "$COMMENTS" | grep -E '^<!-- FORGE:INVESTIGATOR -->' | grep -E 'INVESTIGATION:(COMPLETE|INVALID)' >/dev/null
}

# Quality gate: a marker comment whose result is PASS (any later PASS wins over an earlier FAIL).
has_quality_gate_pass() {
  # With --head-tree the PASS must also record that exact tree (a PASS for an earlier commit does not count).
  if [ "$HEAD_TREE_SET" = "1" ]; then
    printf '%s\n' "$COMMENTS" | grep -E '^<!-- FORGE:QUALITY_GATE -->' | grep -E '\*\*Result\*\*: *PASS' \
      | grep -E "\*\*Tree\*\*: *${HEAD_TREE}([^0-9a-fA-F]|$)" >/dev/null
  else
    printf '%s\n' "$COMMENTS" | grep -E '^<!-- FORGE:QUALITY_GATE -->' | grep -E '\*\*Result\*\*: *PASS' >/dev/null
  fi
}

BAND=""
if has '<!-- FORGE:FAST_PATH -->'; then
  # The FIRST classification wins: a later FAST_PATH comment cannot downgrade the requirement set.
  BAND=$(printf '%s\n' "$COMMENTS" | grep -E '^<!-- FORGE:FAST_PATH -->' | sed -n '1p' \
    | sed -n 's/.*\*\*COMPLEXITY_BAND\*\*: *\([A-Za-z_]*\).*/\1/p' | tr '[:lower:]' '[:upper:]')
fi

MISSING=()
add_missing() { MISSING+=("$1 -> $2"); }

has_investigator || add_missing "INVESTIGATOR" "re-run Skill work-on/investigate"

if [ -z "$BAND" ]; then
  if has '<!-- FORGE:FAST_PATH -->'; then
    add_missing "FAST_PATH (no COMPLEXITY_BAND value)" "re-run work-on Phase 3B classification"
  else
    add_missing "FAST_PATH" "re-run work-on Phase 3B classification"
  fi
  EFFECTIVE="STANDARD"
else
  EFFECTIVE="$BAND"
fi

# The band is agent-chosen: do not let it waive requirements when the diff contains code (#3149).
if [ "$EFFECTIVE" = "INVESTIGATION" ] && [ "$CODE_DIFF" = "1" ]; then
  EFFECTIVE="STANDARD"
  BAND_NOTE="INVESTIGATION band ignored: the diff contains non-documentation files"
fi

case "$EFFECTIVE" in
  INVESTIGATION) NEED_CONTRACT=0; NEED_CTX=0; NEED_QG=0 ;;
  TRIVIAL)       NEED_CONTRACT=1; NEED_CTX=0; NEED_QG=1 ;;
  *)             NEED_CONTRACT=1; NEED_CTX=1; NEED_QG=1 ;;
esac
[ "$DOCS_ONLY" = "1" ] && NEED_QG=0
# Legacy grace: built before the quality-gate marker existed -> not required (string compare on ISO-8601 UTC).
if [ "$NEED_QG" = "1" ] && [ -n "$QG_SINCE" ] && [ -n "$BUILD_AT" ] && [[ "$BUILD_AT" < "$QG_SINCE" ]]; then
  NEED_QG=0
  LEGACY_NOTE="QUALITY_GATE waived: build completed ${BUILD_AT} before ${QG_SINCE}"
fi

if [ "$NEED_CONTRACT" = "1" ] && ! has '<!-- FORGE:CONTRACT -->'; then
  add_missing "CONTRACT" "re-run Skill work-on/build Phase B2 (builder contract)"
fi
if [ "$NEED_CTX" = "1" ]; then
  has '<!-- FORGE:CONTEXT -->' || add_missing "CONTEXT" "re-run Skill work-on/build/context"
  has '<!-- FORGE:ARCHITECT -->' || add_missing "ARCHITECT" "re-run Skill work-on/build/architect"
fi
if [ "$NEED_QG" = "1" ] && ! has_quality_gate_pass; then
  add_missing "QUALITY_GATE" "re-run Skill work-on/build/validate"
fi

if [ "${#MISSING[@]}" -eq 0 ]; then
  echo "PHASE_TRAIL: PASS"
  echo "BAND: ${BAND:-UNKNOWN}"
  [ -n "${LEGACY_NOTE:-}" ] && echo "NOTE: $LEGACY_NOTE"
  [ -n "${BAND_NOTE:-}" ] && echo "NOTE: $BAND_NOTE"
  exit 0
fi

# --- Break-glass override (#3152) ---------------------------------------------------------------
# Reached ONLY with a non-empty MISSING set (exit-1 path); every `exit 2` above precedes it.
# Prints the OVERRIDE/WAIVED lines and returns 0 only when a comment passes every rule; any failure
# (jq error, permission API error, empty field) returns 1 and the caller falls through to FAIL.
# Name set normaliser shared by BOTH sides of the comparison: drops ` -> action` and `(qualifier)`,
# trims, de-duplicates, sorts, joins with commas. bash 3.2/BSD portable.
norm_set() {
  sed -e 's/ -> .*$//' -e 's/([^)]*)//g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | grep -v '^$' | LC_ALL=C sort -u | paste -sd, -
}

evaluate_override() {
  [ "$HEAD_SHA_SET" = "1" ] || return 1
  local cur_set cands pipeline_logins login created head missing reason perm n=0
  cur_set=$(printf '%s\n' "${MISSING[@]}" | norm_set) || return 1
  [ -n "$cur_set" ] || return 1
  # BUILDER exists but its completion time is unknown -> cannot prove the override is newer: reject.
  if has '<!-- FORGE:BUILDER -->' && [ -z "$BUILD_AT" ]; then return 1; fi
  # Pipeline identity set (configured + derived): authors of trusted FORGE marker comments other than overrides.
  # The token this verifier runs under is the pipeline's identity too (forge#3269): a pipeline using a human
  # token with no markers yet must not approve its own override. Lookup failure adds nothing (derived set still applies).
  local self_login extra_logins marker_floor
  self_login=$(gh api user --jq '.login' 2>/dev/null || true)
  case "$self_login" in *[!A-Za-z0-9_-]*) self_login="" ;; esac
  extra_logins="${FORGE_TRAIL_PIPELINE_LOGINS-}${self_login:+,$self_login}"
  pipeline_logins=$(printf '%s' "$RAW" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" --arg extra "$extra_logins" '
    ($assoc | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $A
    | ($logins | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $L
    | ($extra | split(",") | map(gsub("^\\s+|\\s+$"; "") | ascii_downcase) | map(select(length > 0))) as $E
    | ( [ .[]
          | select(
              ((.author_association // "") as $x | $A | index($x) != null)
              or ((.user.type // "") == "Bot")
              or ((.user.login // "") as $x | $L | index($x) != null))
          | select((.body // "") | startswith("<!-- FORGE:") and (startswith("<!-- FORGE:PHASE_TRAIL_OVERRIDE -->") | not))
          | (.user.login // empty) | ascii_downcase ] + $E ) | unique | .[]' 2>/dev/null) || return 1
  # Time floor (forge#3271): the latest trusted BUILDER:COMPLETE. With none, fall back to the newest trusted
  # non-override FORGE marker so an override still has to post-date the pipeline's own activity.
  marker_floor="$BUILD_AT"
  if [ -z "$marker_floor" ]; then
    marker_floor=$(printf '%s' "$RAW" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" '
      ($assoc | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $A
      | ($logins | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $L
      | [ .[]
          | select(((.author_association // "") as $x | $A | index($x) != null)
                   or ((.user.type // "") == "Bot")
                   or ((.user.login // "") as $x | $L | index($x) != null))
          | select((.body // "") | startswith("<!-- FORGE:") and (startswith("<!-- FORGE:PHASE_TRAIL_OVERRIDE -->") | not))
          | .created_at // empty ] | sort | .[-1] // empty' 2>/dev/null) || return 1
  fi
  # Candidates, newest first, as TSV: login created_at head missing reason (reason last, others never empty).
  cands=$(printf '%s' "$RAW" | jq -r --arg bt "$marker_floor" '
    def clean: explode | map(select(. >= 32 and . != 127 and (. < 128 or . > 159) and (. < 8203 or . > 8207) and (. < 8232 or . > 8238) and (. < 8288 or . > 8297) and . != 65279)) | implode;
    [ .[]
      | select((.body // "") | startswith("<!-- FORGE:PHASE_TRAIL_OVERRIDE -->"))
      | select((.user.type // "") == "User")
      | select(((.user.login // "") | test("^[A-Za-z0-9_-]+$")))
      | select((.created_at // "") != "" and (.updated_at // "") != "" and .created_at == .updated_at)
      | select($bt == "" or .created_at > $bt)
      | (.body | split("\n") | map(sub("\r$"; ""))) as $ln
      | { login: .user.login, at: .created_at,
          head: ([$ln[] | capture("^\\*\\*Head\\*\\*: *(?<v>[0-9A-Fa-f]{40,64}) *$")?.v] | .[0] // "-"),
          missing: ([$ln[] | capture("^\\*\\*Missing\\*\\*: *(?<v>.+)$")?.v] | .[0] // "-"),
          reason: ([$ln[] | capture("^\\*\\*Reason\\*\\*: *(?<v>.*)$")?.v] | .[0] // "")
            | clean | gsub("<!--"; "<!-/-") | gsub("-->"; "-/->") | gsub("`"; "'"'"'") | gsub("@"; "(at)")
            | gsub("\\s+"; " ") | sub("^ "; "") | sub(" $"; "") | .[0:200] } ]
    | sort_by(.at) | reverse | .[]
    | [.login, .at, .head, .missing, (if .reason == "" then "-" else .reason end)] | @tsv' 2>/dev/null) || return 1
  [ -n "$cands" ] || return 1
  while IFS=$'\t' read -r login created head missing reason; do
    [ -n "$login" ] || continue
    [ "$reason" != "-" ] && [ -n "$reason" ] || continue
    reason=$(printf '%s' "$reason" | tr -d '[:cntrl:]')   # belt and braces: cntrl (incl. ESC) stripped again
    [ -n "$reason" ] || continue
    [ "$(printf '%s' "$head" | tr 'A-F' 'a-f')" = "$HEAD_SHA" ] || continue
    [ "$(printf '%s' "$missing" | tr ',' '\n' | norm_set)" = "$cur_set" ] || continue
    if printf '%s\n' "$pipeline_logins" | grep -Fx -- "$(printf '%s' "$login" | tr 'A-Z' 'a-z')" >/dev/null; then continue; fi
    n=$((n+1)); [ "$n" -le 5 ] || { echo "NOTE: break-glass override: more than 5 eligible candidates; extra ones ignored" >&2; break; }   # bound API calls (counted only for candidates that passed every local check)
    # Login already matched ^[A-Za-z0-9_-]+$ in jq, so it is safe to interpolate into the API path.
    perm=$(gh api "repos/${REPO}/collaborators/${login}/permission" 2>/dev/null | jq -r '.permission // empty' 2>/dev/null) || perm=""
    case "$perm" in admin|write) ;; *) echo "NOTE: break-glass override by ${login} rejected: permission='${perm:-unreadable}' (needs admin/write; the lookup needs a token with push access)" >&2; continue ;; esac
    echo "PHASE_TRAIL: OVERRIDDEN"
    echo "BAND: ${BAND:-UNKNOWN}"
    echo "WAIVED: ${cur_set}"
    echo "OVERRIDE: approver=${login} head=${HEAD_SHA} missing=${cur_set} reason=${reason}"
    return 0
  done <<< "$cands"
  return 1
}

if evaluate_override; then
  [ -n "${BAND_NOTE:-}" ] && echo "NOTE: $BAND_NOTE"
  exit 0
fi

echo "PHASE_TRAIL: FAIL"
echo "BAND: ${BAND:-UNKNOWN}"
for m in "${MISSING[@]}"; do echo "MISSING: $m"; done
[ -n "${BAND_NOTE:-}" ] && echo "NOTE: $BAND_NOTE"
# Diagnose the "marker present but ignored" case: count FORGE markers posted by untrusted authors.
UNTRUSTED_FORGE=$(printf '%s' "$RAW" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" '
  ($assoc | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $A
  | ($logins | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $L
  | [ .[]
      | select(((.author_association // "") as $x | $A | index($x) == null)
               and ((.user.type // "") != "Bot")
               and ((.user.login // "") as $x | $L | index($x) == null))
      | select((.body // "") | startswith("<!-- FORGE:")) ] | length' 2>/dev/null || echo 0)
if [ "${UNTRUSTED_FORGE:-0}" -gt 0 ] 2>/dev/null; then
  echo "NOTE: ${UNTRUSTED_FORGE} FORGE marker comment(s) from untrusted authors were ignored; set FORGE_TRAIL_TRUSTED_LOGINS or FORGE_TRAIL_TRUSTED_ASSOCIATIONS to trust them"
fi
exit 1
